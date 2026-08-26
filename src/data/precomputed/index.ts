/**
 * One entry point for reading precomputed meshes, whichever format a source uses.
 *
 * The format is discovered from the mesh directory's `info` rather than configured, because
 * it varies across the datasets that matter: hemibrain, MANC and optic-lobe publish sharded
 * multi-resolution Draco; male-CNS publishes flat legacy meshes. A caller asks for neuron ids
 * and a triangle budget and gets geometry in physical nanometres.
 *
 * Nothing here knows about neuPrint — this layer is reusable for any neuroglancer source,
 * which is the point given FlyWire and CAVE are the obvious next backends.
 */

import { decodeDracoFragment } from './draco'
import { concatMeshes, readLegacyMesh } from './legacy'
import type { MultiResInfo, MultiResManifest } from './multires'
import {
  chooseLod,
  fragmentOffset,
  fragmentTransform,
  readManifest,
  readMultiResInfo,
  fragmentsUrl,
} from './multires'
import type { FetchOptions } from './transport'
import { fetchBytes, fetchInfo } from './transport'
import { mapWithConcurrency } from '../concurrency'
import { byteLengthOf, cachedGeometry } from '../geometryCache'

export type MeshFormat = 'multilod-draco' | 'legacy'

export interface MeshSource {
  /** Absolute URL of the mesh directory. */
  base: string
  format: MeshFormat
  /** Only for multi-resolution sources. */
  info?: MultiResInfo
  /** Number of detail levels available; 1 for legacy sources. */
  levels: number
}

interface RawInfo {
  '@type'?: string
  mesh?: string
  sharding?: unknown
}

/**
 * Resolve a segmentation or mesh URL into a usable mesh source.
 *
 * A segmentation `info` names its mesh subdirectory, so a caller can pass either the volume
 * or the mesh directory and get the same answer. An `info` with no `@type` at all is treated
 * as legacy, which is what banc's bucket looks like.
 */
export async function openMeshSource(
  url: string,
  options: FetchOptions = {},
): Promise<MeshSource> {
  const base = url.replace(/\/+$/, '')
  const info = await fetchInfo<RawInfo>(base, options)

  if (info['@type'] === 'neuroglancer_multiscale_volume') {
    if (!info.mesh) throw new Error(`${base} is a volume with no mesh subdirectory`)
    return openMeshSource(`${base}/${info.mesh}`, options)
  }
  if (info['@type'] === 'neuroglancer_multilod_draco') {
    // Unsharded is supported now — hemibrain's ROI meshes are built that way; see `readManifest`.
    const multi = await readMultiResInfo(base, options)
    return { base, format: 'multilod-draco', info: multi, levels: 0 }
  }
  // 'neuroglancer_legacy_mesh', or an info with no @type.
  return { base, format: 'legacy', levels: 1 }
}

export interface MeshResult {
  neuronId: string
  positions: Float32Array
  indices: Uint32Array
}

/** One body's geometry without its id — what the session cache holds, keyed by the id. */
type MeshBody = Omit<MeshResult, 'neuronId'>

/** Cache pairs back into results. Both mesh paths and both partial hooks put the id back on. */
function named(pairs: ReadonlyArray<[string, MeshBody]>): MeshResult[] {
  return pairs.map(([neuronId, mesh]) => ({ neuronId, ...mesh }))
}

export interface FetchMeshesResult {
  meshes: MeshResult[]
  /** Which detail level was used; undefined for single-level sources. */
  lod?: number | undefined
  /** Levels the source offered, so the UI can say "3 of 4". */
  levels?: number | undefined
  triangles: number
  /** Neuron ids the source had no mesh for. */
  missing: string[]
}

/** Default budget. ~1.5M triangles renders comfortably and holds a few dozen neurons coarse. */
export const DEFAULT_TRIANGLE_BUDGET = 1_500_000

