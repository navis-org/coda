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
import type { DataSource } from '../../data/source'
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
  /** Which regions to ask for. The source's primary set when omitted. */
  rois?: readonly string[]
  /** Ignore what is stored and trace again — the card's reload. */
  force?: boolean
  onProgress?: (fraction: number, note?: string) => void
  signal?: AbortSignal
}

/** In-flight loads, so two cards on one dataset share a download rather than racing. */
const inFlight = new Map<string, Promise<RoiOutlineSet>>()

function cacheKey(sourceId: string, datasetId: string): string {
  return `roi-outlines:${sourceId}:${datasetId}`
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
  const rois = options.rois ?? source.peekDataset(datasetId)?.primaryRois ?? []
  const key = cacheKey(source.id, datasetId)
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
      ...(options.rois ? { rois: [...options.rois] } : {}),
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
      roi: item.label ?? String(index),
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
  rois: readonly string[],
): Promise<RoiOutlineSet | undefined> {
  return cacheGet<RoiOutlineSet>(cacheKey(source.id, datasetId), {
    fingerprint: fingerprintOf(rois),
  })
}

/** Test seam; module-level state outlives a test file otherwise. */
export function resetRoiOutlineState(): void {
  inFlight.clear()
}
