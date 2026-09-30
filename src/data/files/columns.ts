/**
 * A table file's columns: what each is, which Coda type it is read as, and how a cell becomes one.
 *
 * The schema half and the value half, side by side for invariant 3 — `fileTableSchema` is what
 * the file's node publishes before a byte of data is read, and `decoderFor` is what turns each
 * raw cell into a `CellValue` when one is. Both take the same column and the same dtype, so a
 * picker downstream is offered exactly the columns and types the rows arrive in.
 *
 * ## Sixty-four-bit integers are the whole difficulty
 *
 * Parquet and Arrow carry an `INT64` exactly (the readers hand back a `bigint`), and it is two
 * different things: a neuron id, which must stay text or it names a different neuron (invariant
 * 8), and a count or a size, which somebody will want to sum and chart. Nothing in a file says
 * which, and the schema has to be decided from the footer, before any value is seen. So:
 *
 *  - **Automatic** reads a column as text when its *name* says it is an id — `isIdentifierColumn`,
 *    the one rule the rest of the app already uses (`root_id`, `pre_pt_root_id`, `bodyId`) — or
 *    when Parquet's own statistics show a value past 2^53, which no number column could hold.
 *  - Otherwise the node's **Read as text** picker says, exactly.
 *  - A value past 2^53 reaching a *number* column is refused by name at read time, never rounded:
 *    a rounded id is a different neuron and nothing downstream could tell. Feather keeps no
 *    statistics, so an edge list whose id columns are called `pre` and `post` is where that
 *    refusal is met, and its message names the control that fixes it.
 */

import { isIdentifierColumn } from '../../core/ids'
import type { DType, TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { CellValue, TableFileColumn } from '../../core/values'

/** What a reader learns from a file's footer, before reading a row. Plain data, cacheable. */
export interface FileSummary {
  readonly format: 'parquet' | 'feather'
  readonly columns: readonly TableFileColumn[]
  /** Columns left out because Coda has no cell for them — lists, structs, maps. */
  readonly skipped: readonly string[]
  readonly rows: number | undefined
  readonly blocks: number
  readonly bytes: number
  /** The size and the footer's own bytes, hashed — changes whenever the file is rewritten. */
  readonly fingerprint: string
}

/**
 * A file's column by name, as a reader needs it, or the refusal every reader gives — `what` names
 * the file the way the card does.
 */
export function fileColumn(
  columns: readonly TableFileColumn[],
  name: string,
  what = 'The file',
): TableFileColumn {
  const found = columns.find((c) => c.name === name)
  if (!found) throw new Error(`${what} has no column "${name}".`)
  return found
}

/**
 * The 64-bit columns read as text: the automatic rule, or exactly the chosen list.
 *
 * One function for the node's inference, its `evaluate`, its card and any reader downstream, so
 * none of them can disagree about which columns are text.
 */
export function textColumnsFor(
  summary: FileSummary,
  automatic: boolean,
  chosen: readonly string[],
): string[] {
  const wanted = new Set(chosen)
  return summary.columns
    .filter(
      (c) =>
        c.int64 && (automatic ? isIdentifierColumn(c.name) || c.overflow : wanted.has(c.name)),
    )
    .map((c) => c.name)
}

/** The schema half: every readable column, a text-read 64-bit one as `str`. */
export function fileTableSchema(
  summary: FileSummary,
  textColumns: readonly string[],
): TableSchema {
  const text = new Set(textColumns)
  return tableSchema(
    ...summary.columns.map((c) =>
      column(c.name, c.int64 && text.has(c.name) ? 'str' : c.dtype),
    ),
  )
}

/** The 64-bit columns alone, for the Read as text picker to offer. */
export function int64Schema(summary: FileSummary): TableSchema {
  return tableSchema(
    ...summary.columns.filter((c) => c.int64).map((c) => column(c.name, 'i64')),
  )
}

/**
 * The columns a block index can be built over: integers and text, which a range of ids can be
 * compared against — not a float, a flag or a timestamp.
 */
export function indexableSchema(summary: FileSummary): TableSchema {
  return tableSchema(
    ...summary.columns
      .filter((c) => !c.time && (c.dtype === 'i64' || c.dtype === 'str'))
      .map((c) => column(c.name, c.dtype)),
  )
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** Whether a 64-bit value is beyond what a number column can hold exactly. One test, two readers. */
export function pastSafe(value: bigint): boolean {
  return value > MAX_SAFE || value < -MAX_SAFE
}

/** One decoder for every binary cell and bound: `TextDecoder` is not free to build per cell. */
export const utf8 = new TextDecoder()

/**
 * The value half: a raw cell, as either reader hands it back, into a `CellValue` of `dtype`.
 *
 * Built once per column per read rather than switching per cell. Raw cells are a `bigint` for any
 * 64-bit integer, a number, a string, a boolean, a `Date` (Parquet timestamps), a number of
 * milliseconds (Arrow timestamps), or null.
 */
export function decoderFor(col: TableFileColumn, dtype: DType): (raw: unknown) => CellValue {
  if (col.time) return (raw) => timeText(raw)
  switch (dtype) {
    case 'str':
      return (raw) => {
        if (raw === null || raw === undefined) return null
        if (typeof raw === 'string') return raw
        if (raw instanceof Uint8Array) return utf8.decode(raw)
        return String(raw)
      }
    case 'i64':
      return (raw) => {
        if (raw === null || raw === undefined) return null
        if (typeof raw === 'bigint') {
          if (pastSafe(raw)) throw overflowError(col.name)
          return Number(raw)
        }
        return typeof raw === 'number' ? raw : null
      }
    case 'f64':
      return (raw) =>
        typeof raw === 'number' ? raw : typeof raw === 'bigint' ? Number(raw) : null
    case 'bool':
      return (raw) => (typeof raw === 'boolean' ? raw : null)
  }
}

function timeText(raw: unknown): CellValue {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString()
  if (typeof raw === 'number') return new Date(raw).toISOString()
  if (typeof raw === 'bigint') return new Date(Number(raw)).toISOString()
  return raw === null || raw === undefined ? null : String(raw)
}

function overflowError(name: string): Error {
  return new Error(
    `"${name}" holds integers too large to be a number column — reading them as numbers would ` +
      `round them, and a rounded id names a different neuron. On the Link Table node, untick ` +
      `Detect id columns and choose "${name}" under Read as text — with every other id column ` +
      `the file holds, since the list replaces the automatic choice rather than adding to it.`,
  )
}
