/**
 * Neuron meshes from a graphene segmentation.
 *
 * CAVE's segmentation is `graphene://`, which is not a bucket you can read by id: a root id is
 * a *dynamic* agglomeration of supervoxels, so the fragment list has to be asked for. The
 * server answers a manifest, the fragments themselves sit in an ordinary precomputed bucket,
 * and from there it is `src/data/precomputed`'s job — `decodeDracoFragment` and `concatMeshes`
 * do the rest unchanged.
 *
 * Four things established against the live service rather than assumed, each of which would
 * otherwise be a plausible wrong picture:
 *
 *  - **`verify=True` is not optional.** Without it the manifest answers a single fragment named
 *    after the root id itself, which does not exist in the bucket — the unverified form is a
 *    promise about what *would* be meshed, not a list of files. With it, one FlyWire neuron
 *    comes back as **492 fragments**.
 *  - **The fragments are Draco**, confirmed by their magic bytes, so the decoder Coda already
 *    carries for neuPrint's multi-resolution meshes reads them with no change.
 *  - **They decode straight to nanometres.** Measured on a real fragment: x 474,201–474,810,
 *    which is world space, not a quantized chunk. So none of `multires.ts`'s
 *    `fragmentOffset`/`fragmentTransform` machinery applies here, and nothing needs scaling —
 *    unlike neuPrint, whose skeletons and synapses arrive in dataset voxels.
 *  - **The bucket is CORS-open** (`access-control-allow-origin: *` on storage.googleapis.com),
 *    so this works from a static deploy with no proxy.
 *
 * **What it costs is requests, and there is no level of detail to trade against.** A graphene
 * manifest lists supervoxel fragments at full resolution — 492 requests and ~1.2 MB for one
 * neuron — where neuPrint's multi-resolution meshes answer in a handful at a chosen LOD. That
 * is why `MESH_WARN_NEURONS` is what it is, and why `fetchCoarseGeometry` does not come through
 * here: there is no cheap representation among these fragments to draw a thumbnail from. It
 * draws from the flat pyramid where a materialization has one and from the level-2 chunk graph
 * where it does not — see `CaveSource.fetchCoarseGeometry`. Measured on one neuron: 13.3 s to
 * fetch, and 1,276,736 triangles before decimation.
 */

import { mapWithConcurrency } from '../concurrency'
import { decimateMesh } from '../meshDecimate'
import { concatMeshes } from '../precomputed/legacy'
import type { DecodedMesh } from '../precomputed/draco'
import { decodeDracoFragment } from '../precomputed/draco'
import { fetchBytes, objectStoreUrl } from '../precomputed/transport'
import type { CaveRequestOptions } from './client'
import { caveGet } from './client'
import { parseGrapheneSource } from './graphene'

/**
 * Where a graphene mesh request starts saying how long it will be.
 *
 * Far below the ten thousand the neuron-count controls share, and the gap is the whole point:
 * at 492 requests and ~1.2 MB apiece, a thousand neurons is half a million requests. It is said
 * by the *source* rather than by the node because it is a fact about graphene rather than about
 * the Meshes node — the same node against neuPrint's multi-resolution meshes has nothing to warn
 * about at all.
 *
 * It was `MAX_MESH_NEURONS = 20`, and a refusal. Twenty was never a scientific quantity of
 * neurons; what it protected against was an unbounded fan-out, and `MESH_CONCURRENCY` plus the
 * session geometry cache are what actually do that. So the number survives as the point where
 * the cost is worth a sentence, and the fetch goes ahead — see `core/limits.ts` for why every
 * guard rail in the tree made the same move.
 */
export const MESH_WARN_NEURONS = 20

/**
 * Triangles a decimated mesh comes out at, per grid step.
 *
 * `decimateMesh` clusters to roughly one vertex per occupied cell, so the count follows the
 * grid's square. Measured on one FlyWire neuron, down from 1,276,736 triangles: grid 96 gives
 * 6,308, grid 192 gives 25,548, grid 256 gives 44,091 — all three within 2% of
 * `0.68 * grid²`, which is what makes the inverse below sound rather than a guess.
 */
const TRIANGLES_PER_CELL = 0.68

/** Below this a neuron stops being an arbor and becomes a smear. */
const MIN_DECIMATE_GRID = 48

/**
 * The grid that lands a set of `count` neurons on the caller's triangle budget.
 *
 * This is what `GeometryRequest.triangleBudget` means for a source with **no** levels of detail.
 * The seam says a source with one level ignores it, and that is written for a publisher whose
 * levels are fixed — graphene is the other case: one level, but a continuous knob, so it is the
 * only source in the tree that can hit an arbitrary budget exactly instead of snapping to a
 * published one. Ignoring it would leave the Meshes node's `Detail` control — non-advanced, on
 * the card, reading "Triangle budget for the whole set" — doing nothing at all here.
 *
 * The floor is what stops "low — many neurons" against twenty neurons erasing the arbor; the
 * caption admits the decimation either way.
 */
