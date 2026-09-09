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
import type { RawMesh } from './legacy'
import type { MultiResInfo, MultiResManifest } from './multires'
import {
  chooseLod,
  fragmentOffset,
  fragmentTransform,
  readManifest,
  readMultiResInfo,
  fragmentsUrl,
} from './multires'
import type { FetchOptions, Oversize } from './transport'
import { OVERSIZE, PrecomputedFetchError, fetchBytes, fetchInfo } from './transport'
import { mapWithConcurrency } from '../concurrency'
import type { GeometryDetail } from '../source'
import { byteLengthOf, cachedGeometry } from '../geometryCache'

/**
 * How a mesh store addresses a body.
 *
 * `dvid-ngmesh` is not a precomputed format and is here anyway, because the *difference* between
 * it and `legacy` is one line — where a body's bytes live — while everything around that line
 * (per-body concurrency, the geometry cache, partial delivery, progress, `missing`) is the same
 * machinery and was not worth a second copy. `data/dvid/meshes.ts` owns the format itself; what
 * this name buys is the fetch loop below. See `fetchMeshes`.
 */
export type MeshFormat = 'multilod-draco' | 'legacy' | 'dvid-ngmesh'

/**
 * How one body's geometry is read out of a flat mesh store.
 *
 * A port rather than a `switch` in `fetchMeshes`, and the direction is the point: `data/dvid`
 * knows about precomputed, and precomputed must not know about DVID. A `switch` would have put
 * a `data/dvid` import in this file and stood the layering on its head for one line.
 *
 * **It takes the whole source, not `source.base`.** Handing the reader one field back off the
 * object it is already attached to fits DVID's meshes, which need only the URL, and stops fitting
 * immediately after: a DVID *skeleton* store carries a voxel scale as well, and a credential is a
 * third thing a reader will have to reach. Passing the source is what lets the same signature be
 * the skeleton port too, instead of the mirror hitting that wall on its first call site.
 *
 * `options` is plain `FetchOptions` — `maxBytes` lives there now, so an intersection restating it
 * would be two spellings of one field.
 *
 * A module-level function, never a closure — `MeshSource` is held for the life of a dataset in
 * `NeuPrintSource`'s state, and a reader capturing a scope would pin whatever that scope held.
 * Taking the source keeps it stateless as well as module-level; the two are not in tension.
 */
export type MeshBodyReader = (
  source: MeshSource,
  neuronId: string,
  options: FetchOptions,
) => Promise<RawMesh | Oversize | undefined>

export interface MeshSource {
  /** Absolute URL of the mesh directory. */
  base: string
  format: MeshFormat
  /** Only for multi-resolution sources. */
  info?: MultiResInfo
  /** Number of detail levels available; 1 for legacy sources. */
  levels: number
  /**
   * How to read one body, for a flat store that is not precomputed's own.
   *
   * Absent means `neuroglancer_legacy_mesh`, which this module reads itself. Set by
   * `openDvidMeshSource`; see `MeshBodyReader`.
   */
  readBody?: MeshBodyReader
}

/**
 * The reader for precomputed's own flat format: a JSON manifest, then its fragments.
 *
 * It **drops `maxBytes`**, and does so explicitly rather than by not looking: the option now
 * reaches every reader, and forwarding it here would silently give a path that has never had a
 * ceiling one that bites per *fragment* — a body abandoned halfway having already spent most of
 * itself. That is a behaviour change rather than a refactor and no caller asks for it. The DVID
 * reader honours it because a DVID body is one key and can be 107 MB.
 */
const readLegacyBody: MeshBodyReader = (source, neuronId, { maxBytes: _maxBytes, ...rest }) =>
  readLegacyMesh(source.base, BigInt(neuronId), rest)

interface RawInfo {
  '@type'?: string
  sharding?: unknown
}

/**
 * The fields of an `info` that say what kind of directory it describes.
 *
 * Its own type rather than each reader's `RawInfo`, because `probe.ts` asks the same question
 * about the same document and the two answers must not be able to differ — a URL the card calls
 * a mesh directory and the fetch calls a volume is one bug wearing two faces.
 */
export interface InfoKind {
  '@type'?: string | undefined
  type?: string | undefined
  mesh?: string | undefined
  skeletons?: string | undefined
  scales?: unknown
}

