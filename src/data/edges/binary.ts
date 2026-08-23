/**
 * Reading an edge list out of Parquet or Feather.
 *
 * **Lazily imported and never referenced from the main chunk** — `apache-arrow` is 50.7 kB
 * gzipped and `hyparquet` 17.0 kB, both measured, against a CSV path that costs nothing. Same
 * doctrine as the notebook exporters and elkjs: verify with `pnpm build` that neither library
 * appears in `main-*.js`.
 *
 * It is worth having despite that, and the numbers are why. Measured on three million rows:
 *
 *   feather (lz4)      110 ms    25.8 MB file    zero-copy typed arrays
 *   parquet (snappy)   759 ms    31.9 MB file    bounded memory, read in slices
 *   csv                255 ms    124.4 MB file   *just to scan for newlines*
 *
 * And the format is better for this data in a way that goes beyond speed: an id column is
 * `INT64`, so it arrives as a **bigint** — exact at eighteen digits with no text parsing and no
 * rounding anywhere. Invariant 8 is satisfied by construction here rather than by care.
 */

import { CompressionType, compressionRegistry, tableFromIPC } from 'apache-arrow'
import lz4 from 'lz4js'
import { asyncBufferFromUrl, parquetMetadataAsync, parquetRead } from 'hyparquet'
import type { AsyncBuffer } from 'hyparquet'

import type { EncodedEdges } from './encode'
import type { EdgeFormat } from './formats'
import { EdgeSetBuilder } from './encode'
import type { EdgeColumnChoice } from './read'

/** Derived, so a third format cannot be added to one list and forgotten in the other. */
export type BinaryFormat = Exclude<EdgeFormat, 'delimited'>

/**
 * `write_feather` compresses with **lz4 by default**, and `apache-arrow` ships no codec for it —
 * a default-written Feather file fails outright with "Record batch is compressed but codec not
 * found". This is the whole reason `lz4js` is a dependency, and it is 2.2 kB gzipped on top of
 * arrow, measured.
 *
 * `encode` is declared and is never used: the registry **validates a codec by round-tripping it**,
 * so registering a decode-only codec throws at registration time rather than at read time.
 *
 * `lz4js` was last published years ago, which is worth knowing and was judged acceptable: the
 * LZ4 frame format is frozen, so a decoder for it is finished rather than abandoned.
 */
compressionRegistry.set(CompressionType.LZ4_FRAME, {
  encode: (bytes: Uint8Array) => lz4.compress(bytes),
  decode: (bytes: Uint8Array) => lz4.decompress(bytes),
})

export interface BinarySource {
  file?: File
  url?: string
}

export interface BinaryPreview {
  columns: string[]
  /** The declared type per column, shown by the panel and read by the float-id refusal. */
  types: string[]
  rows: string[][]
  rowCount?: number
}

/** Rows per `parquetRead` call. Bounded memory: measured at 0 MB retained across 3M rows. */
const SLICE_ROWS = 500_000

/** Sample rows offered to the panel. */
const PREVIEW_ROWS = 20

/**
 * A column of floating-point ids is already wrong before we see it.
 *
 * `720575940628857210` cannot be held in a double, so a file whose id column is `DOUBLE` has
 * *already* rounded it into a different neuron — nothing downstream can recover that, and every
 * row would name a neuron the dataset does not have. Refused by name, because "this joined to
 * nothing" is otherwise the only symptom.
 */
const FLOAT_TYPES = /^(float|double)/i

function requireExactIds(types: readonly string[], columns: EdgeColumnChoice): void {
  for (const [role, at] of [
    ['pre', columns.pre],
    ['post', columns.post],
  ] as const) {
    const type = types[at] ?? ''
    if (FLOAT_TYPES.test(type)) {
      throw new Error(
        `The ${role} column is ${type}, so its ids were rounded when the file was written — ` +
          `an eighteen-digit id cannot survive a floating-point column. Re-export it as an ` +
          `integer or as text.`,
      )
    }
  }
}

/**
 * One decoded cell as exact text.
 *
 * Deliberately **not** called `idText` — `core/ids.ts` exports that name for the cell rule every
 * other layer shares, and two functions of one name that disagree above `MAX_SAFE_INTEGER` is
 * the scar that module's header is about. This one is wider rather than different: Arrow and
 * hyparquet hand back `bigint` for an `INT64` column, which `CellValue` does not cover and which
 * core's would answer `null` for — and bigint is exact at any width, which is the whole reason
 * these formats are worth reading.
 */
function cellText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function weightOf(value: unknown): number {
  // Blank is missing data, and `Number('')` is 0 — a zero-weight edge, which is a connection
  // nobody recorded. `Number` handles a bigint on its own.
  if (value === null || value === undefined || value === '') return Number.NaN
  return Number(value)
}

// ---------------------------------------------------------------------------
// Parquet
// ---------------------------------------------------------------------------

/** hyparquet reads by range, so a `File` never has to be held whole. */
function bufferOf(source: BinarySource): Promise<AsyncBuffer> {
  const file = source.file
  if (file) {
    return Promise.resolve({
      byteLength: file.size,
      slice: (start: number, end?: number) => file.slice(start, end ?? file.size).arrayBuffer(),
    })
  }
  if (!source.url) throw new Error('Nothing to read: name a file or a URL')
  return asyncBufferFromUrl({ url: source.url })
}

