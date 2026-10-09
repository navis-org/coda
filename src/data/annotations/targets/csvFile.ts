/**
 * A CSV file on this machine as an annotation target — somebody's own table of cell types, edited
 * in place.
 *
 * **Every cell is text.** A CSV has no types, and reading `720575940621522189` as a number is a
 * different neuron (invariant 8), so nothing here parses one; the card's text rules apply and a
 * cell is written back exactly as typed. Empty is null both ways.
 *
 * **A record is a row, keyed `{id}#{n}`** — the *n*th row for that id in file order — rather than
 * by position: a row number moves when somebody sorts the file in a spreadsheet between two edits,
 * and the stale-value check would then compare one neuron's cell with another's.
 *
 * **A write re-reads the file and rewrites it whole**, through `checkedWrite` like every target:
 * refuse, re-read, hold what moved, send — one read of the file per write. Writes on one file are
 * queued (`serialiseWrite`), since two overlapping read-modify-writes would each write back a file
 * without the other's change. A row the file does
 * not have (`blank`, shown where a tab asks for it) is appended on its first edit. What a rewrite
 * keeps is the cells, the delimiter, the line ending and the trailing newline; what it does not
 * keep is quoting a cell did not need — a field is quoted only where it holds the delimiter, a
 * quote, a line break or edge whitespace.
 *
 * It writes through the handle the file was picked with (`files/editable.ts`), which only Chromium
 * hands out; anywhere else the backend refuses, a read-only annotation table being no use to anyone.
 */

import { detectDelimiter, splitRows } from '../../csv'
import {
  NO_FILE_WRITES,
  editableFile,
  editableFileState,
  serialiseWrite,
} from '../../files/editable'
import { hasFileHandles } from '../../files/remembered'
import type { RowUpdates } from './checkedWrite'
import { checkedWrite, readOf } from './checkedWrite'
import type {
  AnnotationTarget,
  FieldValue,
  TargetChange,
  TargetField,
  TargetRead,
  TargetRecord,
  TargetWriteResult,
} from './types'

export interface CsvTargetConfig {
  /** The id the file is held by (`holdEditableFile`). */
  file: string
  /** Its name, for the tab and for saying which file is missing. */
  name: string
  /** The column holding the neuron id. */
  keyColumn: string
}

export function csvKey(config: CsvTargetConfig): string {
  return `csv|${config.file}|${config.keyColumn}`
}

/** A file's contents as rows, and what writing them back has to keep. */
interface Parsed {
  header: string[]
  rows: string[][]
  delimiter: string
  newline: string
  trailing: boolean
}

export function parseCsv(text: string): Parsed {
  const delimiter = detectDelimiter(text)
  const [header = [], ...rows] = splitRows(text, delimiter)
  return {
    header,
    rows,
    delimiter,
    newline: text.includes('\r\n') ? '\r\n' : '\n',
    trailing: /\r?\n$/.test(text),
  }
}

/** A field as the file needs it: quoted only where it has to be. */
function quote(cell: string, delimiter: string): string {
  return cell.includes(delimiter) || /["\r\n]|^\s|\s$/.test(cell)
    ? `"${cell.replaceAll('"', '""')}"`
    : cell
}

export function writeCsv(parsed: Parsed): string {
  const line = (row: readonly string[]) =>
    row.map((cell) => quote(cell, parsed.delimiter)).join(parsed.delimiter)
  const text = [parsed.header, ...parsed.rows].map(line).join(parsed.newline)
  return parsed.trailing ? text + parsed.newline : text
}

/** Each row's key, `{id}#{n}`, in file order; a row with no id has none. */
function rowKeys(rows: readonly string[][], at: number): Array<string | undefined> {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const id = (row[at] ?? '').trim()
    if (!id) return undefined
    const n = (seen.get(id) ?? 0) + 1
    seen.set(id, n)
    return `${id}#${n}`
  })
}

const idOfKey = (key: string) => key.slice(0, key.lastIndexOf('#'))

/** A file as one write or read sees it: the handle that writes it, its rows, its id column. */
interface Opened {
  handle: FileSystemFileHandle
  parsed: Parsed
  column: number
  /** Why nothing may be written, or undefined where it may — asked only where it is needed. */
  readOnly?: string | undefined
}

export class CsvTarget implements AnnotationTarget {
  readonly key: string
  readonly label: string
  private readonly config: CsvTargetConfig

  constructor(config: CsvTargetConfig) {
    this.config = config
    this.key = csvKey(config)
    this.label = `CSV · ${config.name}`
  }

  async fields(): Promise<TargetField[]> {
    return fieldsOf(await this.open(true))
  }

  async read(ids: readonly string[], fields: readonly string[]): Promise<TargetRead> {
    const { parsed, column } = await this.open(false)
    const wanted = new Set(ids)
    return readOf(
      ids,
      records(parsed, column, fields, (key) => wanted.has(idOfKey(key))),
    )
  }

