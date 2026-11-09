/**
 * What Find Merges' card says about a run, derived from the run's own table.
 *
 * Headless, and on purpose: the card draws it, but every number in it is a claim about the
 * result and belongs where the result was built, beside the schema that names the columns it
 * reads. The alternative — arithmetic inside a React component — is a summary no test can reach
 * and that drifts from `mergeTables.ts` the first time a column is renamed.
 *
 * **It is read from the output, not recomputed from the model.** The card has no session, no
 * weights and no mesh; it has the `Table` the last run published. That is also what makes
 * `Score cutoff` free to move: the cutoff is applied *here*, to numbers already in hand, so
 * sliding it costs one pass over a few hundred rows instead of a re-run.
 */

import type { TableValue } from '../../core/values'

/**
 * How many bars the score histogram has.
 *
 * Twenty, so each bar is 0.05 wide: fine enough to show whether the scores pile up at the ends
 * (which is what a confident model looks like) and coarse enough that one cell is a visible bar
 * on a neuron with a hundred of them. A bar is also the click target that sets the cutoff, so
 * finer bars would mean a line nobody can place by hand.
 */
export const SCORE_BINS = 20

export interface MergeSummary {
  /** Distinct neurons in the table. */
  readonly neurons: number
  readonly cells: number
  /**
   * Distinct fragment labels — one per cell, plus one more for every cell the per-point head
   * actually cut. A neuron the model thinks is whole has as many fragments as cells.
   */
  readonly fragments: number
  /** Cells whose bipartition put at least one point on each side. */
  readonly cut: number
  readonly minScore: number
  readonly medianScore: number
  readonly maxScore: number
  /** Counts per score bin, `SCORE_BINS` long, left edge `i / SCORE_BINS`. */
  readonly bins: readonly number[]
  /** The tallest bin, so a drawer does not walk the array again. */
  readonly tallest: number
  /** Cells scoring at or above the cutoff, or `undefined` where no cutoff is set. */
  readonly above: number | undefined
}

/**
 * Fold a window table into the card's readout, or `undefined` where there is nothing to say.
 *
 * `undefined` rather than a zeroed summary, because "no run yet" and "a run that found no cells"
 * are different sentences and the card says both.
 */
export function summariseMerges(
  table: TableValue | undefined,
  cutoff: number | undefined,
): MergeSummary | undefined {
  if (!table || table.length === 0) return undefined
  const scores = numbers(table, 'score')
  const balance = numbers(table, 'balance')
  if (!scores) return undefined

  const bins = new Array<number>(SCORE_BINS).fill(0)
  const kept: number[] = []
  let tallest = 0
  let above = 0
  let cut = 0
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i]
    // A row whose score is null is a row nothing can be said about; it is left out of every
    // count rather than folded in as a zero, which would be a cell the model called clean.
    if (score === undefined) continue
    kept.push(score)
    // `min` on the index, not a clamp on the score: a score of exactly 1 belongs in the last bin
    // rather than in a twenty-first that nothing draws.
    const bin = Math.min(SCORE_BINS - 1, Math.max(0, Math.floor(score * SCORE_BINS)))
    const count = (bins[bin] = bins[bin]! + 1)
    if (count > tallest) tallest = count
    if (cutoff !== undefined && score >= cutoff) above += 1
    if ((balance?.[i] ?? 0) > 0) cut += 1
  }
  if (kept.length === 0) return undefined

  const sorted = [...kept].sort((a, b) => a - b)
  return {
    neurons: distinct(table, 'neuronId'),
    cells: kept.length,
    fragments: kept.length + cut,
    cut,
    minScore: sorted[0]!,
    medianScore: sorted[Math.floor(sorted.length / 2)]!,
    maxScore: sorted[sorted.length - 1]!,
    bins,
    tallest,
    above: cutoff === undefined ? undefined : above,
  }
}

/**
 * A column as numbers, **row-aligned** — `undefined` in a slot that holds no finite number, and
 * `undefined` for the whole column where the table does not carry it.
 *
 * Aligned rather than compacted: `score` and `balance` are read together by index, and a column
 * that dropped its nulls would pair one row's score with another row's balance and look right.
 */
function numbers(table: TableValue, name: string): (number | undefined)[] | undefined {
  const column = table.data[name]
  if (!column) return undefined
  return column.map((cell) =>
    typeof cell === 'number' && Number.isFinite(cell) ? cell : undefined,
  )
}

function distinct(table: TableValue, name: string): number {
  const column = table.data[name]
  if (!column) return 0
  const seen = new Set<unknown>()
  for (const cell of column) seen.add(cell)
  return seen.size
}

/**
 * The cutoff a click at `fraction` across the histogram means: that bar's **left edge**.
 *
 * The left edge, not the middle, because the cutoff is "at or above" and a reader clicking a bar
 * means "this bar and everything to the right of it". Rounding to the middle would quietly
 * exclude the bar they aimed at.
 */
export function cutoffForFraction(fraction: number): number {
  const bin = Math.min(SCORE_BINS - 1, Math.max(0, Math.floor(fraction * SCORE_BINS)))
  return bin / SCORE_BINS
}
