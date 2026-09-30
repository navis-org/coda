/**
 * A Delta table as one table file: its live data files are the blocks, read through the Parquet
 * reader each already is.
 *
 * **A block is a file, and a file's own row groups are skipped inside it.** A lookup is ruled out
 * of a whole file by the min/max its `add` carries in the log — no request at all — and only a
 * file that survives has its footer read, where each row group's statistics rule out the rest.
 * Opening every file's footer up front would be one request per live file per worker before a row
 * is read; CAVE's tables are dozens of files and the bigger ones will be thousands.
 *
 * Everything above `TableFileReader` is unchanged by this — the worker split divides files, a block
 * index is kept per file, a Filter Table's conditions apply to the rows fetched — because this
 * *is* one. What it adds over the files it reads:
 *
 *  - **names**: the table's columns by their logical names, the files' by their physical ones
 *    (column mapping, `log.ts`);
 *  - **partition columns**, which are not in the files at all: one value per file, from the log;
 *  - **deletion vectors**, the rows of a file marked deleted without rewriting it
 *    (`deletionVectors.ts`) — left out of every read, and a file carrying one gives up the raw
 *    runs the fast paths read, since its rows are no longer the file's.
 */

import type { TableFileColumn } from '../../../core/values'
import type { ByteSource } from '../bytes'
import { withTail } from '../bytes'
import type { FileSummary } from '../columns'
import { pastSafe, wideDecimal } from '../columns'
import type { ParquetReader } from '../parquet'
import { openParquet } from '../parquet'
import type { ColumnRun, IdProbe, Matches, RawBlock, TableFileReader } from '../reader'
import { lowerBound, matchesByColumns, mayHoldRange, runGetter } from '../reader'
import {
  deletedRows,
  deletionVectorFile,
  vectorBytes,
  vectorRange,
  z85Decode,
} from './deletionVectors'
import type { DeltaField, DeltaFile, DeltaSnapshot, DeltaStat } from './log'

/** How a reader reaches an object by URL: bytes of a known size, read by range. */
type OpenObject = (url: string, size: number) => ByteSource

/** Where a path the log names is: an absolute URI as written, or a path under the root. */
function objectUrl(root: string, path: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? path : `${root}/${path}`
}

/** One data file, open: its reader, and its deleted rows once something has asked for them. */
interface OpenFile {
  readonly block: number
  readonly reader: Promise<ParquetReader>
  deleted?: Promise<Float64Array | undefined>
}

