/**
 * One neuron's open ends searched — the sequence of stages 4 and 5, in one place.
 *
 * A candidate search is three crossings and two rules, and **the sequence is where the failures
 * live**. Each step on its own is checkable; the order they run in is not, and every way of
 * getting it wrong produces a full list of believable candidates:
 *
 * - the own-tip rule runs **after** the cut to `top_k`, not before. Run it first and the cut
 *   then keeps 100 of a list the rule has already thinned, which is a different set — SEAM's
 *   own figures for one end are 538 in the pool, 100 after the cut, 9 after the rule;
 * - the counts are joined to the pool **by position**, so a root the chunkedgraph left out has
 *   to be refused by name here rather than arriving as a hole;
 * - `top_k` and `own_um` come from the **model's** manifest, never from a default, because the
 *   forest and the stages after it were fitted against the lists they produce
 *   (`rankerConfig.ts`);
 * - and the rule is measured against **every tip of the neuron**, including ends no list was
 *   searched for, which still take candidates away from their neighbours.
 *
 * ## One end at a time, finished before the next is begun
 *
 * This yields each end as it is done, because the node publishes them: a reader starts working
 * through the queue while the rest of the neuron is still being measured
 * (`docs/seam-suggestions-plan.md`). What makes that honest is that **a yielded end is final** —
 * the own-tip rule reads the *tip positions*, which are known before any box is read, so an end
 * ranked and ruled now cannot be changed by an end measured later. A draft that moved under the
 * reader would be worse than no streaming at all.
 *
 * It cost the batched counts call. The first draft measured the whole neuron, asked
 * `l2ChunkCounts` once for every root, and ranked — which meant nothing was reviewable until
 * every box in the neuron had been read. Per end the roots are asked for per end, and that is
 * cheaper than it looks: `l2ChunkCounts` memoises by root, so the overlap between neighbouring
 * ends is still free and the bound on what was lost is **one partially-filled batch of fifty per
 * end** — about 200 ms against an end's two seconds, and nothing at all for an end that
 * introduces no new root.
 *
 * ## The prefetch that looks free and is not
 *
 * Roughly 1.4 s of an end's 2 s is network with the worker idle — the box, then two
 * `roots_binary` requests — so a one-deep lookahead on `ends[i + 1].box()` would hide most of it
 * (the measures stay serial; `callPython` has one worker). It is **not** a free win: two
 * `readPool`s in flight both see the supervoxels their ends share as unknown and ask the
 * chunkedgraph for them twice, and neighbouring ends are exactly where that overlap is —
 * `SearchVolume.roots` exists to make it free. Doing it properly means an in-flight promise per
 * batch. Recorded rather than done, because the next reader will think of the prefetch and not
 * of the double lookup.
 *
 * So the sequence lives here, taking its steps as functions — which is `openEndRun.ts`' own
 * argument in this pack ("the sequence is where the failures live, and all of them are quiet…
 * from inside `evaluate` none of them is reachable from a test") and `assessorRun.ts`'
 * arrangement, written the same way before the node that would call it existed.
 *
 * Injected rather than imported for a second reason: `callPython` needs a `Worker`, which
 * `pnpm probe:candidate-search` has no way to give it. The probe passes its own bridge calls and
 * so drives *this* sequence against real data, instead of being a second copy of it.
 *
 * Headless and pure, like `tips.ts` and `ownTip.ts`: it fetches nothing itself.
 */

import { throwIfAborted } from '../../core/slice'
import type {
  CandidatePool,
  CandidatePoolRequest,
  PoolSizes,
  PoolSizesRequest,
} from '../../pyodide/cutoutSummary'
import type { EndCandidates, OwnTipList } from './ownTip'
import { ownTipRule } from './ownTip'
import type { MeasuredPool, RankedPool } from './rankPool'
import { rankPool } from './rankPool'
import type { TreeRanker } from './treeRanker'

function refuse(why: string): never {
  throw new Error(`seam candidate search: ${why}`)
}

/** One end to search: which tip of the neuron it is, and how to get the box to measure. */
export interface EndToSearch {
  /** An **index into `tipsNm`**, as `ownTipRule` means it. */
  readonly tip: number
  /**
   * The neuron the box is about — needed before the box is built, to ask for its chunk count.
   */
  readonly queryRoot: bigint
  /**
   * The box and the open end, **as a function**, because a real cutout is ~19 MB and a neuron
   * is ~500 of them. Taking built requests would mean every box existing at once — some nine
   * gigabytes — where this way each is built, measured and dropped before the next is read.
   */
  box(): Promise<CandidatePoolRequest>
}

/**
 * What the **model's** manifest decides, never this file.
 *
 * All three travel with the weights (`rankerConfig.ts`), because the forest was fitted against
 * the lists these produce: a cut at another `top_k`, or a rule at another radius, is a different
 * question asked of the same trees.
 */
