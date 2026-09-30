/**
 * Parquet, read a row group at a time — a keyed read through the fast path where its pages allow
 * (`pages.ts`), and everything else through `hyparquet`.
 *
 * **One row group per read, never a span of them.** `hyparquet` prefetches every byte range a read
 * plan covers, concurrently, so a read spanning the whole file would pull the whole file into
 * memory at once — the thing this module exists to avoid. A row group is the unit a writer chose
 * to be read whole (pandas and polars default to about a million rows), and reading them one after
 * another keeps memory at one group's worth of the chosen columns. Each read is handed metadata
 * naming only its own group, so planning it does not walk every group in the file either.
 *
 * **Statistics are what make a lookup cheap.** Each column chunk in the footer carries its min and
 * max, so a group whose range cannot contain any of the ids asked about is skipped without a byte
 * of it being read. That pays only when the file is sorted by the id column — shuffled, every
 * group spans every id — which is why the node says so.
 *
 * **SNAPPY or uncompressed only**, because that is what `hyparquet` decodes without a compressor
 * module this build does not carry. `pandas` and `pyarrow` write SNAPPY by default; `polars`
 * writes ZSTD, so its files are refused at open with the one line that rewrites them.
 */

import type { FileMetaData, Statistics } from 'hyparquet'
import type * as Hyparquet from 'hyparquet'
import { hyparquet, pageLibraries } from '../libraries'

import type { DType } from '../../core/types'
import type { TableFileColumn } from '../../core/values'
import type { ByteSource } from './bytes'
import { TAIL_READ } from './bytes'
import type { FileSummary } from './columns'
import { pastSafe } from './columns'
import type { ColumnRun, IdProbe, RawBlock, TableFileReader } from './reader'
import { footerFingerprint, mayHoldRange, runGetter } from './reader'
import { Unsupported, plainColumns, readMatches } from './pages'

const READABLE_CODECS = new Set(['UNCOMPRESSED', 'SNAPPY'])

type SchemaTree = ReturnType<typeof Hyparquet.parquetSchema>

export async function openParquet(bytes: ByteSource): Promise<TableFileReader> {
  const file = {
    byteLength: bytes.size,
    slice: async (start: number, end?: number) => {
      const view = await bytes.read(start, end ?? bytes.size)
      // Handed over as is where the view is its whole buffer — a copy of every column chunk,
      // otherwise, which briefly doubles a group's worth of memory for nothing.
      return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
        ? (view.buffer as ArrayBuffer)
        : (view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer)
    },
  }
  const { parquetMetadataAsync, parquetRead, parquetSchema } = await hyparquet()
  const metadata = await parquetMetadataAsync(file, { initialFetchSize: TAIL_READ })
  refuseCodecs(metadata)

  // A column's position among each group's chunks, by name — the same in every group.
  const chunkIndex = new Map(
    (metadata.row_groups[0]?.columns ?? []).map((chunk, i) => [
      chunk.meta_data?.path_in_schema.join('.') ?? '',
      i,
    ]),
  )
  const statsOf = (block: number, name: string): Statistics | undefined => {
    const index = chunkIndex.get(name)
    return index === undefined
      ? undefined
      : metadata.row_groups[block]?.columns[index]?.meta_data?.statistics
  }

  const { columns, skipped } = readableColumns(metadata, parquetSchema(metadata), statsOf)
  // The columns the fast path reads (`pages.ts`); undefined for a file with nested columns.
  // Let go once a refusal is how the whole file was written, so no block fetches its chunks twice.
  let plain = plainColumns(metadata, chunkIndex)
  const summary: FileSummary = {
    format: 'parquet',
    columns,
    skipped,
    rows: Number(metadata.num_rows),
    blocks: metadata.row_groups.length,
    bytes: bytes.size,
    fingerprint: await footerFingerprint(bytes, 'parquet'),
  }

  return {
    summary,

    mayHold(block: number, name: string, probe: IdProbe): boolean {
      const stats = statsOf(block, name)
      return stats ? mayHoldRange(...bounds(stats), probe) : true
    },

    async readMatches(block, keys, probe, outputs) {
      if (!plain) return undefined
      try {
        return await readMatches(
          await pageLibraries(),
          bytes,
          metadata,
          plain,
          block,
          keys,
          probe,
          outputs,
        )
      } catch (error) {
        // Not a page this path reads: the library reads the block instead, slower and exact.
        if (!(error instanceof Unsupported)) throw error
        if (error.fileWide) plain = undefined
        return undefined
      }
    },

    async readBlock(block: number, wanted: readonly string[]): Promise<RawBlock> {
      const group = metadata.row_groups[block]
      const rows = Number(group?.num_rows ?? 0)
      if (!group || rows === 0 || wanted.length === 0) return { rows, columns: {} }
      const chunks = new Map<string, ColumnRun[]>()
      await parquetRead({
        file,
        metadata: { ...metadata, row_groups: [group], num_rows: group.num_rows },
        columns: [...wanted],
        compressors: { SNAPPY: (await pageLibraries()).snappy },
        rowStart: 0,
        rowEnd: rows,
        onChunk: (chunk) => {
          const list = chunks.get(chunk.columnName) ?? []
          list.push({ start: chunk.rowStart, values: chunk.columnData })
          chunks.set(chunk.columnName, list)
        },
      })
      // A column arrives as a typed array per data page — eight or more for a million-row group —
      // and a nullable one holding nulls as one plain array spanning the group. (A nullable column
      // with *no* nulls went the second way too, a value at a time, until
      // `patches/hyparquet@1.29.1.patch`: on a 192M-row synapse table that was half a lookup's
      // time.) They are handed over as they are, never joined: joining would materialise the whole
      // group to hand back the three rows a lookup keeps.
      const out: Record<string, (row: number) => unknown> = {}
      const runs: Record<string, ColumnRun[]> = {}
      for (const name of wanted) {
        runs[name] = (chunks.get(name) ?? []).sort((a, b) => a.start - b.start)
        out[name] = runGetter(runs[name], rows)
      }
      return { rows, columns: out, runs }
    },
  }
}