export async function openDelta(
  snapshot: DeltaSnapshot,
  open: OpenObject,
): Promise<TableFileReader> {
  const { files } = snapshot
  const byName = new Map(snapshot.fields.map((f) => [f.name, f]))
  const partitioned = new Set(snapshot.partitionColumns)
  const fieldOf = (name: string): DeltaField => {
    const field = byName.get(name)
    if (!field) throw new Error(`The Delta table has no column "${name}".`)
    return field
  }

  // One file held open at a time. Every reader walks blocks in ascending order and does not come
  // back, and a footer, its kept tail and a deletion vector for every file ever opened is what a
  // whole-table read of thousands of files would otherwise hold to its end.
  let current: OpenFile | undefined
  const fileOf = (block: number): OpenFile => {
    if (current?.block !== block) {
      const file = files[block]!
      const bytes = withTail(open(objectUrl(snapshot.root, file.path), file.size))
      current = { block, reader: openParquet(bytes) }
    }
    return current
  }
  const deletedIn = (file: OpenFile) =>
    (file.deleted ??= readDeleted(snapshot.root, files[file.block]!, open))

  /**
   * `names` as one file holds them: the stored ones under both names, and each partition column's
   * one value — as the column's cells would arrive from a file, were it in one.
   */
  const split = (names: readonly string[], file: DeltaFile) => {
    const stored = names.filter((name) => !partitioned.has(name))
    return {
      stored,
      physical: stored.map((name) => fieldOf(name).physical),
      constants: names
        .filter((name) => partitioned.has(name))
        .map((name): [string, unknown] => [name, partitionCell(fieldOf(name), file)]),
    }
  }

  return {
    summary: deltaSummary(snapshot),

    mayHold(block: number, name: string, probe: IdProbe): boolean {
      const field = fieldOf(name)
      const file = files[block]!
      if (partitioned.has(name)) {
        const value = partitionCell(field, file)
        return value === null ? false : mayHoldRange(value, value, probe)
      }
      const min = file.min?.[field.physical]
      const max = file.max?.[field.physical]
      if (min === undefined || max === undefined) return true
      return mayHoldRange(bound(field.type, min), bound(field.type, max), probe)
    },

    async readBlock(
      block: number,
      wanted: readonly string[],
      head?: number,
    ): Promise<RawBlock> {
      const { stored, physical, constants } = split(wanted, files[block]!)
      const file = fileOf(block)
      const [reader, gone] = await Promise.all([file.reader, deletedIn(file)])
      // A capped read stops once it has its rows, where a file is otherwise read whole to keep its
      // first thousand: inside a row group where no row of the file is deleted, and otherwise at
      // the group that covers the cap, the deleted rows among those read allowed for.
      const groups: RawBlock[] = []
      const starts: number[] = []
      let read = 0
      for (let g = 0; g < reader.summary.blocks; g++) {
        const left = head === undefined || gone?.length ? undefined : head - read
        const group = await reader.readBlock(g, physical, left)
        groups.push(group)
        starts.push(read)
        read += group.rows
        if (head !== undefined && read - (gone ? lowerBound(gone, read) : 0) >= head) break
      }
      const columns: Record<string, (row: number) => unknown> = {}
      const runs: Record<string, ColumnRun[]> = {}
      stored.forEach((name, i) => {
        runs[name] = joinRuns(groups, starts, physical[i]!)
        columns[name] = runGetter(runs[name], read)
      })
      for (const [name, value] of constants) columns[name] = () => value
      const deleted = gone?.subarray(0, lowerBound(gone, read))
      if (!deleted?.length) return { rows: read, columns, runs }
      // The rows the vector leaves, and every column read through them. Runs describe the file's
      // rows, which these no longer are, so the fast paths take the slower route.
      const kept = keptRows(read, deleted)
      for (const name of Object.keys(columns)) {
        const get = columns[name]!
        columns[name] = (row) => get(kept[row]!)
      }
      return { rows: kept.length, columns }
    },

    async readMatches(block, keys, probe, outputs): Promise<Matches | undefined> {
      // A key that is a partition column matches the whole file or none of it: read through
      // `readBlock`, which has the value for every row.
      if (keys.some((name) => partitioned.has(name))) return undefined
      const file = fileOf(block)
      const reader = await file.reader
      const physicalKeys = keys.map((name) => fieldOf(name).physical)
      const { stored, physical, constants } = split(outputs, files[block]!)
      const rows: number[] = []
      const values: Record<string, unknown[]> = Object.fromEntries(stored.map((n) => [n, []]))
      let start = 0
      for (let g = 0; g < reader.summary.blocks; g++) {
        const from = start
        start += reader.rowsIn(g)
        if (!physicalKeys.some((key) => reader.mayHold(g, key, probe))) continue
        const found =
          (await reader.readMatches?.(g, physicalKeys, probe, physical)) ??
          (await matchesByColumns(reader, g, physicalKeys, probe, physical))
        for (const row of found.rows) rows.push(from + row)
        stored.forEach((name, i) => {
          // A loop, not a spread: a group's matches can be more than a call takes arguments.
          const into = values[name]!
          for (const value of found.values[physical[i]!]!) into.push(value)
        })
      }
      // Matches in rows the vector deleted are not matches; the rest keep their place. With no
      // match there is nothing for a vector to remove, and it is not fetched.
      const gone = rows.length ? await deletedIn(file) : undefined
      const keep = gone?.length
        ? rows.map((row) => gone[lowerBound(gone, row)] !== row)
        : undefined
      const kept = <V>(list: readonly V[]) => (keep ? list.filter((_, i) => keep[i]) : list)
      const out: Record<string, readonly unknown[]> = {}
      for (const name of stored) out[name] = kept(values[name]!)
      const live = kept(rows)
      for (const [name, value] of constants) out[name] = live.map(() => value)
      return { rows: live, values: out }
    },
  }
}

/** A partition column's one value in a file, as the column's cells arrive from a file. */
function partitionCell(field: DeltaField, file: DeltaFile): unknown {
  return cellOf(field.type, file.partition[field.physical] ?? null)
}

