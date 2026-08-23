/**
 * Reading somebody's edge list into an encoded set.
 *
 * Deliberately *not* `parseDelimited`, which is the right reader for an uploaded table and the
 * wrong one here for one reason: it takes the whole file as a string and infers a dtype per
 * column by scanning every value. An edge list at the size this feature exists for is a stream,
 * and its three columns have known roles — two ids and a count — so nothing needs inferring.
 * What it *does* borrow is the part that would be wrong to write twice: `RowSplitter` is
 * `csv.ts`'s own RFC 4180 parser, so a quoted field means the same thing in both readers.
 *
 * The preview is the other half. A file names its columns however its author felt, so the panel
 * shows the first few rows and asks which is which — with a guess, because the spellings that
 * actually occur are a short list and getting it right on the first try is most of the
 * experience.
 */

import type { Delimiter } from '../csv'
import { RowSplitter, parseDelimited } from '../csv'
import type { EncodedEdges } from './encode'
import { EdgeSetBuilder } from './encode'

/** How much of a file to read for the preview. Enough for a header and a few dozen rows. */
export const PREVIEW_BYTES = 64 * 1024

/** Which column is which, by index. Resolved by the panel from a preview and used once. */
export interface EdgeColumnChoice {
  pre: number
  post: number
  /** Absent means every edge weighs 1, which is what an unweighted edge list means. */
  weight?: number
}

export interface EdgeFilePreview {
  delimiter: Delimiter
  hasHeader: boolean
  /** Header names, or `col_1…` where row one looked like data. */
  columns: string[]
  /** The first rows, as the text they arrived as. */
  rows: string[][]
  /** A guess, where the names are recognisable. Absent means the panel must ask. */
  suggestion?: EdgeColumnChoice
}

/**
 * Column names that actually occur, normalised, most specific first.
 *
 * Worth having as a list rather than a regex because the order is the point: FlyWire writes
 * `pre_pt_root_id` and also has a `pre_pt_supervoxel_id`, so a loose `/pre/` matches the wrong
 * one. Every entry here was taken from a real published edge list — CAVE's connection views,
 * neuprint-python's `fetch_adjacencies` frame, CATMAID's connector table, Codex's exports.
 */
const PRE_NAMES = [
  'preptrootid',
  'prerootid',
  'presynapticid',
  'presynaptic',
  'bodyidpre',
  'skeletonidpre',
  'sourceid',
  'preid',
  'source',
  'from',
  'pre',
]
const POST_NAMES = [
  'postptrootid',
  'postrootid',
  'postsynapticid',
  'postsynaptic',
  'bodyidpost',
  'skeletonidpost',
  'targetid',
  'postid',
  'target',
  'to',
  'post',
]
const WEIGHT_NAMES = ['weight', 'syncount', 'synapsecount', 'nsyn', 'synapses', 'count', 'size']

const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The first column whose name matches a candidate, candidates in priority order. */
function pick(columns: readonly string[], candidates: readonly string[]): number | undefined {
  const names = columns.map(normalise)
  for (const candidate of candidates) {
    const at = names.indexOf(candidate)
    if (at !== -1) return at
  }
  return undefined
}

export function suggestEdgeColumns(
  columns: readonly string[],
  hasHeader: boolean,
): EdgeColumnChoice | undefined {
  if (!hasHeader) {
    // No names to go on, so position is the only signal — and `pre, post, weight` is what a
    // headerless edge list is. Offered as a starting point the panel shows, never applied blind.
    if (columns.length < 2) return undefined
    return columns.length >= 3 ? { pre: 0, post: 1, weight: 2 } : { pre: 0, post: 1 }
  }
  const pre = pick(columns, PRE_NAMES)
  const post = pick(columns, POST_NAMES)
  if (pre === undefined || post === undefined || pre === post) return undefined
  const weight = pick(columns, WEIGHT_NAMES)
  return weight === undefined ? { pre, post } : { pre, post, weight }
}