/**
 * How many bodies are read at once, in each of the two phases.
 *
 * **100, which is neuroglancer's own number** — `data_management_context.ts` gives its chunk
 * queue `download: { defaultItemLimit: 100, defaultSizeLimit: Infinity }` — and these are the
 * same Range requests against the same public buckets, so there is no reason to be more timid
 * than the tool that made these files.
 *
 * It was **6**, which was never measured and cost roughly an order of magnitude. Measured in a
 * real browser against `neuroglancer-janelia-flyem-hemibrain/v1.2/segmentation/mesh`, cache
 * disabled, ids enumerated out of the bucket's own minishard indices so they spread across shard
 * files (best of two runs each, interleaved so a warming network could not read as a trend):
 *
 * | in flight | 96 bodies | of which manifests | 32 heavy bodies |
 * | --- | --- | --- | --- |
 * | 6   | 10,463 ms | 7,973 ms | 3,094 ms |
 * | 16  |  3,908 ms | 3,069 ms |     —    |
 * | 32  |  1,944 ms | 1,589 ms |   697 ms |
 * | 64  |  1,369 ms | 1,134 ms |   685 ms |
 * | 100 |    819 ms |   718 ms |   692 ms |
 *
 * Two things to read off it. **The gain continues for as long as the limit is under the batch
 * size** — 32 bodies plateaus at 32 because there is nothing left to overlap, while 96 bodies is
 * still improving at 100 — so this is a *latency* budget, not a bandwidth one. And **the manifest
 * sweep is the cost**: 87% of the wall clock at every setting, because it is one small request
 * per body and nothing can start until the last one lands (`chooseLod` sums across the batch).
 * That is also why manifests get their own cache entry — see `geometryCache.ts`.
 *
 * The one thing it spends is the HTTP/2 stream budget on `storage.googleapis.com`, which many
 * peers default to ~100 and which CAVE's fragment reads and Explore's thumbnails also draw on.
 * Overflow queues in the browser rather than failing, and graph nodes execute one at a time, so
 * the realistic collision is a widget fetching alongside a run — it waits, and gets there.
 */
const BUCKET_CONCURRENCY = 100

export interface FetchMeshesOptions extends FetchOptions {
  triangleBudget?: number
  /** Concurrency for per-body reads; defaults to `BUCKET_CONCURRENCY`. */
  concurrency?: number
  /**
   * Skip any body whose chosen level still exceeds this many compressed bytes, reporting it
   * as missing instead.
   *
   * Different guard rail from `triangleBudget`, which balances a whole batch: this one bounds a
   * *single* body, for a caller that would rather show nothing than wait. It matters because
   * even the coarsest level has a long tail — sampled over hemibrain, the coarsest level is 264
   * bytes at the median but 508 kB at the maximum, and the same 2000× spread exists in every
   * dataset. The manifest carries the size, so the decision costs no download.
   */
  maxBytesPerBody?: number
  /** `phase` distinguishes the manifest sweep from the fragment fetch. */
  onProgress?: (done: number, total: number, phase: 'manifests' | 'fragments') => void
  /** Clear Cache, passed straight through to `geometryCache`. */
  refresh?: boolean
  /** When the geometry came from a server; see `GeometryRequest.onFetched`. */
  onFetched?: (at: number) => void
  /**
   * Hand back the meshes decoded so far, in final order, while the rest are still in flight.
   *
   * Wired to the **fragment** sweep only. A manifest is not drawable — it is the pyramid, not the
   * geometry — and the level cannot even be chosen until the last one lands, since `chooseLod`
   * sums across the batch. So on a cold multi-resolution run nothing streams until the manifest
   * phase is done, which the measurements above put at 87% of the wall clock. The sweep after
   * that is what fills in, and a re-run with the manifests already cached streams from the start.
   */
  onPartial?: (meshes: MeshResult[]) => void
  /** Held until this settles, and passed straight through — see `CachedGeometryRequest`. */
  readyBefore?: Promise<unknown>
}

/**
 * Report a mesh fetch's two phases as one 0..1 fraction and one caption.
 *
 * Here rather than in a backend, because `'manifests' | 'fragments'` is this module's own
 * vocabulary: `fetchMeshes` is what emits those phases, and every source that calls it has to
 * turn the pair into the one bar and the one line a node card draws. It was written out inside
 * `NeuPrintSource` and copied verbatim into the next source that needed it, which put the split
 * below in two places and its test in one.
 *
 * **The two phases cost wildly different amounts.** A manifest is a few hundred bytes per body,
 * while the fragments behind it are megabytes — so an even split races to the halfway mark in the
 * first second and then appears to hang, which is the failure mode of every progress bar that
 * measures the cheap half. Manifests get the first fifth and fragments the remaining four.
 *
 * The fraction never decreases, including across the phase boundary, which is the property that
 * matters: an indicator that goes backwards is worse than none.
 */
