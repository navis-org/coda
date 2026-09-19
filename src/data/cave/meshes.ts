/**
 * Neuron meshes from a graphene segmentation.
 *
 * CAVE's segmentation is `graphene://`, which is not a bucket you can read by id: a root id is
 * a *dynamic* agglomeration of supervoxels, so the fragment list has to be asked for. The
 * server answers a manifest, the fragments themselves sit in an ordinary precomputed bucket,
 * and from there it is `decodeDracoFragment` and `decimateParts`' job — the fragments are never
 * joined, which `src/data/meshDecimate.ts` argues.
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
 * manifest lists supervoxel fragments at full resolution, where neuPrint's multi-resolution
 * meshes answer in a handful at a chosen LOD. Measured over sets of 25 neurons, which is the
 * measurement `CaveSource.grapheneMeshes` states its cost from and the one to re-take rather than
 * extrapolate — **a lone neuron does not predict a set, and the neurons that get measured on
 * their own are the ones somebody had open, which are the big ones**:
 *
 *   FlyWire   132 fragments/neuron (median), 1.59 s, 0.51 MB — unsharded
 *   BANC       10                          , 0.39 s, 0.46 MB — sharded
 *   mosquito   51                          , 1.29 s, 3.92 MB — sharded
 *
 * The spread within one datastack is wider than the spread between them: mosquito's 25 ran from
 * 4 fragments to 608. That is why `MESH_WARN_SECONDS` is stated as a wait rather than a count of
 * neurons, and why the sentence it raises says the spread out loud.
 *
 * It is also why `fetchCoarseGeometry` does not come through here: there is no cheap
 * representation among these fragments to draw a thumbnail from. It draws from the flat pyramid
 * where a materialization has one and from the level-2 chunk graph where it does not — see
 * `CaveSource.fetchCoarseGeometry`.
 */

import { mapWithConcurrency } from '../concurrency'
import type { Reduction } from '../meshDecimate'
import { applyReduction } from '../meshDecimate'
import type { MeshArrays } from '../meshParts'
import { decodeDracoFragment } from '../precomputed/draco'
import { fetchBytes, objectStoreUrl } from '../precomputed/transport'
import type { CaveRequestOptions } from './client'
import { caveGet } from './client'
import { parseGrapheneSource } from './graphene'

/**
 * What a graphene mesh costs, per neuron, over a **set**.
 *
 * The three figures the file header measures, taken at their slow end: 1.59 s a neuron on FlyWire,
 * 3.92 MB on mosquito, 0.46 MB at the bottom. Rounded out rather than averaged, because the point
 * of quoting them is a wait somebody is about to sit through.
 *
 * They are exported as constants rather than written into the sentence because the *threshold* is
 * derived from them — see `MESH_WARN_SECONDS`. A message that says five minutes, raised by a
 * condition that means something else, is two numbers to keep in step and eventually one bug.
 */
export const SECONDS_PER_NEURON = 2
export const MB_PER_NEURON = { low: 0.5, high: 4 } as const

/**
 * How long a fetch has to threaten before it says so: **five minutes**.
 *
 * A wait rather than a neuron count, which is the whole of this control. It was 20 neurons, and
 * 20 was inherited from a refusal where it had protected against an unbounded fan-out — a job
 * `MESH_CONCURRENCY` and the session geometry cache actually do. As a *warning* threshold it was
 * answering the wrong question: twenty graphene meshes is half a minute, and a sentence about
 * cancelling in front of half a minute is a sentence that teaches people to dismiss the next one.
 *
 * Expressed here, the number is arguable on its own terms — five minutes is about where a wait
 * stops being something you sit through — where "20 neurons" could only be argued about by
 * somebody who already knew what a neuron costs.
 */
export const MESH_WARN_SECONDS = 300

/**
 * The neuron count that reaches `MESH_WARN_SECONDS`, which is what the fetch actually tests.
 *
 * **Derived, so the threshold and the sentence cannot disagree**: the warning fires exactly when
 * the duration it is about to print exceeds five minutes. Re-measuring `SECONDS_PER_NEURON` moves
 * both at once, which is the property that was missing when the estimate drifted by 10× and the
 * threshold did not notice.
 *
 * It is said by the *source* rather than by the node because it is a fact about graphene rather
 * than about the Meshes node — the same node against neuPrint's multi-resolution meshes has
 * nothing to warn about at all.
 */
export const MESH_WARN_NEURONS = Math.ceil(MESH_WARN_SECONDS / SECONDS_PER_NEURON)

