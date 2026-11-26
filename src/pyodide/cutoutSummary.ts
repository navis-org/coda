/**
 * What is in a box of segmentation around a point: a typed wrapper over `cutoutSummary.py`.
 *
 * It also holds the **pool** — `runCandidatePool`, the big one, and `runPoolSizes`, the short
 * second call that finishes its feature set. The summary underneath is the lower-level question ("what is in this box"), kept because
 * `pnpm probe:cutout-summary` is what checks the axis-order crossing both share. `touchUm` and
 * `momentsUm` are not on the pool's request on purpose: SEAM's `summary_args` decides them, so
 * that a caller cannot ask for a summary the features were not fitted against.
 *
 * **A candidate search is three calls, not one, and that is forced.** Two of the eleven features
 * SEAM's forest ranks on are log counts of level-2 chunks, which come from an authenticated
 * chunkedgraph read — and the roots to ask about are not known until the pool has been measured.
 * So: `runCandidatePool`, then `l2ChunkCounts` (`data/cave/rootIds.ts`), then `runPoolSizes`,
 * with the forest in `packs/seam/treeRanker.ts`, the sort, cut and numbering in
 * `packs/seam/rankPool.ts`, and **the order of all of it in `packs/seam/searchRun.ts`**, which
 * is what a caller actually calls. `coda_candidate_pool`'s docstring carries the reasoning; the
 * ask that would collapse it back to one call is in `docs/seam-suggestions-plan.md`.
 *
 * The inputs are deliberately the shapes Coda already has. `labels` and `index` are a
 * `LabelBox` exactly as `readLabelBox` returns it — the distinct supervoxels and one index per
 * voxel, x fastest — and `roots` is what `cavePostBinary` answers for those supervoxels at a
 * timestamp. Nothing here fetches either one: one is a public bucket read and the other an
 * authenticated chunkedgraph call, and keeping them out of the worker keeps the credential out
 * of it too.
 *
 * **Nothing calls this yet** — but it is tested, which is why it is not in the knip baseline:
 * `cutoutSummary.test.ts` drives it against a mocked `callPython`, which is
 * `warp.test.ts`' arrangement and exists there because a marshalling bug in a wrapper survived
 * on the argument that vitest has no Worker. The Python under it is exercised separately by
 * `pnpm probe:cutout-summary`.
 *
 * **The columns are SEAM's, not Coda's.** They are whatever `summarize_cutout` returns, which is
 * what the geometric ranker was fitted on; naming a subset here would be a second list to keep
 * in step with a file that is vendored precisely so it cannot drift.
 */

import type { VoxelIndex } from '../data/precomputed/volume'
import { callPython } from './engine'
import type { CallOptions, PyResult } from './engine'
import { float64Columns, float64From, numberFrom, uint64From } from './types'

/**
 * A box of segmentation with the root of every supervoxel in it — what three requests here all
 * begin with, named once.
 *
 * It is the agreement with the Python side about a labelled box: what `size` is ordered as,
 * which arrays are transferred, what `0` in `roots` means, and that `queryRoot` is never one.
 * The summary adds a point to measure from, the pool adds the open end, the assessor adds
 * candidates — so each of those says **what it takes**, rather than naming itself as the
 * summary minus the summary's extras. That second form had already been written twice, and a
 * fourth summary-only field would have to be subtracted in both: forgetting it compiles, and
 * silently widens the other two. For a typed array that is worse than cosmetic, because
 * `engine.ts` transfers every view in a request and would detach a buffer nothing reads.
 *
 * A `type`, not an `interface`: only an alias gets the implicit index signature `PyArg` needs.
 */
