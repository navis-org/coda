/**
 * Feather (the Arrow IPC file format), read a record batch at a time through `apache-arrow`.
 *
 * `apache-arrow` reads a file lazily only through its Node `FileHandle` path — every other source
 * it takes is read whole — so this hands it an object shaped like one (`fd`, `stat`, `read`,
 * `close`) over whatever `ByteSource` the file is. That shape is the library's own duck test
 * (`isFileHandle` asks for a numeric `fd` and a `stat`), which is why a number no file descriptor
 * table has ever held sits on it.
 *
 * **One request per batch, not four.** The reader walks a batch as four small sequential reads —
 * a continuation marker, a length, the metadata, the body — which over HTTP is four round trips.
 * The footer already says each batch's exact extent, so the whole extent is fetched once and the
 * four reads are served from it.
 *
 * **One read at a time.** The reader's handle and its message reader share a single seek position,
 * so two batches read concurrently interleave each other's bytes. Reads queue on a promise chain,
 * and the last batch is kept, since a lookup asks for the key column and then the rest of the same
 * batch.
 *
 * **No statistics**, so a lookup reads every batch: Feather records where each batch is and not
 * what is in it. The node says so, and names Parquet sorted by the id column as the fix.
 */

import type {
  Field,
  RecordBatch,
  RecordBatchReader,
  Type as TypeId,
  Vector,
} from 'apache-arrow'

import { arrow } from '../libraries'

type Arrow = Awaited<ReturnType<typeof arrow>>

import type { TableFileColumn } from '../../core/values'
import type { ByteSource } from './bytes'
import type { FileSummary } from './columns'
import type { ColumnRun, RawBlock, TableFileReader } from './reader'
import { footerFingerprint } from './reader'

export async function openFeather(bytes: ByteSource): Promise<TableFileReader> {
  const library = await arrow()
  const handle = fileHandleOver(bytes)
  // `as never`: the library types the handle as Node's own `FileHandle`, which this only resembles.
  const reader = (await library.RecordBatchReader.from(handle as never)) as RecordBatchReader
  await reader.open()
  const footer = reader.footer
  if (!reader.isFile() || !footer) {
    throw new Error(
      'This is an Arrow stream, which cannot be read in pieces like a Feather file. Write it ' +
        'with pyarrow.feather.write_feather, or as Parquet.',
    )
  }

  const columns: TableFileColumn[] = []
  const skipped: string[] = []
  for (const field of reader.schema.fields) {
    const column = describe(library, field)
    if (column) columns.push(column)
    else skipped.push(field.name)
  }

  const summary: FileSummary = {
    format: 'feather',
    columns,
    skipped,
    // Not in the footer: a batch's length is in its own header, so knowing it means reading all.
    rows: undefined,
    blocks: reader.numRecordBatches,
    bytes: bytes.size,
    fingerprint: await footerFingerprint(bytes, 'feather'),
  }

  let queue: Promise<unknown> = Promise.resolve()
  let last: { block: number; batch: RecordBatch | null } | undefined

  const batchAt = async (block: number): Promise<RecordBatch | null> => {
    if (last?.block === block) return last.batch
    const extent = footer.getRecordBatch(block)
    if (extent) {
      await handle.prefetch(
        extent.offset,
        extent.offset + extent.metaDataLength + extent.bodyLength,
      )
    }
    // Arrow IPC has two codecs, lz4 and ZSTD, and `arrow()` registers both.
    const batch = (await reader.readRecordBatch(block)) ?? null
    last = { block, batch }
    return batch
  }

  return {
    summary,

    mayHold: () => true,

    readBlock(block: number, wanted: readonly string[]): Promise<RawBlock> {
      const run = async (): Promise<RawBlock> => {
        const batch = await batchAt(block)
        if (!batch) return { rows: 0, columns: {} }
        const out: Record<string, (row: number) => unknown> = {}
        const runs: Record<string, ColumnRun[]> = {}
        for (const name of wanted) {
          const vector = batch.getChild(name)
          out[name] = vector ? (row) => vector.get(row) : () => null
          const own = vector && runsOf(library, vector)
          if (own) runs[name] = own
        }
        return { rows: batch.numRows, columns: out, runs }
      }
      const next = queue.then(run, run)
      queue = next.catch(() => {})
      return next
    },
  }
}

