/**
 * Sweeping a neuron's windows and settling its tips as they are finished.
 *
 * `windowRun.ts`' counterpart for the open-end task, and here for the reason that one is: the
 * sequence is where the failures live, and all of them are quiet. A tip released one page early
 * keeps a lower score for ever; a page whose centres are counted twice releases every tip at the
 * end, which is a node that works and does not stream; a settled tip folded again is work with
 * no answer. None of those throws, and from inside `evaluate` none of them is reachable from a
 * test — scoring a page needs Pyodide, a GPU and a neuron.
 *
 * So the sequence lives here, taking the scoring as a function. What the node supplies is how to
 * score a page and what to do with the tips a page settles; what this owns is the order, the
 * counting and the fold.
 *
 * The geometry it rests on is `openEndsOps.ts`': a window's points lie inside its own crop, so a
 * cell within `tipReachNm` of a tip can only come from a centre within `within` of it. Build
 * those and the tip is finished, whatever is left of the neuron.
 */

import { throwIfAborted } from '../../core/slice'
import {
  addCells,
  bestWithin,
  emptyCellPool,
  pendingOf,
  planSweep,
  settledBy,
} from './openEndsOps'
import type { TipSweep } from './openEndsOps'

/** One page's worth of scored surface: which centres were asked for, and the cells they gave. */
export interface ScoredPage {
  /** `cells × 3` nanometres — the pooled cells, not the raw window points. */
  readonly cellsNm: Float32Array
  /** One score per cell. */
  readonly scores: Float32Array
}

export interface OpenEndRunOptions {
  /** `tips × 3` nanometres, snapped — `tipsOf`'s. */
  readonly tipsNm: Float32Array
  /** `centres × 3` nanometres: the whole tiling, indexed by centre number. */
  readonly centresNm: Float32Array
  /** How far a centre may be from a tip and still reach it (`reachNm`). */
  readonly within: number
  /** How far from a tip a cell may be and still be its `e_tip`. */
  readonly tipReachNm: number
  /** `config.scan.reduceUm`: the box a pooled cell stands for. */
  readonly cellUm: number
  /** Centres built, scored and folded before the next page. */
  readonly pageSize: number
  /** Score one page of centres. Returning no cells is allowed: a centre may hold no surface. */
  score(centres: Int32Array, done: number, total: number): Promise<ScoredPage>
  /**
   * The tips this page finished, in the order they settled.
   *
   * `best[t]` is final for every tip named, and `-Infinity` where no cell reached it.
   */
  onSettled(tips: readonly number[], best: Float64Array): void | Promise<void>
  readonly signal?: AbortSignal
}

/**
 * What the sweep did, which the node does not read — every row it publishes has already gone out
 * through `onSettled`, which is the point of the callback. It is here for the tests, which assert
 * the ordering through `onSettled` and the arithmetic through this, and for a caller that wants
 * the scores without the streaming.
 */
export interface OpenEndRun {
  /** Per tip, the best cell score within reach, or `-Infinity` where none was. */
  readonly best: Float64Array
  /** The centres the sweep actually asked for — the ones some tip was waiting on. */
  readonly swept: number
  /** How many tips were settled. Equal to the tip count unless the run was cut short. */
  readonly settled: number
}

/**
 * Sweep the tiling tip by tip, folding each page in and settling the tips it finishes.
 *
 * Returns once every tip has settled, which is once every centre in the plan has been asked for —
 * **including the ones that build no window**. A centre whose cells hold no surface answers a tip
 * just as finally as one that produced a window, and waiting for windows instead would leave a
 * tip at the edge of the arbour pending for ever.
 */
export async function runOpenEnds(options: OpenEndRunOptions): Promise<OpenEndRun> {
  const sweep: TipSweep = planSweep(options.tipsNm, options.centresNm, options.within)
  const pending = pendingOf(sweep)
  const best = new Float64Array(sweep.rows.length).fill(-Infinity)
  const pool = emptyCellPool(options.cellUm)
  let settled = 0

  /**
   * A tip's score, read off the pool at the moment it settles.
   *
   * At settle time and not before, which is what makes it the whole-neuron answer: a box within
   * reach of this tip can only be written by a centre in this tip's own reach set, and those are
   * exactly what has just finished — so the pool's representative for every box the tip reads is
   * final.
   */
  const scoreOf = (tips: readonly number[]) => {
    for (const t of tips) {
      best[t] = bestWithin(
        pool,
        options.tipsNm[t * 3]!,
        options.tipsNm[t * 3 + 1]!,
        options.tipsNm[t * 3 + 2]!,
        options.tipReachNm,
      )
    }
  }

  /*
   * A tip no centre reaches is finished before the sweep starts, and would otherwise never be:
   * nothing can settle it, because nothing is waiting. It keeps `-Infinity`, which the caller
   * publishes as "no cell reached this one".
   */
  const orphans: number[] = []
  for (let t = 0; t < pending.length; t++) if (pending[t] === 0) orphans.push(t)
  if (orphans.length > 0) {
    settled += orphans.length
    await options.onSettled(orphans, best)
  }

  for (let at = 0; at < sweep.order.length; at += options.pageSize) {
    throwIfAborted(options.signal)
    const asked = sweep.order.slice(at, at + options.pageSize)
    const page = await options.score(asked, at + asked.length, sweep.order.length)
    if (page.scores.length > 0) addCells(pool, page.cellsNm, page.scores)
    const done = settledBy(pending, sweep, asked)
    if (done.length === 0) continue
    scoreOf(done)
    settled += done.length
    await options.onSettled(done, best)
  }

  return { best, swept: sweep.order.length, settled }
}