export type LabelBoxRequest = {
  /** The distinct supervoxels of the box — `LabelBox.labels`. */
  labels: BigUint64Array
  /**
   * One index into `labels` per voxel, x fastest — `LabelBox.index`.
   *
   * **Either width, and the Python reads the one that arrives.** `readLabelBox` sends sixteen
   * bits wherever the box's table fits in them, which a real cutout's does: asking for
   * `Uint32Array` here would make every caller widen a box back out before handing it over, and
   * the copy would land in a wasm heap that never shrinks. The type is `VoxelIndex` itself
   * rather than a spelling of it, so the two cannot come to mean different things.
   */
  index: VoxelIndex
  /**
   * The box's extent in voxels, `[x, y, z]` — `LabelBox.size`.
   *
   * A plain array, not a typed one, and so are the three below it. `callPython` **transfers**
   * every view in its arguments, so a three-element `Int32Array` would be detached on the
   * caller's side for no saving at all — and a caller passing `scale.resolution` twice would
   * find it empty the second time. Only the box itself is big enough to be worth transferring.
   */
  size: readonly number[]
  /**
   * The root each entry of `labels` belongs to, in the same order, `0` for none.
   *
   * At the snapshot's timestamp, not at head: a supervoxel's root changes with every edit, and
   * a search scored against today's agglomeration cannot be compared with a fit made against
   * last month's.
   */
  roots: BigUint64Array
  /**
   * The neuron the box is about — the root everything else is measured *to*.
   *
   * **Never `0`.** That is the id for "no object" in `roots`, and the Python refuses it rather
   * than measuring every candidate's distance to background voxels, which comes back as a full
   * table of plausible rows. A zero reaches a caller from an unmapped supervoxel or a root
   * lookup that soft-failed, so it is an input to check rather than a typo.
   */
  queryRoot: bigint
  /** Nanometres per voxel of the scale the box was read at. */
  resolutionNm: readonly number[]
  /** The box's own corner in that scale's voxels — `VoxelBox.lo`. */
  loVoxels: readonly number[]
}

/** A labelled box, plus the point and radii `summarize_cutout` measures against. */
export type CutoutSummaryRequest = LabelBoxRequest & {
  /**
   * The open end the search is about, in nanometres, or empty for the distance columns alone.
   *
   * With it come `point_dist_um` and the local moments, which four of the ranker's eight
   * features read — so a search always passes it, and omitting it is for a caller that wants
   * only "what is near this box" rather than a ranking.
   */
  pointNm?: readonly number[]
  /** How near counts as touching the query. SEAM's default is 0.5 µm. */
  touchUm?: number
  /** The radius the local shape is measured over. SEAM's default is 3 µm. */
  momentsUm?: number
}

/** One row per root in the box, as flat columns. */
export interface CutoutSummary {
  readonly rows: number
  /**
   * True where the query root has no voxel in its own box, and then there are no rows.
   *
   * **Not an error.** The vendored function answers this for itself, and it is a real state: a
   * tip whose neuron does not reach the cutout around it is a tip worth looking at, not a failed
   * read. A caller that treated it as a failure would drop exactly the ends it is hunting for.
   */
  readonly missingQuery: boolean
  /** Every column `summarize_cutout` returned, by its own name. */
  readonly columns: Readonly<Record<string, Float64Array>>
  /** The id columns, kept 64-bit — a root through a float64 is a different neuron. */
  readonly root: BigUint64Array
  readonly repSupervoxel: BigUint64Array
  /** What the call took in Python, for a caller pricing a search over many ends. */
  readonly ms: number
}

/**
 * Summarise one box of segmentation.
 *
 * **The arrays are transferred, not copied** — `callPython`'s own rule — so a caller holding a
 * `LabelBox` it means to keep must copy first. Nothing here copies on its behalf: a cutout is
 * 19 MB of index and the common case is a caller that is finished with it.
 */
export async function runCutoutSummary(
  request: CutoutSummaryRequest,
  options: CallOptions = {},
): Promise<CutoutSummary> {
  const result = await callPython(
    { module: 'cutoutSummary', fn: 'coda_cutout_summary', args: [request] },
    options,
  )
  return {
    rows: numberFrom(result, 'rows'),
    missingQuery: result['missingQuery'] === true,
    columns: float64Columns(result),
    root: uint64From(result, 'root'),
    repSupervoxel: uint64From(result, 'rep_svid'),
    ms: numberFrom(result, 'ms'),
  }
}

export type CandidatePoolRequest = LabelBoxRequest & {
  /** The open end the search is about, in nanometres. Required here, unlike the summary. */
  endNm: readonly number[]
}

/** One open end's pool, unranked, as flat columns. */
export interface CandidatePool {
  readonly rows: number
  /** True where the query root has no voxel in its own box — see `CutoutSummary.missingQuery`. */
  readonly missingQuery: boolean
  /** The candidate object of each row, 64-bit. */
  readonly candRoot: BigUint64Array
  /**
   * Each row's `rep_svid`, 64-bit: the candidate's supervoxel nearest the query — its side of
   * the contact, published as `cand_sv` (`searchTips.ts`).
   */
  readonly repSupervoxel: BigUint64Array
  /**
   * Every float column `pool_features` produced, by SEAM's own names — the eight geometric
   * features, `end_dist_um`, and the contact point. **Not `l2c`/`l2x`**: those need a count this
   * side of the bridge has to fetch, and they come back from `runPoolSizes`.
   *
   * **Not sorted, not cut and not numbered.** The whole pool crosses; `packs/seam/rankPool.ts`
   * scores, sorts, cuts and numbers it, because the score is a forest in TypeScript now.
   */
  readonly columns: Readonly<Record<string, Float64Array>>
  readonly ms: number
}

