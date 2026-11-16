/**
 * A box of supervoxels with the root of each — the read the candidate search, its assessor and the
 * merge anchors share.
 *
 * Its own module because it has callers on both sides: the search (`searchVolume.ts`,
 * `suggestMerges.ts`) and the merge anchors (`mergeAnchors.ts`), which should not depend on the
 * search to read a box. A `BoxReader` is a volume plus what one reader has learned — its chunks
 * and its supervoxel → root map at one instant — and `boxReader` is the one place that builds the
 * empty memo. `SearchVolume` extends it with the search's own state.
 *
 * ## The reader holds its own supervoxel map, and that is load-bearing
 *
 * (Written for the search, whose numbers these are; the anchors are the same thing smaller.)
 *
 * A box is ~14,000 supervoxels and a neuron is hundreds of boxes, so the lookup is the second
 * biggest thing the search does. `rootsAtInstant` is the arm of `rootIds.ts` that does **not**
 * touch the shared store — its docstring says why asking that one per box is quadratic — and
 * `BoxReader.roots` is the map it writes into instead. Overlap between neighbouring ends is
 * then free, and nothing of the run is kept past it.
 *
 * **Absence is remembered too**, as `0n`. A supervoxel the graph does not list is not going to
 * start appearing, and leaving it out of the map would mean re-asking for it in every later box
 * that holds it — which, since the whole premise is that boxes overlap, is the one unremovable
 * request per end.
 *
 * ## A supervoxel the graph does not list is root `0`
 *
 * The vendored `summarize_cutout` says `roots_u`: "root of each supervoxel (0 = none)", and
 * treats zero as no object at all. So an absent lookup is written as `0n` rather than dropped —
 * dropping one would shorten the array and silently shift every later supervoxel's root onto the
 * wrong label, which is the kind of failure that still ranks.
 */

import type { CaveRequestOptions } from '../../data/cave/client'
import { sharedRequestOptions } from '../../data/cave/client'
import type { GrapheneSource } from '../../data/cave/graphene'
import type { Instant } from '../../data/cave/rootIds'
import { rootsAtInstant } from '../../data/cave/rootIds'
import type { ChunkCache } from '../../data/precomputed/chunkCache'
import type { VolumeInfo, VolumeScale, VoxelBox } from '../../data/precomputed/volume'
import { readLabelBox } from '../../data/precomputed/volume'
import { untilAborted } from '../../data/memoPromise'
import type { LabelBoxRequest } from '../../pyodide/cutoutSummary'

