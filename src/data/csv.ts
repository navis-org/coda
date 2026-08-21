/**
 * Delimited text in, a Coda table out.
 *
 * The counterpart to `ui/export.ts`, which writes CSV. It lives here rather than beside that
 * file because reading is a *data* concern — the uploads store keeps what this produces, and
 * nothing about parsing needs a DOM. Headless, so the whole of it is testable without a
 * browser and a future non-React consumer can read a user's file too.
 *
 * Everything is decided from the text itself: the delimiter, whether row one is a header, and
 * each column's dtype. That is a deliberate limit rather than a first cut — see the note on
 * `parseDelimited`.
 */

import type { ColumnSchema, DType } from '../core/types'
import { column, tableSchema } from '../core/types'
import type { ColumnData, TableValue } from '../core/values'
import { makeTable } from '../core/values'

/**
 * Delimiters tried, in preference order.
 *
 * Semicolon and tab are not exotic: a spreadsheet saving "CSV" under a locale that uses the
 * comma as a decimal separator writes semicolons, and everything R and pandas emit by default
 * from `write.table`/`to_csv(sep=)` is tab-separated. Refusing those would refuse most of the
 * files a working scientist actually has.
 */
const DELIMITERS = [',', '\t', ';', '|'] as const

export type Delimiter = (typeof DELIMITERS)[number]

