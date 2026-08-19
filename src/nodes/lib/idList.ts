/**
 * Reading a list of neuron ids somebody typed or pasted.
 *
 * The sibling of `labelLookup.ts`, and the same three jobs: parse the text field, union it with
 * a wired column, and report back what the dataset did not have. What is different is that a
 * *label* is free text and an *id* is a number — so this half refuses where that one accepts,
 * and the refusals are most of the file.
 */

import type { TableValue } from '../../core/values'

/**
 * What separates one id from the next.
 *
 * Whitespace, comma and semicolon are the ones anybody would expect. Brackets and quotes are in
 * there because the list very often arrives as `[123, 456]` or `"123","456"` — copied out of a
 * Python session, a JSON blob or a spreadsheet — and refusing that paste on a punctuation mark
 * would be refusing the gesture rather than the content. They are separators and not *stripped*
 * characters, which is what keeps `12a` a single bad token rather than a `12` with something
 * quietly discarded after it.
 */
const SEPARATORS = /[\s,;[\]()'"]+/

/** Digits only. No sign: a negative body id is a typo, most often a `123-456` range. */
const DIGITS = /^\d+$/

export interface IdListResult {
  ids: number[]
  /**
   * Why the text could not be read, if it could not.
   *
   * A returned message rather than a throw, because both callers need it and neither can throw:
   * `validate` runs at edit time and returns strings, and `evaluate` wants to raise the *same*
   * sentence so the badge and the error agree word for word.
   */
  error?: string
}

/**
 * `Number.MAX_SAFE_INTEGER`, spelled out because the message quotes it.
 *
 * `CellValue` is a JS number, so an `i64` column is really a float64 and an id past this cannot
 * be held exactly — it would be stored as a nearby integer and identify a *different neuron*,
 * with nothing anywhere to say so. neuPrint's ids are nine to eleven digits and nowhere near it;
 * FlyWire root ids are eighteen and are well past.
 */
const MAX_SAFE = Number.MAX_SAFE_INTEGER

/**
 * Ids out of typed text, or the reason there are none.
 *
 * **A bad token refuses the whole list rather than being skipped.** The alternative was
 * considered and declined: a list of ids is a list of neurons somebody means to look at, and
 * quietly dropping one is quietly answering a different question. The cost is real and is
 * accepted — pasting a spreadsheet column brings its header along, and that header now has to be
 * deleted — so the message says so when the first token is a word, which is exactly that case.
 */
export function parseIdList(text: unknown): IdListResult {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return { ids: [] }

  const tokens = raw.split(SEPARATORS).filter((t) => t !== '')
  const seen = new Set<number>()
  const ids: number[] = []

  for (const [index, token] of tokens.entries()) {
    if (!DIGITS.test(token)) {
      const headerHint =
        index === 0 && /^[A-Za-z_]+$/.test(token)
          ? ` If you pasted a column, delete its header line.`
          : ''
      return {
        ids: [],
        error:
          `"${token}" is not a neuron id. Ids are digits only, separated by spaces, commas ` +
          `or newlines.${headerHint}`,
      }
    }
    const value = Number(token)
    if (!Number.isSafeInteger(value)) {
      return {
        ids: [],
        error:
          `"${token}" is too large to hold exactly (the limit is ${MAX_SAFE.toLocaleString()}). ` +
          `It would be stored as a nearby number and identify a different neuron.`,
      }
    }
    // Deduplicated with first-occurrence order kept: a neuron listed twice is one neuron, and a
    // repeated row would be double-counted by everything downstream that sums a weight.
    if (seen.has(value)) continue
    seen.add(value)
    ids.push(value)
  }

  return { ids }
}

export interface IdSources {
  /** Raw text of the node's own field. */
  typed: unknown
  /** The wired ids table, when connected. */
  table?: TableValue | undefined
  /** Which of its columns holds the ids. */
  column?: string | undefined
}

/**
 * Ids from a wired column.
 *
 * **Silently drops what it cannot use, unlike the typed half**, and the asymmetry is deliberate
 * rather than an oversight. Typed text is *authored*: a token that is not an id is a mistake
 * somebody just made and can fix, so refusing is useful. A wired column is *data*, arriving from
 * a query or a file, and a node that refused to run because one upstream row had a null id would
 * be unusable — which is why `idColumn()` has always skipped them, and this agrees with it.
 *
 * Ids past the safe range are dropped here rather than refused for the same reason, and they are
 * counted so the card can say a number rather than nothing.
 */
function idsFromColumn(
  table: TableValue | undefined,
  column: string | undefined,
): { ids: number[]; dropped: number } {
  if (!table || !column) return { ids: [], dropped: 0 }
  const data = table.data[column]
  if (!data) return { ids: [], dropped: 0 }

  const ids: number[] = []
  let dropped = 0
  for (const cell of data) {
    if (cell === null || cell === undefined || cell === '') continue
    const value = Number(cell)
    if (!Number.isSafeInteger(value) || value < 0) {
      dropped++
      continue
    }
    ids.push(value)
  }
  return { ids, dropped }
}

export interface CollectedIds {
  ids: number[]
  /** Why the typed half could not be read. Nothing is collected at all when this is set. */
  error?: string
  /** Rows of the wired column that were not usable ids. */
  dropped: number
}

/**
 * The full set to look up: typed first, then the wired column.
 *
 * A union rather than one overriding the other — the same call `collectLabels` makes, for the
 * same reason. Both are things somebody asked for, and a node that dropped the text field the
 * moment a wire arrived would look correct, because the result is a valid neuron table either
 * way. First-occurrence order is kept because that is the order the unmatched report prints in.
 */
export function collectIds(sources: IdSources): CollectedIds {
  const typed = parseIdList(sources.typed)
  if (typed.error) return { ids: [], error: typed.error, dropped: 0 }

  const wired = idsFromColumn(sources.table, sources.column)
  const seen = new Set<number>()
  const ids: number[] = []
  for (const id of [...typed.ids, ...wired.ids]) {
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return { ids, dropped: wired.dropped }
}

/**
 * Which of the requested ids the dataset did not return.
 *
 * Derived from the run rather than reported by it — same reasoning as `unmatchedLabels`, and the
 * same two refusals. No result means the node has not run, so nothing is missing from anything;
 * a result with no `bodyId` column means silence, because "none of these exist" over a table
 * full of neurons is a specific and wrong claim where saying nothing is merely unhelpful.
 */
export function unmatchedIds(
  ids: readonly number[],
  result: TableValue | undefined,
  columnName = 'bodyId',
): number[] {
  if (ids.length === 0 || !result) return []
  const values = result.data[columnName]
  if (!values) return []

  const present = new Set<number>()
  for (const cell of values) {
    if (cell === null || cell === undefined) continue
    present.add(Number(cell))
  }
  return ids.filter((id) => !present.has(id))
}
