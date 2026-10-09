/**
 * BigClust's two wide files read as long ones, off the main thread.
 *
 * Both are wide because numpy likes them that way and both are wrong for Coda as they stand:
 *
 *  - **The k-NN graph** is `nn_idx_1 … nn_idx_k` and `nn_dist_1 … nn_dist_k` per neuron, the
 *    indices being *row positions* in `meta` rather than ids. Long, it is the
 *    `queryId, targetId, rank, distance` table Embedding's `neighbours` port and Build Network
 *    already take. BigClust's own reading (`_load_knn_graph`) is followed exactly: a non-finite,
 *    negative or out-of-range index is no neighbour, and nor is a row pointing at itself.
 *  - **The features** are one column per partner type — fish2's are 129,325 × 1,062 at 1.1% non-zero,
 *    which as a Coda table is 137M boxed cells and well past the crash floor. Long and sparse, zeros
 *    dropped as they are read, it is 1.5M rows. The columns are read a few at a time
 *    (`FEATURE_BATCH`) so the decoded arrays never hold more than that many at once.
 *
 * Positions, not ids, come back — typed arrays that transfer rather than copy — and the page turns
 * them into ids against `meta`'s, which is the alignment BigClust makes: every file is matched to
 * `meta` **by row**, not joined on an id.
 *
 * Imports the format readers, so it is reached only through the worker or a dynamic `import()`.
 */

import type { JobHandler, JobRunOptions } from '../workerJob'
import type { FileSpec } from '../files/bytes'
import type { ColumnRun } from '../files/reader'
import { openTableSpec } from '../files/read'
import { INDEX_COLUMNS, rowMismatch } from './info'

/** How many feature columns are decoded at once: 64 × 129k doubles is 66 MB. */
const FEATURE_BATCH = 64

export interface KnnLong {
  readonly kind: 'knn'
  readonly query: Int32Array
  readonly target: Int32Array
  readonly rank: Int32Array
  readonly distance: Float64Array
  /** Neurons left with no neighbour at all — BigClust warns about the same number. */
  readonly isolated: number
}

export interface FeaturesLong {
  readonly kind: 'features'
  /** The feature columns, in file order; `column` indexes into this. */
  readonly names: readonly string[]
  readonly row: Int32Array
  readonly column: Int32Array
  readonly value: Float64Array
}

export interface LongJob {
  readonly kind: 'knn' | 'features'
  readonly spec: FileSpec
  /** Meta's row count, which every file must match. */
  readonly rows: number
}

export type LongResult = KnnLong | FeaturesLong

export const longJob: JobHandler<LongJob, LongResult> = (job, options) =>
  job.kind === 'knn'
    ? knnLong(job.spec, job.rows, options)
    : featuresLong(job.spec, job.rows, options)

/** What moves rather than copies, for `serveJob`. */
export function longTransfer(result: LongResult): Transferable[] {
  return result.kind === 'knn'
    ? [result.query.buffer, result.target.buffer, result.rank.buffer, result.distance.buffer]
    : [result.row.buffer, result.column.buffer, result.value.buffer]
}

/** `nn_<prefix>_<k>` columns, ordered by `k`, so the first is the nearest. */
function rankedColumns(names: readonly string[], prefix: string): string[] {
  return names
    .map((name) => ({
      name,
      k: /^\d+$/.test(name.slice(prefix.length)) ? Number(name.slice(prefix.length)) : NaN,
    }))
    .filter(({ name, k }) => name.startsWith(prefix) && Number.isFinite(k))
    .sort((a, b) => a.k - b.k)
    .map(({ name }) => name)
}

async function knnLong(spec: FileSpec, rows: number, options: JobRunOptions): Promise<KnnLong> {
  const reader = await openTableSpec(spec, options.signal)
  const names = reader.summary.columns.map((c) => c.name)
  const indices = rankedColumns(names, 'nn_idx_')
  const distances = rankedColumns(names, 'nn_dist_')
  if (indices.length === 0) {
    throw new Error(
      'The k-NN file has no nn_idx_1, nn_idx_2, … columns (0-based row positions).',
    )
  }
  if (indices.length !== distances.length) {
    throw new Error(
      `The k-NN file has ${indices.length} nn_idx_ columns but ${distances.length} nn_dist_ ` +
        `columns; they must match.`,
    )
  }
  if (reader.summary.rows !== undefined && reader.summary.rows !== rows) {
    throw rowMismatch('The k-NN file', reader.summary.rows, rows)
  }

  const k = indices.length
  const query = new Int32Array(rows * k)
  const target = new Int32Array(rows * k)
  const rank = new Int32Array(rows * k)
  const distance = new Float64Array(rows * k)
  const found = new Uint8Array(rows)
  let kept = 0
  let offset = 0
  for (let block = 0; block < reader.summary.blocks; block++) {
    options.signal?.throwIfAborted()
    const raw = await reader.readBlock(block, [...indices, ...distances])
    const idx = indices.map((name) => dense(raw.runs?.[name], raw.columns[name], raw.rows))
    const dist = distances.map((name) => dense(raw.runs?.[name], raw.columns[name], raw.rows))
    // Query by query, nearest first: the order the wide file reads in, with nothing to sort.
    for (let r = 0; r < raw.rows; r++) {
      const q = offset + r
      for (let j = 0; j < k; j++) {
        const t = idx[j]![r]!
        // BigClust's rule: a missing, out-of-range or self neighbour is no neighbour.
        if (!Number.isInteger(t) || t < 0 || t >= rows || t === q) continue
        query[kept] = q
        target[kept] = t
        rank[kept] = j + 1
        distance[kept] = dist[j]![r]!
        found[q] = 1
        kept++
      }
    }
    offset += raw.rows
    options.onProgress?.((block + 1) / reader.summary.blocks)
  }
  if (offset !== rows) throw rowMismatch('The k-NN file', offset, rows)
  let isolated = 0
  for (let q = 0; q < rows; q++) if (!found[q]) isolated++
  return {
    kind: 'knn',
    query: query.slice(0, kept),
    target: target.slice(0, kept),
    rank: rank.slice(0, kept),
    distance: distance.slice(0, kept),
    isolated,
  }
}