/**
 * What the panel needs to ask its question, from the first `PREVIEW_BYTES` of a file.
 *
 * The sample is trimmed back to its last complete line first. Without that the final row is
 * whatever the cut left behind — which is harmless in a preview and is *not* harmless in the
 * delimiter and header decisions, both of which are judged on how consistently rows split.
 */
export function previewEdges(sample: string): EdgeFilePreview {
  const lastBreak = sample.lastIndexOf('\n')
  const text = lastBreak > 0 ? sample.slice(0, lastBreak) : sample
  const parsed = parseDelimited(text)
  const columns = parsed.table.schema.columns.map((c) => c.name)
  const suggestion = suggestEdgeColumns(columns, parsed.hasHeader)
  // Re-split for the preview rows, so the panel shows the text as it is in the file rather than
  // the values `parseDelimited` narrowed them to — a null cell would otherwise read as blank
  // with no way to tell it from an empty field.
  const splitter = new RowSplitter(parsed.delimiter)
  const rows = [...splitter.push(text), ...splitter.finish()]
  return {
    delimiter: parsed.delimiter,
    hasHeader: parsed.hasHeader,
    columns,
    rows: (parsed.hasHeader ? rows.slice(1) : rows).slice(0, 20),
    ...(suggestion ? { suggestion } : {}),
  }
}

export interface ReadEdgesOptions {
  delimiter: Delimiter
  hasHeader: boolean
  columns: EdgeColumnChoice
  /** Total bytes, where the caller knows it, so progress is a fraction rather than a count. */
  totalBytes?: number
  onProgress?: (fraction: number, note?: string) => void
  signal?: AbortSignal
}

/** Rows between progress reports. Frequent enough to move, rare enough to cost nothing. */
const REPORT_EVERY = 250_000

/**
 * Stream a delimited file into an encoded edge set.
 *
 * Nothing is held but the builder: the text is decoded a chunk at a time and the rows are
 * consumed as they complete, so the file's own size never appears in memory. What *is* held is
 * the accumulating edge list, which is the cost recorded on `EdgeSetBuilder`.
 */
export async function readEdges(
  stream: ReadableStream<Uint8Array>,
  options: ReadEdgesOptions,
): Promise<EncodedEdges> {
  const { pre, post, weight } = options.columns
  const builder = new EdgeSetBuilder()
  const splitter = new RowSplitter(options.delimiter)
  const decoder = new TextDecoder()
  const reader = stream.getReader()

  let skip = options.hasHeader ? 1 : 0
  let bytes = 0
  let rows = 0
  let reportedAt = 0

  const consume = (row: string[]) => {
    if (skip > 0) {
      skip--
      return
    }
    rows++
    // A weight column that is absent means an unweighted edge list; one that is *blank* on this
    // row is missing data, and `Number('')` is 0 — a zero-weight edge, which is a connection
    // nobody recorded. `NaN` sends it to the builder's dropped count instead.
    let value = 1
    if (weight !== undefined) {
      const text = (row[weight] ?? '').trim()
      value = text === '' ? Number.NaN : Number(text)
    }
    builder.add(row[pre] ?? '', row[post] ?? '', value)
  }

  try {
    for (;;) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      for (const row of splitter.push(decoder.decode(value, { stream: true }))) consume(row)
      if (rows - reportedAt >= REPORT_EVERY) {
        reportedAt = rows
        // A fraction only where the caller knew the size; a chunked response declares nothing,
        // and a fraction built from a missing length is worse than none.
        const fraction = options.totalBytes ? Math.min(0.99, bytes / options.totalBytes) : 0
        options.onProgress?.(fraction, `${rows.toLocaleString()} rows`)
      }
    }
    // Flush the decoder's own tail, then the splitter's — a multi-byte character or a final row
    // with no newline after it lives in one or the other.
    for (const row of splitter.push(decoder.decode())) consume(row)
    for (const row of splitter.finish()) consume(row)
  } finally {
    reader.releaseLock()
  }

  options.onProgress?.(0.99, 'Compressing')
  return builder.finish()
}
