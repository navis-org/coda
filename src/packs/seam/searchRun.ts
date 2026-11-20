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
 * ## Several ends under way, each yielded finished and in order
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
 * ends is still free and the bound on what was lost is **one partially-filled batch per end**
 * — about 200 ms against an end's two seconds, and nothing at all for an end that introduces no
 * new root.
 *
 * **Up to `depth` ends are under way at once** (2026-11-19, `SearchOptions.depth`). One at a
 * time, an end's box, pool and counts ran in a row on three different resources, each idle
 * most of an end, and the search set the run's pace — 3.1 s an end against 1.8 of scoring.
 * Several deep, the next ends' boxes are read and their counts asked while this end is
 * measured; the measures still take turns on the one Python worker, in end order, and the ends
 * are still yielded in order and final. The chunkedgraph was measured keeping up first
 * (`docs/seam-suggestions-plan.md`), inside one budget per server (`rootIds.ts`).
 *
 * ## The prefetch that looked free and was not
 *
 * Most of an end is network with the worker idle — the box, then the supervoxel lookups, then
 * the chunk counts — so running the next end's search alongside this one's scoring hides it.
 * That was recorded here as **not** a free win, because two box reads in flight both saw the
 * supervoxels their ends share as unknown and asked the chunkedgraph for them twice, and
 * neighbouring ends are exactly where that overlap is.
 *
 * Sharing the lookups is what made it free (`rootedBox.ts`' `resolveRoots`, through
 * `shareInFlight`): one lookup, shared between the reads that want it — however many are in
 * flight, now that several ends are searched at once. `oneAhead` below is the other half, and the
 * node wraps this generator in it.
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
import type { Slots } from '../../data/concurrency'
import { slots } from '../../data/concurrency'
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
   * Other roots that are the query too, **already written as `queryRoot` in the box** — an
   * accepted piece's path, where the end belongs to a neuron being extended (`pieces.ts`).
   *
   * Carried here for the one thing the box cannot say once that is done: how big the neuron
   * is. The ranker's size features read the query's level-2 chunk count, and the neuron as it
   * will be once merged is these counted with it.
   */
  readonly alsoQuery?: readonly bigint[]
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
 * tips overlap heavily and `l2ChunkCounts` batches 160 to a request. A caller may put its own
 * cache behind it; nothing here assumes one.
 */
export interface SearchSteps {
  /**
   * `onPool` is to be called with the pool's roots as soon as they are known, before the measure
   * returns (`runCandidatePool`'s own `onPool`), so the counts can start under the rest of it. A
   * step that never calls it is answered exactly the same, one stage later.
   */
  measure(
    request: CandidatePoolRequest,
    onPool?: (candRoot: BigUint64Array) => void,
  ): Promise<CandidatePool>
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
  /**
   * How many ends may be under way at once, the one being waited for among them — box read,
   * measure queued, counts in flight. 1, the default, begins each end only when it is asked for.
   */
  readonly depth?: number
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

  /*
   * **Up to `depth` ends under way at once, yielded in order.** Each end's box is read as soon as
   * it is started, alongside the others'; the measures take turns on the Python worker in end
   * order; the counts overlap freely inside the chunkedgraph's budget. `depth` 1 is the old
   * sequence exactly — an end is begun when it is asked for.
   *
   * **A started end's failure waits its turn.** Its promise carries a handler from the moment it
   * is made (`oneAhead`'s rule), so an end failing while an earlier one is still being yielded is
   * not an unhandled rejection; it surfaces when its own turn comes, as it would have serially.
   */
  // A depth that is not a number is the old sequence, never no search at all.
  const depth = Number.isFinite(options.depth) ? Math.max(1, Math.floor(options.depth!)) : 1
  // The measures, one at a time, in the order the ends were started (`searchOne` says how).
  const turns = slots(1)
  /*
   * **Stopped when this generator closes**, a failure or a `break`: the ends still queued for the
   * measure leave the queue and measure nothing; one already measuring finishes its own steps,
   * whose signals are their own. But a close reaches here only once the
   * end being awaited has finished — an async generator's `return()` waits behind its pending
   * `next()` — so a caller that must stop at once aborts `options.signal` itself, as Suggest
   * Merges does. A box read already in flight finishes: its signal is its step's own.
   */
  const own = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, own.signal]) : own.signal
  const each = { ...options, signal }
  const queue: Promise<SearchedEnd>[] = []
  let next = 0
  try {
    for (;;) {
      throwIfAborted(options.signal)
      while (next < ends.length && queue.length < depth) {
        const one = searchOne(ends[next++]!, turns, tipsNm, rules, steps, each)
        void one.catch(() => {})
        queue.push(one)
      }
      const one = queue.shift()
      if (!one) return
      yield await one
    }
  } finally {
    own.abort()
  }
}