export function meshProgress(
  onProgress: (fraction: number, note?: string) => void,
): NonNullable<FetchMeshesOptions['onProgress']> {
  return (done, total, phase) => {
    const share = total > 0 ? Math.min(1, done / total) : 1
    const manifests = phase === 'manifests'
    onProgress(
      manifests ? 0.05 + share * 0.15 : 0.2 + share * 0.8,
      `${done}/${total} ${manifests ? 'manifests' : 'meshes'}`,
    )
  }
}

/**
 * Fetch meshes for a set of neuron ids.
 *
 * For a multi-resolution source this reads every manifest first — they are a few hundred
 * bytes each — then picks a single detail level for the whole batch so the scene is
 * internally consistent, then fetches only that level's fragments.
 */
export async function fetchMeshes(
  source: MeshSource,
  neuronIds: readonly string[],
  options: FetchMeshesOptions = {},
): Promise<FetchMeshesResult> {
  const budget = options.triangleBudget ?? DEFAULT_TRIANGLE_BUDGET
  const concurrency = options.concurrency ?? BUCKET_CONCURRENCY
  /*
   * How a partial reaches the caller, once for both mesh formats.
   *
   * `undefined` when nobody asked, which is what keeps `cachedGeometry` from walking the id list
   * every 250 ms for a caller that would only discard the result — the thumbnail path is the one
   * that never wants this.
   */
  const forwardPartial =
    options.onPartial && ((pairs: ReadonlyArray<[string, MeshBody]>) => options.onPartial?.(named(pairs)))

  if (source.format === 'legacy') {
    let done = 0
    const { ordered, missing } = await cachedGeometry<MeshBody>({
      ids: neuronIds,
      key: (id) => `mesh:${source.base}:legacy:${id}`,
      bytes: (m) => byteLengthOf(m.positions, m.indices),
      refresh: options.refresh,
      onFetched: options.onFetched,
      onPartial: forwardPartial,
      readyBefore: options.readyBefore,
      fetch: async (want, deliver) => {
        await mapWithConcurrency(want, concurrency, async (neuronId) => {
          const mesh = await readLegacyMesh(source.base, BigInt(neuronId), options)
          options.onProgress?.(++done, want.length, 'fragments')
          if (mesh) deliver(neuronId, mesh)
        })
      },
    })
    const meshes = named(ordered)
    return {
      meshes,
      levels: 1,
      triangles: meshes.reduce((n, m) => n + m.indices.length / 3, 0),
      missing,
    }
  }

  const info = source.info!

  /*
   * Manifests first, and cached in their own right.
   *
   * They are one request per body of a few hundred bytes, and — unlike the fragments — they do
   * not depend on the level of detail: a manifest *is* the pyramid. So caching them means the
   * level decision for a changed neuron set costs nothing at all, which is what makes the
   * fragment cache reachable. Without it every re-run paid one round trip per neuron just to
   * work out which level to ask for.
   */
  let read = 0
  const manifests = await cachedGeometry<MultiResManifest>({
    ids: neuronIds,
    key: (id) => `mesh:${source.base}:manifest:${id}`,
    // Small, and the arrays inside are plain numbers rather than typed. The floor keeps an
    // entry from costing nothing in the budget and so never being evicted.
    bytes: (m) => 256 + m.levels.length * 64,
    // `refresh` only, no `onFetched`: the age badge should describe the *geometry*, and a cached
    // manifest beside a freshly fetched mesh would report the result as older than it is.
    refresh: options.refresh,
    fetch: async (want, deliver) => {
      await mapWithConcurrency(want, concurrency, async (neuronId) => {
        const manifest = await readManifest(source.base, BigInt(neuronId), info, options)
        options.onProgress?.(++read, want.length, 'manifests')
        if (manifest) deliver(neuronId, manifest)
      })
    },
  })
  const missing = [...manifests.missing]
  const pyramids = new Map(manifests.ordered)
  const lod = chooseLod([...pyramids.values()], budget)
  const levels = Math.max(1, ...[...pyramids.values()].map((m) => m.levels.length))

  /**
   * The level this body will actually be read at, which is not always `lod`: a shallow pyramid
   * clamps. It is also the half of the cache key that matters — the same id at two levels is two
   * different meshes, and `chooseLod` weighs the whole batch, so adding a neuron can legitimately
   * move it. Keyed per body rather than by the batch's `lod`, so a body whose pyramid clamps
   * keeps its cached mesh even when the batch's choice moves around it.
   */
  const levelOf = (neuronId: string) => Math.min(lod, pyramids.get(neuronId)!.levels.length - 1)

  /*
   * The size refusal is applied *before* the cache is consulted, not inside the fetch.
   *
   * It is a property of the caller rather than of the body — only the thumbnail path sets it —
   * so a mesh cached for a scene must not become visible to a caller that had asked for it to be
   * skipped, and a body skipped for one caller must not be remembered as missing for the next.
   */
  const wanted = manifests.ordered
    .map(([neuronId]) => neuronId)
    .filter((neuronId) => {
      if (options.maxBytesPerBody === undefined) return true
      const totalBytes = pyramids.get(neuronId)!.levels[levelOf(neuronId)]?.totalBytes ?? 0
      if (totalBytes <= options.maxBytesPerBody) return true
      missing.push(neuronId)
      return false
    })

  let done = 0
  const fragments = await cachedGeometry<MeshBody>({
    ids: wanted,
    key: (id) => `mesh:${source.base}:lod${levelOf(id)}:${id}`,
    bytes: (m) => byteLengthOf(m.positions, m.indices),
    refresh: options.refresh,
    onFetched: options.onFetched,
    onPartial: forwardPartial,
    readyBefore: options.readyBefore,
    fetch: async (want, deliver) => {
      await mapWithConcurrency(want, concurrency, async (neuronId) => {
        const manifest = pyramids.get(neuronId)!
        const mesh = await readLodFragments(
          source,
          info,
          manifest,
          neuronId,
          levelOf(neuronId),
          options,
        )
        options.onProgress?.(++done, want.length, 'fragments')
        if (mesh) deliver(neuronId, mesh)
      })
    },
  })
  const meshes = named(fragments.ordered)
  // A body whose manifest read but whose fragments did not is missing too, and only this list
  // knows it — the manifest sweep above could not.
  missing.push(...fragments.missing)
  return {
    meshes,
    lod,
    levels,
    triangles: meshes.reduce((n, m) => n + m.indices.length / 3, 0),
    missing,
  }
}