/**
 * Whether an `info` describes a multiscale volume rather than a directory of geometry.
 *
 * **`@type` is optional on a volume, and the older publishers omit it.** That was read as "no
 * `@type` means a legacy mesh directory", which is right for a mesh directory and wrong for
 * every flat segmentation published before the field was conventional — `gs://flywire_v141_m783`
 * says `"type": "segmentation"`, `"mesh": "mesh_mip_1_err_40"`, `"skeletons":
 * "skeletons_mip_1"`, eight `scales`, and no `@type` at all. Read as a mesh directory it opened
 * as `legacy` at the bucket root, where the manifests are not; every request 404s, and because
 * a missing mesh is an ordinary answer the whole thing came back as "this neuron has no mesh".
 * Two multi-resolution mesh sets and a skeleton set were unreachable behind that.
 *
 * So the volume markers decide it instead: `scales`, or a named `mesh`/`skeletons` subdirectory.
 * A mesh or skeleton directory's `info` carries none of the three — it describes one thing and
 * has nowhere to point — which is what makes the test a discrimination rather than a heuristic.
 */
export function isVolumeInfo(info: InfoKind): boolean {
  if (info['@type'] !== undefined) return info['@type'] === 'neuroglancer_multiscale_volume'
  return info.scales !== undefined || info.mesh !== undefined || info.skeletons !== undefined
}

/**
 * Resolve a segmentation or mesh URL into a usable mesh source.
 *
 * A segmentation `info` names its mesh subdirectory, so a caller can pass either the volume or
 * the mesh directory and get the same answer.
 *
 * Paired with `openMeshDir`, and the split is the difference between *what is this URL* and
 * *open this mesh directory*. Only this one has to decide, so only this one reads an `info`
 * strictly: a URL with nothing at it is a URL nobody can use, and saying so beats resolving to
 * an empty legacy directory whose every fetch then reports a missing neuron.
 */
export async function openMeshSource(
  url: string,
  options: FetchOptions = {},
): Promise<MeshSource> {
  const base = url.replace(/\/+$/, '')
  const info = await fetchInfo<RawInfo & InfoKind>(base, options)
  if (!isVolumeInfo(info)) return openMeshDir(base, options)
  if (!info.mesh) throw new Error(`${base} is a volume with no mesh subdirectory`)
  return openMeshDir(`${base}/${info.mesh}`, options)
}

/**
 * Open a directory already known to hold meshes.
 *
 * **A missing `info` is legacy here, and is not an error.** That is the rule for a directory a
 * volume *named*: `gs://lee-lab_brain-and-nerve-cord-fly-connectome/neuron_meshes` names
 * `meshes`, and `meshes/info` does not exist — which is ordinary, since a legacy mesh directory
 * has nothing to declare. Only a 404 is forgiven, not any failure: a CORS refusal or an
 * unreachable host read as "legacy" would turn one blip into a directory whose every manifest
 * request 404s, reported per neuron as a missing mesh.
 */
export async function openMeshDir(
  url: string,
  options: FetchOptions = {},
): Promise<MeshSource> {
  const base = url.replace(/\/+$/, '')
  const info = await fetchInfo<RawInfo>(base, options).catch((error: unknown) => {
    if (error instanceof PrecomputedFetchError && error.status === 404) return {} as RawInfo
    throw error
  })
  if (info['@type'] === 'neuroglancer_multilod_draco') {
    // Unsharded is supported now — hemibrain's ROI meshes are built that way; see `readManifest`.
    const multi = await readMultiResInfo(base, options)
    return { base, format: 'multilod-draco', info: multi, levels: 0 }
  }
  // 'neuroglancer_legacy_mesh', an info with no @type, or no info at all.
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
  /**
   * The subset of `missing` that the caller's own `maxBytesPerBody` turned down.
   *
   * A subset rather than a separate list, so anything counting absences keeps counting all of
   * them and nothing has to remember to add two numbers. Empty unless a ceiling was set, which
   * only the thumbnail path does — and that path asks about **one** body, which is why this is a
   * plain list in whatever order the refusals arrived: it exists so `fetchCoarseMesh` can tell a
   * refusal from an absence, not so anybody can read it against a page.
   */
  oversize: string[]
}

/** Default budget. ~1.5M triangles renders comfortably and holds a few dozen neurons coarse. */
export const DEFAULT_TRIANGLE_BUDGET = 1_500_000