/** A supervoxel volume, and what one reader of it has learned at one instant. */
export interface BoxReader {
  /** The supervoxel volume's base URL — the bucket the chunkedgraph named. */
  readonly base: string
  readonly info: VolumeInfo
  /** The chunkedgraph the roots are asked of. */
  readonly graphene: GrapheneSource
  /**
   * The instant every box is rooted at, in epoch ms, resolved once by whoever opens the reader —
   * `roots` is only true at it. An instant that cannot be resolved is refused there, before the
   * first byte (`openSearchVolume`'s materialization check), not per box.
   *
   * `'server'` is the server's own now (`Instant`), for the merge plan's anchors, read right after
   * this session's own merges. It is **not one moment**: each supervoxel's root is as of when it
   * was first asked, so one reader's map can span an edit made while it reads. The plan accepts
   * that because nothing it anchors is sent unchecked — the batch reads both ends again at the
   * server's now before each merge. Nothing that needs one moment (a search) may use it.
   */
  readonly at: Instant
  /**
   * This run's supervoxel → root map, `0n` for one the graph does not list.
   *
   * 64-bit on both sides: a decimal string per supervoxel is what this would otherwise retain,
   * and at a run's scale (a ~14,000-supervoxel box per end, hundreds of ends) that is the larger
   * half of its memory. `0n` is also the "no object" the vendored `summarize_cutout` reads, so
   * absence needs no second sentinel.
   */
  readonly roots: Map<bigint, bigint>
  /**
   * Supervoxels whose root is **being looked up right now**, each mapped to the lookup that
   * will answer it.
   *
   * `roots` fills on completion, which is enough while one box is read at a time and wrong the
   * moment two are. Neighbouring boxes of one neuron are mostly the same supervoxels — that is
   * the premise `roots` is built on — so two reads in flight would each find the shared ones
   * missing from `roots` and ask the chunkedgraph for all of them twice. The duplicate answers
   * the same thing, so nothing downstream could notice: it is paid in requests at a shared
   * public server (SEAM's invariant 8) and in wall clock.
   *
   * **One entry per supervoxel, all pointing at a handful of shared promises.** A promise per
   * supervoxel *request* would destroy the batching that `rootsAtInstant` exists for — the same
   * trap `l2ChunkCounts` records about `memoPromise`. This keys by supervoxel, which is what a
   * caller can ask about, and the value is the whole lookup that covers it.
   *
   * An entry removes itself when its lookup settles, so this is empty whenever nothing is in
   * flight. That is why `forgetRoots` does not clear it: a non-empty map there would mean a
   * lookup whose writes are still coming, and dropping its entries would let the next caller
   * start a second one for the same supervoxels.
   */
  readonly asking: Map<bigint, Promise<void>>
  /**
   * Chunks this reader has already fetched, shared by every box it reads.
   *
   * **The run's single biggest saving, and it is not a small one.** A chunk of this segmentation
   * is 8.2 x 8.2 x 2.9 µm where a search box is 6 µm and a patch box a little over 8, so the two
   * boxes of one end are largely the same chunks and so are the boxes of neighbouring ends.
   * Measured on one neuron's 505 ends (`pnpm probe:seam-tip-boxes`): 8,438 chunk fetches, 25.4
   * GB, against 945 distinct chunks and 2.8 GB. Nine fetches in ten were bytes the run already
   * had.
   *
   * It sits beside `roots` because it is the same kind of thing — what this run has learned,
   * held for as long as the run and no longer — and for the same reason it is per run rather
   * than global: the working set belongs to the neuron being searched, and keeping it for the
   * session would hold a hundred megabytes nobody is going to ask for again.
   *
   * Unlike `roots` it is **not** forgotten between neurons: a budget evicts what is no longer
   * wanted on its own, and two neurons near each other in the volume share chunks that
   * `forgetRoots` has no equivalent reason to drop.
   */
  readonly chunks: ChunkCache
}

/**
 * The reader narrowed to its root memo — what `resolveRoots` and `forgetRoots` take.
 *
 * Exported so the test does not declare a second copy of the same `Pick`: a copy drifts in one
 * direction silently, since adding a field breaks the stub but removing one leaves a stub that
 * over-supplies.
 */
export type RootLookup = Pick<BoxReader, 'roots' | 'asking' | 'graphene' | 'at'>

/** A box that has been read and rooted — `LabelBoxRequest` without the search's query root. */
export type RootedBox = Omit<LabelBoxRequest, 'queryRoot'>

/**
 * A reader over an opened volume, with an empty memo. The one place the memo is built, so a
 * second reader cannot start with a map the first one shares.
 */
export function boxReader(
  volume: Pick<BoxReader, 'base' | 'info' | 'graphene'>,
  at: Instant,
  chunks: ChunkCache,
): BoxReader {
  return {
    base: volume.base,
    info: volume.info,
    graphene: volume.graphene,
    at,
    roots: new Map(),
    asking: new Map(),
    chunks,
  }
}