async function parquetSchemaOf(source: BinarySource) {
  const file = await bufferOf(source)
  const metadata = await parquetMetadataAsync(file)
  const leaves = metadata.schema.filter((element) => element.type !== undefined)
  return {
    file,
    rowCount: Number(metadata.num_rows),
    columns: leaves.map((element) => element.name),
    types: leaves.map((element) =>
      element.converted_type
        ? `${element.type}/${element.converted_type}`
        : String(element.type),
    ),
  }
}

async function previewParquet(source: BinarySource): Promise<BinaryPreview> {
  const { file, rowCount, columns, types } = await parquetSchemaOf(source)
  const rows: string[][] = []
  await parquetRead({
    file,
    rowStart: 0,
    rowEnd: Math.min(PREVIEW_ROWS, rowCount),
    onComplete: (data) => {
      for (const row of data) rows.push(row.map((cell) => cellText(cell)))
    },
  })
  return { columns, types, rows, rowCount }
}

async function readParquet(
  source: BinarySource,
  choice: EdgeColumnChoice,
  options: BinaryReadOptions,
): Promise<EncodedEdges> {
  const { file, rowCount, columns, types } = await parquetSchemaOf(source)
  requireExactIds(types, choice)

  const wanted = [columns[choice.pre]!, columns[choice.post]!]
  if (choice.weight !== undefined) wanted.push(columns[choice.weight]!)
  const builder = new EdgeSetBuilder()

  /*
   * Read in slices rather than in one call. `parquetReadObjects` builds one JS object per row —
   * 399 MB at three million, so about 1.3 GB at ten — which is the `TableValue`-versus-CSR trap
   * in a second costume. Sliced, the retained heap is zero.
   */
  for (let start = 0; start < rowCount; start += SLICE_ROWS) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    await parquetRead({
      file,
      columns: wanted,
      rowStart: start,
      rowEnd: Math.min(start + SLICE_ROWS, rowCount),
      onComplete: (data) => {
        for (const row of data) {
          builder.add(
            cellText(row[0]),
            cellText(row[1]),
            choice.weight === undefined ? 1 : weightOf(row[2]),
          )
        }
      },
    })
    options.onProgress?.(
      Math.min(0.98, (start + SLICE_ROWS) / rowCount),
      `${builder.accepted.toLocaleString()} rows`,
    )
  }
  options.onProgress?.(0.99, 'Compressing')
  return builder.finish()
}

// ---------------------------------------------------------------------------
// Feather
// ---------------------------------------------------------------------------

async function featherBytes(source: BinarySource): Promise<Uint8Array> {
  if (source.file) return new Uint8Array(await source.file.arrayBuffer())
  if (!source.url) throw new Error('Nothing to read: name a file or a URL')
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`${source.url} answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * An Arrow IPC file is read whole, unlike Parquet.
 *
 * That is the format rather than a shortcut — the record batches are laid out for random access
 * and the reader wants the buffer. It costs the file's own size transiently: 25.8 MB at three
 * million rows, so roughly 86 MB at ten. Acceptable against what it buys, which is that the
 * columns come out as views on that same buffer with no per-row work at all.
 */
async function featherTable(source: BinarySource) {
  const table = tableFromIPC(await featherBytes(source))
  const columns = table.schema.fields.map((field) => field.name)
  const types = table.schema.fields.map((field) => String(field.type))
  return { table, columns, types }
}

async function previewFeather(source: BinarySource): Promise<BinaryPreview> {
  const { table, columns, types } = await featherTable(source)
  const rows: string[][] = []
  for (let i = 0; i < Math.min(PREVIEW_ROWS, table.numRows); i++) {
    rows.push(columns.map((name) => cellText(table.getChild(name)?.get(i))))
  }
  return { columns, types, rows, rowCount: table.numRows }
}

async function readFeather(
  source: BinarySource,
  choice: EdgeColumnChoice,
  options: BinaryReadOptions,
): Promise<EncodedEdges> {
  const { table, columns, types } = await featherTable(source)
  requireExactIds(types, choice)

  // `toArray()` is the whole point: an `INT64` column is a `BigInt64Array` view into the buffer
  // already decoded, a `Utf8` one a plain array of strings, and either is indexable directly.
  const column = (at: number | undefined) =>
    at === undefined ? undefined : table.getChild(columns[at]!)?.toArray()
  const pre = column(choice.pre)
  const post = column(choice.post)
  const weight = column(choice.weight)
  if (!pre || !post) throw new Error('The chosen columns are not in this file')

  const builder = new EdgeSetBuilder()
  for (let i = 0; i < table.numRows; i++) {
    if ((i & 0xfffff) === 0) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      options.onProgress?.(Math.min(0.98, i / table.numRows), `${i.toLocaleString()} rows`)
    }
    builder.add(
      cellText(pre[i]),
      cellText(post[i]),
      weight === undefined ? 1 : weightOf(weight[i]),
    )
  }
  options.onProgress?.(0.99, 'Compressing')
  return builder.finish()
}

// ---------------------------------------------------------------------------

export interface BinaryReadOptions {
  onProgress?: (fraction: number, note?: string) => void
  signal?: AbortSignal
}

export function previewBinary(
  format: BinaryFormat,
  source: BinarySource,
): Promise<BinaryPreview> {
  return format === 'parquet' ? previewParquet(source) : previewFeather(source)
}

export function readBinary(
  format: BinaryFormat,
  source: BinarySource,
  choice: EdgeColumnChoice,
  options: BinaryReadOptions = {},
): Promise<EncodedEdges> {
  return format === 'parquet'
    ? readParquet(source, choice, options)
    : readFeather(source, choice, options)
}