/**
 * Byte ceiling for a single thumbnail's mesh, compressed.
 *
 * A guard rail against a broken body, not a quality filter. It sits above the largest coarsest
 * level measured in any dataset here — 508 kB on hemibrain, 169 kB on male-CNS — so in practice
 * every neuron gets a thumbnail and this only fires for something pathological.
 *
 * The line is drawn where it is because 2 MB is what an *entire* hemibrain neuron costs at full
 * resolution (its pyramid runs 2 MB / 280 kB / 48 kB / 11 kB). A body whose **coarsest** level
 * is that big is not a neuron that happens to be large, it is an unsplit segmentation blob, and
 * a placeholder is the right answer for it.
 *
 * Here rather than beside one backend, because two now draw thumbnails from a precomputed
 * pyramid — neuPrint's published buckets and the flat segmentations CAVE's datastacks have
 * beside them — and it is a property of `maxBytesPerBody` either way. FlyWire's flat coarsest
 * level runs 73 kB to 1.44 MB across a sample of eight, so this admits all of them.
 *
 * It was 128 kB, chosen above p90 to keep a page of 25 rows cheap. That bought a few hundred
 * kilobytes per page at the cost of blanking the most interesting neurons in the dataset —
 * giant fibres and big tracts are exactly the bodies with the heaviest coarse mesh. The median
 * is 264 bytes (hemibrain) and 7.3 kB (male-CNS), so the typical page is unchanged by this;
 * only the tail is, and the tail is the part worth looking at.
 */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024

/**
 * The same guard rail for a store with **no pyramid**, where it is a different question.
 *
 * The 2 MB above is an argument about a *level*: a whole hemibrain neuron at full resolution
 * costs that, so a body whose **coarsest of four levels** is 2 MB is an unsplit blob rather than
 * a large neuron. A flat store has no levels — DVID's `.ngmesh` is the only mesh there is — so
 * the same number is being asked to separate a big neuron at full resolution from a blob at full
 * resolution, and 2 MB is hemibrain's answer to a question about somebody else's dataset. It
 * blanked one Explore row in twelve on `neuprint-fish2`, a whole-brain larval zebrafish
 * segmentation, and the neurons it blanked were the big ones.
 *
 * **12 MB, measured on fish2 rather than chosen**: its real arbors stop at 8.31 MB and it holds
 * bodies four times denser than their own volume explains, which is what an unsplit merge looks
 * like. The ceiling sits between them. [docs/backends.md](../../../docs/backends.md) has the
 * distributions and `neuprint.test.ts`'s `FISH2_NGMESH_BYTES` is where they are machine-checked —
 * one place to re-measure rather than three prose copies that drift apart.
 *
 * **On a flat store a refusal costs the ceiling, where on a pyramid it costs nothing.** DVID sends
 * no `Content-Length`, so `readCapped` streams and cancels: a body this turns down is downloaded
 * up to 12 MB and thrown away, against 2 MB before. Once per session — the verdict is held in
 * memory, though deliberately not persisted — and the alternative was measured and does not exist:
 * `HEAD` carries no length and `Range` is ignored. Worth knowing when reading the number, not a
 * reason to lower it: the bodies that pay it are the ones nobody can draw anyway.
 */
export const THUMBNAIL_MAX_FLAT_BYTES = 12 * 1024 * 1024

/**
 * Which of the two a source is judged by.
 *
 * A function rather than two call sites choosing, because the choice *is* the distinction the
 * pair exists to draw and one caller getting it wrong is a silent blank tile. `multilod-draco`
 * is the only format with levels to trade; both flat ones are read whole.
 *
 * **Exhaustive rather than `format === 'multilod-draco' ? … : …`**, and the direction a default
 * would fall is why. `MeshFormat` has three members today; a fourth — a second pyramid spelling,
 * a sharded multi-LOD variant — would land in the *permissive* arm of a ternary and quietly get
 * six times the level ceiling, which is not a blank tile but 12 MB a row, admitting exactly the
 * unsplit blobs `THUMBNAIL_MAX_BYTES` exists to refuse. Written this way it is a compile error,
 * which is the rule `CoarseRefusal.kind` follows one file over.
 */
