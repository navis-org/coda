/**
 * One row per matrix line — the Reduce Matrix node's two halves.
 *
 * The way out of a matrix for everything that is not a picture. A `MatrixValue` can be
 * normalised, clustered, embedded and drawn, and until now that was the whole list: nothing
 * downstream of one could compute a per-neuron number, because `Linkage` reads a matrix as
 * *distances* and every other node that takes numbers takes a table. So a ZapBench trace
 * matrix — 3,000 neurons against 7,879 timesteps — was a dead end for the question people
 * actually ask of it, which is "which of these neurons is most active", and the answer to that
 * is a column, not a heatmap.
 *
 * ## The axis word names what comes out, not what is consumed
 *
 * `axis: 'rows'` reduces **each row across its columns** and yields one output row per matrix
 * row. That is `matrixShape.ts`' convention — `axisTotals(m, 'rows')` is already a per-row
 * vector, and `labelsOf(m, 'rows')` already names the lines that survive — and the two files
 * share `MatrixAxis` so they cannot drift apart on it.
 *
 * It is worth saying out loud because the *user's* phrasing is the opposite one: "reduce over
 * the columns" is this same operation named after the axis that disappears. Both readings are
 * reasonable and the wrong one is a silently transposed answer, so the control's options name
 * both halves ("each row, across its columns") rather than picking a side.
 *
 * ## Absence
 *
 * Non-finite cells are skipped, which is `axisTotals`' rule and the one the ZapBench node's
 * `unmatched: null` setting is built for: a neuron with no `zapbenchId` arrives as a row of
 * `NaN`, and what should come out is *no measurement* rather than a zero among real ones.
 *
 * A line with no finite cell at all therefore follows `groupByTable`'s null rule exactly:
 * `mean`, `sd`, `min`, `max` and `median` answer **null**, where zero would be a manufactured
 * measurement; `sum` answers **0**, which is the identity of addition rather than a value; and
 * `n` answers 0, which is the count it was asked for. `sd` is null below *two* finite cells —
 * `profileStats`' rule, for its reason: a single value has no spread and 0 claims it was
 * measured to have none.
 *
 * ## The diagonal needs labels that line up, and that departs from `skip_self`
 *
 * `Exclude diagonal` drops cell `(i, i)` — but only where `isSquarePopulation` holds, and
 * otherwise it is ignored with a warning. `neuron.nblastMatches` made the opposite call
 * deliberately (`skip_self` "is the diagonal rather than a name comparison") and was right to:
 * it is holding parity with navis, and its matrix arrives from NBLAST one node up.
 *
 * Here any matrix arrives. A 400-neuron trace matrix over a 400-timestep condition window is
 * square and its diagonal is 400 real measurements, so a positional rule would silently delete
 * them from every statistic on the card. Requiring the labels to agree costs nothing where the
 * control is meant — a similarity, NBLAST or adjacency matrix over one neuron set has identical
 * label lists by construction — and refuses to guess where it is not. The predicate is
 * `linkageOps.ts`', which is where the same two questions are already asked of the same
 * matrices as a refusal.
 */