/** One end searched: its box, pool, counts, sizes, ranking and the own-tip rule. */
async function searchOne(
  end: EndToSearch,
  turns: Slots,
  tipsNm: Float32Array,
  rules: SearchRules,
  steps: SearchSteps,
  options: SearchOptions,
): Promise<SearchedEnd> {
  const { ranker, topK, ownUm } = rules
  /*
   * This end's roots, its query among them. `l2ChunkCounts` is memoised by root on the node's
   * side, so a root a neighbouring end already bought costs nothing here.
   */
  const query = [end.queryRoot, ...(end.alsoQuery ?? [])].map(String)
  const rootsOf = (candRoot: BigUint64Array) => [
    ...new Set([...query, ...Array.from(candRoot, String)]),
  ]
  /*
   * **The counts start as soon as the pool's roots are known**, under the rest of the measure
   * — the organelle measure, ~270 ms an end that the counts never read (2026-11-18). The
   * handler goes on where the promise is made, `oneAhead`'s rule: the measure can still throw
   * with this in flight, and an unawaited rejection is "Uncaught (in promise)". **Started inside
   * the chain**, so a step that throws rather than rejects is caught too: `onPool` runs in the
   * Python worker's message handler, where a throw reaches nobody (`CallOptions`).
   */
  let early: Promise<EarlyCounts> | undefined
  /*
   * **The box is read at once, alongside the other ends'; the measure waits its turn.** The end
   * takes its place in line before anything here is awaited, so the line is the order the ends
   * were started, whichever box arrives first; and it holds its place while its box is read.
   */
  const box = Promise.resolve().then(() => end.box())
  void box.catch(() => {})
  const pool = await turns.run(async () => {
    const request = await box
    throwIfAborted(options.signal)
    return steps.measure(request, (candRoot) => {
      early = Promise.resolve()
        .then(() => steps.counts(rootsOf(candRoot)))
        .then(
          (counts) => ({ counts }),
          (failed: unknown) => ({ failed }),
        )
    })
  }, options.signal)
  if (pool.missingQuery) return emptyEnd(end.tip)

  throwIfAborted(options.signal)
  const counts = await topUpCounts(rootsOf(pool.candRoot), await early, steps)
  /*
   * **This end's failure, not the run's.** A root the chunkedgraph does not list is a fact
   * about one object beside one open end; `countsInPoolOrder` refuses by name because that is
   * where the hole is created, and here is where it is survivable. A neuron is hundreds of
   * ends and the expensive half is already spent by the time this is known, so a throw would
   * cost the whole run to say something about one of them.
   */
  let candCount: Float64Array
  const queryCount = queryCountOf(counts, query)
  try {
    if (queryCount === undefined) {
      const without = query.filter((root) => !counts.has(root))
      refuse(`the query root ${without.join(', ')} has no level-2 chunk count`)
    }
    candCount = countsInPoolOrder(pool.candRoot, counts)
  } catch (error) {
    return { ...emptyEnd(end.tip), missingQuery: false, refusal: messageOf(error) }
  }

  /*
   * **Copies, because `callPython` transfers.** Every view in a request is handed to the
   * worker and detached on this side, so sending either of these as they are would empty the
   * array that `measured` and then `rankPool` read on the next two lines — surfacing as "the
   * pool says 538 rows and its candidate ids number 0" on the first end, and *only* in the
   * app: the unit test's fake and the probe's in-process bridge both post nothing.
   *
   * **It is per array read afterwards, not per array sent**, which is the part that caught
   * this twice. `candRoot` was copied here from the beginning and `candCount` was not, and
   * that was right for exactly as long as nothing read `candCount` again — publishing it as
   * `n_l2` two lines down made it wrong, with the same sentence and a different column name.
   * A `searchRun.test.ts` fake that detaches what it is given is what now holds the rule.
   */
  const sizes = await steps.sizes({
    candRoot: BigUint64Array.from(pool.candRoot),
    candCount: Float64Array.from(candCount),
    queryRoot: end.queryRoot,
    queryCount: queryCount!,
  })
  const measured: MeasuredPool = {
    rows: pool.rows,
    candRoot: pool.candRoot,
    /*
     * The two size features join the rest here, which is the one place that knows they came
     * by a second route. `rankPool` is deliberately feature-agnostic and must not learn it.
     *
     * **`n_l2` is the count itself, carried beside them and used by neither.** The ranker
     * reads `l2c`, which is `log10` of it, and the published column has to be the raw number:
     * a reader sorting a review queue by how big a piece is wants the quantity, and
     * reconstructing it from a log in the card would be this pack holding a feature's
     * definition in two places. It costs one `Float64Array` already in hand.
     */
    columns: { ...pool.columns, l2c: sizes.l2c, l2x: sizes.l2x, n_l2: candCount },
  }
  const ranking = rankPool(ranker, measured, topK)

  /*
   * **The rule, after the cut, against every tip of the neuron.** One list per call: the lists
   * are independent — each is tested against the same tip positions — so this answers exactly
   * what the whole-neuron call answered, one end sooner. It rebuilds the k-d tree per end,
   * which over a few hundred points is microseconds against this end's 560 ms of measuring.
   */
  const list: EndCandidates = { rows: ranking.rows, columns: ranking.columns, tip: end.tip }
  return gather(ranking, ownTipRule(tipsNm, [list], ownUm)[0]!, pool)
}