/**
 * Forget the run's supervoxel lookups.
 *
 * Called between neurons by the node. Overlap is what the map is for, and it is a fact about one
 * neuron's own ends — the tips of two different neurons are nowhere near each other, so carrying
 * the map across them keeps millions of entries that will never be asked for again. Nothing here
 * is a cache in the usual sense: `rootsAtInstant` keeps nothing of its own, by design.
 *
 * **`asking` is deliberately not cleared**, and the field says why in full. The fact that is
 * local to here: this is called between neurons, where the run has finished every end of the
 * last one, so nothing is in flight to be orphaned.
 */
export function forgetRoots(volume: Pick<RootLookup, 'roots'>): void {
  volume.roots.clear()
}

/**
 * A box of supervoxels with the root of each, at the reader's instant.
 *
 * Three callers: the search's 6 µm box and the assessor's patch box (`searchVolume.ts`,
 * `suggestMerges.ts`), and the merge anchors' box at the graph's base scale (`mergeAnchors.ts`).
 * They read different scales around different points, and what they have in common is the
 * supervoxel map. A second copy of this loop would look up the same supervoxels twice — and
 * neighbouring boxes of one neuron overlap heavily, which is the whole premise `BoxReader.roots`
 * is built on. One map, and one place that writes it.
 *
 * **No query root.** The search's Python step wants one (`LabelBoxRequest.queryRoot`) and the
 * anchors do not, so the callers that want it add it.
 *
 * **Safe to have two of these in flight.** `resolveRoots` shares a lookup between callers rather
 * than letting each ask, so pipelining an end's patch box against the next end's search box does
 * not double the chunkedgraph's work. Reading the voxels is already safe: `ChunkCache.set` is
 * idempotent on a key it already holds, so a chunk fetched twice is wasted bytes rather than a
 * wrong box.
 *
 * **Two things that costs, both open and both recorded in `docs/seam-suggestions-plan.md`.** A
 * chunk neither read holds yet is fetched by both, since the cache has no in-flight map — the
 * shape `asking` is for supervoxels, one layer up. And `overChunks` bounds its own concurrency
 * per call (`DEFAULT_CONCURRENCY`), so two reads in flight claim twice the streams that
 * constant was measured to take as its share of a bucket shared with meshes and thumbnails.
 *
 * `scale` is a parameter, and the reader has none, for the same reason: a patch is cut at
 * `PATCH_NM`, the search box at whatever the ranker's manifest asked for and an anchor at the
 * graph's base scale — on Aedes 32, 32 and 16 nm of one volume.
 */
export async function labelledBox(
  volume: BoxReader,
  scale: VolumeScale,
  box: VoxelBox,
  options: CaveRequestOptions,
): Promise<RootedBox> {
  const read = await readLabelBox(volume.base, scale, box, {
    ...options,
    info: volume.info,
    chunks: volume.chunks,
  })
  await resolveRoots(volume, read.labels, options)
  // A plain loop: a typed array's `from` with a map function takes the iterator path, about twice
  // the cost per label on the search's hot path (measured 2026-11-16, 14,000 labels).
  const roots = new BigUint64Array(read.labels.length)
  for (let i = 0; i < roots.length; i++) roots[i] = volume.roots.get(read.labels[i]!)!
  return {
    labels: read.labels,
    index: read.index,
    size: read.size,
    roots,
    resolutionNm: scale.resolution,
    loVoxels: box.lo,
  }
}

/**
 * Make sure every one of these supervoxels has a root in `volume.roots`, asking for the ones
 * nobody is asking for yet and waiting on the lookups that already cover the rest.
 *
 * ## The partition and the registration are one synchronous block, and that is the whole thing
 *
 * Nothing may yield between reading `roots`/`asking` and writing `asking`. JavaScript is single
 * threaded, so a block with no `await` in it cannot be interleaved — and the moment one is added
 * between the two, a second caller runs in the gap, sees the same supervoxels in neither map,
 * and asks for them again. That failure is invisible: the answers agree, the run is correct, and
 * the only sign is twice the requests at a server that is not ours.
 *
 * So the loop below is deliberately dull, and the `await` is deliberately last.
 *
 * Exported for `rootedBox.test.ts`, which is the one thing here worth a test of its own: the
 * invariant is about *interleaving*, so it cannot be checked by reading the call site and it
 * cannot be reached through `labelledBox` without standing up a volume server to read voxels
 * this has no opinion about.
 *
 * ## Waiting is not a serialisation
 *
 * A caller that joins somebody else's lookup is answered no later than if it had asked itself —
 * its own request would have gone to the same server, behind the same one, and this run keeps
 * to four streams. What it saves is the bytes and the server's work, and the shared supervoxels
 * are the majority: neighbouring boxes of one neuron overlap heavily.
 */
