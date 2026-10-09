/**
 * Opening a table file and reading rows out of it — the half that runs wherever the bytes are
 * read, in a worker where there is one (`worker.ts`) and on this thread where there is not.
 *
 * Imports both format libraries, so it must only ever be reached through a dynamic `import()` or
 * the worker: `apache-arrow` and `hyparquet` are ~70 kB gzipped between them and belong in no
 * chunk the canvas loads.
 */

import { CRASH_FLOOR_CELLS, refuseIfOverCrashFloor } from '../../core/limits'
import type { DType } from '../../core/types'
import type { CellValue, TableFileColumn } from '../../core/values'
import type { JobHandler, JobRunOptions } from '../workerJob'
import type { ByteSource, FileSpec } from './bytes'
import {
  ARROW_MAGIC,
  FILE_CHANGED,
  PARQUET_MAGIC,
  TAIL_READ,
  bytesOf,
  endsWith,
  withTail,
} from './bytes'
import { decoderFor } from './columns'
import type { RowCondition } from './filters'
import { rowTest, withConditionColumns } from './filters'
import { openDelta } from './delta/reader'
import { openFeather } from './feather'
import { openParquet } from './parquet'
import type { BlockIndex, BlockRange, TableFileReader } from './reader'
import { blockMayHold, idProbe, matchesByColumns } from './reader'
import { indexedReader } from './blockIndex'

/** A reader for whatever a spec names: one file's bytes, or a Delta table's live files. */
export function openTableSpec(spec: FileSpec, signal?: AbortSignal): Promise<TableFileReader> {
  if (spec.kind !== 'delta') return openTableFile(bytesOf(spec, signal))
  return openDelta(spec.snapshot, (url, size) => bytesOf({ kind: 'url', url, size }, signal))
}

/**
 * A reader for whatever is at `bytes`, decided by the magic its tail ends in rather than its name
 * — a file arrives called `.parq`, `.arrow`, `.feather` or nothing at all from a URL.
 *
 * The tail is read first on purpose: both formats keep their footer there, so with it held
 * (`withTail`) the format library's footer walk and the fingerprint are served from one read
 * rather than a round trip each.
 *
 * Anything that is neither is refused, and the refusal is aimed at the case it will almost always
 * be: a CSV, which has no footer to find a row in and no blocks to skip, so reading it lazily is
 * reading all of it. The message is the conversion, since that is what somebody has to go and do.
 */
export async function openTableFile(source: ByteSource): Promise<TableFileReader> {
  const bytes = withTail(source)
  const tail = await bytes.read(Math.max(0, bytes.size - TAIL_READ), bytes.size)
  const ending = (magic: string) => endsWith(tail, magic)
  if (ending(PARQUET_MAGIC)) return openParquet(bytes)
  if (ending(ARROW_MAGIC)) return openFeather(bytes)
  // Two relatives of the formats read here, told apart so neither is sent to convert a CSV.
  if (ending('PARE')) {
    throw new Error(
      'This Parquet file is encrypted, which Coda cannot read. Write it unencrypted.',
    )
  }
  if (ending('FEA1')) {
    throw new Error(
      'This is a version 1 Feather file, which Coda cannot read in pieces. Write it again with ' +
        'pyarrow.feather.write_feather, whose default is version 2.',
    )
  }
  throw new Error(
    'This is not a Parquet or Feather file. A CSV cannot be read in pieces, so every lookup ' +
      'would read all of it. Convert it once, sorted by the column you will look ids up ' +
      'in: pandas.read_csv(path).sort_values("root_id").to_parquet("out.parquet"). Small ' +
      'tables can go through Upload Table instead.',
  )
}

/** One output column: as the file stores it, and the dtype the node reads it as. */
export interface OutputColumn {
  readonly column: TableFileColumn
  readonly dtype: DType
}

export interface ReadRowsRequest {
  /** The file the caller's schema was built from; a different one is refused. */
  readonly fingerprint: string
  readonly columns: readonly OutputColumn[]
  /**
   * Keep only rows where one of the `names` columns holds one of `ids` — usually one column; a
   * synapse table's `pre` and `post` together, so one pass answers both ends. Absent keeps every
   * row. `indexed` asks for each column's block index, which `readRowsJob` honours by reading
   * through `withBlockIndex`.
   */
  readonly key?: {
    readonly names: readonly string[]
    readonly ids: readonly string[]
    readonly indexed?: boolean
  }
  /**
   * Row conditions a Filter Table left on the file (`filters.ts`): a row failing one is not kept,
   * and never counts towards `limit`. Their columns are read whether or not they are outputs.
   */
  readonly filters?: readonly RowCondition[]
  /** Stop after this many kept rows. */
  readonly limit: number
  /**
   * Only blocks `[from, to)` — one part of a read split across workers (`client.ts`). Absent reads
   * every block.
   */
  readonly blocks?: BlockRange
}

export interface ReadRowsResult {
  readonly data: Record<string, CellValue[]>
  readonly rows: number
  readonly blocksRead: number
  readonly blocksSkipped: number
  /** The row cap was reached with rows left to read. */
  readonly truncated: boolean
  /** What happened to the key's block indexes — set by the page (`client.ts`), which keeps them. */
  readonly index?: IndexOutcome
  /**
   * The block indexes a read built over its blocks, by column, for the page to join with the other
   * parts' and save — a part of a split read sees only its own blocks.
   */
  readonly built?: Readonly<Record<string, BlockIndex>>
}

/** What happened to a key's block index on one read: used where stored, or built and saved. */
export type IndexOutcome = 'used' | 'built'