  /** Where the file is (`editableFileState`): found after a reload, or allowed again, it is read again. */
  revision(): string {
    return editableFileState(this.config.file)
  }

  blank(id: string, fields: readonly string[]): TargetRecord {
    return { key: `${id}#1`, id, values: Object.fromEntries(fields.map((f) => [f, null])) }
  }

  /**
   * One read of the file per write: the fields, the re-read and the rewrite all see the same
   * snapshot, and the per-file queue keeps every other write of ours out of the gap.
   */
  write(changes: readonly TargetChange[]): Promise<TargetWriteResult> {
    return serialiseWrite(this.config.file, async () => {
      const opened = await this.open(true)
      return checkedWrite(changes, fieldsOf(opened), {
        batch: Number.POSITIVE_INFINITY,
        reread: async (keys, names) => {
          const asked = new Set(keys)
          const byKey = new Map(
            records(opened.parsed, opened.column, names, (key) => asked.has(key)).map(
              (r) => [r.key, r.values] as const,
            ),
          )
          // A row the file does not have is empty, not gone: its first edit appends it.
          return new Map(
            keys.map((key) => [key, byKey.get(key) ?? this.blank(idOfKey(key), names).values]),
          )
        },
        send: (rows) => this.send(opened, rows),
      })
    })
  }

  // -------------------------------------------------------------------------

  /** Apply each row's changes to the snapshot the write read, and write it back. */
  private async send(
    { handle, parsed, column, readOnly }: Opened,
    rows: RowUpdates,
  ): Promise<void> {
    if (readOnly) throw new Error(`"${this.config.name}" cannot be written: ${readOnly}.`)
    const at = new Map<string, number>()
    rowKeys(parsed.rows, column).forEach((key, i) => key && at.set(key, i))
    const index = new Map(parsed.header.map((name, i) => [name, i]))
    const width = parsed.header.length
    for (const [key, values] of rows) {
      let r = at.get(key)
      if (r === undefined) {
        const row = new Array<string>(width).fill('')
        row[column] = idOfKey(key)
        r = parsed.rows.push(row) - 1
        at.set(key, r)
      }
      const row = parsed.rows[r]!
      while (row.length < width) row.push('')
      for (const [field, value] of Object.entries(values)) {
        const i = index.get(field)
        if (i !== undefined) row[i] = cellText(value)
      }
    }
    const writable = await handle.createWritable()
    await writable.write(writeCsv(parsed))
    await writable.close()
  }

  /**
   * The file as it is now, parsed, and where its id column is — and, asked for by `writable`,
   * whether it may be written, which a read has no use for.
   */
  private async open(writable: boolean): Promise<Opened> {
    const { name, keyColumn } = this.config
    const handle = editableFile(this.config.file)
    if (!handle) {
      // Not open here: gone from this browser, or a browser that cannot hold a file to edit at all.
      throw new Error(
        hasFileHandles()
          ? `"${name}" is not open in this browser: choose it again.`
          : `"${name}" cannot be opened here: ${NO_FILE_WRITES}.`,
      )
    }
    const parsed = parseCsv(await (await handle.getFile()).text())
    const column = parsed.header.indexOf(keyColumn)
    if (column < 0) {
      throw new Error(
        `"${name}" has no column "${keyColumn}". It has: ${parsed.header.join(', ') || 'none'}.`,
      )
    }
    if (!writable) return { handle, parsed, column }
    const readOnly =
      (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'
        ? undefined
        : 'writing to it was not allowed — choose it again in the tab’s settings and allow editing'
    return { handle, parsed, column, readOnly }
  }
}

/** The file's columns: the id column read-only, and every one read-only where nothing writes. */
function fieldsOf({ parsed, column, readOnly }: Opened): TargetField[] {
  return parsed.header.map((name, i) => {
    const why = i === column ? 'the id column' : readOnly
    return { name, kind: 'text', ...(why ? { readOnly: why } : {}) }
  })
}

/**
 * The rows as records, built only for the keys `wanted` takes — `rowKeys` still walks every row, a
 * row's `#n` depending on the rows before it, but nobody else's values are copied.
 */
function records(
  parsed: Parsed,
  column: number,
  fields: readonly string[],
  wanted: (key: string) => boolean,
): TargetRecord[] {
  const index = new Map(parsed.header.map((name, i) => [name, i]))
  const rowKey = rowKeys(parsed.rows, column)
  return parsed.rows.flatMap((row, r) => {
    const key = rowKey[r]
    if (!key || !wanted(key)) return []
    const id = idOfKey(key)
    const values: Record<string, FieldValue> = {}
    for (const name of fields) {
      const i = index.get(name)
      const cell = i === undefined ? '' : (row[i] ?? '')
      values[name] = cell === '' ? null : cell
    }
    return [{ key, id, values }]
  })
}

/** A value as a cell: text as typed, a list comma-joined, nothing as empty. */
function cellText(value: FieldValue): string {
  if (value === null) return ''
  return Array.isArray(value) ? value.join(', ') : String(value)
}