export function decimateGridFor(triangleBudget: number, count: number): number {
  const perNeuron = Math.max(1, triangleBudget) / Math.max(1, count)
  return Math.max(MIN_DECIMATE_GRID, Math.round(Math.sqrt(perNeuron / TRIANGLES_PER_CELL)))
}

/**
 * How many fragment requests are in flight across the whole run.
 *
 * The work is latency rather than bytes — 492 fragments averaging about 2.4 kB — so this is the
 * number that decides the wait. Measured against the live bucket on **one** neuron: 18.9 s at
 * 12, 13.3 s at 32, 11.3 s at 64. Past 32 the gain is small and it is already a lot of parallel
 * requests at one host.
 *
 * A **shared** budget rather than a per-neuron one, because the per-neuron figure above is what
 * was measured and a fixed 32 apiece times the neurons in flight is not it: three neurons would
 * put 96 requests on `storage.googleapis.com`, at the edge of the 100-stream default many HTTP/2
 * peers use, where anything else on that host (an Explore thumbnail, a neuPrint mesh) tips it
 * into browser-side queueing and the measurement stops describing what happens. Dividing keeps
 * a single-neuron fetch at the 32 that was measured and a full set at the same total.
 *
 * Note the measurements are from Node, where nothing caps connections, so a browser will do no
 * better than this and may do worse.
 */
const FRAGMENT_CONCURRENCY = 32

/** Never so few that one slow neuron starves. */
const MIN_FRAGMENT_CONCURRENCY = 8

/** The per-neuron share of the fragment budget, given how many neurons are in flight. */
export function fragmentConcurrencyFor(neuronsInFlight: number): number {
  return Math.max(
    MIN_FRAGMENT_CONCURRENCY,
    Math.floor(FRAGMENT_CONCURRENCY / Math.max(1, neuronsInFlight)),
  )
}

/**
 * A graphene fragment carries world coordinates, so nothing is applied on decode.
 *
 * Measured on a real FlyWire fragment: x spans 474,201–474,810, which is nanometres in the
 * volume's own frame rather than a 0..2^n quantized chunk. neuPrint's multi-resolution
 * fragments are the other case, which is what `fragmentOffset`/`fragmentTransform` exist for.
 */
const IDENTITY_SCALE = [1, 1, 1] as const
const NO_OFFSET = [0, 0, 0] as const

interface GrapheneManifest {
  fragments: string[]
}

/**
 * Where a datastack's mesh fragments live, read off its segmentation info.
 *
 * `data_dir` is a `gs://` URI and `mesh` is a directory under it. Neither is a URL a browser can
 * fetch, so the bucket is rewritten to `storage.googleapis.com` — the same host the neuPrint
 * mesh buckets are read from, and already CORS-open.
 */
export interface GrapheneMeshSource {
  /** Base URL of the fragment directory, no trailing slash. */
  fragmentBase: string
  /**
   * Where the *unsharded* fragments live, when the segmentation names a separate directory.
   *
   * `mesh_metadata.unsharded_mesh_dir`, and it is load-bearing rather than a detail. A verified
   * manifest mixes two kinds of fragment: the frozen ones, named `~<layer>/<shard>.shard:off:len`
   * and read out of the shard files beside them, and the ones covering *recently edited* parts of
   * the neuron, which are plain objects in this subdirectory. BANC publishes `"dynamic"` and one
   * neuron's manifest was 40 sharded fragments and 21 unsharded; read from the mesh root they all
   * 404, and `mapWithConcurrency` turns each into a dropped fragment — so the neuron arrives
   * looking whole, minus every piece anyone has touched.
   *
   * FlyWire's public segmentation is frozen and its manifests are entirely sharded, which is why
   * this went unnoticed: the datastack the mesh path was built against never exercises it.
   */
  unshardedDir?: string
  /** Where to ask for a root id's fragment list. */
  manifestBase: string
}

interface SegmentationInfo {
  data_dir?: string
  mesh?: string
  mesh_metadata?: { unsharded_mesh_dir?: string }
}

/**
 * Resolve a `graphene://` segmentation source into the two URLs meshes need.
 *
 * The meshing API is keyed by the chunkedgraph *table* rather than by the datastack — see
 * `parseGrapheneSource`, which is where that distinction now lives.
 */