/**
 * A column's chunks as the runs a scan walks (`matchingRows`), or undefined where one chunk is not
 * simply its values: a chunk holding nulls (the getter masks them), a dictionary (the values are
 * indices), a half float (the values are raw bits) or anything but an integer or float. A chunk's
 * `values` are already sliced to it — Arrow reads an int64 as `values[index]` — so each is a run
 * as it stands. Without this a Feather scan made a `bigint` per row through `get`: on the 10.7 GB
 * FlyWire synapse table, 15% of a lookup, beside the LZ4 half the library spends decoding.
 */
function runsOf({ DataType, Precision }: Arrow, vector: Vector): ColumnRun[] | undefined {
  const runs: ColumnRun[] = []
  let start = 0
  for (const data of vector.data) {
    const { type } = data
    const plain =
      DataType.isInt(type) || (DataType.isFloat(type) && type.precision !== Precision.HALF)
    if (!plain || data.nullCount !== 0 || data.stride !== 1) return undefined
    runs.push({ start, values: data.values.subarray(0, data.length) })
    start += data.length
  }
  return runs
}

/** Scalar Arrow types only; a list, struct, map or union is left out and named. */
function describe({ Type }: Arrow, field: Field): TableFileColumn | undefined {
  const { name } = field
  type Described = { typeId: TypeId; bitWidth?: number; dictionary?: Described }
  const outer = field.type as Described
  // A dictionary column is described by its values' type — its 64-bit flag included, or a value
  // past 2^53 is refused with advice about a text column the node never offers.
  const type = outer.typeId === Type.Dictionary && outer.dictionary ? outer.dictionary : outer
  switch (type.typeId) {
    case Type.Int:
      return type.bitWidth === 64 ? { name, dtype: 'i64', int64: true } : { name, dtype: 'i64' }
    case Type.Float:
      return { name, dtype: 'f64' }
    case Type.Bool:
      return { name, dtype: 'bool' }
    // Utf8View is polars' string type in an IPC file.
    case Type.Utf8:
    case Type.LargeUtf8:
    case Type.Utf8View:
      return { name, dtype: 'str' }
    case Type.Date:
    case Type.Timestamp:
      return { name, dtype: 'str', time: true }
    // A decimal arrives as a big-number object no cell decodes, and a time of day is a duration
    // since midnight: both left out and named rather than read as nulls or 1970 dates.
    default:
      return undefined
  }
}

/**
 * A `FileHandle`-shaped reader over a byte source, with one prefetched window.
 *
 * `read` must return the very buffer it was handed, written at `offset`, and a non-zero
 * `bytesRead` — the library reads `.buffer` off the result and loops until it has what it asked
 * for, so a zero would spin forever.
 */
function fileHandleOver(bytes: ByteSource) {
  let window: { start: number; data: Uint8Array } | undefined
  return {
    fd: 0,
    stat: async () => ({ size: bytes.size }),
    async prefetch(start: number, end: number): Promise<void> {
      window = { start, data: await bytes.read(start, Math.min(end, bytes.size)) }
    },
    async read(buffer: Uint8Array, offset: number, length: number, position: number) {
      const end = Math.min(position + length, bytes.size)
      const held = window
      const chunk =
        held && position >= held.start && end <= held.start + held.data.byteLength
          ? held.data.subarray(position - held.start, end - held.start)
          : await bytes.read(position, end)
      // A read past the end answers nothing, and the library asks again for ever: a truncated
      // file would hang the worker until somebody pressed Cancel.
      if (length > 0 && chunk.byteLength === 0) {
        throw new Error('The file ends before its own footer says it should: it is truncated.')
      }
      buffer.set(chunk, offset)
      return { bytesRead: chunk.byteLength, buffer }
    },
    close: async () => {},
  }
}