export function thumbnailCeiling(source: MeshSource): number {
  switch (source.format) {
    case 'multilod-draco':
      return THUMBNAIL_MAX_BYTES
    case 'legacy':
    case 'dvid-ngmesh':
      return THUMBNAIL_MAX_FLAT_BYTES
    default: {
      const unreachable: never = source.format
      throw new Error(`no thumbnail ceiling declared for ${String(unreachable)}`)
    }
  }
}

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
    options.onPartial &&
    ((pairs: ReadonlyArray<[string, MeshBody]>) => options.onPartial?.(named(pairs)))

  /*
   * The two flat formats share this loop, because they differ only in how one body is addressed:
   * a precomputed legacy body is a JSON manifest naming fragment files, a DVID body is a single
   * `<id>.ngmesh` key. Everything else here — the cache, the concurrency, the partials, the
   * `missing` accounting — is about there being no pyramid, which is true of both.
   *
   * `maxBytesPerBody` reaches the DVID reader and not the legacy one, and that asymmetry is the
   * honest one: it is enforced *after* the download here, since DVID publishes no size to
   * refuse on, where the multi-resolution branch below refuses from a manifest for free. A DVID
   * body can be 107 MB (`data/dvid/meshes.ts` has the measurement), so a caller that set a
   * ceiling wants it applied even at the cost of the transfer.
   */
  if (source.format === 'legacy' || source.format === 'dvid-ngmesh') {
    const readBody = source.readBody ?? readLegacyBody
    /** Bodies this call's ceiling turned down, as opposed to bodies the store does not have. */
    const refused: string[] = []
    let done = 0
    const { ordered, missing } = await cachedGeometry<MeshBody>({
      ids: neuronIds,
      key: (id) => `mesh:${source.base}:${source.format}:${id}`,
      bytes: (m) => byteLengthOf(m.positions, m.indices),
      refresh: options.refresh,
      onFetched: options.onFetched,
      onPartial: forwardPartial,
      readyBefore: options.readyBefore,
      // Built once rather than per body: it does not depend on the neuron.
      fetch: async (want, deliver) => {
        const readOptions: FetchOptions = { ...options, maxBytes: options.maxBytesPerBody }
        await mapWithConcurrency(want, concurrency, async (neuronId) => {
          const mesh = await readBody(source, neuronId, readOptions)
          options.onProgress?.(++done, want.length, 'fragments')
          if (mesh === OVERSIZE) refused.push(neuronId)
          else if (mesh) deliver(neuronId, mesh)
        })
      },
    })
    const meshes = named(ordered)
    return {
      meshes,
      levels: 1,
      triangles: meshes.reduce((n, m) => n + m.indices.length / 3, 0),
      missing,
      oversize: [...refused],
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

  const { wanted, refused } = withinCeiling(
    manifests.ordered.map(([neuronId]) => neuronId),
    (neuronId) => pyramids.get(neuronId)!.levels[levelOf(neuronId)]?.totalBytes ?? 0,
    options.maxBytesPerBody,
  )
  missing.push(...refused)

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
    oversize: refused,
  }
}

/**
 * Which bodies a byte ceiling admits, and which it turned down.
 *
 * Extracted from the multi-resolution branch for one reason: inline it had **no offline test at
 * all** — reaching it means getting a whole sharded manifest sweep past a stubbed transport — so
 * a mutation that stopped recording a refusal passed the entire suite. It is pure arithmetic over
 * numbers the caller already has, which is the shape a test can ask about directly.
 *
 * Two rules it carries, both from the code it replaced. The refusal is applied **before the cache
 * is consulted** rather than inside the fetch, because a ceiling is a property of the *caller* —
 * only the thumbnail path sets one — so a mesh cached for a scene must not become visible to a
 * caller that asked for it to be skipped, and a body skipped for one caller must not be
 * remembered as missing for the next. And `refused` is the *reason* half of `missing`: every id
 * here also belongs in that list, which is why the caller appends rather than choosing.
 */
