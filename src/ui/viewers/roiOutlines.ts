/**
 * The thing that gets kept when the meshes are thrown away.
 *
 * A dataset's region meshes are 29–62 MB and are fetched once. What survives that fetch is this:
 * every region flattened into the three anatomical planes, plus what could be measured off the
 * geometry before it went. A few tens of kilobytes against tens of megabytes — measured at 42 kB
 * for hemibrain's 63 regions and 95 kB for male-CNS's 139, at trace grid 512.
 *
 * That ratio is the entire dividend of having three fixed planes rather than a camera. With an
 * arbitrary angle askable at any moment the geometry has to be retained; with three answers it
 * can be computed and released.
 *
 * ## Cached, and the fingerprint is the interesting half
 *
 * `data/cache.ts` rather than a bespoke store, because these *are* re-derivable: the meshes are
 * still on the server, so an eviction costs a download rather than somebody's data. (That is the
 * line `store/library.ts` and `data/uploads.ts` sit on the other side of.)
 *
 * The fingerprint carries the format version, the trace grid and the region list, and every part
 * of that earns its place. Once the meshes are discarded, **these outlines are the only copy** —
 * so a change to how they are traced cannot be noticed by looking at them, and a cache that
 * outlived its tracer would serve polylines nobody can regenerate or explain. That is the
 * thumbnail cache's lesson, which persisted *refusals* and quietly outlived the byte ceiling that
 * produced them: every neuron the old limit turned down stayed a placeholder through any number
 * of reloads, because nothing ever asked again.
 */

import { cacheGet, cacheSet } from '../../data/cache'
import { datasetCacheKey } from '../../data/neuronIndex'
import type { DataSource } from '../../data/source'
import { regionList } from '../../data/source'
import type { MeshesValue } from '../../core/values'
import type { RoiView } from './roiProjection'
import {
  ROI_VIEWS,
  TRACE_GRID,
  meshSurfaceArea,
  meshVolume,
  projectRegions,
} from './roiProjection'

/**
 * Bumped when anything about the stored shape or the way it is traced changes.
 *
 * Not derived from the code, because it cannot be: the outlines outlive the geometry, so nothing
 * about a stored set reveals which tracer produced it.
 */
const OUTLINE_FORMAT = 'roi-outlines.v1'

/** One region in one plane. Rings are x,y interleaved, in nanometres. */
export interface RoiOutlineView {
  rings: Float32Array[]
  centre: [number, number]
  /** Mean projected depth; larger is further from the viewer, for a painter's sort. */
  depth: number
  /** The disc radius the explode solver treats this region as having. */
  radius: number
}

export interface RoiOutlineRegion {
  roi: string
  primary: boolean
  /**
   * Enclosed volume in nm³, and **approximate**.
   *
   * neuPrint publishes these meshes "for visualization only… not suitable for quantitative
   * analysis", and Coda then decimates them further before this is measured. It is carried
   * because nothing else in the app can say anything at all about a region's size — but every
   * surface showing it has to say where it came from.
   */
  volume: number
  surfaceArea: number
  views: Record<RoiView, RoiOutlineView>
}

export interface RoiOutlineSet {
  regions: RoiOutlineRegion[]
  /** Regions the dataset lists that published no mesh. Never an error; often not even a gap. */
  missing: string[]
  /** Bytes of geometry downloaded to build this, for a caption that can state the cost. */
  bytes: number
}

export interface LoadRoiOutlinesOptions {
  source: DataSource
  datasetId: string
  /**
   * Which of the dataset's region lists this is. Decides the cache variant, always — so an
   * explicit `rois` narrows what is fetched without ever putting it on the other shelf.
   *
   * Required rather than defaulted: `primaryOnly !== false` is a claim about what an *absent*
   * key means on a stored document, and `roisPrimaryOnly` is where that claim lives. A default
   * here would be a second copy of it in a module nobody edits alongside the node.
   */
  primaryOnly: boolean
  /** Which regions to ask for. `roiRegions`' answer for `primaryOnly` when omitted. */
  rois?: readonly string[]
  /** Ignore what is stored and trace again — the card's reload. */
  force?: boolean
  onProgress?: (fraction: number, note?: string) => void
  signal?: AbortSignal
}

