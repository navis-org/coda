/**
 * The per-column summary behind `out.describe`, in the two halves invariant 3 requires.
 *
 *   describeSchema()      — the summary's columns. Runs at edit time, no data.
 *   describeTable(table)  — one row per column of the input.
 *
 * Its own file rather than another pair in `tableOps.ts`, because it is the one op here whose
 * output is *about* a table rather than made of one: nothing it emits is a column of the input,
 * so none of that file's machinery — the unit that rides along, the dtype that widens, the
 * `neurons`-ness that survives — applies to it.
 *
 * ## Three decisions, each of which the obvious alternative gets wrong
 *
 * **`describeSchema` takes no arguments, and that is the interesting property.** Every other
 * `*Schema` here is a function of the input's schema; this one is a constant, because the
 * summary's shape is decided by the statistics and not by the data. So the `Summary` port is
 * fully typed before anything has run and before anything is even wired — a column picker
 * downstream fills immediately, which is the opposite end of the range from Pivot, whose
 * columns are named by its data and which needs `observesOutputSchema` to say anything at all.
 *
 * **Only numeric columns get numbers.** `min`, `q1`, `median`, `q3`, `max`, `mean` and
 * `non_zero` are null on a `str` or `bool` column rather than filled with a lexicographic
 * answer nobody asked for: the first cell type in alphabetical order is not a minimum, and a
 * reader scanning a column of numbers has no way to tell that one of them means something else.
 * Counts still apply to everything, so a text column reports `non_nulls`, `nulls` and `unique`
 * and leaves the rest empty — the readout somebody actually wants of an annotation column.
 *
 * **The id column is counted and never measured**, even though it is usually `i64`. Two
 * reasons, and the weaker one is enough on its own. A mean neuron id is not a neuron: it is a
 * number that identifies nothing, printed in a row where every other number identifies
 * something. And `CellValue` is a float64 (invariant 8), so on a source whose ids are eighteen
 * digits the arithmetic would be over values that are already not the ids — a confident wrong
 * answer rather than a blank one. `non_nulls`, `nulls` and `unique` are exact whatever the
 * width, because they compare cells rather than adding them, and `unique` on the id column is
 * the one number anybody reads off it anyway.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { ColumnSchema, TableSchema } from '../../core/types'
import { column, isNumericDType, tableSchema } from '../../core/types'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
/*
 * The type-7 quantile, from the module that already owns it.
 *
 * `boxStats.ts` sits under `ui/viewers` and is headless — its own header says so, and it
 * already imports `nodes/lib/chartSelection`, so this direction is the established one here
 * (`nodes/output/dendrogram.ts` reaches into `ui/encoding` the same way). Worth the reach:
 * "which of the nine quantile definitions" is exactly the kind of thing two copies come to
 * disagree about, and a Distribution node and a Describe node quoting different medians of the
 * same column is a bug nobody would think to look for.
 */
import { quantileSorted } from '../../ui/viewers/boxStats'
import { valueLabel } from './datasetStats'

/**
 * Where the work stops being free.
 *
 * Pivot's number, because it is the same shape of cost — a pass over every cell — and a second
 * threshold half an order of magnitude away would be a claim about a difference that does not
 * exist. What is actually paid above it is the sort per numeric column that the quartiles need;
 * see the node's `evaluate`, which is where the warning is raised.
 */
export const DESCRIBE_CELLS_WARN = 2_000_000

/** The columns carrying a statistic, i.e. the ones a non-numeric column leaves null. */
const MEASURED = ['non_zero', 'min', 'q1', 'median', 'q3', 'max', 'mean'] as const

/**
 * The summary's columns. Constant — see the header.
 *
 * No units anywhere, deliberately. A `min` here is the minimum of whichever column that row is
 * about, and the rows are about columns with different units — nanometres on one line and
 * synapses on the next — so a unit declared on this column would be attached to the wrong
 * quantity on every row but one. The input's unit is not lost: it is still on the table that
 * left by the pass-through port.
 */
export function describeSchema(): TableSchema {
  return tableSchema(
    column('column', 'str'),
    column('dtype', 'str'),
    /*
     * Values present, then absent: `non_nulls + nulls` is the input's row count on every row,
     * which is what makes a `nulls` of 40,000 readable without scrolling back to the node it
     * came from.
     *
     * Spelled out rather than called `n`, which is what it was. `n` is the name `groupBy` gives
     * a *row* count one op over, so the same letter on a row that is about a column would have
     * meant two different things a wire apart — and beside `nulls` and `non_zero` it was the
     * one column here whose name did not say which way it counted.
     */
    column('non_nulls', 'i64'),
    column('nulls', 'i64'),
    column('non_zero', 'i64'),
    column('unique', 'i64'),
    // Five-number order rather than the order somebody would list them in, because read left to
    // right it is the distribution: a row whose q1 and q3 sit against its min and max is a
    // column with a tail, and that is visible as a shape rather than as arithmetic.
    column('min', 'f64'),
    column('q1', 'f64'),
    column('median', 'f64'),
    column('q3', 'f64'),
    column('max', 'f64'),
    column('mean', 'f64'),
  )
}

