/**
 * The Explore widget's query language, and the search that runs it.
 *
 * Headless on purpose: the node's `evaluate` and the widget's keystroke-by-keystroke preview
 * have to agree exactly about what a query means, and the only way to guarantee that is for
 * both to call this. A second implementation in the UI would drift, and the drift would show
 * up as a list that disagrees with the table it feeds.
 *
 * ## The language
 *
 *   DNp01                     bare term — matches anywhere, in any field
 *   "giant fiber"             quoted phrase, spaces included
 *   !fragment  -fragment      exclude rows matching the term
 *   class==sensory            field equals value (case-insensitive)
 *   class!=sensory            field does not equal value
 *   post>1000  size<=5e6      numeric comparison
 *   type~^LC[0-9]+$           regular expression against one field
 *
 * Terms are ANDed. There is no `||` and no bracketing: every extra operator is something a
 * newcomer can get wrong, and the graph already has a Filter node for anything this cannot
 * express.
 *
 * ## Fuzzy is a fallback, not the default
 *
 * A bare term matches as a **substring**. Only when the whole query finds *nothing* is it
 * retried as a **subsequence**, and the result says so, so the widget can admit it is showing
 * approximate matches.
 *
 * Running both at once was the first design and it was wrong on real data: subsequence
 * matching over a concatenated row is extremely permissive, so `DNp01` reported 4,389 hits
 * against male-CNS instead of 320. The right ones ranked first, but a hit count off by an
 * order of magnitude is its own lie. As a fallback it still does the job people want fuzz for
 * — `mechnosensory` with the typo finds `mechanosensory` — without inflating every count.
 *
 * Both passes are affordable, which was worth measuring before designing around: over
 * male-CNS's 165,122 neurons × 11 string fields a substring pass is ~6 ms and a full
 * subsequence pass ~30 ms. So the dataset is rescanned per keystroke, and nothing is
 * precomputed beyond one concatenated lowercase string per row.
 *
 * ## Nulls
 *
 * A missing value matches no positive term and every negated one — so `status!=Traced` returns
 * the untraced *and* the unlabelled, which is what someone hunting for gaps wants. SQL's
 * three-valued logic would exclude both, and silently.
 */

import type { ColumnSchema, TableSchema } from '../../core/types'
import { isNumericDType } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'

export type CompareOp = 'eq' | 'ne' | 'gt' | 'lt' | 'ge' | 'le' | 'match'

export interface TextTerm {
  kind: 'text'
  /** Already lowercased. */
  value: string
  negate: boolean
}

export interface FieldTerm {
  kind: 'field'
  /** As typed; resolved against the schema case-insensitively at match time. */
  field: string
  op: CompareOp
  value: string
  negate: boolean
}

export type SearchTerm = TextTerm | FieldTerm

export interface ParsedSearch {
  terms: SearchTerm[]
  /** Human-readable problems — an unparseable regex, an operator with no value. */
  errors: string[]
}

/** Operators, longest first: `>=` must be tried before `>`, `==` before `=`. */
const OPERATORS: Array<[token: string, op: CompareOp]> = [
  ['==', 'eq'],
  ['!=', 'ne'],
  ['>=', 'ge'],
  ['<=', 'le'],
  ['~', 'match'],
  ['>', 'gt'],
  ['<', 'lt'],
  ['=', 'eq'],
]

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface Token {
  text: string
  /** Offsets into the original query, so autocomplete can splice a replacement in. */
  from: number
  to: number
}

/**
 * Split on whitespace, keeping quoted runs together.
 *
 * Returns offsets because the completion popup has to replace the token under the caret
 * without re-parsing, and because an unterminated quote — which is the state the query is in
 * for as long as someone is typing one — must still yield a usable last token.
 */
export function tokenizeSearch(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++
    if (i >= text.length) break
    const from = i
    let quote: string | undefined
    while (i < text.length) {
      const ch = text[i]!
      if (quote) {
        if (ch === quote) quote = undefined
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (/\s/.test(ch)) {
        break
      }
      i++
    }
    tokens.push({ text: text.slice(from, i), from, to: i })
  }
  return tokens
}