/** In-flight loads, so two cards on one dataset share a download rather than racing. */
const inFlight = new Map<string, Promise<RoiOutlineSet>>()

/**
 * How many regions a card will download without asking a second time.
 *
 * The Load button is already one confirmation, and for the primary set it is the only one
 * needed: 63 regions on hemibrain, 144 on male-CNS. The *published* list is a different
 * proposition — 230 and **5,619** — and it is one request per region at a concurrency of four,
 * so the second of those is well over a thousand sequential rounds against a shared production
 * server. A button that said `Load 5,619 regions` and started is a button that reads the same
 * as the one that starts 144.
 *
 * **Conventional, not measured**, and this file says so rather than implying a finding: nobody
 * here has run male-CNS's whole list, which is precisely why the card asks. What the number has
 * to clear is every *primary* set (144) and hemibrain's whole published list (230), so that the
 * question is asked where the count has left the range the card was designed around rather than
 * on every untick. It refuses nothing — the confirm has a Download button on it.
 */
export const ROI_CONFIRM_REGIONS = 500

/**
 * Through `datasetCacheKey` rather than spelled out, so the dataset card's ⟳ reaches these too:
 * outlines traced from a release's region meshes are exactly as stale as the release.
 *
 * The two region sets are two *shelves*, not two versions of one: `isDatasetCacheKey` already
 * admits a variant, so unticking the box and ticking it back does not pay for the primary set's
 * download twice. Primary keeps the bare key it has always had, so outlines traced by an earlier
 * build are still found. The fingerprint is what validates a shelf's contents — the variant only
 * stops the two evicting each other — which is why the pair cannot drift into serving one set's
 * shapes under the other's name.
 */
function cacheKey(sourceId: string, datasetId: string, primaryOnly: boolean): string {
  return datasetCacheKey('roi-outlines', sourceId, datasetId, primaryOnly ? '' : 'all')
}

function fingerprintOf(rois: readonly string[]): string {
  // The region list by name, not by count: a dataset that renames a region between versions
  // would otherwise reuse outlines traced for a different set of shapes.
  return `${OUTLINE_FORMAT}:${TRACE_GRID}:${[...rois].sort().join(',')}`
}

/**
 * The outlines for a dataset, from cache where possible.
 *
 * Never fetches speculatively — the caller decides when to start, because the download is large
 * enough that it has to be somebody's explicit choice rather than a side effect of mounting a
 * card.
 */