export async function openGrapheneMeshes(
  segmentationSource: string,
  options: CaveRequestOptions = {},
): Promise<GrapheneMeshSource | undefined> {
  const parsed = parseGrapheneSource(segmentationSource)
  if (!parsed) return undefined
  const { server, table, base } = parsed

  const info = await caveGet<SegmentationInfo>(`${base}/info`, options)
  if (!info.data_dir || !info.mesh) return undefined

  // `objectStoreUrl` refuses a scheme it does not know rather than guessing — not every CAVE
  // datastack is on GCS, and a bucket URI mapped onto the wrong host 404s per fragment, which
  // reads as a neuron with no mesh.
  const bucket = objectStoreUrl(info.data_dir)
  if (!bucket) return undefined

  const unsharded = info.mesh_metadata?.unsharded_mesh_dir?.replace(/^\/+|\/+$/g, '')
  return {
    fragmentBase: `${bucket}/${info.mesh.replace(/\/+$/, '')}`,
    ...(unsharded ? { unshardedDir: unsharded } : {}),
    manifestBase: `${server}/meshing/api/v1/table/${table}/manifest`,
  }
}

/**
 * Where one named fragment actually is.
 *
 * The name says which of the two it is: a sharded fragment carries `.shard:<offset>:<length>`
 * and sits under the mesh directory, and anything else is an unsharded object under
 * `unsharded_mesh_dir`. Matched on `.shard:` rather than on the leading `~<layer>/`, because the
 * layer prefix is part of the *path* to the shard file and would still be there if the naming
 * changed; the byte range is what makes it a shard read.
 */
function fragmentUrl(source: GrapheneMeshSource, name: string): string {
  const base =
    source.unshardedDir && !name.includes('.shard:')
      ? `${source.fragmentBase}/${source.unshardedDir}`
      : source.fragmentBase
  return `${base}/${name}`
}

/**
 * One neuron's mesh, or undefined where the segment has none.
 *
 * Undefined rather than an error for the reason `readLegacyMesh` answers the same way: an
 * unproofread or merged-away segment having no mesh is normal, and failing the whole request
 * over one of them would make a set of twenty as fragile as its worst member.
 */
export async function readGrapheneMesh(
  source: GrapheneMeshSource,
  neuronId: string,
  grid: number,
  fragmentLimit: number,
  options: CaveRequestOptions = {},
): Promise<DecodedMesh | undefined> {
  /*
   * A manifest failure is *not* swallowed, which is the opposite of `readLegacyMesh`'s call and
   * deliberately so. That one reads a static bucket, where a 404 genuinely means "this body has
   * no mesh"; this calls an API whose 404 means the table name is wrong — the trap named at the
   * top of this file. Letting it throw is what lets `mapWithConcurrency` do its job: one bad
   * neuron still becomes `undefined` and loses none of the others, but a systematically broken
   * call fails *every* neuron and gets rethrown, instead of handing back an empty scene under a
   * green node.
   */
  const manifest = await caveGet<GrapheneManifest>(
    `${source.manifestBase}/${neuronId}:0?verify=True`,
    options,
  )
  const fragments = manifest.fragments ?? []
  if (fragments.length === 0) return undefined

  const parts = await mapWithConcurrency(fragments, fragmentLimit, async (name) => {
    const bytes = await fetchBytes(
      fragmentUrl(source, name),
      options.signal ? { signal: options.signal } : {},
    )
    // Identity scale and offset: a graphene fragment decodes to world nanometres already, so
    // the chunk transform `multires.ts` computes for neuPrint has no counterpart here.
    return decodeDracoFragment(bytes, IDENTITY_SCALE, NO_OFFSET)
  })

  // A fragment that failed comes back undefined rather than taking the neuron with it —
  // `mapWithConcurrency`'s rule, and the right one here: a mesh short one supervoxel of 492 is
  // a mesh, where a thrown request is a neuron missing from the scene with nothing saying why.
  // Only the partial-failure case survives this: `mapWithConcurrency` has already thrown if
  // every fragment failed, and an empty fragment list returned above.
  const decoded = parts.filter((p): p is DecodedMesh => p !== undefined)

  /*
   * Decimated on arrival, and this is not optional at graphene's resolution: one FlyWire neuron
   * concatenates to 668,750 vertices and 1,276,736 triangles, so a set of twenty at full detail
   * is twenty-five million triangles in a WebGL scene that also has to draw synapses. The same
   * call the ROI shells make, at the same grid — a *feature size* rather than a vertex target,
   * so a small neuron keeps proportionally as much shape as a large one, and a mesh already
   * below the target is returned untouched.
   *
   * It reduces memory and draw cost, not the wait: the 492 requests are already paid by here.
   */
  const joined = concatMeshes(decoded)
  return decimateMesh(joined.positions, joined.indices, grid)
}
