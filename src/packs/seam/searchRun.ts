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
 * - `top_k` and `own_um` come from the set's own manifest, never from a default, because the
 *   stages after this were fitted against the lists they produce;
 * - and the rule is a **per-neuron** pass over every tip, including ends no list was searched
 *   for, which still take candidates away from their neighbours.
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

/** What the set's manifest decides, never this file. */
export interface SearchRules {
  /** The forest, from `pipeline.search.ranker` — `treeRankerFor`. */
  readonly ranker: TreeRanker
  /** `pipeline.search.top_k`. SEAM keeps 100. */
  readonly topK: number
  /** `pipeline.own_tip.own_um`. SEAM's is 2.0. */
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

/** Cancel and progress, as `assessorRun.ts` takes them. */
export interface SearchOptions {
  /**
   * **Not a Cancel bound.** The signal is looked at between ends, so a Cancel waits out the
   * measure in flight — ~0.6 s — rather than stopping inside the worker.
   */
  readonly signal?: AbortSignal
  /** Ends measured, as a fraction. The counts and the rule are not weighed separately. */
  readonly onProgress?: (fraction: number) => void
}

/** One end's answer: the list SEAM would publish for it. */
export interface SearchedEnd extends RankedPool {
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
export async function searchEnds(
  tipsNm: Float32Array,
  ends: readonly EndToSearch[],
  rules: SearchRules,
  steps: SearchSteps,
  options: SearchOptions = {},
): Promise<SearchedEnd[]> {
  const { ranker, topK, ownUm } = rules
  /*
   * **Checked before anything is measured**, which is `ownTipRule`'s own discipline — it refuses
   * a bad tip before building its tree, because the caller would otherwise pay for the tree
   * first. Here the bill is far larger: `ownTipRule` runs last, so without this a neuron's worth
   * of boxes, bridge calls and chunkedgraph requests is spent before a tip out of range or a
   * second list at one tip is noticed.
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
  /*
   * Measured first, all of them, because the roots to ask the chunkedgraph about are not known
   * until `pool_features` has run — which is the whole reason a search is three crossings and
   * not one. `cutoutSummary.ts`' header argues it.
   *
   * **One at a time, not `Promise.all`.** Each request carries a labelled box — ~10 MB for a
   * real cutout — and `callPython` posts it to the worker, which handles one call at a time. A
   * neuron is ~500 tips, so starting them together queues every box in the worker's message
   * port before the first answer comes back, for no parallelism at all: the gain of measuring
   * ahead is that the counts can be asked for in one batch, not that the boxes overlap.
   */
  const pools: CandidatePool[] = []
  for (const [i, end] of ends.entries()) {
    throwIfAborted(options.signal)
    pools.push(await steps.measure(await end.box()))
    options.onProgress?.((i + 1) / ends.length)
  }
  if (ends.length === 0) options.onProgress?.(1)

  /*
   * One counts call for the neuron, not one per end. Neighbouring tips see much the same
   * objects, and `l2ChunkCounts` batches fifty roots to a request — so asking per end would
   * spend most of each batch on roots the last end already bought.
   */
  const roots = new Set<string>()
  for (const [i, pool] of pools.entries()) {
    for (const root of pool.candRoot) roots.add(String(root))
    roots.add(String(ends[i]!.queryRoot))
  }
  throwIfAborted(options.signal)
  const counts = await steps.counts([...roots])

  const ranked: RankedPool[] = []
  for (const [at, pool] of pools.entries()) {
    const end = ends[at]!
    if (pool.missingQuery) {
      ranked.push({ rows: 0, candRoot: new BigUint64Array(0), columns: {} })
      continue
    }
    throwIfAborted(options.signal)
    const queryCount = counts.get(String(end.queryRoot))
    if (queryCount === undefined) {
      refuse(`the query root ${end.queryRoot} has no level-2 chunk count`)
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
      candCount: countsInPoolOrder(pool.candRoot, counts),
      queryRoot: end.queryRoot,
      queryCount,
    })
    const measured: MeasuredPool = {
      rows: pool.rows,
      candRoot: pool.candRoot,
      // The two size features join the rest here, which is the one place that knows they came
      // by a second route. `rankPool` is deliberately feature-agnostic and must not learn it.
      columns: { ...pool.columns, l2c: sizes.l2c, l2x: sizes.l2x },
    }
    ranked.push(rankPool(ranker, measured, topK))
  }

  /*
   * **After the cut, and over the whole neuron at once.** The rule asks whether some *other*
   * tip lies nearer a candidate's contact, so it needs every tip — including ends no list was
   * searched for — and it answers all the lists together.
   */
  /*
   * An end with no list at all is **left out of the call, not passed as an empty one**. The rule
   * reads a contact column per row and refuses a list that has none — and a missing query gives
   * a pool with no columns, so handing it over throws on exactly the state this is meant to
   * carry through. Leaving it out costs nothing: `tipsNm` still holds its tip, which is what
   * makes the end take candidates away from its neighbours, and `ownTipRule`'s own doc says an
   * end no list was searched for still does that.
   */
  const searched = pools.flatMap((pool, at) => (pool.missingQuery ? [] : [at]))
  const lists: EndCandidates[] = searched.map((at) => ({
    rows: ranked[at]!.rows,
    columns: ranked[at]!.columns,
    tip: ends[at]!.tip,
  }))
  const kept = ownTipRule(tipsNm, lists, ownUm)
  const keptAt = new Map(searched.map((at, i) => [at, kept[i]!]))

  return ranked.map((ranking, at) => {
    const rule = keptAt.get(at)
    return rule === undefined
      ? {
          tip: ends[at]!.tip,
          rows: 0,
          candRoot: new BigUint64Array(0),
          columns: {},
          missingQuery: true,
          pooled: 0,
          tooFar: 0,
          anothersTip: 0,
        }
      : gather(ranking, rule, pools[at]!)
  })
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