export interface SearchRules {
  /** The forest, from the manifest's one `ranker` part — `openTreeRanker`. */
  readonly ranker: TreeRanker
  /** `config.top_k`. SEAM keeps 100. */
  readonly topK: number
  /** `config.own_um`. SEAM's is 2.0. */
  readonly ownUm: number
}

/**
 * The three steps, as functions.
 *
 * `counts` takes every root at once rather than one end's, because the roots of neighbouring
 * tips overlap heavily and `l2ChunkCounts` batches fifty to a request. A caller may put its own
 * cache behind it; nothing here assumes one.
 */
export interface SearchSteps {
  measure(request: CandidatePoolRequest): Promise<CandidatePool>
  sizes(request: PoolSizesRequest): Promise<PoolSizes>
  counts(roots: readonly string[]): Promise<Map<string, number>>
}

/**
 * Cancel, and nothing else.
 *
 * There was an `onProgress` here while this returned an array. A generator has no use for one:
 * the **yield is the tick**, and it is the caller that knows the denominator — the node counts
 * ends across every neuron, where this one only ever sees one neuron's. A second progress
 * channel beside `ctx.progress` would report a different fraction from the same run.
 *
 * **The signal is not a Cancel bound.** It is looked at between ends, so a Cancel waits out the
 * measure in flight — ~0.6 s — rather than stopping inside the worker.
 */
export interface SearchOptions {
  readonly signal?: AbortSignal
}

/** One end's answer: the list SEAM would publish for it. */
export interface SearchedEnd extends RankedPool {
  /**
   * Why this end has no list, where it has none — `undefined` when it has one.
   *
   * An end can fail on its own without the run being wrong: its query root may have no voxel in
   * its own box, or the chunkedgraph may not list one of the objects beside it. Carried per end
   * so the node can count them and say so once, rather than a throw taking down a run of several
   * hundred after the expensive ones have been paid for.
   */
  readonly refusal?: string
  /** Which tip it was searched at — an index into `tipsNm`, carried through. */
  readonly tip: number
  /** True where the query root has no voxel in its own box, and then there are no rows. */
  readonly missingQuery: boolean
  /** How many objects the pool held before the cut — the figure `top_k` is a cut *of*. */
  readonly pooled: number
  /** Dropped by the own-tip rule for a contact further than `ownUm` from this end. */
  readonly tooFar: number
  /** Dropped because another tip of the neuron lies nearer the contact. */
  readonly anothersTip: number
}

/**
 * The counts for one pool, in the pool's own order.
 *
 * **The join, and the refusal that belongs with it.** `l2ChunkCounts` leaves a root the graph
 * does not list *out* of its answer rather than calling it zero, so this is where "absent"
 * becomes a hole — and therefore where it has to be named. One step later the hole is a `NaN` in
 * a `Float64Array` and the root it belonged to has been thrown away; two steps later the
 * vendored `size_features` can only say how many rows were short, which is the right message for
 * a fit script holding the whole table and the wrong one here.
 */
export function countsInPoolOrder(
  candRoot: BigUint64Array,
  counts: ReadonlyMap<string, number>,
): Float64Array {
  const short = [...candRoot].filter((root) => counts.get(String(root)) === undefined)
  if (short.length > 0) {
    refuse(
      `${short.length} of ${candRoot.length} roots have no level-2 chunk count, ` +
        `first ${short.slice(0, 3).join(', ')}`,
    )
  }
  return Float64Array.from(candRoot, (root) => counts.get(String(root))!)
}

/**
 * Search every open end of one neuron.
 *
 * `tipsNm` is **every** tip, `n × 3` in nanometres; `ends` are the ones to search, each naming
 * its index into that array. An end whose query root has no voxel in its own box comes back
 * empty rather than missing, because that is a tip worth looking at rather than a failed read.
 */