/**
 * How many fragment requests are in flight across the whole run.
 *
 * The work is latency rather than bytes — a fragment averages 3-4 kB on FlyWire and BANC — so
 * this is the number that decides the wait. Measured against the live bucket on **one** neuron,
 * which is the right shape of fixture for this one question because it isolates the fan-out:
 * 18.9 s at 12, 13.3 s at 32, 11.3 s at 64. Past 32 the gain is small and it is already a lot of
 * parallel requests at one host.
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
   * `mesh_metadata.unsharded_mesh_dir`, holding the fragments that cover *recently edited* parts
   * of a neuron — `"dynamic"` on both mosquito and BANC. `fragmentLocation` is where the split
   * between these and the frozen ones is stated; read from the mesh root instead, every one 404s
   * and the neuron arrives looking whole minus every piece anyone has touched.
   *
   * Its **absence** is load-bearing too: a segmentation naming one is a segmentation with a
   * frozen half, which is what `grapheneMeshes` reads it as when it says what a fetch will cost.
   * FlyWire's public segmentation names none and its manifests are entirely plain objects — 136
   * for one neuron, no `~` name among them — which is why the datastack this path was built
   * against exercises neither branch.
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
  options: CaveRequestOptions,
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
 * Where the **frozen** shard files sit, under the mesh directory.
 *
 * A constant rather than something read off the segmentation `info`, because it is not published
 * there: cloudvolume's `GrapheneMeshMetadata.sharded_mesh_dir` is the literal `"initial"`, beside
 * `unsharded_mesh_dir` which *is* published. Checked against the bucket — `graphene_meshes/`
 * holds exactly `initial/` and `dynamic/` on mosquito, with the shard files under
 * `initial/<layer>/`.
 */
const SHARDED_MESH_DIR = 'initial'

/**
 * A sharded fragment name: `~<layer>/<shard file>:<byte offset>:<length>`.
 *
 * cloudvolume's own (`datasource/graphene/mesh/sharded.py`), character for character, because
 * this is the only written-down statement of the grammar — the meshing API documents none.
 */
const SHARDED_FRAGMENT = /^~(\d+)\/([\d-]+\.shard):(\d+):(\d+)$/

/** A fetchable address for one fragment: a shard read carries the byte range it needs. */
interface FragmentLocation {
  url: string
  range?: readonly [number, number]
}

/**
 * Where one named fragment actually is.
 *
 * **The leading `~` is a marker, not a path**, and that is the whole of what this gets right.
 * A verified manifest mixes two kinds of name:
 *
 *  - `~3/127630-0.shard:10686716:600` — frozen, and every part of it is an instruction:
 *    layer `3`, shard file `127630-0.shard` under `initial/3/`, and 600 bytes from offset
 *    10,686,716. It is **not** an object path. Left as written it asks the bucket for an object
 *    literally called `~3/127630-0.shard:10686716:600`, which is a 404 — and asks for the whole
 *    of it, since the range never became a `Range` header.
 *  - `396932493720355753:0:32768-36864_…` — recently edited, a plain object under
 *    `unsharded_mesh_dir`.
 *
 * The previous rule discriminated on `.shard:` and kept the name verbatim under the mesh root,
 * reasoning that `~<layer>/` was part of the path. It is not, and the symptom is the one this
 * whole file is arranged to avoid: `mapWithConcurrency` turns each 404 into a dropped fragment,
 * so on mosquito 449 of 471 fragments vanished and the neuron arrived as the 22 pieces somebody
 * had edited — a mesh, drawn in the right place, that is a twentieth of the neuron.
 *
 * Undefined for a name that parses as neither, which `readGrapheneMesh` counts and reports
 * rather than guessing a URL for.
 */
function fragmentLocation(
  source: GrapheneMeshSource,
  name: string,
): FragmentLocation | undefined {
  const sharded = SHARDED_FRAGMENT.exec(name)
  if (sharded) {
    const [, layer, file, offset, length] = sharded
    const start = Number(offset)
    return {
      url: `${source.fragmentBase}/${SHARDED_MESH_DIR}/${layer}/${file}`,
      range: [start, start + Number(length) - 1],
    }
  }
  // A `~` name that did not parse is a shard read this build cannot address; guessing an object
  // path for it is how the bug above happened.
  if (name.startsWith('~')) return undefined
  const base = source.unshardedDir
    ? `${source.fragmentBase}/${source.unshardedDir}`
    : source.fragmentBase
  return { url: `${base}/${name}` }
}

/**
 * How much of a neuron actually arrived.
 *
 * **This is the only fan-out in the tree below the item level**, and that is what makes a count
 * here necessary rather than duplicated. Everywhere else `mapWithConcurrency` runs over neurons,
 * so a dropped one is an id absent from `cachedGeometry`'s `missing` — a list, which is strictly
 * better than a count and which two sources already turn into a sentence. Fragments are *parts of
 * one neuron*, so nothing above this function can see them go: a mesh short one supervoxel of 471
 * is a mesh, a mesh short 449 is a picture of somebody's recent edits, and both decode, both sit
 * where the neuron is, and both decimate to an ordinary triangle count.
 *
 * `unaddressable` is split out of `missing` because the **remedy differs and only one of them is
 * a retry**: a fragment that 404'd may well arrive next time, where a name this build cannot
 * parse will parse the same way forever — it is a bug in Coda, and telling somebody to try again
 * is telling them to do the one thing that cannot work.
 */
export interface FragmentTally {
  /** Fragments the manifest named. */
  named: number
  /** Named fragments whose geometry is not in the result, `unaddressable` included. */
  missing: number
  /** Of `missing`, those whose name this build could not turn into a request at all. */
  unaddressable: number
}