/** A chunk's min and max, from whichever of the two spellings the writer used. */
function bounds(stats: Statistics): [unknown, unknown] {
  return [stats.min_value ?? stats.min, stats.max_value ?? stats.max]
}

/**
 * Top-level scalar columns only. A list, a struct or a map has no single cell to put in a table,
 * so it is left out and named — the node lists what it skipped rather than silently narrowing.
 */
function readableColumns(
  metadata: FileMetaData,
  schema: SchemaTree,
  statsOf: (block: number, name: string) => Statistics | undefined,
): { columns: TableFileColumn[]; skipped: string[] } {
  const columns: TableFileColumn[] = []
  const skipped: string[] = []
  for (const child of schema.children) {
    const described = child.children.length === 0 ? describe(child) : undefined
    if (!described) skipped.push(child.element.name)
    else columns.push(described.int64 ? overflowOf(metadata, described, statsOf) : described)
  }
  return { columns, skipped }
}

/**
 * Logical and converted types left out and named: decoded into objects no cell holds (JSON,
 * geometry), not decoded at all (BSON, INTERVAL), or a time of day — a duration since midnight,
 * which `timeText` would print as a 1970 date.
 */
const UNREAD: ReadonlySet<string> = new Set([
  'JSON',
  'BSON',
  'GEOMETRY',
  'GEOGRAPHY',
  'VARIANT',
  'INTERVAL',
  'TIME',
  'TIME_MILLIS',
  'TIME_MICROS',
])

/** Logical and converted types read as a timestamp's text. */
const TIMES: ReadonlySet<string> = new Set([
  'TIMESTAMP',
  'DATE',
  'TIMESTAMP_MILLIS',
  'TIMESTAMP_MICROS',
])

function describe(node: SchemaTree): TableFileColumn | undefined {
  const { element } = node
  const name = element.name
  if (element.repetition_type === 'REPEATED') return undefined
  const logical = element.logical_type?.type
  const converted = element.converted_type
  if (logical === 'DECIMAL' || converted === 'DECIMAL') {
    // A whole-number decimal is how a SQL export spells a root id, and past fifteen digits a
    // float rounds it into a different neuron — left out and named, as Feather leaves every
    // decimal (invariant 8). One with a fraction is a measurement, where a float is the answer.
    const wide = !element.scale && (element.precision ?? Infinity) > 15
    return wide ? undefined : { name, dtype: 'f64' }
  }
  // Read as the library decodes it — a number, which the text decoder would only stringify.
  if (logical === 'FLOAT16') return { name, dtype: 'f64' }
  if (UNREAD.has(logical ?? '') || UNREAD.has(converted ?? '')) return undefined
  if (TIMES.has(logical ?? '') || TIMES.has(converted ?? '') || element.type === 'INT96') {
    return { name, dtype: 'str', time: true }
  }
  const dtype = physicalDType(element.type)
  if (!dtype) return undefined
  return element.type === 'INT64' ? { name, dtype, int64: true } : { name, dtype }
}

function physicalDType(type: string | undefined): DType | undefined {
  switch (type) {
    case 'BOOLEAN':
      return 'bool'
    case 'INT32':
    case 'INT64':
      return 'i64'
    case 'FLOAT':
    case 'DOUBLE':
      return 'f64'
    case 'BYTE_ARRAY':
    case 'FIXED_LEN_BYTE_ARRAY':
      return 'str'
    default:
      return undefined
  }
}

/** A 64-bit column whose statistics, in any group, show a value no number column could hold. */
function overflowOf(
  metadata: FileMetaData,
  column: TableFileColumn,
  statsOf: (block: number, name: string) => Statistics | undefined,
): TableFileColumn {
  for (let block = 0; block < metadata.row_groups.length; block++) {
    const stats = statsOf(block, column.name)
    if (stats && bounds(stats).some((bound) => typeof bound === 'bigint' && pastSafe(bound))) {
      return { ...column, overflow: true }
    }
  }
  return column
}

function refuseCodecs(metadata: FileMetaData): void {
  for (const group of metadata.row_groups) {
    for (const chunk of group.columns) {
      const codec = chunk.meta_data?.codec
      if (codec && !READABLE_CODECS.has(codec)) {
        throw new Error(
          `This Parquet file is compressed with ${codec}, which Coda cannot read yet. Rewrite ` +
            `it with SNAPPY — in pandas, df.to_parquet(path, compression="snappy"); in polars, ` +
            `df.write_parquet(path, compression="snappy").`,
        )
      }
    }
  }
}