/** The table's summary: its columns by their logical names, its live files as its blocks. */
function deltaSummary(snapshot: DeltaSnapshot): FileSummary {
  const columns: TableFileColumn[] = []
  const skipped: string[] = []
  for (const field of snapshot.fields) {
    const column = describe(field, snapshot.files)
    if (column) columns.push(column)
    else skipped.push(field.name)
  }
  const counted = snapshot.files.every((f) => f.rows !== undefined)
  const rows = counted
    ? snapshot.files.reduce((n, f) => n + f.rows! - (f.dv?.cardinality ?? 0), 0)
    : undefined
  return {
    format: 'delta',
    version: snapshot.version,
    columns,
    skipped,
    rows,
    blocks: snapshot.files.length,
    bytes: snapshot.files.reduce((n, f) => n + f.size, 0),
    fingerprint: snapshot.fingerprint,
  }
}

/** Spark's integer types; `long` is the one a number column may not hold. */
const INTEGERS: ReadonlySet<string> = new Set(['long', 'integer', 'short', 'byte'])

/** A Spark type as a Coda column, or undefined for one Coda has no cell for. */
function describe(field: DeltaField, files: readonly DeltaFile[]): TableFileColumn | undefined {
  const { name, type } = field
  const decimal = /^decimal\((\d+),\s*(\d+)\)$/.exec(type)
  if (decimal) {
    return wideDecimal(Number(decimal[1]), Number(decimal[2]))
      ? undefined
      : { name, dtype: 'f64' }
  }
  if (type === 'long') {
    // Past 2^53 somewhere in the log's stats: no number column can hold it.
    const wide = files.some((f) =>
      [f.min?.[field.physical], f.max?.[field.physical]].some(
        (v) => typeof v === 'string' && pastSafe(BigInt(v)),
      ),
    )
    return wide
      ? { name, dtype: 'i64', int64: true, overflow: true }
      : { name, dtype: 'i64', int64: true }
  }
  if (INTEGERS.has(type)) return { name, dtype: 'i64' }
  switch (type) {
    case 'double':
    case 'float':
      return { name, dtype: 'f64' }
    case 'boolean':
      return { name, dtype: 'bool' }
    case 'string':
      return { name, dtype: 'str' }
    case 'date':
    case 'timestamp':
    case 'timestamp_ntz':
      return { name, dtype: 'str', time: true }
    default:
      return undefined
  }
}

/** A partition value, written as text in the log, as the file's own cells of that type arrive. */
function cellOf(type: string, value: string | null): unknown {
  if (value === null) return null
  if (type === 'long') return BigInt(value)
  if (INTEGERS.has(type) || type === 'double' || type === 'float') return Number(value)
  return type === 'boolean' ? value === 'true' : value
}

/** A stats bound as the range test compares it: an integer column's as a `bigint`. */
function bound(type: string, value: DeltaStat): unknown {
  const whole =
    typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
  return INTEGERS.has(type) && whole ? BigInt(value) : value
}

/**
 * One column's runs across the row groups read of a file, laid end to end: each group's own,
 * moved to where the group starts. The Parquet reader hands every column it read as runs.
 */
function joinRuns(
  groups: readonly RawBlock[],
  starts: readonly number[],
  name: string,
): ColumnRun[] {
  return groups.flatMap((group, g) =>
    (group.runs?.[name] ?? []).map((run) => ({
      start: starts[g]! + run.start,
      values: run.values,
    })),
  )
}

/** A file's deleted rows, ascending, or undefined where it has no deletion vector. */
async function readDeleted(
  root: string,
  file: DeltaFile,
  open: OpenObject,
): Promise<Float64Array | undefined> {
  const { dv } = file
  if (!dv) return undefined
  if (dv.storageType === 'i') return deletedRows(z85Decode(dv.pathOrInlineDv), dv.cardinality)
  const url =
    dv.storageType === 'u'
      ? `${root}/${deletionVectorFile(dv)}`
      : objectUrl(root, dv.pathOrInlineDv)
  const [from, to] = vectorRange(dv)
  const bytes = await open(url, to).read(from, to)
  return deletedRows(vectorBytes(dv, bytes), dv.cardinality)
}

/** The rows of `total` a vector leaves, ascending. */
function keptRows(total: number, gone: Float64Array): Uint32Array {
  const kept = new Uint32Array(total - gone.length)
  let at = 0
  let skip = 0
  for (let row = 0; row < total; row++) {
    if (skip < gone.length && gone[skip] === row) skip++
    else kept[at++] = row
  }
  return kept
}