/**
 * One column's row of the summary.
 *
 * A record rather than positional values, so the two halves cannot drift into disagreeing about
 * an *order* while still agreeing about the names — `makeTable` catches a missing column and
 * catches nothing about a swap.
 */
type SummaryRow = Record<string, CellValue>

/**
 * Memoised on the table object.
 *
 * Not an optimisation looking for a problem: this is called twice for the same table on every
 * run, once by `evaluate` and once by the card, which is handed the node's own pass-through
 * output — the very object `evaluate` was given. Without this, every edit on a `cheap` node
 * sorts every numeric column twice.
 *
 * A cache over a pure function of an immutable input, so invariant 4 is untouched: there is no
 * state here that could make `evaluate` answer differently twice, and a miss costs a recompute
 * rather than a wrong answer. `WeakMap` so the summary lives exactly as long as the table it
 * describes — nothing to evict and nothing to invalidate, since a changed table is a different
 * object.
 *
 * The second thing it buys is identity: the card gets the same `TableValue` back on every
 * render, and `TableViewer` resets its page whenever the table changes identity.
 */
const MEMO = new WeakMap<TableValue, TableValue>()

/** One row per column of `table`, in the input's column order. */
export function describeTable(table: TableValue): TableValue {
  const hit = MEMO.get(table)
  if (hit) return hit
  const built = summarise(table)
  MEMO.set(table, built)
  return built
}

function summarise(table: TableValue): TableValue {
  const rows = table.schema.columns.map((col) => summariseColumn(table, col))
  const data: Record<string, ColumnData> = {}
  for (const col of describeSchema().columns) {
    data[col.name] = rows.map((row) => row[col.name] ?? null)
  }
  return makeTable(describeSchema(), data)
}

/**
 * Whether this column's numbers mean a quantity.
 *
 * The dtype and the name, because both can disqualify a column and only one of them is a type
 * question. See the header on why the id column is counted and never measured.
 */
function isQuantitative(col: ColumnSchema): boolean {
  return isNumericDType(col.dtype) && col.name !== ID_COLUMN_NAME
}

function summariseColumn(table: TableValue, col: ColumnSchema): SummaryRow {
  const data: ColumnData = table.data[col.name] ?? []
  const quantitative = isQuantitative(col)

  /*
   * One pass for the counts, gathering the numbers as it goes.
   *
   * `valueLabel` decides what counts as absent, shared with the Dataset Summary's arithmetic
   * rather than restated — an empty or whitespace-only string is nothing recorded, and `false`
   * is a real answer. It is also the key `unique` deduplicates on, so the count is of distinct
   * values *as printed*, which is the count somebody comparing it against a Group By expects.
   */
  const seen = new Set<string>()
  const numbers: number[] = []
  let nulls = 0
  let nonZero = 0
  for (let row = 0; row < table.length; row++) {
    const cell = data[row]
    const label = valueLabel(cell)
    if (label === null) {
      nulls++
      continue
    }
    seen.add(label)
    if (!quantitative) continue
    /*
     * Non-finite is neither summarised nor counted as non-zero. A NaN in an f64 column is a
     * value that arrived, so it is present and it is distinct — but it has no place in a sort,
     * where it would land wherever the comparator left it and drag a quartile with it.
     */
    if (typeof cell === 'number' && Number.isFinite(cell)) {
      numbers.push(cell)
      if (cell !== 0) nonZero++
    }
  }

  const counts: SummaryRow = {
    column: col.name,
    dtype: col.dtype,
    non_nulls: table.length - nulls,
    nulls,
    unique: seen.size,
  }
  // Explicitly null rather than absent: `summarise` reads every declared column off this
  // record, and an absent key and a null one differ only in which of them `??` has to catch.
  if (!quantitative || numbers.length === 0) {
    for (const name of MEASURED) counts[name] = null
    // A numeric column of nothing but nulls still has a real answer for this one.
    if (quantitative) counts.non_zero = 0
    return counts
  }

  numbers.sort((a, b) => a - b)
  let sum = 0
  for (const value of numbers) sum += value

  return {
    ...counts,
    non_zero: nonZero,
    min: numbers[0]!,
    q1: quantileSorted(numbers, 0.25),
    median: quantileSorted(numbers, 0.5),
    q3: quantileSorted(numbers, 0.75),
    max: numbers[numbers.length - 1]!,
    mean: sum / numbers.length,
  }
}