function unquote(value: string): string {
  const first = value[0]
  if ((first === '"' || first === "'") && value.length >= 2) {
    return value.endsWith(first) ? value.slice(1, -1) : value.slice(1)
  }
  return value
}

/** Split a token into `field`, operator and value, or undefined when it is a bare term. */
function splitOperator(
  token: string,
): { field: string; op: CompareOp; value: string } | undefined {
  for (const [symbol, op] of OPERATORS) {
    const at = token.indexOf(symbol)
    if (at <= 0) continue
    const field = token.slice(0, at)
    if (!FIELD_NAME.test(field)) continue
    return { field, op, value: token.slice(at + symbol.length) }
  }
  return undefined
}

export function parseSearch(text: string): ParsedSearch {
  const terms: SearchTerm[] = []
  const errors: string[] = []

  for (const token of tokenizeSearch(text)) {
    let raw = token.text
    let negate = false
    // `-` only negates when something follows it, or a lone dash while typing would silently
    // negate the next thing typed.
    if ((raw.startsWith('!') || raw.startsWith('-')) && raw.length > 1 && !splitOperator(raw)) {
      negate = true
      raw = raw.slice(1)
    }

    const split = splitOperator(raw)
    if (!split) {
      const value = unquote(raw)
      if (value) terms.push({ kind: 'text', value: value.toLowerCase(), negate })
      continue
    }

    const value = unquote(split.value)
    if (!value) {
      // Not an error: this is every query mid-typing, and reporting it would flash a message
      // on the node between "class==" and "class==sensory".
      continue
    }
    if (split.op === 'match') {
      try {
        new RegExp(value)
      } catch (error) {
        errors.push(`Invalid regex for "${split.field}": ${(error as Error).message}`)
        continue
      }
    }
    terms.push({ kind: 'field', field: split.field, op: split.op, value, negate })
  }

  return { terms, errors }
}

// ---------------------------------------------------------------------------
// The searchable index
// ---------------------------------------------------------------------------

export interface SearchIndex {
  /** One lowercase string per row: every searchable field, space-joined. */
  haystacks: string[]
  /** Columns folded into the haystack, in order. */
  searched: string[]
  /** Column names to rank by, when present — a hit here beats a hit anywhere else. */
  primary: string[]
}

/**
 * Fields worth ranking a hit in. `type` and `instance` are what people search by name, so a
 * hit there should outrank the same string appearing in, say, a neurotransmitter prediction.
 */
const PRIMARY_CANDIDATES = ['type', 'instance', 'bodyId']

/** Columns folded into the free-text haystack: identifiers and every string field. */
function searchableColumns(schema: TableSchema): ColumnSchema[] {
  return schema.columns.filter((c) => c.dtype === 'str' || c.name === 'bodyId')
}

/**
 * Build the concatenated lowercase haystacks. ~55 ms and ~24 MB for 165k neurons, so this is
 * memoised per table by `searchIndexFor` rather than rebuilt per query.
 */
export function buildSearchIndex(table: TableValue): SearchIndex {
  const columns = searchableColumns(table.schema)
  const arrays = columns.map((c) => table.data[c.name] ?? [])
  const haystacks = new Array<string>(table.length)

  for (let row = 0; row < table.length; row++) {
    let joined = ''
    for (const column of arrays) {
      const cell = column[row]
      if (cell === null || cell === undefined) continue
      joined += joined ? ' ' + String(cell) : String(cell)
    }
    haystacks[row] = joined.toLowerCase()
  }

  return {
    haystacks,
    searched: columns.map((c) => c.name),
    primary: PRIMARY_CANDIDATES.filter((name) => table.data[name] !== undefined),
  }
}

const indexCache = new WeakMap<TableValue, SearchIndex>()