/** A read, as a job: where the bytes are, what to keep, and the key columns' stored indexes. */
export interface ReadRowsJob {
  readonly spec: FileSpec
  readonly request: ReadRowsRequest
  /** By column, where one is stored — loaded by the page, so a worker never opens the store. */
  readonly held?: Readonly<Record<string, BlockIndex>>
}

/** The one body the worker serves and the no-worker fallback runs. */
export const readRowsJob: JobHandler<ReadRowsJob, ReadRowsResult> = async (job, options) => {
  const { key, blocks } = job.request
  const reader = await openTableSpec(job.spec, options.signal)
  if (!key?.indexed) return readRows(reader, job.request, options)
  // Each key column skipped by its stored index, which the page handed over, and built where there
  // is none. Saving is the page's: a part of a split read builds only its own blocks.
  const { indexed, wrappers } = indexedReader(reader, key.names, job.held, blocks)
  const result = await readRows(indexed, job.request, options)
  const built: Record<string, BlockIndex> = {}
  key.names.forEach((name, i) => {
    const index = wrappers[i]!.finish()
    if (index) built[name] = index
  })
  return Object.keys(built).length ? { ...result, built } : result
}

const nothing = () => null

/**
 * Refuse a file that is not the one the caller's columns were read from — every reader of rows
 * asks, since a rewritten file's footer may name different columns, or the same names over
 * different data.
 */
export function requireFingerprint(reader: TableFileReader, fingerprint: string): void {
  if (reader.summary.fingerprint === fingerprint) return
  throw new Error(FILE_CHANGED)
}

/**
 * The rows a request asks for, a block at a time.
 *
 * Each block is ruled out on its statistics where it can be. What survives is matched on its key
 * column **alone** first, and only a block holding a match has its other columns read — which in
 * Parquet is bytes never fetched, and everywhere is cells never decoded. So a full scan of a
 * shuffled file for three neurons costs one column's worth of reading, not the whole table's.
 *
 * What has been kept is what the crash floor is asked about, in cells, as it grows: the refusal
 * comes before the allocation that would end the tab, never after it.
 *
 * A key's block index is the reader's business (`withBlockIndex`), answered through `mayHold`.
 */
export async function readRows(
  reader: TableFileReader,
  request: ReadRowsRequest,
  options: JobRunOptions = {},
): Promise<ReadRowsResult> {
  const { summary } = reader
  requireFingerprint(reader, request.fingerprint)

  const data: Record<string, CellValue[]> = {}
  for (const { column } of request.columns) data[column.name] = []
  const names = request.key?.names ?? []
  let kept = 0
  let blocksRead = 0
  let blocksSkipped = 0
  const result = (truncated: boolean): ReadRowsResult => ({
    data,
    rows: kept,
    blocksRead,
    blocksSkipped,
    truncated,
  })

  // Empty is empty, never everything — the Input IDs rule: an unconfigured lookup reads nothing.
  if (request.key?.ids.length === 0) return result(false)
  const probe = request.key && idProbe(request.key.ids)

  const outputs = request.columns.map(({ column, dtype }) => ({
    name: column.name,
    into: data[column.name]!,
    decode: decoderFor(column, dtype),
  }))
  const conditions = request.filters ?? []
  const outputNames = outputs.map((o) => o.name)
  // Read beside the outputs, never output: a condition's column is the reader's business.
  const wanted = withConditionColumns(outputNames, conditions)
  const width = Math.max(1, outputs.length)

  const { from, to } = request.blocks ?? { from: 0, to: summary.blocks }
  for (let block = from; block < to; block++) {
    options.signal?.throwIfAborted()
    // Ruled out only when no key column can hold an id there.
    if (probe && !blockMayHold(reader, names, probe, block)) {
      blocksSkipped++
      continue
    }
    // At the cap with rows left: every block holds some without a key, so this one says so.
    if (!probe && kept >= request.limit) return result(true)
    blocksRead++

    // The block's kept cells, by their place among the kept rows. With a key: through the format's
    // own keyed path where it has one for this block (`pages.ts`), and otherwise its key columns
    // read and matched first, then the rest. Without one: every row, and a reader may stop at the
    // cap — and one row past it, which is what says the read was cut short.
    let count: number
    let cellsAt: (name: string) => (i: number) => unknown
    if (probe) {
      const matches =
        (await reader.readMatches?.(block, names, probe, wanted)) ??
        (await matchesByColumns(reader, block, names, probe, wanted))
      count = matches.rows.length
      // With a key, only a match left to keep is a row left to read.
      if (kept >= request.limit && count > 0) return result(true)
      cellsAt = (name) => {
        const values = matches.values[name]!
        return (i) => values[i] ?? null
      }
    } else {
      const head = conditions.length ? undefined : request.limit - kept + 1
      const raw = await reader.readBlock(block, wanted, head)
      count = raw.rows
      cellsAt = (name) => raw.columns[name] ?? nothing
    }

    const cells = outputs.map(({ name, into, decode }) => ({
      into,
      decode,
      get: cellsAt(name),
    }))
    const passes = rowTest(conditions, cellsAt)
    for (let i = 0; i < count; i++) {
      if (passes && !passes(i)) continue
      if (kept >= request.limit) return result(true)
      for (const { into, decode, get } of cells) into.push(decode(get(i)))
      kept++
      if (kept % 65_536 === 0 && kept * width > CRASH_FLOOR_CELLS) {
        refuseIfOverCrashFloor(
          `reading ${kept.toLocaleString()} rows of ${width} columns`,
          kept * width * 8,
          'Choose fewer columns, match fewer ids, or lower the row cap.',
        )
      }
    }
    options.onProgress?.(
      (block + 1 - from) / (to - from),
      `${(block + 1 - from).toLocaleString()} of ${(to - from).toLocaleString()} blocks`,
    )
  }
  return result(false)
}