/**
 * Each value of `stream`, with the **next one already being computed** while the body runs.
 *
 * `for await` asks a generator for its next value only once the body has finished with the last
 * one, which is right when the two share a resource and wrong when they do not. Here they mostly
 * do not: searching an end is nearly all network, and the expensive half of what the node does
 * with a yielded end is the GPU. Serial, an end cost the sum; one ahead, it costs the largest
 * resource.
 *
 * **Both halves also call Pyodide** — the search measures its pool, the body cuts its patches.
 * On one worker that work queued: the first run after this landed went 4.9 s an end to 3.3
 * against a predicted 2.8, and the stage that appeared to get slower (`cutting patches`) had
 * not, it had started waiting for the worker. The cutter now has a worker of its own
 * (`src/pyodide/engine.ts`' `PyLane`), which took 3.3 s an end to 3.0 (2026-11-18). Anyone
 * widening the overlap should move the Pyodide work, not the order of the ends.
 *
 * **One ahead, never more — here.** This only makes the next value be asked for before the body
 * runs; how far a source runs ahead of *that* is the source's own business (`searchEnds`'
 * `depth`), and a second layer of lookahead here would only hold another finished end.
 *
 * ## The two things a caller must know
 *
 * **The source runs ahead of the body, so a value must be final when it is yielded.** That is
 * `searchEnds`' own property and the reason this is safe here: the own-tip rule reads tip
 * positions, which are known before any box is read, so nothing a later end learns can change
 * an earlier one. A generator whose values settle only once the next is drawn would be
 * published half-made.
 *
 * **Whatever the source does while running ahead must be safe to do more than once at a time.**
 * For a search that means several box reads in flight against one volume, whose supervoxel
 * lookups `resolveRoots` shares (`shareInFlight`).
 *
 * Generic because the shape is, and here rather than in `src/core` because the two paragraphs
 * above are what make it correct and they are facts about this sequence.
 */