export async function resolveRoots(
  /*
   * **The four fields it reads, not the whole volume.** A parameter wider than its use is what
   * made the test (now `rootedBox.test.ts`) cast a four-field literal through `unknown` to call this — the
   * type system pointing out that the box, the chunk cache and the eviction plan have nothing
   * to do with resolving a supervoxel. Narrowed rather than split into its own object: there is
   * one caller, and `Pick` says the same thing for a line.
   */
  volume: RootLookup,
  labels: BigUint64Array,
  options: CaveRequestOptions,
): Promise<void> {
  const mine: bigint[] = []
  const waits = new Set<Promise<void>>()
  // No `await` in this loop, or in anything between it and the registration below.
  for (const id of labels) {
    if (volume.roots.has(id)) continue
    const already = volume.asking.get(id)
    if (already) waits.add(already)
    else mine.push(id)
  }
  if (mine.length > 0) {
    const unknown = BigUint64Array.from(mine)
    /*
     * One promise, and the `finally` is inside it: a `finally` on the async body completes
     * before the promise it returns settles, so no awaiter can resume and find its supervoxel
     * still listed as being asked about. A second `turn.finally(...)` promise wrapped around a
     * first bought exactly that same guarantee and a paragraph explaining itself.
     *
     * **`sharedRequestOptions`, never the caller's own.** This is a request other callers join,
     * and a joiner must not be cancelled by whoever happened to start it — `src/data/cave`'s
     * rule, kept by `l2.ts` and `skeletonService.ts`' own shared lookups. Benign while both
     * joiners are one run with one signal, which is exactly when a rule stops being greppable.
     */
    const shared = sharedRequestOptions(options)
    const fill = async () => {
      const found = await rootsAtInstant(volume.graphene, volume.at, unknown, shared)
      // Absence is written too: see the header on why re-asking is the cost that matters.
      for (let i = 0; i < unknown.length; i++) volume.roots.set(unknown[i]!, found[i]!)
    }
    /*
     * The `finally` runs before any awaiter resumes, so nobody can be handed back a supervoxel
     * that is still listed as being asked about. Removed **only where this lookup is still the
     * registered one**: a failed lookup must leave nothing for a retry to join, and a retry that
     * has already registered its own must not be unregistered by its predecessor's unwind.
     * `memoPromise`'s `forget` records the same rule for the one-promise-per-key case, which
     * this cannot use — many keys, one promise.
     *
     * (A `try`/`finally` inside an async IIFE would be one promise instead of two, and is what
     * this wants to be; TypeScript refuses the self-reference in a `const` initialiser.)
     */
    const settled: Promise<void> = fill().finally(() => {
      for (const id of mine) if (volume.asking.get(id) === settled) volume.asking.delete(id)
    })
    for (const id of mine) volume.asking.set(id, settled)
    waits.add(settled)
  }
  /*
   * **Waited with the caller's own signal, not the request's.** The lookup is shared, so a
   * Cancel must not abort it out from under the other reader — `sharedRequestOptions` is what
   * keeps the signal off the wire. What a cancelled caller does instead is stop waiting, which
   * is `untilAborted`'s whole job and the rule `memoPromise` states for every shared read here.
   */
  await untilAborted(
    Promise.all(waits).then(() => undefined),
    options.signal,
  )
}