export function withinCeiling(
  ids: readonly string[],
  bytesOf: (neuronId: string) => number,
  maxBytesPerBody: number | undefined,
): { wanted: string[]; refused: string[] } {
  if (maxBytesPerBody === undefined) return { wanted: [...ids], refused: [] }
  const wanted: string[] = []
  const refused: string[] = []
  for (const neuronId of ids) {
    if (bytesOf(neuronId) <= maxBytesPerBody) wanted.push(neuronId)
    else refused.push(neuronId)
  }
  return { wanted, refused }
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

/**
 * Triangle budget behind `CoarseGeometryRequest.detail = 'fine'`.
 *
 * Named for what the data layer knows — a detail level — rather than for Explore's hover preview,
 * which is one caller and not this module's business.
 *
 * `chooseLod` walks from the finest level down and returns the first that fits, so this is the
 * whole of what makes a hover preview show more than its tile did — the coarsest level is what a
 * budget of 1 asks for, and there is no other knob.
 *
 * 150,000 triangles is a ~255 kB allowance at `DRACO_BYTES_PER_TRIANGLE`. On hemibrain's real
 * pyramid (2.0 MB / 280 kB / 48 kB / 11 kB) that is **one step**: it clears LOD 2 and stops short
 * of LOD 1, which is the number doing the work rather than an accident. 48 kB against 11 kB is
 * about 28k triangles, more than a 320 CSS-pixel picture can show; LOD 1 would be a quarter of a
 * megabyte per hover for a difference nothing on screen could resolve. The point is a bigger
 * *picture*, not the mesh a 3D scene would draw.
 *
 * Under `THUMBNAIL_MAX_BYTES` by a factor of eight, so the per-body ceiling still governs the
 * pathological bodies and this only decides which level is asked for first.
 */
export const FINE_TRIANGLE_BUDGET = 150_000

/**
 * The coarsest level of one body, for a thumbnail — or nothing cheap enough to draw.
 *
 * Every caller of this is a list of rows, so the two refusals matter more than the success. A
 * source with no pyramid answers `undefined` rather than its only level: `DataSource
 * .fetchCoarseGeometry` promises a browsable list ~10 kB a row, and a legacy directory would
 * hand back several megabytes each. And `thumbnailCeiling` turns down a single pathological
 * body — off the manifest where there is one, so the refusal costs no download.
 *
 * **A refusal is `OVERSIZE` and an absence is `undefined`**, which every layer below this folded
 * into one until a tile needed to say which. See `readKey`.
 *
 * Shared because it was written twice: neuPrint reads a published bucket and CAVE reads the flat
 * segmentation beside a datastack, and both want exactly this call. A triangle budget of one
 * cannot be met by any level, and `chooseLod` answers that with the coarsest — which is the
 * level wanted here, so the budget is a way of asking rather than a limit.
 */
export async function fetchCoarseMesh(
  source: MeshSource,
  neuronId: string,
  options: FetchOptions = {},
  detail: GeometryDetail = 'coarsest',
): Promise<MeshBody | Oversize | undefined> {
  /*
   * `legacy` is still refused and `dvid-ngmesh` is not, which is not an inconsistency: the
   * question is whether the *download* can be bounded, not whether the format has levels.
   *
   * Neither has a pyramid, so neither can answer with a cheaper version — but a DVID body is a
   * single key read through `FetchOptions.maxBytes`, which abandons the transfer past the
   * ceiling, so the worst case is `THUMBNAIL_MAX_BYTES` and a placeholder. A `legacy` body is a
   * manifest plus N fragments assembled into one mesh, where a ceiling can only be applied per
   * fragment and a body abandoned halfway has already spent most of itself; that path keeps its
   * refusal until somebody wants it enough to bound the whole assembly.
   *
   * Worth having rather than theoretical: mushroombody's meshes are a median of 16 kB and a p90
   * of 92 kB over 40 sampled bodies, so a page of 25 is about 0.4 MB — less than hemibrain's
   * coarsest precomputed level costs. See `data/dvid/meshes.ts`.
   */
  if (source.format === 'legacy') return undefined
  const result = await fetchMeshes(source, [neuronId], {
    ...options,
    // A budget of one cannot be met by any level, which is how `chooseLod` is asked for the
    // coarsest. Raising it is the only way to ask for a finer one, and the only reason to.
    triangleBudget: detail === 'fine' ? FINE_TRIANGLE_BUDGET : 1,
    concurrency: 1,
    maxBytesPerBody: thumbnailCeiling(source),
  })
  if (result.oversize.length > 0) return OVERSIZE
  const mesh = result.meshes[0]
  // Untagged, and the caller adds `kind`. This module's own header promises it knows nothing
  // about any particular source, and importing `CoarseGeometry` to stamp one word would spend
  // that for no safety: `kind` is a *required* discriminant, so a `fetchCoarseGeometry` handing
  // this straight back is a compile error rather than a silent fall-through to the mesh branch.
  return mesh ? { positions: mesh.positions, indices: mesh.indices } : undefined
}

export { parseLegacyFragment } from './legacy'
export { chooseLod, parseMultiResManifest } from './multires'
export { locate } from './sharded'
export { proxied, resetTransport, transportModes } from './transport'