async function readLodFragments(
  source: MeshSource,
  info: MultiResInfo,
  manifest: MultiResManifest,
  neuronId: string,
  lod: number,
  options: FetchOptions,
): Promise<{ positions: Float32Array; indices: Uint32Array } | undefined> {
  const level = manifest.levels[lod]
  if (!level || level.sizes.length === 0) return undefined
  const url = fragmentsUrl(source.base, BigInt(neuronId), info.sharding)

  // One Range request spanning the whole level, then sliced locally: the fragments are
  // contiguous, and one request for 300 kB beats forty for 8 kB each.
  const start = fragmentOffset(manifest, lod, 0)
  const bytes = await fetchBytes(url, {
    ...options,
    range: [start, start + level.totalBytes - 1],
  })

  const parts: Array<{ positions: Float32Array; indices: Uint32Array }> = []
  let at = 0
  for (let fragment = 0; fragment < level.sizes.length; fragment++) {
    const size = level.sizes[fragment]!
    if (size === 0) continue
    const { scale, offset } = fragmentTransform(info, manifest, lod, fragment)
    parts.push(await decodeDracoFragment(bytes.slice(at, at + size), scale, offset))
    at += size
  }
  return parts.length ? concatMeshes(parts) : undefined
}

export { parseLegacyFragment } from './legacy'
export { chooseLod, parseMultiResManifest } from './multires'
export { locate } from './sharded'
export { proxied, resetTransport, transportModes } from './transport'