export async function* searchEnds(
  tipsNm: Float32Array,
  ends: readonly EndToSearch[],
  rules: SearchRules,
  steps: SearchSteps,
  options: SearchOptions = {},
): AsyncGenerator<SearchedEnd> {
  const { ranker, topK, ownUm } = rules
  /*
   * **Checked before anything is measured**, which is `ownTipRule`'s own discipline — it refuses
   * a bad tip before building its tree, because the caller would otherwise pay for the tree
   * first. Here the bill is far larger: without this a neuron's worth of boxes, bridge calls and
   * chunkedgraph requests is spent before a tip out of range or a second list at one tip is
   * noticed. It is a property of the *call* — tips and ends together — so it cannot move into
   * the loop below.
   */
  const tips = Math.floor(tipsNm.length / 3)
  const at = new Set<number>()
  for (const end of ends) {
    if (!Number.isInteger(end.tip) || end.tip < 0 || end.tip >= tips) {
      refuse(`an end at tip ${end.tip}, which is not one of the ${tips} tips given`)
    }
    if (at.has(end.tip)) refuse(`two ends at tip ${end.tip}; the rule takes one list per end`)
    at.add(end.tip)
  }

  for (const end of ends) {
    throwIfAborted(options.signal)
    const pool = await steps.measure(await end.box())
    if (pool.missingQuery) {
      yield emptyEnd(end.tip)
      continue
    }

    /*
     * This end's roots, its query among them. `l2ChunkCounts` is memoised by root on the node's
     * side, so a root a neighbouring end already bought costs nothing here.
     */
    const roots = new Set<string>([String(end.queryRoot)])
    for (const root of pool.candRoot) roots.add(String(root))
    throwIfAborted(options.signal)
    const counts = await steps.counts([...roots])
    /*
     * **This end's failure, not the run's.** A root the chunkedgraph does not list is a fact
     * about one object beside one open end; `countsInPoolOrder` refuses by name because that is
     * where the hole is created, and here is where it is survivable. A neuron is hundreds of
     * ends and the expensive half is already spent by the time this is known, so a throw would
     * cost the whole run to say something about one of them.
     */
    let candCount: Float64Array
    const queryCount = counts.get(String(end.queryRoot))
    try {
      if (queryCount === undefined) {
        refuse(`the query root ${end.queryRoot} has no level-2 chunk count`)
      }
      candCount = countsInPoolOrder(pool.candRoot, counts)
    } catch (error) {
      yield { ...emptyEnd(end.tip), missingQuery: false, refusal: messageOf(error) }
      continue
    }

    /*
     * **A copy, because `callPython` transfers.** Every view in a request is handed to the
     * worker and detached on this side, so sending `pool.candRoot` itself would empty the array
     * that `measured` and then `rankPool` read on the next two lines — surfacing as "the pool
     * says 538 rows and its candidate ids number 0" on the first end, and *only* in the app:
     * the unit test's fake and the probe's in-process bridge both post nothing.
     */
    const sizes = await steps.sizes({
      candRoot: BigUint64Array.from(pool.candRoot),
      candCount,
      queryRoot: end.queryRoot,
      queryCount: queryCount!,
    })
    const measured: MeasuredPool = {
      rows: pool.rows,
      candRoot: pool.candRoot,
      // The two size features join the rest here, which is the one place that knows they came
      // by a second route. `rankPool` is deliberately feature-agnostic and must not learn it.
      columns: { ...pool.columns, l2c: sizes.l2c, l2x: sizes.l2x },
    }
    const ranking = rankPool(ranker, measured, topK)

    /*
     * **The rule, after the cut, against every tip of the neuron.** One list per call: the lists
     * are independent — each is tested against the same tip positions — so this answers exactly
     * what the whole-neuron call answered, one end sooner. It rebuilds the k-d tree per end,
     * which over a few hundred points is microseconds against this end's 560 ms of measuring.
     */
    const list: EndCandidates = { rows: ranking.rows, columns: ranking.columns, tip: end.tip }
    yield gather(ranking, ownTipRule(tipsNm, [list], ownUm)[0]!, pool)
  }
}

/** A refusal's sentence, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** An end with no list: a missing query root, which is a tip worth looking at, not a failure. */
function emptyEnd(tip: number): SearchedEnd {
  return {
    tip,
    rows: 0,
    candRoot: new BigUint64Array(0),
    columns: {},
    missingQuery: true,
    pooled: 0,
    tooFar: 0,
    anothersTip: 0,
  }
}

/** One list cut down to what the rule kept, with `geo_rank` renumbered from one. */
function gather(ranked: RankedPool, kept: OwnTipList, pool: CandidatePool): SearchedEnd {
  const columns: Record<string, Float64Array> = {}
  for (const [name, column] of Object.entries(ranked.columns)) {
    columns[name] = Float64Array.from(kept.kept, (from) => column[from]!)
  }
  /*
   * **Renumbered, not carried.** `OwnTipList.kept` is in the new rank's order, so a kept row's
   * `geo_rank` is its position here plus one — and SEAM's published lists are numbered that way
   * (`make_search.py` refuses a published list whose `geo_rank` is not `1..n`). Carrying the
   * pre-rule numbers through would leave gaps that every stage after this reads as ranks.
   */
  columns['geo_rank'] = Float64Array.from(kept.kept, (_, at) => at + 1)
  return {
    tip: kept.tip,
    rows: kept.kept.length,
    candRoot: BigUint64Array.from(kept.kept, (from) => ranked.candRoot[from]!),
    columns,
    missingQuery: pool.missingQuery,
    pooled: pool.rows,
    tooFar: kept.tooFar,
    anothersTip: kept.anothersTip,
  }
}