export interface ParsedTable {
  table: TableValue
  delimiter: Delimiter
  /** False when row one looked like data and the columns were named `col_1…`. */
  hasHeader: boolean
  /** Rows whose field count did not match the header's. Padded or trimmed, never dropped. */
  raggedRows: number
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/**
 * One pass, RFC 4180: `"` opens a quoted field, `""` inside one is a literal quote, and a
 * delimiter or newline inside quotes is data.
 *
 * Written as a character loop rather than a regex because a field may legally contain a
 * newline, so the file cannot be split into lines first — which is the bug in every
 * `text.split('\\n').map(l => l.split(','))` CSV reader.
 */
function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let started = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
      started = true
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      started = true
      continue
    }
    if (ch === '\n' || ch === '\r') {
      // Swallow the LF of a CRLF; a bare CR is a line ending in its own right.
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (started || field !== '' || row.length) {
        row.push(field)
        rows.push(row)
      }
      row = []
      field = ''
      started = false
      continue
    }
    field += ch
    started = true
  }
  if (started || field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Which delimiter the file is using, judged on how *consistent* the split is.
 *
 * Counting occurrences would pick the comma out of a tab-separated file of prose, and picking
 * whichever yields the most fields would pick the pipe out of anything containing a table of
 * ASCII art. A real delimited file splits every row into the same number of fields, so the
 * candidate producing one field count across the sample — and more than one field — wins, with
 * `DELIMITERS` order breaking the tie.
 */
function detectDelimiter(text: string): Delimiter {
  const sample = text.slice(0, 64 * 1024)
  let best: Delimiter = ','
  let bestScore = -1
  for (const candidate of DELIMITERS) {
    const rows = splitRows(sample, candidate).slice(0, 20)
    if (rows.length === 0) continue
    const counts = rows.map((r) => r.length)
    const fields = counts[0]!
    if (fields < 2) continue
    const consistent = counts.filter((c) => c === fields).length / counts.length
    // Consistency dominates; field count only separates two equally consistent candidates.
    const score = consistent * 1000 + fields
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

/**
 * Whether row one names the columns.
 *
 * A header is text: the moment any field of the first row parses as a number, that row is
 * data. That is the whole rule, and the two obvious extra conditions are both wrong here.
 * *Blank* names cannot disqualify it — `to_csv()` with an index writes `,a,b` and every such
 * export would be read as headerless. *Duplicated* names cannot either, because `uniqueNames`
 * already suffixes them, and demoting the row to data instead puts the word "type" into the
 * first row of the column it was naming.
 *
 * The remaining ambiguity — an all-text file with no header — is resolved *towards* a header,
 * which is the same bias `pandas.read_csv` takes and the same one a person reading the file
 * would.
 */
function detectHeader(first: string[]): boolean {
  if (first.length === 0) return false
  const trimmed = first.map((f) => f.trim())
  if (trimmed.every((f) => f === '')) return false
  return !trimmed.some((f) => looksNumeric(f))
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Deliberately not `Number(v)`: that accepts '', '0x10', 'Infinity' and whitespace. */
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const INTEGER_RE = /^-?\d+$/

function looksNumeric(text: string): boolean {
  return NUMERIC_RE.test(text) && Number.isFinite(Number(text))
}

/**
 * An integer only when the text survives a round trip.
 *
 * `007` and `0012` are how a zero-padded code is written, and reading them as 7 and 12 loses
 * the thing that made them identifiers; neuron ids past `Number.MAX_SAFE_INTEGER` come back as a
 * different number entirely. Both round-trip badly, so both stay text — which is lossless, and
 * is why the `Text columns` override never has to rescue a value, only a *reading* of one.
 */
function looksIntegral(text: string): boolean {
  if (!INTEGER_RE.test(text)) return false
  const n = Number(text)
  return Number.isSafeInteger(n) && String(n) === text
}

/**
 * Whether reading this as a number would change it.
 *
 * Applied to integer-shaped text only. A float's trailing zeros are formatting — `1.50` and
 * `1.5` are the same measurement — but an integer's are identity, and so is every digit of one
 * past `Number.MAX_SAFE_INTEGER`. Vetoing the *numeric* reading and not merely the integral one
 * is the load-bearing half: without it `007` fails the integer test, passes the float test and
 * arrives as `7` anyway, which is the exact loss the rule exists to prevent.
 */
function losesMeaningAsNumber(text: string): boolean {
  return INTEGER_RE.test(text) && !looksIntegral(text)
}

const TRUE_WORDS = new Set(['true', 'false'])

/**
 * The dtype every non-empty value in a column agrees on.
 *
 * Widening only, and `str` is the floor — one stray value is enough to keep the whole column
 * text, because a column that is 99% numeric and 1% `n/a` is a text column with a convention
 * in it, and reading the other 99% as numbers would silently drop that row's value.
 *
 * `0`/`1` are integers here, never booleans: a synapse count of 1 is not `true`, and there is
 * no way to tell the two apart from the text.
 */
export function inferDType(values: readonly string[]): DType {
  let seen = false
  let integral = true
  let numeric = true
  let boolean = true
  for (const raw of values) {
    if (raw === '') continue
    seen = true
    const v = raw.trim()
    if (boolean && !TRUE_WORDS.has(v.toLowerCase())) boolean = false
    if (integral && !looksIntegral(v)) integral = false
    if (numeric && (!looksNumeric(v) || losesMeaningAsNumber(v))) numeric = false
    if (!boolean && !numeric) return 'str'
  }
  // A column with nothing in it is text: there is no evidence for anything narrower, and str
  // is the one dtype every later value can still be read as.
  if (!seen) return 'str'
  if (boolean) return 'bool'
  if (integral) return 'i64'
  if (numeric) return 'f64'
  return 'str'
}

function toCell(raw: string, dtype: DType): string | number | boolean | null {
  // An empty field is *absent*, never zero. `Number('')` is 0, which is what would otherwise
  // draw a dense stripe of data nobody recorded along the axis of every chart downstream.
  if (raw === '') return null
  const v = raw.trim()
  if (v === '') return dtype === 'str' ? raw : null
  switch (dtype) {
    case 'bool':
      return v.toLowerCase() === 'true'
    case 'i64':
    case 'f64':
      return Number(v)
    default:
      return raw
  }
}

/** `type`, `type_2`, `type_3`… — the suffixing `joinedColumns` and the wide pivot both use. */
function uniqueNames(raw: string[]): string[] {
  const seen = new Map<string, number>()
  return raw.map((name, i) => {
    const base = name.trim() || `col_${i + 1}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}_${n}`
  })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse delimited text into a table, deciding everything from the text.
 *
 * There is no options argument, and that is the design rather than a gap. The parse settings a
 * caller might pass — delimiter, header — are exactly the ones that would have to be *stored*
 * to be honoured on a later run, which puts them in the provenance key and makes the node's
 * stored schema something that can drift from its stored rows. Detecting once, at ingest, and
 * keeping the finished table means the two cannot disagree. The cost is that a file whose
 * shape is undetectable has to be fixed rather than configured.
 */
export function parseDelimited(text: string): ParsedTable {
  // A BOM survives every editor and would otherwise become part of the first column's name,
  // so a file saved from Excel has a first column no picker can find.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const delimiter = detectDelimiter(body)
  const rows = splitRows(body, delimiter)
  if (rows.length === 0) {
    return {
      table: makeTable(tableSchema(), {}, 'table'),
      delimiter,
      hasHeader: false,
      raggedRows: 0,
    }
  }

  const hasHeader = detectHeader(rows[0]!)
  const width = rows[0]!.length
  const names = uniqueNames(
    hasHeader ? rows[0]! : Array.from({ length: width }, (_, i) => `col_${i + 1}`),
  )
  const bodyRows = hasHeader ? rows.slice(1) : rows

  // Ragged rows are padded rather than dropped: a trailing comma or a missing last field is a
  // routine flaw in a hand-edited file, and losing the row silently is worse than a null in it.
  let raggedRows = 0
  const cells: string[][] = names.map(() => new Array<string>(bodyRows.length).fill(''))
  for (let r = 0; r < bodyRows.length; r++) {
    const row = bodyRows[r]!
    if (row.length !== width) raggedRows++
    for (let c = 0; c < width; c++) cells[c]![r] = row[c] ?? ''
  }

  const columns: ColumnSchema[] = []
  const data: Record<string, ColumnData> = {}
  for (let c = 0; c < width; c++) {
    const dtype = inferDType(cells[c]!)
    const name = names[c]!
    columns.push(column(name, dtype))
    data[name] = cells[c]!.map((raw) => toCell(raw, dtype))
  }

  return {
    table: makeTable({ columns }, data, 'table'),
    delimiter,
    hasHeader,
    raggedRows,
  }
}
