/**
 * Reading one of a suggestion set's parquet files, through Coda's own lazy reader.
 *
 * `src/data/files` is reused whole rather than reaching for hyparquet here, and what that buys is
 * not convenience: a server that answers a ranged GET with the entire object is **refused** there
 * rather than quietly buffering eleven megabytes, an unsupported codec is one sentence naming the
 * rewrite, and the footer fingerprint is what notices a file replaced under a running graph. Each
 * of those is a failure nobody would see from here.
 *
 * ## The file is checked against the contract, column by column
 *
 * `suggestionTables.ts` declares what a suggestion set holds. This asks the file for exactly
 * those columns and refuses by name when one is missing or arrives as a type the declared schema
 * does not promise. The alternative — publish what turned up — is a table whose schema and
 * contents disagree, which is invariant 3's failure reached through a file.
 *
 * ## Why every row, with a cap that is a refusal rather than a trim
 *
 * `readRows` takes a `limit` and reports `truncated`. A suggestion set read short is not a
 * smaller suggestion set: the tips are a queue and the candidates are ranked lists, so dropping
 * the tail silently removes suggestions. So the limit is a ceiling that **throws** when reached,
 * and it is sized at ten times rv2's own candidate count rather than at rv2's.
 */

import type { DType } from '../../core/types'
import type { CellValue } from '../../core/values'
import { urlHead } from '../../data/files/bytes'
import type { ByteSpec } from '../../data/files/bytes'
import { openTableSpec, readRows } from '../../data/files/read'
import type { TableFileReader } from '../../data/files/reader'
import { formatNumber } from '../../style/format'
import { FIRST_CANDIDATE } from './suggestionTables'
import type { Field } from './suggestionTables'

/**
 * The most rows one file of a set may hold.
 *
 * Ten times rv2's 103,375 candidates. Not a guess at what is reasonable — it is the point past
 * which a set is so much larger than anything SEAM has produced that reading it whole into a
 * `TableValue` is the wrong shape and somebody should be told, rather than a number tuned to the
 * one set that exists.
 */
export const MAX_SUGGESTION_ROWS = 1_000_000

/** How a file's bytes are reached. Factored so a test reads a blob and the node reads a URL. */
export type OpenFile = (file: string, signal?: AbortSignal) => Promise<TableFileReader>

/** Open a set's file over HTTP, by byte range. */
export function openOverHttp(url: (file: string) => string): OpenFile {
  return async (file, signal) => {
    const address = url(file)
    // The size has to be known before a ranged read can be planned, and `urlHead` is also where a
    // host that will not answer a HEAD is found — before eleven megabytes, not during.
    const { size, modified } = await urlHead(address)
    const spec: ByteSpec = modified
      ? { kind: 'url', url: address, size, modified }
      : { kind: 'url', url: address, size }
    return openTableSpec(spec, signal)
  }
}

export interface ReadOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (fraction: number) => void
}

/**
 * Read one file's declared columns.
 *
 * Returns the cells keyed by their **file** names, which is what `tableOf` takes — the rename to
 * published names happens in one place, there, rather than being half-done here.
 */
export async function readFields(
  reader: TableFileReader,
  fields: readonly Field[],
  what: string,
  options: ReadOptions = {},
): Promise<{ data: Record<string, CellValue[]>; rows: number }> {
  const held = new Map(reader.summary.columns.map((column) => [column.name, column]))
  // A field the file does not hold because it is filled in afterwards — see `FIRST_CANDIDATE`.
  const columns = fields
    .filter((field) => field.from !== FIRST_CANDIDATE)
    .map((field) => {
      const column = held.get(field.from)
      if (!column) {
        const skipped = reader.summary.skipped.includes(field.from)
        throw new Error(
          `${what} has no \`${field.from}\` column` +
            (skipped
              ? ', because it is a list or a struct and Coda reads neither. SEAM writes these as ' +
                '`;`-joined text; this set was made before that change.'
              : `. It holds ${reader.summary.columns.length} columns, and a suggestion set needs ` +
                `the ${fields.length} this node publishes.`),
        )
      }
      if (!compatible(column.dtype, field.dtype, column.int64 === true)) {
        throw new Error(
          `${what}'s \`${field.from}\` is ${column.dtype} and this node publishes it as ` +
            `${field.dtype}. Reading it anyway would put one kind of value under a schema ` +
            `promising another, which every picker downstream believes.`,
        )
      }
      return { column, dtype: field.dtype }
    })

  const result = await readRows(
    reader,
    { fingerprint: reader.summary.fingerprint, columns, limit: MAX_SUGGESTION_ROWS },
    options,
  )
  if (result.truncated) {
    throw new Error(
      `${what} holds more than ${formatNumber(MAX_SUGGESTION_ROWS)} rows. Reading part of a ` +
        `suggestion set would drop suggestions off the end of the queue without saying so, so ` +
        `this is refused rather than trimmed.`,
    )
  }
  return { data: result.data, rows: result.rows }
}

/**
 * Whether a file's column may be read as the field's dtype.
 *
 * Equal, with one exception: a 64-bit integer may be read as **text**. That is Coda's own id rule
 * (`columns.ts`) and the reason it exists is invariant 8 — a root id past 2^53 is a different
 * neuron once it has been through a float. SEAM writes its ids as strings today; this is what
 * keeps a set that one day writes them as `INT64` readable instead of refused, and readable
 * *exactly*, since the text decoder stringifies a `bigint` rather than narrowing it.
 *
 * Nothing else is tolerated. Reading a float column as text, or an integer one as a float, would
 * put values under a schema that promises something else, and every picker downstream believes
 * the schema.
 */
function compatible(held: DType, wanted: DType, int64: boolean): boolean {
  return held === wanted || (int64 && wanted === 'str')
}