import type { Warner } from '../../core/limits'
import type { ParamValues } from '../../core/node'
import { quantileSorted } from '../../core/stats'
import type { ColumnSchema, TableSchema } from '../../core/types'
import { column } from '../../core/types'
import type { ColumnData, MatrixValue, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { isSquarePopulation } from './linkageOps'
import type { MatrixAxis } from './matrixShape'
import { labelsOf } from './matrixShape'
import { LABEL_COLUMN_NAME } from './tableOps'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The statistics one line can be reduced to.
 *
 * Deliberately not `AggFn`, which is the vocabulary of `Group By` and `Pivot`. Three of those
 * seven make no sense over a matrix line — `count` counts rows, `countDistinct` counts distinct
 * values and `join` produces text — and two of these seven are missing from it, because a
 * long table's aggregations have never needed `sd` or `median`. One shared type would be a
 * union with five members excluded at each of the two call sites; `describeOps.ts`' third list
 * is the same decision taken twice already.
 */
export type ReduceStat = 'n' | 'sum' | 'mean' | 'sd' | 'min' | 'max' | 'median'

/** The chips, in the order the control offers them. */
export const REDUCE_STAT_OPTIONS: Array<{ value: ReduceStat; label: string }> = [
  { value: 'mean', label: 'mean' },
  { value: 'median', label: 'median' },
  { value: 'sd', label: 'sd' },
  { value: 'min', label: 'min' },
  { value: 'max', label: 'max' },
  { value: 'sum', label: 'sum' },
  { value: 'n', label: 'n' },
]

const STATS = new Set<string>(REDUCE_STAT_OPTIONS.map((option) => option.value))

/**
 * Which lines survive, named by both halves.
 *
 * The value is `matrixShape.ts`' `MatrixAxis` — the axis that *remains* — and the label names
 * the axis that disappears beside it, because the header's transposition trap is exactly the
 * one a two-word label walks somebody into.
 */
export const REDUCE_AXIS_OPTIONS: Array<{ value: MatrixAxis; label: string }> = [
  { value: 'rows', label: 'each row, across its columns' },
  { value: 'columns', label: 'each column, down its rows' },
]

export interface ReduceOptions {
  axis: MatrixAxis
  /** In the order chosen, without repeats. Empty means the labels alone. */
  stats: ReduceStat[]
  /** Prepended to every statistic's column name, `_`-joined. */
  prefix: string
  excludeDiagonal: boolean
}

/**
 * The four params, read once — the node, both exporters and the tests.
 *
 * `readOrderOptions`' arrangement, for its reason: a stored param is `unknown`, and a narrowing
 * written per caller is where the node and an emitter come to disagree about what an unset
 * control meant. Both readings are **derived from the option lists** rather than restating
 * them, which is `enumValue`'s rule for a reader that cannot reach the definition: a third axis
 * added to `REDUCE_AXIS_OPTIONS` would otherwise read as `rows` in the node and in both
 * emitters, silently.
 */
export function readReduceOptions(params: ParamValues): ReduceOptions {
  const stored = Array.isArray(params.stats) ? params.stats : []
  return {
    axis: REDUCE_AXIS_OPTIONS.find((option) => option.value === params.axis)?.value ?? 'rows',
    // The `Set` drops a repeat, which would name two columns the same thing and describe a
    // table whose data has one — `aggValueColumns`' rule, one file over.
    stats: [...new Set(stored.map(String))].filter((name): name is ReduceStat =>
      STATS.has(name),
    ),
    prefix: String(params.prefix ?? '').trim(),
    excludeDiagonal: params.excludeDiagonal === true,
  }
}

/**
 * What a statistic's column is called. One place, so both halves agree (invariant 3).
 *
 * A trailing separator the user typed is dropped rather than doubled: `zap` and `zap_` both
 * give `zap_mean`, because a control whose help says it produces `zap_mean` should produce it
 * for either thing somebody types into it.
 */
export function reduceColumnName(stat: ReduceStat, prefix: string): string {
  const base = prefix.replace(/[\s_]+$/, '')
  return base ? `${base}_${stat}` : stat
}

// ---------------------------------------------------------------------------
// The schema half
// ---------------------------------------------------------------------------

/**
 * The output columns, from the params alone.
 *
 * Exact at edit time with nothing observed, which is what `observesOutputSchema` exists for and
 * what this node does not need it for: the label column is constant and every other name is a
 * chip beside a prefix. Column pickers downstream fill the moment the chips are ticked.
 *
 * The input schema contributes nothing — a matrix has no columns, only labels — so this takes
 * options rather than a schema, which is where it departs from every other pair in
 * `tableOps.ts`.
 */
export function reduceMatrixSchema(options: ReduceOptions): TableSchema {
  const columns: ColumnSchema[] = [column(LABEL_COLUMN_NAME, 'str')]
  for (const stat of options.stats) {
    // `n` is a count; everything else is a measurement over floats.
    columns.push(column(reduceColumnName(stat, options.prefix), stat === 'n' ? 'i64' : 'f64'))
  }
  return { columns }
}

// ---------------------------------------------------------------------------
// The value half
// ---------------------------------------------------------------------------

/** Every statistic, and the six of them one pass produces whether or not they were ticked. */
const ALL_STATS: ReduceStat[] = REDUCE_STAT_OPTIONS.map((option) => option.value)
const SINGLE_PASS_STATS: ReduceStat[] = ALL_STATS.filter((stat) => stat !== 'median')

/** One line's accumulators, filled in a single pass. */
interface LineStats {
  n: number
  sum: number
  mean: number
  /** Welford's `M2`; `sd` is `sqrt(M2 / (n - 1))`. */
  m2: number
  min: number
  max: number
  median: number
}

/** Everything one set of numbers-affecting options produces, under the statistic's bare name. */
interface Reduction {
  labels: ColumnData
  columns: Partial<Record<ReduceStat, ColumnData>>
  warnings: string[]
}

/**
 * The last reduction of one input matrix, so renaming a column does not recompute it.
 *
 * Two params in the provenance key change no number. **`Prefix` names the output columns**, so
 * it has to be in the key (invariant 4) and reaches `inferOutputs` and every picker downstream
 * — which is also why it cannot be `presentational`; it is the bill for this node owning a
 * naming concern `core.rename` would otherwise, argued at the node. And **the chips** decide
 * which columns come out, where the single pass computes all six of the cheap ones regardless:
 * `min` costs two compares and Welford's `m2` two multiplies, against a division for the mean
 * that every ticking pays anyway.
 *
 * So the key is `axis`, `Exclude diagonal` and whether `median` was asked for — nothing else —
 * and everything else re-enters `evaluate` free. Measured on a 3,000 × 7,879 matrix: **108 ms**
 * for the six single-pass statistics and **1,175 ms** once `median` is ticked, which is a sort
 * per line, against **0.0 ms** for a prefix keystroke and **0.0 ms** for ticking any of the six.
 * Unticking `median` costs the 108 ms again, the key having changed back. Typing is one to
 * three recomputes rather than one per character — `TextField` commits on a 220 ms debounce and
 * the scheduler waits ~180 ms behind it — which is still seconds of a blocked main thread
 * against a memo that costs one slot.
 *
 * **One slot, not `heatmap.ts`' `LruMap` of them.** That file keeps four because two Heatmaps
 * read one upstream matrix with different tabs and a miss there is a Pyodide round trip; here
 * the keys number at most eight and a session touches one or two, so a second slot would buy
 * only flipping the axis back and forth. What is retained is `lines × 6` boxed cells, not a
 * second copy of the grid.
 *
 * Warnings are held with the answer and replayed, or the "Exclude diagonal was ignored" line
 * would vanish from a card the moment somebody typed a prefix — which is the cache showing
 * through. That capture-and-replay contract is now in five places (`heatmap.ts`' `SHAPED`,
 * `displayLabels.ts`' `JOINS`, `editTable.ts`' `PLANS`, `neuronSearch.ts`, here) and wants one
 * helper beside `LruMap`; this is the smallest of the five and a poor first caller for it.
 */
const REDUCED = new WeakMap<MatrixValue, { key: string; reduction: Reduction }>()

function reductionKey(options: ReduceOptions): string {
  return JSON.stringify([
    options.axis,
    options.excludeDiagonal,
    options.stats.includes('median'),
  ])
}

export function reduceMatrixTable(
  matrix: MatrixValue,
  options: ReduceOptions,
  /** Where an ignored `Exclude diagonal` is reported. `SILENT` for a caller with nobody to tell. */
  ctx: Warner,
): TableValue {
  const key = reductionKey(options)
  let held = REDUCED.get(matrix)
  if (held?.key !== key) {
    held = { key, reduction: reduce(matrix, options) }
    REDUCED.set(matrix, held)
  }
  const { reduction } = held
  for (const message of reduction.warnings) ctx.warn(message)

  const data: Record<string, ColumnData> = { [LABEL_COLUMN_NAME]: reduction.labels }
  for (const stat of options.stats) {
    /*
     * The key pins which statistics the entry holds — the six single-pass ones always, and
     * `median` exactly when it was asked for — so a ticked statistic is always there. Read
     * without asserting it anyway: `makeTable` refuses a schema column with no data by name,
     * which is a better failure than a `!` that hands on an `undefined`.
     */
    const values = reduction.columns[stat]
    if (values) data[reduceColumnName(stat, options.prefix)] = values
  }
  return makeTable(reduceMatrixSchema(options), data)
}

function reduce(matrix: MatrixValue, options: ReduceOptions): Reduction {
  const rows = matrix.rowLabels.length
  const cols = matrix.colLabels.length

  /*
   * One index walk for both axes rather than two loops. A row is `cols` cells one apart, a
   * column is `rows` cells `cols` apart — so the reduction below never mentions an axis again,
   * and the strided half cannot come to disagree with the contiguous one about absence or about
   * the diagonal.
   *
   * The strided walk reads eight times the cache lines, so a blocked gather per axis was costed
   * — and measured away. On a 3,000 × 7,879 matrix the six statistics take **108 ms** down the
   * rows against **114 ms** across the columns, and with `median` ticked the strided walk is
   * the *faster* of the two (929 ms against 1,175): both are bound by the 189 MB the grid
   * occupies rather than by line fetches, and the prefetcher has a constant stride to work with
   * either way. A second spelling of the arithmetic would buy 6 ms.
   */
  const [lines, span, step, stride] =
    options.axis === 'rows' ? [rows, cols, 1, cols] : [cols, rows, cols, 1]

  const warnings: string[] = []
  const skipDiagonal = options.excludeDiagonal && isSquarePopulation(matrix)
  if (options.excludeDiagonal && !skipDiagonal) {
    warnings.push(
      `Exclude diagonal ignored: this ${rows} × ${cols} matrix has different row and ` +
        `column labels, so there is no self-comparison on its diagonal.`,
    )
  }

  // Allocated once and reused per line, not per statistic: `median` is the only one that needs
  // the values rather than a running total, and a fresh array per line is `lines` allocations
  // of `span` floats for an answer that is one number.
  const wantMedian = options.stats.includes('median')
  const sorted = wantMedian ? new Float64Array(span) : undefined
  const produced = wantMedian ? ALL_STATS : SINGLE_PASS_STATS

  /*
   * No `.fill()`: the loop below writes every slot of every column, so an initialiser is
   * `lines × stats` discarded writes — the mistake `zapbench/traces.ts` recorded making with a
   * 63-million-cell one. `new Array(n)` still reports the length `makeTable` checks.
   */
  const columns: Partial<Record<ReduceStat, ColumnData>> = {}
  const out = produced.map((stat) => {
    const values = new Array<number | null>(lines)
    columns[stat] = values
    return values
  })

  // Nothing ticked is the labels alone, and then there is nothing to read: a matrix this node
  // only names the lines of must not be walked cell by cell to do it.
  if (options.stats.length > 0) {
    for (let line = 0; line < lines; line++) {
      const stats = reduceLine(
        matrix.values,
        line * stride,
        span,
        step,
        skipDiagonal ? line : -1,
        sorted,
      )
      // Indexed rather than keyed: the stat names are a per-cell string lookup otherwise.
      for (let i = 0; i < produced.length; i++) out[i]![line] = valueOf(stats, produced[i]!)
    }
  }

  return { labels: labelsOf(matrix, options.axis).slice(), columns, warnings }
}

/**
 * One line, in one pass.
 *
 * Welford rather than `Σx²  − (Σx)²/n`: the closed form loses every significant digit when the
 * mean is large against the spread. Measured on `[b+1, b+2, b+3]`, whose sd is 1 at every `b`:
 * it is right to 1e7, answers **0** at 1e8 and 1e9, and at 1e10 answers a negative variance and
 * so `NaN` under the root. The 0 is the worse failure, being a claim that the line is constant.
 *
 * Positional arguments and a `skipAt` of `-1`, because both were read *per cell* off an options
 * object in the first version — 47 million property loads on a trace matrix, and a literal
 * allocated per line for two scalars.
 */
function reduceLine(
  values: Float64Array,
  start: number,
  span: number,
  step: number,
  /** The offset along this line holding its own self-comparison, or `-1` for none. */
  skipAt: number,
  /** Scratch for the median, filled with the finite cells. Absent when nothing needs it. */
  sorted: Float64Array | undefined,
): LineStats {
  let n = 0
  let sum = 0
  let mean = 0
  let m2 = 0
  let min = Infinity
  let max = -Infinity
  let at = start
  for (let j = 0; j < span; j++, at += step) {
    if (j === skipAt) continue
    const v = values[at]!
    if (!Number.isFinite(v)) continue
    n += 1
    sum += v
    const delta = v - mean
    mean += delta / n
    m2 += delta * (v - mean)
    if (v < min) min = v
    if (v > max) max = v
    if (sorted) sorted[n - 1] = v
  }
  let median = NaN
  if (n > 0 && sorted) {
    /*
     * A full sort where a selection would do, and the one place this file leaves real time on
     * the table: the sort is ~307M comparisons for 3,000 lines of 7,879 — nine tenths of the
     * 1,175 ms — where quickselect would be ~2-3n and about 3.5× faster.
     *
     * Not taken here, because `quantileSorted` is the app's one definition of a quantile
     * (`core/stats.ts`, moved down there precisely so there would not be two) and a selection
     * written in this file would be a second definition of the median. If it is wanted it
     * belongs beside `quantileSorted` as a second entry point, with the sort as its oracle.
     */
    const window = sorted.subarray(0, n)
    window.sort()
    median = quantileSorted(window, 0.5)
  }
  return { n, sum, mean, m2, min, max, median }
}

/** A statistic's cell, with the null rule the header states applied in one place. */
function valueOf(stats: LineStats, stat: ReduceStat): number | null {
  switch (stat) {
    case 'n':
      return stats.n
    // The identity of addition, where every other absence is a missing measurement.
    case 'sum':
      return stats.sum
    case 'mean':
      return stats.n > 0 ? stats.mean : null
    case 'median':
      return stats.n > 0 ? stats.median : null
    // Null below two, never 0: one cell has no spread rather than a spread of nothing.
    case 'sd':
      return stats.n > 1 ? Math.sqrt(stats.m2 / (stats.n - 1)) : null
    case 'min':
      return stats.n > 0 ? stats.min : null
    case 'max':
      return stats.n > 0 ? stats.max : null
  }
}
