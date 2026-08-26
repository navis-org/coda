/**
 * What a *mark* on a chart is called when a viewer hands it back to the graph.
 *
 * The counterpart to [`rowIds.ts`](rowIds.ts), and the distinction between the two is the whole
 * reason this module exists. A scatter lassoes **rows**, so its selection is a list of row ids
 * and `rowIds.ts` owns what a row is called. A pie slice, a box and a histogram bar are not
 * rows: each is an *aggregate* standing for anywhere between one row and a hundred thousand.
 * Storing the rows behind one would put a category's worth of ids into every saved file and
 * every share link, for a gesture whose meaning is one word.
 *
 * So a categorical mark is stored as **its label** and a histogram bar as **its range**, and
 * the node resolves that back into rows at run time. Two consequences, both wanted:
 *
 *  - The selection survives an upstream re-run. A row index does not, and a set of ids only
 *    survives if the ids do — where "the LC4 slice" still means the LC4 slice after a filter
 *    upstream changes which rows are in it.
 *  - It is small. Selecting the largest slice of a 165,122-row table costs four characters.
 *
 * The price is that the column the label was read from becomes part of what the selection
 * *means*, which is why the column params these charts resolve a selection against are **not
 * `presentational`** — exactly the call `out.scatter` makes for its `idColumn`. Marking one
 * presentational would let a stale downstream result survive a change to the very thing that
 * decides which rows `Selected` carries (invariant 4).
 *
 * Both halves live here rather than in the viewers because the label a viewer writes and the
 * label a node matches have to be the same string. Two agreeing implementations drift the
 * first time either is touched — the standing reason `rowIds.ts` is one module imported by
 * both sides, and the reason this one is too.
 */

import type { CellValue, TableValue } from '../../core/values'
import { selectRows } from '../../core/values'
import { rowsMatching } from './rowIds'

/**
 * What a categorical mark is called.
 *
 * Null and undefined become one visible bucket rather than disappearing: a table where a
 * third of the rows have no `type` is the common case here, and a pie that silently omits
 * them misreports every remaining percentage.
 */
export const MISSING_LABEL = '—'

export function markLabel(cell: CellValue | undefined): string {
  return cell === null || cell === undefined ? MISSING_LABEL : String(cell)
}

/**
 * The rows whose value in `column` carries one of the selected labels, in the table's own
 * order — the same "a subset is a subset" property `rowsWithKeys` keeps.
 *
 * An unresolved column, or a label nothing carries any more, yields no rows. Neither is
 * grounds to throw: a stale control is not a reason to block everything downstream
 * (invariant 5's corollary).
 */
export function rowsWithLabels(
  table: TableValue,
  column: string | undefined,
  selection: unknown,
): TableValue {
  const data = column ? table.data[column] : undefined
  // An unresolved column names nothing, which `rowsMatching` reads as an empty selection.
  return rowsMatching(table, (row) => markLabel(data?.[row]), data ? selection : [])
}

// ---------------------------------------------------------------------------
// Histogram bars — a range rather than a label
// ---------------------------------------------------------------------------

/**
 * One histogram bar, as the thing that identifies it.
 *
 * Half-open `[lo, hi)`, because that is how the bar was counted — and `closed` for the last
 * bar, which has to take the maximum or the largest value in the table would fall outside
 * every bar in a picture that plainly contains it. Carrying the flag rather than inferring it
 * is what lets `evaluate` resolve one bar without knowing how many there were: bin count is
 * `presentational`, so it is not in the cache key and nothing would re-run if it changed.
 *
 * The bounds are the *edges the viewer drew*, so a stored selection keeps meaning the bar it
 * was clicked on after the bin count moves under it. It then names a range that no longer
 * lines up with any bar, which is honest — the alternative is a bar index silently re-pointing
 * at different rows.
 */
export interface ValueRange {
  lo: number
  hi: number
  /** Include the upper bound. True only for the topmost bar. */
  closed?: boolean
}

/**
 * `lo:hi`, plus a `:c` suffix on the one closed bar.
 *
 * `Number.prototype.toString` round-trips a double exactly, and neither a minus sign nor an
 * exponent contains a colon, so the split is unambiguous.
 */
export function encodeRange(range: ValueRange): string {
  return `${range.lo}:${range.hi}${range.closed ? ':c' : ''}`
}

export function decodeRange(text: unknown): ValueRange | undefined {
  if (typeof text !== 'string') return undefined
  const parts = text.split(':')
  if (parts.length < 2 || parts.length > 3) return undefined
  const lo = Number(parts[0])
  const hi = Number(parts[1])
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return undefined
  if (parts.length === 2) return { lo, hi }
  // An unrecognised third part is a spelling this build does not know, and guessing at it is
  // how a stored selection quietly comes to mean something else. Rejected rather than read as
  // the open range it happens to resemble.
  return parts[2] === 'c' ? { lo, hi, closed: true } : undefined
}

/** Every well-formed range in a stored selection; a malformed entry is skipped, not thrown on. */
export function decodeRanges(selection: unknown): ValueRange[] {
  if (!Array.isArray(selection)) return []
  const ranges: ValueRange[] = []
  for (const entry of selection) {
    const range = decodeRange(entry)
    if (range) ranges.push(range)
  }
  return ranges
}

/**
 * Read a cell as a number, refusing what `Number()` accepts.
 *
 * `Number(null)`, `Number('')` and `Number(false)` are all 0, so a plain conversion would put
 * every empty cell in whichever bar contains zero — a dense bar of data that does not exist.
 * Same trap `numeric()` in `ui/encoding.ts` and `cellNumber()` in `ui/viewers/scatterPlot.ts`
 * exist for; **not** the same answer, and the difference is deliberate rather than a drift.
 * Those two answer `NaN` and map `false` to 0, because a size channel has to put an
 * unplottable row *somewhere*. Binning does not: a row with no number belongs in no bar, so
 * this one answers `undefined` and rejects booleans, which the caller counts and reports.
 */
export function numericCell(cell: CellValue | undefined): number | undefined {
  if (cell === null || cell === undefined || cell === '' || typeof cell === 'boolean') {
    return undefined
  }
  const value = Number(cell)
  return Number.isFinite(value) ? value : undefined
}

/** The rows whose value in `column` falls inside any selected range, in the table's own order. */
export function rowsInRanges(
  table: TableValue,
  column: string | undefined,
  selection: unknown,
): TableValue {
  const ranges = decodeRanges(selection)
  const data = column ? table.data[column] : undefined
  const rows: number[] = []
  if (ranges.length > 0 && data) {
    for (let row = 0; row < table.length; row++) {
      const value = numericCell(data[row])
      if (value === undefined) continue
      for (const range of ranges) {
        if (value >= range.lo && (range.closed ? value <= range.hi : value < range.hi)) {
          rows.push(row)
          break
        }
      }
    }
  }
  // Not `rowsMatching`: a range is a *test* rather than a name, so there is no string to
  // compare and nothing the shared loop could do with it.
  return selectRows(table, rows)
}