/** A segment the manifest names no fragments for — not a partial answer, an absent one. */
export const NO_FRAGMENTS: FragmentTally = { named: 0, missing: 0, unaddressable: 0 }

/** One neuron's mesh and the accounting that says how much of it this is. */
export interface GrapheneMesh {
  /** Undefined where the segment has no mesh at all. */
  mesh?: MeshArrays
  tally: FragmentTally
  /**
   * Triangles the fragments held before any reduction.
   *
   * Cached beside the mesh rather than recomputed, because it is the denominator the caption's
   * factor is a ratio of — and on a second Run nothing is fetched, so a count taken during the
   * fetch would be gone exactly when the same reduced meshes are still on screen.
   */
  fullTriangles: number
}

/**
 * The fragment names a verified manifest lists for one root id.
 *
 * Exported because `verify=True` is load-bearing (see the top of this file) and a second caller
 * spelling the URL out is a second place for that to be forgotten — the live test asks the same
 * question to decide which neuron is worth asserting about.
 */
export async function grapheneFragmentNames(
  source: GrapheneMeshSource,
  neuronId: string,
  options: CaveRequestOptions,
): Promise<string[]> {
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
  return manifest.fragments ?? []
}

/**
 * One neuron's mesh, with the accounting that says how much of it arrived.
 *
 * An absent mesh rather than an error for the reason `readLegacyMesh` answers the same way: an
 * unproofread or merged-away segment having no mesh is normal, and failing the whole request
 * over one of them would make a set of twenty as fragile as its worst member.
 *
 * Returned rather than reported through a callback, which is the shape every sibling here
 * already has — `fetchSkeletons` answers `{ skeletons, missing }`, `cachedGeometry` answers
 * `{ ordered, missing }`. It also closes the hole an out-param leaves: a tally fired just before
 * the return says nothing on the two early exits, which are the cases where the *most* is
 * missing.
 */
export async function readGrapheneMesh(
  source: GrapheneMeshSource,
  neuronId: string,
  reduction: Reduction | undefined,
  fragmentLimit: number,
  options: CaveRequestOptions,
): Promise<GrapheneMesh> {
  const fragments = await grapheneFragmentNames(source, neuronId, options)
  if (fragments.length === 0) return { tally: NO_FRAGMENTS, fullTriangles: 0 }

  /*
   * Names are resolved in **one pass before the fan-out**, not inside it. Two reasons, and the
   * second is the one that matters: a datastack whose shard files are named some other way makes
   * *every* fragment unaddressable, and inside the worker that is 471 `Error` constructions with
   * stack capture per neuron of which `mapWithConcurrency` keeps exactly one. Out here it is one
   * throw, immediately, naming the fragment that could not be read.
   */
  const located = fragments.map((name) => fragmentLocation(source, name))
  const addressable = located.filter((at): at is FragmentLocation => at !== undefined)
  const unaddressable = fragments.length - addressable.length
  if (addressable.length === 0) {
    throw new Error(
      `This build cannot address any of the ${fragments.length} mesh fragments the ` +
        `manifest names for ${neuronId} (first: "${fragments[0]}").`,
    )
  }

  const parts = await mapWithConcurrency(addressable, fragmentLimit, async (at) => {
    const bytes = await fetchBytes(at.url, { range: at.range, signal: options.signal })
    // Identity scale and offset: a graphene fragment decodes to world nanometres already, so
    // the chunk transform `multires.ts` computes for neuPrint has no counterpart here.
    return decodeDracoFragment(bytes, IDENTITY_SCALE, NO_OFFSET)
  })

  // A fragment that failed comes back undefined rather than taking the neuron with it —
  // `mapWithConcurrency`'s rule, and the right one here: a mesh short one supervoxel of 492 is
  // a mesh, where a thrown request is a neuron missing from the scene with nothing saying why.
  // Only the partial-failure case survives this: `mapWithConcurrency` has already thrown if
  // every fragment failed, and an empty fragment list returned above.
  const decoded = parts.filter((p): p is MeshArrays => p !== undefined)
  const tally: FragmentTally = {
    named: fragments.length,
    missing: fragments.length - decoded.length,
    unaddressable,
  }

  /*
   * Reduced here where the fragments already are, rather than after joining them, which is the
   * difference between holding one full-resolution mesh and holding two — `decimateParts` argues
   * it. With no reduction asked for this joins and nothing else.
   *
   * It used to reduce *always*, at a grid derived from the caller's triangle budget, because
   * graphene publishes one resolution and a budget with no levels to spend would otherwise have
   * done nothing here. That made one control mean two different things depending on the dataset;
   * `GeometryRequest.downsample` is the explicit half, and full resolution is what a graphene
   * fetch answers when nobody asks for less.
   */
  const fullTriangles = decoded.reduce((n, part) => n + part.indices.length / 3, 0)
  return { mesh: applyReduction(decoded, reduction), tally, fullTriangles }
}