async function featuresLong(
  spec: FileSpec,
  rows: number,
  options: JobRunOptions,
): Promise<FeaturesLong> {
  const reader = await openTableSpec(spec, options.signal)
  const names = reader.summary.columns
    .filter((c) => !INDEX_COLUMNS.has(c.name) && (c.dtype === 'f64' || c.dtype === 'i64'))
    .map((c) => c.name)
  if (names.length === 0) throw new Error('The features file has no numeric feature columns.')
  if (reader.summary.rows !== undefined && reader.summary.rows !== rows) {
    throw rowMismatch('The features file', reader.summary.rows, rows)
  }

  let capacity = 1 << 16
  let row = new Int32Array(capacity)
  let column = new Int32Array(capacity)
  let value = new Float64Array(capacity)
  let kept = 0
  const grow = () => {
    capacity *= 2
    const r = new Int32Array(capacity)
    const c = new Int32Array(capacity)
    const v = new Float64Array(capacity)
    r.set(row)
    c.set(column)
    v.set(value)
    row = r
    column = c
    value = v
  }

  const batches = Math.ceil(names.length / FEATURE_BATCH)
  let offset = 0
  for (let block = 0; block < reader.summary.blocks; block++) {
    let blockRows = 0
    for (let b = 0; b < batches; b++) {
      options.signal?.throwIfAborted()
      const batch = names.slice(b * FEATURE_BATCH, (b + 1) * FEATURE_BATCH)
      const raw = await reader.readBlock(block, batch)
      blockRows = raw.rows
      batch.forEach((name, i) => {
        const at = b * FEATURE_BATCH + i
        // Straight off the decoded runs: at 1% non-zero, a full-length array per column was 137M
        // numbers written to keep 1.5M.
        eachNumber(raw.runs?.[name], raw.columns[name], raw.rows, (r, v) => {
          // Zero is the absence of a connection, and a missing value is no value.
          if (v === 0 || !Number.isFinite(v)) return
          if (kept === capacity) grow()
          row[kept] = offset + r
          column[kept] = at
          value[kept] = v
          kept++
        })
      })
      options.onProgress?.((block * batches + b + 1) / (reader.summary.blocks * batches))
    }
    offset += blockRows
  }
  if (offset !== rows) throw rowMismatch('The features file', offset, rows)
  return {
    kind: 'features',
    names,
    row: row.slice(0, kept),
    column: column.slice(0, kept),
    value: value.slice(0, kept),
  }
}

/**
 * Each row of one column of a block as a number, from the runs the reader decoded where it handed
 * them over — a 64-bit run's `bigint`s and a nullable run's nulls becoming numbers and `NaN` — and
 * through the getter otherwise.
 */
function eachNumber(
  runs: readonly ColumnRun[] | undefined,
  getter: ((row: number) => unknown) | undefined,
  rows: number,
  visit: (row: number, value: number) => void,
): void {
  if (runs) {
    for (const run of runs) {
      const values = run.values
      for (let i = 0; i < values.length && run.start + i < rows; i++) {
        visit(run.start + i, toNumber(values[i]))
      }
    }
  } else if (getter) {
    for (let r = 0; r < rows; r++) visit(r, toNumber(getter(r)))
  }
}

/** One column of a block as numbers, `NaN` where a row has none — the k-NN walk's random access. */
function dense(
  runs: readonly ColumnRun[] | undefined,
  getter: ((row: number) => unknown) | undefined,
  rows: number,
): Float64Array {
  const out = new Float64Array(rows).fill(Number.NaN)
  eachNumber(runs, getter, rows, (r, v) => (out[r] = v))
  return out
}

function toNumber(cell: unknown): number {
  if (typeof cell === 'number') return cell
  if (typeof cell === 'bigint') return Number(cell)
  return Number.NaN
}
