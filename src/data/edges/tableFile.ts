/**
 * An edge list read out of a table file, whole, into an encoded edge set.
 *
 * The Custom Dataset's Edges socket takes a Link Table file, and a connectivity question walks
 * many hops — every one a lookup in both directions — so the file is read **once**, its three
 * columns streamed a block at a time into the same `EdgeSetBuilder` an imported edge list goes
 * through, and every later question is answered from memory. What is read is only those columns,
 * which in Parquet is bytes never fetched for the rest.
 *
 * Imports both format libraries, so — `files/read.ts`' rule — reached only through the worker or a
 * dynamic `import()`.
 *
 * ## Cells, as the file stores them
 *
 * The reader hands back raw cells, not the Link Table's typing: an id column is 64-bit integers,
 * `bigint` here, and becomes exact text with no detour through a double (invariant 8), whatever
 * `Detect id columns` decided for the pickers. Both cell rules are `encode.ts`' — every edge list
 * reads its cells one way, however it arrived.
 */

import type { EdgeColumns, EncodedEdges } from './encode'
import { EdgeSetBuilder, edgeIdCell, edgeWeightCell } from './encode'
import type { JobHandler } from '../workerJob'
import type { FileSpec } from '../files/bytes'
import { bytesOf } from '../files/bytes'
import { openTableFile, requireFingerprint } from '../files/read'
import type { RowCondition } from '../files/filters'
import { rowTest, withConditionColumns } from '../files/filters'
import type { ColumnRun } from '../files/reader'
import { int64Words } from '../files/reader'

/** The columns to read, and the file they were chosen from — a different one is refused. */
export interface ReadEdgesRequest extends EdgeColumns {
  readonly fingerprint: string
  /** A Filter Table's conditions (`files/filters.ts`): a row failing one is no edge. */
  readonly filters?: readonly RowCondition[]
}

export interface ReadEdgesJob {
  readonly spec: FileSpec
  readonly request: ReadEdgesRequest
}

export const readTableFileEdgesJob: JobHandler<ReadEdgesJob, EncodedEdges> = async (
  job,
  options,
) => {
  const { fingerprint, pre, post, weight, filters = [] } = job.request
  const reader = await openTableFile(bytesOf(job.spec, options.signal))
  requireFingerprint(reader, fingerprint)
  const { blocks } = reader.summary
  const builder = new EdgeSetBuilder()
  const picked = weight ? [pre, post, weight] : [pre, post]
  const columns = withConditionColumns(picked, filters)
  // Asked of the footer, before any block is read — and in words that name the node's picker
  // rather than each library's own.
  const known = new Set(reader.summary.columns.map((column) => column.name))
  const absent = picked.find((name) => !known.has(name))
  if (absent !== undefined) throw new Error(`The file has no column "${absent}".`)
  for (let block = 0; block < blocks; block++) {
    options.signal?.throwIfAborted()
    options.onProgress?.(
      block / blocks,
      `${block.toLocaleString()} of ${blocks.toLocaleString()} blocks`,
    )
    const raw = await reader.readBlock(block, columns)
    const from = raw.columns[pre]!
    const to = raw.columns[post]!
    const weighs = weight ? raw.columns[weight]! : undefined
    const passes = rowTest(filters, (name) => raw.columns[name]!)
    const fromRuns = raw.runs?.[pre]
    const toRuns = raw.runs?.[post]
    if (fromRuns && toRuns && addByWords(builder, fromRuns, toRuns, weighs, passes, raw.rows)) {
      continue
    }
    for (let row = 0; row < raw.rows; row++) {
      if (passes && !passes(row)) continue
      builder.add(
        edgeIdCell(from(row)),
        edgeIdCell(to(row)),
        weighs ? edgeWeightCell(weighs(row)) : 1,
      )
    }
  }
  return builder.finish()
}

/**
 * Offer a block's rows by their ids' 32-bit words (`EdgeSetBuilder.addWords`) where both ends are
 * 64-bit integer runs — no string per row — and answer whether it could. The two columns' runs need
 * not break at the same rows (Parquet's pages do not), so each end walks its own with a cursor, in
 * locals: this is the per-row loop of a fifteen-million-edge read.
 */
function addByWords(
  builder: EdgeSetBuilder,
  fromRuns: readonly ColumnRun[],
  toRuns: readonly ColumnRun[],
  weighs: ((row: number) => unknown) | undefined,
  passes: ((row: number) => boolean) | undefined,
  rows: number,
): boolean {
  const from = fromRuns.map((run) => int64Words(run.values))
  const to = toRuns.map((run) => int64Words(run.values))
  if (from.some((w) => !w) || to.some((w) => !w)) return false
  let f = 0
  let t = 0
  for (let row = 0; row < rows; row++) {
    while (f + 1 < fromRuns.length && row >= fromRuns[f + 1]!.start) f++
    while (t + 1 < toRuns.length && row >= toRuns[t + 1]!.start) t++
    if (passes && !passes(row)) continue
    const a = from[f]!.words
    const b = to[t]!.words
    const i = row - fromRuns[f]!.start
    const j = row - toRuns[t]!.start
    builder.addWords(
      a[2 * i + 1]!,
      a[2 * i]!,
      b[2 * j + 1]!,
      b[2 * j]!,
      weighs ? edgeWeightCell(weighs(row)) : 1,
      from[f]!.signed,
      to[t]!.signed,
    )
  }
  return true
}