export async function loadRoiOutlines(options: LoadRoiOutlinesOptions): Promise<RoiOutlineSet> {
  const { source, datasetId } = options
  const { primaryOnly } = options
  const rois = options.rois ?? regionList(source.peekDataset(datasetId), primaryOnly)
  const key = cacheKey(source.id, datasetId, primaryOnly)
  const fingerprint = fingerprintOf(rois)

  if (!options.force) {
    const cached = await cacheGet<RoiOutlineSet>(key, { fingerprint })
    if (cached) return cached
  }

  const existing = inFlight.get(key)
  if (existing) return existing

  const load = (async () => {
    const fetchMeshes = source.fetchRoiMeshes?.bind(source)
    if (!fetchMeshes || !source.capabilities.roiMeshes) {
      throw new Error(`${source.label} does not publish region meshes`)
    }

    const meshes = await fetchMeshes({
      datasetId,
      /*
       * The resolved list, not `options.rois` — the whole published set has to reach the fetch,
       * where an omitted `rois` means the source's *primary* set by `RoiMeshRequest`'s own rule
       * and unticking the box would have quietly re-fetched what was already on screen.
       *
       * Still omitted when the list is empty, which is the one case where the request's default
       * is the better answer: a source that lists no regions has not asked for none.
       */
      ...(rois.length > 0 ? { rois: [...rois] } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })

    const set = buildRoiOutlines(meshes, rois)
    // Storage is best-effort by the module's own contract: failing to *remember* outlines is not
    // failing to have them, and the next open simply pays the download again.
    await cacheSet(key, set, fingerprint)
    return set
  })()

  inFlight.set(key, load)
  try {
    return await load
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Flatten a fetched mesh set into the cached form.
 *
 * Separate from the loading so it can be driven directly in a test, and so the expensive part is
 * one pure function of its input: three projections, a volume and an area per region, and
 * nothing about caches or networks.
 */
export function buildRoiOutlines(
  meshes: MeshesValue,
  requested: readonly string[] = [],
  bytes = 0,
): RoiOutlineSet {
  const items = meshes.items
  /*
   * Read through the schema rather than through `getColumn`, which throws for a name it does not
   * have. The attribute table belongs to whichever source answered, and a source that carries no
   * `primary` column has not said these regions are nested — it has said nothing, which is a
   * different thing and must not read as `false`.
   */
  const hasPrimary = meshes.attributes.schema.columns.some(
    (column) => column.name === 'primary',
  )
  const primaryColumn = hasPrimary ? meshes.attributes.data['primary'] : undefined

  /*
   * Projected once per plane over the whole set rather than per region, because the frame every
   * outline is expressed in is shared: `projectRegions` fits one scale across the scene, so
   * region by region they would each be traced at their own resolution and disagree about where
   * a shared edge sits.
   */
  const perView = new Map<RoiView, Map<number, RoiOutlineView>>()
  for (const view of ROI_VIEWS) {
    const byIndex = new Map<number, RoiOutlineView>()
    for (const region of projectRegions(items, view)) {
      byIndex.set(region.index, {
        rings: region.rings,
        centre: [region.centre[0], region.centre[1]],
        depth: region.depth,
        radius: region.radius,
      })
    }
    perView.set(view, byIndex)
  }

  const regions: RoiOutlineRegion[] = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    const views = {} as Record<RoiView, RoiOutlineView>
    let drawn = false
    for (const view of ROI_VIEWS) {
      const found = perView.get(view)?.get(index)
      // A region can project to nothing in one plane — a shell seen exactly edge-on — and still
      // be perfectly visible in the other two, so an empty view is a blank rather than a drop.
      views[view] = found ?? { rings: [], centre: [0, 0], depth: 0, radius: 0 }
      if (found) drawn = true
    }
    if (!drawn) continue

    regions.push({
      roi: item.id,
      primary: primaryColumn ? primaryColumn[index] !== false : true,
      volume: meshVolume(item.positions, item.indices),
      surfaceArea: meshSurfaceArea(item.positions, item.indices),
      views,
    })
  }

  const drawn = new Set(regions.map((region) => region.roi))
  return {
    regions,
    // In the order the dataset lists them, so a caption naming them reads the way it reads
    // everywhere else.
    missing: requested.filter((roi) => !drawn.has(roi)),
    bytes,
  }
}

/**
 * What is already stored, without asking the network for anything.
 *
 * This is what lets the card skip its Load button on the second open. Kept separate from
 * `loadRoiOutlines` rather than folded in behind a flag, because the two answer different
 * questions and only one of them can cost sixty megabytes: "is this here?" must never be able
 * to start a download by accident.
 */
export async function peekRoiOutlines(
  source: DataSource,
  datasetId: string,
  primaryOnly: boolean,
): Promise<RoiOutlineSet | undefined> {
  return cacheGet<RoiOutlineSet>(cacheKey(source.id, datasetId, primaryOnly), {
    // Resolved here rather than taken alongside `primaryOnly`: a list and the boolean it derives
    // from are two inputs that must agree, and disagreeing is exactly how one set's shapes come
    // back under the other's key.
    fingerprint: fingerprintOf(regionList(source.peekDataset(datasetId), primaryOnly)),
  })
}

/** Test seam; module-level state outlives a test file otherwise. */
export function resetRoiOutlineState(): void {
  inFlight.clear()
}