export async function* oneAhead<T>(stream: AsyncGenerator<T>): AsyncGenerator<T> {
  /*
   * **The handler goes on where the promise is made, not where it is abandoned.** A pending
   * `next()` nobody awaits is an unhandled rejection — "Uncaught (in promise)" in a browser, a
   * failed run under vitest — and the window opens the instant the consumer's body throws or a
   * Cancel fires, which is typically while it is parked on something long and cannot yet react.
   * `assessorRun.ts` earned this one. It does not swallow the rejection the loop awaits: that
   * copy still rejects normally. In one place, because the comment is the load-bearing part and
   * a second copy is a second thing to keep true.
   */
  const ask = () => {
    const next = stream.next()
    void next.catch(() => {})
    return next
  }
  let coming = ask()
  try {
    for (;;) {
      const got = await coming
      if (got.done) return
      // Before the body sees the value, which is the whole point.
      coming = ask()
      yield got.value
    }
  } finally {
    /*
     * **Close the source when the consumer gives up.** `for await` closes *this* generator on a
     * break or a throw, which resumes it here — but without this the source is left suspended
     * and its outstanding `next()` runs to completion into a run that is being discarded. For a
     * search that is a whole end: a 19 MB box read, a chunkedgraph lookup and a Pyodide measure,
     * all written into a volume nobody will read. The box read and the bridge call carry the
     * run's signal, so a Cancel stops most of it, and a shared lookup stops once nobody waits on
     * it (`shareInFlight`). On every other exit — the assessor throwing, a bridge call failing —
     * this is what stops it: closing `searchEnds` stops the ends it has under way from measuring
     * (its own stop signal), though a read already in flight finishes.
     *
     * **`void`, not `await`.** `return()` queues behind the pending `next()`, so awaiting it
     * would make the failing path wait out the very prefetch it is trying to abandon. Not
     * awaited, it still stops the source going on to a second value and lets it run its own
     * `finally` if it ever grows one.
     */
    void stream.return?.(undefined)
  }
}

/** What the early ask came to: the counts, or what it failed with — kept, never swallowed. */
type EarlyCounts =
  { readonly counts: ReadonlyMap<string, number> } | { readonly failed: unknown }

/**
 * The counts for `roots`: the early answer where there is one, and the rest asked now.
 *
 * **Asked again for anything the early answer does not hold**, rather than trusting it to be
 * the same set: the early roots are a promise of the bridge's (`runCandidatePool`'s `onPool`),
 * and a pool that came back different would otherwise be ranked on holes. In a run they are the
 * same set, and the only roots asked again are ones the graph does not list — which an answer
 * leaves out, and `l2ChunkCounts`' memo answers without a request.
 *
 * **A failed early ask fails here, as the counts always did, and is not asked again.** Asked
 * again it was every batch twice at a server that had just refused them — at a `429`, the
 * opposite of what it asked for — and a Cancel turned into a fresh ask after the Cancel.
 *
 * Not "ask everything again and let the memo answer": `SearchSteps.counts` promises no cache, and
 * `l2ChunkCounts`' memo fills only as each batch lands.
 */
async function topUpCounts(
  roots: readonly string[],
  early: EarlyCounts | undefined,
  steps: SearchSteps,
): Promise<ReadonlyMap<string, number>> {
  if (!early) return steps.counts(roots)
  if ('failed' in early) throw early.failed
  const missing = roots.filter((root) => !early.counts.has(root))
  if (missing.length === 0) return early.counts
  return new Map([...early.counts, ...(await steps.counts(missing))])
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

/**
 * How big the query is: the level-2 chunk counts of every root that is it, summed — or
 * `undefined` where the chunkedgraph does not list **one** of them, which the caller refuses by
 * name, as it does a neuron's own end whose root has no count.
 *
 * One root for a neuron's own end. For an accepted piece's, the neuron and the pieces between:
 * what the neuron will be once they are merged. **All of them or none**: a sum over the ones
 * that happened to be listed is a neuron a fraction of its size, ranked on without a word — and,
 * carrying no refusal, remembered as the end's answer for the session.
 */
export function queryCountOf(
  counts: ReadonlyMap<string, number>,
  query: readonly string[],
): number | undefined {
  let sum = 0
  for (const root of query) {
    const count = counts.get(root)
    if (count === undefined) return undefined
    sum += count
  }
  return query.length > 0 ? sum : undefined
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