/**
 * Measure one open end's candidates — stage 4 and the measuring half of 5.
 *
 * Everything that has to match SEAM happens on the far side of this call: the cutout summary
 * and the features are two vendored steps with nothing of Coda's between them. What this file
 * does is carry the box over and name the columns back.
 *
 * **The arrays are transferred, not copied.** See `runCutoutSummary`.
 */
export async function runCandidatePool(
  request: CandidatePoolRequest,
  options: CallOptions & {
    /**
     * The pool's roots, as soon as they are known — `CandidatePool.candRoot`, in its order —
     * while the call goes on to the organelle measure, so the level-2 counts can start
     * (`searchEnds`). Not called for an end whose query has no voxel in its box.
     */
    onPool?: (candRoot: BigUint64Array) => void
  } = {},
): Promise<CandidatePool> {
  const { onPool, ...rest } = options
  const result = await callPython(
    { module: 'cutoutSummary', fn: 'coda_candidate_pool', args: [request] },
    onPool ? { ...rest, onPartial: (partial) => poolFrom(partial, onPool) } : rest,
  )
  return {
    rows: numberFrom(result, 'rows'),
    missingQuery: result['missingQuery'] === true,
    candRoot: uint64From(result, 'candRoot'),
    repSupervoxel: uint64From(result, 'rep_svid'),
    columns: float64Columns(result),
    ms: numberFrom(result, 'ms'),
  }
}

/**
 * The early roots, read with the **same guard as the final `candRoot`**, so a float64 id is
 * refused rather than misread. Refused quietly here: this runs in the worker's message handler,
 * where a throw reaches nobody, and the final `candRoot` meets the same guard and fails the call
 * where it can be seen. The caller then simply had no head start.
 */
function poolFrom(partial: PyResult, onPool: (candRoot: BigUint64Array) => void): void {
  let candRoot: BigUint64Array
  try {
    candRoot = uint64From(partial, 'candRoot')
  } catch {
    return
  }
  onPool(candRoot)
}

/**
 * A measured pool and its level-2 chunk counts, for the two size features.
 *
 * The counts travel **by position**, one per pool row in the pool's own order, with the query's
 * as a scalar. The first draft sent them keyed by root, which made Python re-join what this side
 * had already aligned — and `coda_pool_sizes`' docstring records what that join cost.
 */
export type PoolSizesRequest = {
  /** The pool's candidates, as `CandidatePool.candRoot` came back. */
  candRoot: BigUint64Array
  /** Each candidate's level-2 chunk count, in the same order. */
  candCount: Float64Array
  /** The neuron the pool was measured to — `LabelBoxRequest.queryRoot`. */
  queryRoot: bigint
  /** The query's own count, which every row's `l2x` reads. */
  queryCount: number
}

/** `l2c` and `l2x`, one per pool row, in the pool's own order. */
export interface PoolSizes {
  readonly l2c: Float64Array
  readonly l2x: Float64Array
}

/**
 * Add SEAM's two whole-object size features to a measured pool.
 *
 * A second crossing for two expressions, deliberately: `candidates.size_features` is a vendored
 * feature and computing it here instead would be exactly the drift SEAM's invariant 11 exists to
 * prevent — a feature computed slightly differently still ranks, and nothing downstream can see
 * that it ranks differently. Coda has broken that invariant once, for the forest, and "only
 * where there was no choice" has to stay literally true.
 *
 * **The short count is refused before this**, by `countsInPoolOrder` in `packs/seam/searchRun.ts`
 * — where a `Map` missing a root becomes a hole in a positional array, which is the moment the
 * root's name still exists. By the time this function sees the array, "absent" is a `NaN` and
 * naming it means re-deriving from a sentinel what the caller had in hand a line earlier. What
 * stays here is the length check, which is a marshalling fact and nothing else's business.
 */
export async function runPoolSizes(
  request: PoolSizesRequest,
  options: CallOptions = {},
): Promise<PoolSizes> {
  if (request.candCount.length !== request.candRoot.length) {
    throw new Error(
      `seam pool sizes: ${request.candRoot.length} candidates and ` +
        `${request.candCount.length} counts`,
    )
  }
  const result = await callPython(
    { module: 'cutoutSummary', fn: 'coda_pool_sizes', args: [request] },
    options,
  )
  return { l2c: float64From(result, 'l2c'), l2x: float64From(result, 'l2x') }
}