/** Memoised `buildSearchIndex`. Keyed by table identity, which is how values flow anyway. */
export function searchIndexFor(table: TableValue): SearchIndex {
  let index = indexCache.get(table)
  if (!index) {
    index = buildSearchIndex(table)
    indexCache.set(table, index)
  }
  return index
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Is `needle` a subsequence of `hay`? Both must already be lowercase. */
export function isSubsequence(needle: string, hay: string): boolean {
  if (needle.length === 0) return true
  if (needle.length > hay.length) return false
  let n = 0
  for (let i = 0; i < hay.length; i++) {
    if (hay[i] === needle[n]) {
      n++
      if (n === needle.length) return true
    }
  }
  return false
}

function resolveColumn(table: TableValue, field: string): ColumnSchema | undefined {
  const lower = field.toLowerCase()
  return table.schema.columns.find((c) => c.name.toLowerCase() === lower)
}

/**
 * Compare one cell against one field term.
 *
 * A missing value satisfies `!=` and nothing else. So `status!=Traced` returns the untraced
 * *and* the unlabelled, which is what someone auditing a dataset for gaps is asking for; SQL's
 * three-valued logic would drop the unlabelled from both sides of the comparison and never say
 * it had. Every other operator, `==` included, treats null as "no value to compare".
 */
function cellMatches(
  cell: CellValue,
  term: FieldTerm,
  numeric: boolean,
  regex?: RegExp,
): boolean {
  if (cell === null || cell === undefined) return term.op === 'ne'

  if (term.op === 'match') return regex ? regex.test(String(cell)) : false

  if (numeric) {
    const left = typeof cell === 'number' ? cell : Number(cell)
    const right = Number(term.value)
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false
    switch (term.op) {
      case 'eq':
        return left === right
      case 'ne':
        return left !== right
      case 'gt':
        return left > right
      case 'lt':
        return left < right
      case 'ge':
        return left >= right
      case 'le':
        return left <= right
    }
  }

  const left = String(cell).toLowerCase()
  const right = term.value.toLowerCase()
  switch (term.op) {
    case 'eq':
      return left === right
    case 'ne':
      return left !== right
    // Lexicographic, so `type>M` is at least meaningful rather than silently false.
    case 'gt':
      return left > right
    case 'lt':
      return left < right
    case 'ge':
      return left >= right
    case 'le':
      return left <= right
  }
}

export interface SearchResult {
  /** Matching row indices, best first. */
  rows: number[]
  /** True when nothing matched exactly and these are approximate (subsequence) matches. */
  fuzzy: boolean
}

/**
 * Run a parsed query.
 *
 * Ordering: exact body-id hit, then hits in `type`/`instance`, then substring hits anywhere,
 * then subsequence-only hits, and `bodyId` order within each tier. An empty query returns
 * every row in the table's own order and does no ranking work at all.
 */
export function runSearch(
  table: TableValue,
  index: SearchIndex,
  parsed: ParsedSearch,
): SearchResult {
  const textTerms = parsed.terms.filter((t): t is TextTerm => t.kind === 'text')
  const fieldTerms = parsed.terms.filter((t): t is FieldTerm => t.kind === 'field')

  if (textTerms.length === 0 && fieldTerms.length === 0) {
    return { rows: Array.from({ length: table.length }, (_, i) => i), fuzzy: false }
  }

  // Resolved once per term rather than per row: a RegExp constructor and a schema lookup
  // inside a 165k-iteration loop is most of the cost of the loop.
  const prepared = fieldTerms.map((term) => {
    const column = resolveColumn(table, term.field)
    const data = column ? table.data[column.name] : undefined
    return {
      term,
      data,
      numeric: column ? isNumericDType(column.dtype) : false,
      regex: term.op === 'match' ? new RegExp(term.value, 'i') : undefined,
      // An unknown field cannot match anything; `validateSearch` is what tells the user why.
      unknown: !column || !data,
    }
  })

  const scan = (fuzzy: boolean): number[] => {
    const hits: number[] = []
    for (let row = 0; row < table.length; row++) {
      let keep = true

      for (const entry of prepared) {
        const matched = entry.unknown
          ? false
          : cellMatches(entry.data![row] ?? null, entry.term, entry.numeric, entry.regex)
        if (matched === entry.term.negate) {
          keep = false
          break
        }
      }
      if (!keep) continue

      for (const term of textTerms) {
        const hay = index.haystacks[row] ?? ''
        const matched = fuzzy ? isSubsequence(term.value, hay) : hay.includes(term.value)
        if (matched === term.negate) {
          keep = false
          break
        }
      }
      if (keep) hits.push(row)
    }
    return hits
  }

  const positive = textTerms.filter((t) => !t.negate)
  let hits = scan(false)
  let fuzzy = false
  // Only worth retrying when there is something to be approximate *about*: a query of pure
  // field comparisons that matches nothing matches nothing, and re-scanning would say so
  // twice as slowly.
  if (hits.length === 0 && positive.length > 0) {
    hits = scan(true)
    fuzzy = hits.length > 0
  }

  if (positive.length === 0) return { rows: hits, fuzzy }
  return { rows: rankHits(table, index, hits, positive[0]!.value), fuzzy }
}

/** How well a row matches the leading term. Lower is better; see `TIERS`. */
const TIERS = 5

function tierOf(table: TableValue, index: SearchIndex, row: number, needle: string): number {
  for (const name of index.primary) {
    const cell = table.data[name]?.[row]
    if (cell === null || cell === undefined) continue
    const value = String(cell).toLowerCase()
    if (value === needle) return 0
    if (value.startsWith(needle)) return 1
    if (value.includes(needle)) return 2
  }
  return (index.haystacks[row] ?? '').includes(needle) ? 3 : 4
}

/**
 * Order hits by match quality — as a bucket partition, not a sort.
 *
 * There are only five tiers, so partitioning is O(n) and exact, where a comparator sort would
 * be O(n log n) with a lookup per comparison. That difference is why this can rank *every*
 * hit rather than giving up above some threshold, and giving up was a real bug: `dnp1` matches
 * 21,264 male-CNS neurons as a subsequence, so a 20k cut-off left the actual DNp01 neurons
 * unranked and buried thousands of rows deep, which reads as "fuzzy search does not work".
 *
 * Hits arrive in the table's own order (body id) and buckets preserve it, so the result is a
 * total order: the same query always yields the same rows in the same sequence.
 */
function rankHits(
  table: TableValue,
  index: SearchIndex,
  hits: number[],
  needle: string,
): number[] {
  const buckets: number[][] = Array.from({ length: TIERS }, () => [])
  for (const row of hits) buckets[tierOf(table, index, row, needle)]!.push(row)
  return buckets.flat()
}

// ---------------------------------------------------------------------------
// Validation and help
// ---------------------------------------------------------------------------

/**
 * Problems worth putting on the node: a bad regex, or a field nobody has.
 *
 * An unknown field is a warning rather than a silent empty result, because `superclas==x`
 * matching nothing looks identical to a dataset that genuinely has no such neurons.
 */
export function validateSearch(
  schema: TableSchema | undefined,
  parsed: ParsedSearch,
): string[] {
  const issues = [...parsed.errors]
  if (!schema) return issues
  const names = new Set(schema.columns.map((c) => c.name.toLowerCase()))
  const unknown = parsed.terms
    .filter((t): t is FieldTerm => t.kind === 'field')
    .map((t) => t.field)
    .filter((field) => !names.has(field.toLowerCase()))
  for (const field of [...new Set(unknown)]) {
    issues.push(`No field "${field}" in this dataset`)
  }
  return issues
}

// ---------------------------------------------------------------------------
// Autocompletion
// ---------------------------------------------------------------------------

export interface Completion {
  /** Replacement text for the token under the caret. */
  text: string
  label: string
  detail?: string
  kind: 'field' | 'value'
}

export interface CompletionResult {
  /** Range in the query string that `text` replaces. */
  from: number
  to: number
  items: Completion[]
}

const MAX_COMPLETIONS = 8

const valueCache = new WeakMap<TableValue, Map<string, string[]>>()

/**
 * Distinct values of a string column, sorted, memoised per table.
 *
 * Not capped: `type` has 11,751 distinct values on male-CNS and `instance` 23,848, and those
 * are exactly the fields worth completing. Building all of them takes ~60 ms once.
 */
export function fieldValues(table: TableValue, column: string): string[] {
  let byColumn = valueCache.get(table)
  if (!byColumn) {
    byColumn = new Map()
    valueCache.set(table, byColumn)
  }
  const held = byColumn.get(column)
  if (held) return held

  const data = table.data[column] ?? []
  const seen = new Set<string>()
  for (const cell of data) {
    if (cell === null || cell === undefined) continue
    seen.add(String(cell))
  }
  const values = [...seen].sort()
  byColumn.set(column, values)
  return values
}

/** The token the caret sits in or immediately after. */
function tokenAt(text: string, caret: number): Token | undefined {
  return tokenizeSearch(text).find((t) => caret >= t.from && caret <= t.to)
}

/**
 * Rank candidate strings for the completion list.
 *
 * Deliberately the same four tiers `runSearch` ranks hits by — exact, prefix, substring,
 * subsequence — rather than the palette's `fuzzyMatch` scoring. Two reasons: the completion
 * list then orders the way the result list will, and `src/nodes` stays free of any import
 * from `src/ui`, which a headless runner would not ship.
 */
export function rankStrings(query: string, values: readonly string[], limit: number): string[] {
  const needle = query.toLowerCase()
  if (!needle) return values.slice(0, limit)

  const scored: Array<{ value: string; tier: number }> = []
  for (const value of values) {
    const lower = value.toLowerCase()
    let tier: number
    if (lower === needle) tier = 0
    else if (lower.startsWith(needle)) tier = 1
    else if (lower.includes(needle)) tier = 2
    else if (isSubsequence(needle, lower)) tier = 3
    else continue
    scored.push({ value, tier })
  }
  // Shorter wins within a tier: for "lc", "LC4" should beat "LC4_complex_variant".
  scored.sort(
    (a, b) =>
      a.tier - b.tier || a.value.length - b.value.length || (a.value < b.value ? -1 : 1),
  )
  return scored.slice(0, limit).map((entry) => entry.value)
}

/**
 * Suggest completions for the token under the caret.
 *
 * Field names when there is no operator yet, values when there is one. Nothing is offered for
 * an empty token — a popup that appears on every space is noise, not help.
 */
export function completeSearch(
  table: TableValue,
  text: string,
  caret: number,
): CompletionResult {
  const token = tokenAt(text, caret)
  const empty: CompletionResult = { from: caret, to: caret, items: [] }
  if (!token || !token.text) return empty

  const bare = token.text.replace(/^[!-]/, '')
  const prefix = token.text.slice(0, token.text.length - bare.length)
  const split = splitOperator(bare)

  if (!split) {
    const names = table.schema.columns.filter((c) => c.name !== 'bodyId').map((c) => c.name)
    const dtypeOf = new Map(table.schema.columns.map((c) => [c.name, c.dtype]))
    return {
      from: token.from,
      to: token.to,
      items: rankStrings(bare, names, MAX_COMPLETIONS).map((name) => ({
        // `==` for strings, and for numbers too: a numeric field usually gets `>` typed by
        // hand, and offering `>` here would make an equality search need a deletion.
        text: `${prefix}${name}==`,
        label: `${name}==`,
        detail: dtypeOf.get(name) ?? '',
        kind: 'field' as const,
      })),
    }
  }

  const column = resolveColumn(table, split.field)
  if (!column || column.dtype !== 'str') return empty

  const values = rankStrings(
    unquote(split.value),
    fieldValues(table, column.name),
    MAX_COMPLETIONS,
  )
  return {
    from: token.from,
    to: token.to,
    items: values.map((value) => ({
      // Quoted when it has to be, or `instance=="aPhM1 L"` would parse as two terms.
      text: `${prefix}${split.field}==${/\s/.test(value) ? `"${value}"` : value}`,
      label: value,
      detail: column.name,
      kind: 'value' as const,
    })),
  }
}

/** Shown as the search field's help, and in the node's param tooltip. */
export const SEARCH_SYNTAX_HELP =
  'Terms are combined with AND. `DNp01` matches any field (fuzzily); `"giant fiber"` keeps ' +
  'spaces; `!term` excludes. Per-field: `class==sensory`, `status!=Traced`, `post>1000`, ' +
  '`type~^LC[0-9]+$`.'
