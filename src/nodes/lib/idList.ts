/**
 * Reading a list of neuron ids somebody typed or pasted.
 *
 * The sibling of `labelLookup.ts`, and the same three jobs: parse the text field, union it with
 * a wired column, and report back what the dataset did not have. What is different is that a
 * *label* is free text and an *id* is a number — so this half refuses where that one accepts,
 * and the refusals are most of the file.
 *
 * **Ids come out as exact decimal text, not as numbers**, which is what `NeuronId` is and why
 * the refusal this file used to make about `Number.MAX_SAFE_INTEGER` is gone. It was right for
 * as long as an id had to become a float64 on the way to a query: an eighteen-digit CAVE root
 * id would have been stored as a nearby integer and identified a different neuron. Keeping the
 * digits means there is nothing to lose, so a wide id is now simply an id.
 */

import type { TableValue } from '../../core/values'
import { idText } from '../../core/ids'

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

/**
 * Digits only, for *typed* text. Stricter than `isNeuronId`, which is the transport grammar
 * and allows a sign: a negative neuron id somebody typed is a typo, most often a `123-456` range.
 */
const DIGITS = /^\d+$/

/** Hoisted, like the two above it — `parseIdList` runs on every keystroke of the ids field. */
const LEADING_ZEROS = /^0+(?=\d)/

export interface IdListResult {
  ids: string[]
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
 * The widest id any backend here can hold, in digits.
 *
 * `9223372036854775807` is a signed 64-bit maximum, which is what both Neo4j and CAVE store an
 * id in — so nineteen digits is the honest ceiling and anything past it is a paste that went
 * wrong rather than a neuron. This replaces the old `Number.MAX_SAFE_INTEGER` refusal, which
 * was about *JavaScript* rather than about the data and cut off at sixteen: neuPrint's ids are
 * nine to eleven digits, CAVE's are eighteen, and only one of those used to be expressible.
 */
const MAX_ID_DIGITS = 19

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
  const seen = new Set<string>()
  const ids: string[] = []

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
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
    // Leading zeros are stripped rather than kept. `007` is a typo for `7` in a field of body
    // ids, and the two have to dedupe against each other — but the deciding reason is that the
    // digits are spliced into Cypher as an integer literal, where a leading zero is not
    // something every server reads the way it looks.
    // Gated on the first character: this runs per keystroke over up to ten thousand tokens,
    // and essentially none of them start with a zero.
    const value = token.charCodeAt(0) === 48 ? token.replace(LEADING_ZEROS, '') : token
    if (value.length > MAX_ID_DIGITS) {
      return {
        ids: [],
        error:
          `"${token}" is too long to be a neuron id — ids are at most ${MAX_ID_DIGITS} digits, ` +
          `which is what a 64-bit id holds.`,
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
 * A *number* cell too wide to be exact is dropped here rather than refused, and counted so the
 * card can say a number rather than nothing — by the time it is a float64 its digits are already
 * gone, so there is nothing to recover. A *string* cell of digits is kept whatever its width,
 * which is how a CAVE root id survives the trip.
 */
function idsFromColumn(
  table: TableValue | undefined,
  column: string | undefined,
): { ids: string[]; dropped: number } {
  if (!table || !column) return { ids: [], dropped: 0 }
  const data = table.data[column]
  if (!data) return { ids: [], dropped: 0 }

  const ids: string[] = []
  let dropped = 0
  for (const cell of data) {
    if (cell === null || cell === undefined || cell === '') continue
    const value = idText(cell)
    if (value === null || !DIGITS.test(value)) {
      dropped++
      continue
    }
    ids.push(value)
  }
  return { ids, dropped }
}

export interface CollectedIds {
  ids: string[]
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
  const seen = new Set<string>()
  const ids: string[] = []
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
 * a result with no `neuronId` column means silence, because "none of these exist" over a table
 * full of neurons is a specific and wrong claim where saying nothing is merely unhelpful.
 */
export function unmatchedIds(
  ids: readonly string[],
  result: TableValue | undefined,
  columnName = 'neuronId',
): string[] {
  if (ids.length === 0 || !result) return []
  const values = result.data[columnName]
  if (!values) return []

  const present = new Set<string>()
  for (const cell of values) {
    const id = idText(cell)
    if (id !== null) present.add(id)
  }
  return ids.filter((id) => !present.has(id))
}
