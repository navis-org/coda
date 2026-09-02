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
 *   /^LC[0-9]+$               regular expression against every field
 *
 * Terms are ANDed. There is no `||` and no bracketing: every extra operator is something a
 * newcomer can get wrong, and the graph already has a Filter node for anything this cannot
 * express.
 *
 * ## A bare regex is opted into with a slash, and matched per field
 *
 * `^LC4$` on its own is a *literal* — the substring `^LC4$`, which nothing has. It has to be,
 * because the same box has to keep finding `LC4(R)` and `SMP001(a)`, and a term compiled as a
 * pattern reads those as a group and quietly matches `LC4R` and `SMP001a` as well. That is
 * `escapeRegex`'s whole reason for existing (`src/data/terms.ts`), and a search box widening
 * itself by one row with nothing on screen to say so is exactly the failure it was written for.
 *
 * So the pattern is opted into: a term beginning with `/` is a regex, which is neuroglancer's
 * convention for the same control in the same kind of box. A closing `/` is optional and
 * stripped — `/^LC4$` and `/^LC4$/` are one term, because sed and vim have taught everybody the
 * second spelling and it would otherwise search for a pattern ending in a slash and find
 * nothing at all. To match a trailing slash, escape it: `/LC4\/`.
 *
 * It runs against **each searchable field separately**, not against the concatenated haystack a
 * literal term scans. Anchors are the point of asking for a regex here, and `^LC4$` against a
 * row's joined text — `"10 LC4 visual"` — can never match. The fields are the index's own, so a
 * regex sees exactly what free text sees, minus the same exclusions.
 *
 * ## Fuzzy is a fallback, not the default
 *
 * A bare *literal* term matches as a **substring**. Only when the whole query finds *nothing*
 * is it retried as a **subsequence**, and the result says so, so the widget can admit it is showing
 * approximate matches.
 *
 * Running both at once was the first design and it was wrong on real data: subsequence
 * matching over a concatenated row is extremely permissive, so `DNp01` reported 4,389 hits
 * against male-CNS instead of 320. The right ones ranked first, but a hit count off by an
 * order of magnitude is its own lie. As a fallback it still does the job people want fuzz for
 * — `mechnosensory` with the typo finds `mechanosensory` — without inflating every count.
 *
 * A regex is exempt in both directions: it is never approximated, and a query of nothing but
 * regexes is never re-scanned. Somebody who wrote `/^LC4$` asked for the rows matching
 * `^LC4$`, and answering with the rows that nearly do is not a kindness.
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
import type { CellValue, ColumnData, TableValue } from '../../core/values'
/*
 * The *field* term lives in `src/data/terms.ts`, because the sources that filter a neuron index
 * locally need the same matcher and `src/data` cannot import `src/nodes`. The kinds that name
 * no column — a literal and a bare regex, both of which are questions about a whole row — stay
 * here, since nothing below `src/nodes` can express one: a `DataSource` is asked in structured
 * criteria, never in free text. This file keeps the *language* too — the tokenizer, the fuzzy
 * fallback, the ranking and the completion. `FieldTerm` is imported rather than re-exported: a
 * second spelling of it is how the two halves would drift back apart.
 */
import type { CompareOp, FieldTerm } from '../../data/terms'
import { fieldTermsMatch, prepareFieldTerms, resolveColumn } from '../../data/terms'

export interface TextTerm {
  kind: 'text'
  /** Already lowercased. */
  value: string
  negate: boolean
}

/**
 * A bare regex — `/^LC4$` — tested against every searchable field on its own.
 *
 * Kept apart from `TextTerm` rather than added to it as a flag, because the two differ in
 * three ways a reader would otherwise have to remember: the value is a pattern rather than a
 * needle, it is **not** lowercased (a lowercased `[A-Z]` is a different pattern, so the case
 * insensitivity is a flag on the `RegExp`), and it is never approximated by the fuzzy pass.
 * `FieldTerm` keeps its own `match` operator for the same reason it always has — that one
 * names a column, and this one does not.
 */
export interface RegexTerm {
  kind: 'regex'
  /** The pattern as typed, without the slashes. Compiles: `parseSearch` has checked it. */
  value: string
  negate: boolean
}

export type SearchTerm = TextTerm | RegexTerm | FieldTerm

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

/**
 * Why a pattern will not compile, or undefined when it will.
 *
 * Three callers ask before building a term — the two branches of `parseSearch` and the table
 * viewer's filter cells — and each wraps the answer in wording of its own. The compile itself
 * is the part that must not differ: it is the precondition `prepareFieldTerms` documents and
 * relies on, and a caller that forgot it would throw inside a scan of 165k rows.
 */
export function regexError(pattern: string): string | undefined {
  try {
    new RegExp(pattern)
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

/**
 * The pattern inside a bare regex term, or undefined when the token is not one.
 *
 * A leading `/` is the opt-in and a trailing one is optional — see the note at the top of the
 * file. "Optional" is spelled as *not preceded by a backslash* rather than as a backslash
 * parity count, because this rule is ported into the notebook exporters by hand and three
 * languages agreeing exactly is worth more here than `/LC4\/` closing itself.
 *
 * An empty pattern is not a term: `/` on its own is what the box holds for as long as somebody
 * is typing one, and an empty regex matches every row.
 */
function bareRegex(token: string): string | undefined {
  if (!token.startsWith('/')) return undefined
  let pattern = token.slice(1)
  if (pattern.endsWith('/') && !pattern.endsWith('\\/')) pattern = pattern.slice(0, -1)
  return pattern || undefined
}

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

/**
 * Strip one layer of matching quotes.
 *
 * Exported because the table viewer's per-column filter cells accept the same values these
 * tokens do, and a quote that is punctuation here and a literal character there would be one
 * grammar in name only.
 */
export function unquote(value: string): string {
  const first = value[0]
  if ((first === '"' || first === "'") && value.length >= 2) {
    return value.endsWith(first) ? value.slice(1, -1) : value.slice(1)
  }
  return value
}

/**
 * An operator written at the *start* of a string, with what follows it.
 *
 * This is the half of `splitOperator` that a per-column filter cell needs: the column is
 * already known there, so `>=10` has to mean what `weight>=10` means here. Longest-first
 * order matters and is `OPERATORS`', so `>=` cannot be read as `>` in one place and not the
 * other.
 */
export function leadingOperator(text: string): { op: CompareOp; rest: string } | undefined {
  for (const [symbol, op] of OPERATORS) {
    if (text.startsWith(symbol)) return { op, rest: text.slice(symbol.length) }
  }
  return undefined
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
      if (!value) continue
      if (value.startsWith('/')) {
        // `/` alone narrows nothing rather than being an error, exactly as `class==` does.
        const pattern = bareRegex(value)
        if (!pattern) continue
        const bad = regexError(pattern)
        if (bad) {
          errors.push(`Invalid regex: ${bad}`)
          continue
        }
        // Not lowercased, unlike a literal: the pattern is case-insensitive by its flag, and
        // folding it here would turn `[A-Z]` into a different question.
        terms.push({ kind: 'regex', value: pattern, negate })
        continue
      }
      terms.push({ kind: 'text', value: value.toLowerCase(), negate })
      continue
    }

    const value = unquote(split.value)
    if (!value) {
      // Not an error: this is every query mid-typing, and reporting it would flash a message
      // on the node between "class==" and "class==sensory".
      continue
    }
    if (split.op === 'match') {
      const bad = regexError(value)
      if (bad) {
        errors.push(`Invalid regex for "${split.field}": ${bad}`)
        continue
      }
    }
    // Insensitive, which is what a search box has always been here. Explicit rather than
    // defaulted — see `FieldTerm.ignoreCase`.
    terms.push({
      kind: 'field',
      field: split.field,
      op: split.op,
      value,
      negate,
      ignoreCase: true,
    })
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
  /**
   * The same columns as arrays, for the matchers that read a field rather than the haystack.
   *
   * References to the table's own arrays, so this is eleven pointers rather than a copy — and
   * the memo is a `WeakMap` keyed on that table, so nothing is kept alive that was not already.
   */
  fields: ColumnData[]
  /** Column names to rank by, when present — a hit here beats a hit anywhere else. */
  primary: string[]
}

/**
 * Fields worth ranking a hit in. `type` and `instance` are what people search by name, so a
 * hit there should outrank the same string appearing in, say, a neurotransmitter prediction.
 */
const PRIMARY_CANDIDATES = ['type', 'instance', 'neuronId']

/**
 * Columns folded into the free-text haystack: identifiers and every string field.
 *
 * `exclude` is how a column stays *shown* without being *searched*, which is what Explore's
 * `Search tags` opt-out is. It only reaches the free-text half — a field term naming the column
 * still matches it, because `prepareFieldTerms` reads the table rather than this index, and
 * asking for a column by name is an explicit act rather than a stray word in a search box.
 */
function searchableColumns(schema: TableSchema, exclude: ReadonlySet<string>): ColumnSchema[] {
  return schema.columns.filter(
    (c) => (c.dtype === 'str' || c.name === 'neuronId') && !exclude.has(c.name),
  )
}

/**
 * Build the concatenated lowercase haystacks. ~55 ms and ~24 MB for 165k neurons, so this is
 * memoised per table by `searchIndexFor` rather than rebuilt per query.
 */
export function buildSearchIndex(
  table: TableValue,
  exclude: readonly string[] = [],
): SearchIndex {
  const columns = searchableColumns(table.schema, new Set(exclude))
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
    fields: arrays,
    primary: PRIMARY_CANDIDATES.filter((name) => table.data[name] !== undefined),
  }
}

const indexCache = new WeakMap<TableValue, Map<string, SearchIndex>>()

/** Memoised `buildSearchIndex`. Keyed by table identity, which is how values flow anyway. */
export function searchIndexFor(
  table: TableValue,
  exclude: readonly string[] = [],
): SearchIndex {
  // Keyed on the exclusion as well as the table: the haystack *is* the exclusion, so one entry
  // per table would hand a widget that excludes tags the index a node built without excluding
  // them. Sorted, so two spellings of one exclusion share an entry rather than building the
  // whole 24 MB haystack twice.
  const key = [...exclude].sort().join('\u0001')
  let byExclusion = indexCache.get(table)
  if (!byExclusion) {
    byExclusion = new Map<string, SearchIndex>()
    indexCache.set(table, byExclusion)
  }
  let index = byExclusion.get(key)
  if (!index) {
    /*
     * Bounded, because the `WeakMap` protects nothing here: `cacheGet` promotes a hit into
     * `cache.ts`'s module map, so the neuron index is held for the life of the tab and every
     * distinct exclusion would accumulate a haystack that is never collected — 24 MB apiece at
     * 165k neurons. Two is what the honest case needs (two Explore nodes on one dataset,
     * configured differently); a single slot would thrash between them at 55 ms a swap.
     */
    if (byExclusion.size >= MAX_CACHED_INDEXES) {
      byExclusion.delete(byExclusion.keys().next().value!)
    }
    index = buildSearchIndex(table, exclude)
    byExclusion.set(key, index)
  }
  return index
}

/** Haystacks kept per table. See the note in `searchIndexFor`. */
const MAX_CACHED_INDEXES = 3

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
 * then subsequence-only hits, and `neuronId` order within each tier. An empty query returns
 * every row in the table's own order and does no ranking work at all. A regex ranks by the
 * same five tiers, reading "exact" as a match covering the whole value.
 */
export function runSearch(
  table: TableValue,
  index: SearchIndex,
  parsed: ParsedSearch,
): SearchResult {
  const textTerms = parsed.terms.filter((t): t is TextTerm => t.kind === 'text')
  const regexTerms = parsed.terms.filter((t): t is RegexTerm => t.kind === 'regex')
  const fieldTerms = parsed.terms.filter((t): t is FieldTerm => t.kind === 'field')

  if (textTerms.length === 0 && regexTerms.length === 0 && fieldTerms.length === 0) {
    return { rows: Array.from({ length: table.length }, (_, i) => i), fuzzy: false }
  }

  const prepared = prepareFieldTerms(table, fieldTerms)
  const patterns = regexTerms.map((term) => matcherFor(term, index.fields))

  /*
   * Cheapest filter first, which is the opposite of the order these were written in.
   *
   * A literal is one `includes` against a string that is already built; a regex is up to one
   * `String(cell)` and one `test` per searchable field, so it is the most expensive of the
   * three per row and belongs where the fewest rows reach it. Measured over 165,122 rows × 11
   * fields with a selective literal beside a broad pattern: 28.8 ms with the regexes first,
   * 17.0 ms with them last, for the same 46 rows. Terms are ANDed and every matcher is pure, so
   * the order is ours to choose.
   */
  const scan = (fuzzy: boolean): number[] => {
    const hits: number[] = []
    rows: for (let row = 0; row < table.length; row++) {
      if (!fieldTermsMatch(prepared, row)) continue

      for (const term of textTerms) {
        const hay = index.haystacks[row] ?? ''
        const matched = fuzzy ? isSubsequence(term.value, hay) : hay.includes(term.value)
        if (matched === term.negate) continue rows
      }

      // Never approximated, whichever pass this is.
      for (const { term, matches } of patterns) {
        if (matches(row) === term.negate) continue rows
      }
      hits.push(row)
    }
    return hits
  }

  const positiveText = textTerms.filter((t) => !t.negate)
  let hits = scan(false)
  let fuzzy = false
  // Only worth retrying when there is something to be approximate *about*: a query of pure
  // field comparisons that matches nothing matches nothing, and re-scanning would say so
  // twice as slowly. A regex is not something to be approximate about either — it is an exact
  // question somebody asked on purpose — so it neither triggers the retry nor loosens in one.
  if (hits.length === 0 && positiveText.length > 0) {
    hits = scan(true)
    fuzzy = hits.length > 0
  }

  // The first positive term *as written*, which is why this reads `parsed.terms` rather than
  // either bucket: `/^LC` and `DNp01` rank by different rules, and the one to rank by is
  // whichever the query leads with.
  const lead = parsed.terms.find(
    (t): t is TextTerm | RegexTerm => (t.kind === 'text' || t.kind === 'regex') && !t.negate,
  )
  if (!lead) return { rows: hits, fuzzy }
  // The lead's matcher is one of the ones already built, never a second copy of it: two
  // answers to "does this row match the pattern" is the shape this file warns about.
  const ranker =
    lead.kind === 'text'
      ? textRanker(lead.value, index)
      : regexRanker(patterns.find((p) => p.term === lead) ?? matcherFor(lead, index.fields))
  return { rows: rankHits(table, index, hits, ranker), fuzzy }
}

/** One regex term, compiled once: the row predicate and the pattern the ranking reads. */
interface PreparedRegex {
  term: RegexTerm
  regex: RegExp
  /** Does any searchable field of this row match? */
  matches(row: number): boolean
}

/**
 * Compile one bare regex against the index's own columns.
 *
 * Per field, never against `index.haystacks` — an anchored pattern is the whole point of a
 * regex here and `^LC4$` cannot match a row's joined text. A missing value is skipped rather
 * than matched as `""`, which is the same rule every positive term follows.
 */
function matcherFor(term: RegexTerm, fields: readonly CellValue[][]): PreparedRegex {
  // Insensitive by flag, as `FieldTerm.ignoreCase` is, and for the same reason: this is a
  // search box, and nobody types a cell type's capitalisation from memory. Not global, so
  // `test` and `exec` carry no `lastIndex` between them and the ranking can share this object.
  const regex = new RegExp(term.value, 'i')
  return {
    term,
    regex,
    matches: (row) => {
      for (const column of fields) {
        const cell = column[row]
        if (cell === null || cell === undefined) continue
        if (regex.test(String(cell))) return true
      }
      return false
    },
  }
}

/** How well a row matches the leading term. Lower is better; see `TIERS`. */
const TIERS = 5

/**
 * The leading term's opinion of one value, and of one row.
 *
 * Two implementations because a literal and a pattern answer "exact" differently and nothing
 * else about the ranking differs — a whole-value regex match is what `type` equalling the
 * needle is, and `m.index === 0` is what `startsWith` is. Written as one interface so
 * `tierOf` keeps holding the *policy* (primary fields first, then anywhere) in one place.
 */
interface Ranker {
  /** 0 exact, 1 prefix, 2 inside the value, 3 no hit at all. */
  tier(value: string): number
  /** A hit anywhere in the row's searchable text. */
  row(row: number): boolean
}

function textRanker(needle: string, index: SearchIndex): Ranker {
  return {
    tier: (value) => {
      const lower = value.toLowerCase()
      if (lower === needle) return 0
      if (lower.startsWith(needle)) return 1
      return lower.includes(needle) ? 2 : 3
    },
    // The one tier the scan cannot have settled: a fuzzy pass admits rows this test rejects,
    // which is exactly what tier 4 means.
    row: (row) => (index.haystacks[row] ?? '').includes(needle),
  }
}

function regexRanker(prepared: PreparedRegex): Ranker {
  return {
    tier: (value) => {
      const found = prepared.regex.exec(value)
      if (!found) return 3
      // Whole value, then from the start: an anchored pattern lands in tier 0 and `/LC` puts
      // the types that *begin* LC above the ones that merely contain it, which is the order a
      // literal `LC` already gets.
      if (found[0] === value) return 0
      return found.index === 0 ? 1 : 2
    },
    /*
     * Always true, and not an approximation of `prepared.matches`.
     *
     * Every hit reached the ranking by passing this very term in the scan, and a regex has no
     * loosened pass to slip through — so tier 4 is unreachable for a pattern, where for a
     * literal it is the subsequence-only bucket. Re-running the matcher would rescan all
     * eleven fields of every hit to rediscover that: 11.8 ms against 6.6 ms to rank the
     * 110,081 hits of a pattern matching a non-primary column.
     */
    row: () => true,
  }
}

function tierOf(table: TableValue, index: SearchIndex, row: number, ranker: Ranker): number {
  for (const name of index.primary) {
    const cell = table.data[name]?.[row]
    if (cell === null || cell === undefined) continue
    const tier = ranker.tier(String(cell))
    if (tier < 3) return tier
  }
  return ranker.row(row) ? 3 : 4
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
 * Hits arrive in the table's own order (neuron id) and buckets preserve it, so the result is a
 * total order: the same query always yields the same rows in the same sequence.
 */
function rankHits(
  table: TableValue,
  index: SearchIndex,
  hits: number[],
  ranker: Ranker,
): number[] {
  const buckets: number[][] = Array.from({ length: TIERS }, () => [])
  for (const row of hits) buckets[tierOf(table, index, row, ranker)]!.push(row)
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
  // A regex is not a field name half-typed, and the field list would splice `type==` over the
  // pattern somebody is in the middle of writing.
  if (bare.startsWith('/')) return empty
  const split = splitOperator(bare)

  if (!split) {
    const names = table.schema.columns.filter((c) => c.name !== 'neuronId').map((c) => c.name)
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

  const column = resolveColumn(table.schema, split.field)
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

/**
 * The example query, shown in the box and on the param row.
 *
 * One string because it is written in two places — the widget prefixes it — and the pair drifts
 * the first time a form is added to the language, which is exactly what happened to it.
 */
export const SEARCH_PLACEHOLDER = 'DNp01   class==sensory   /^LC[0-9]+$'

/** Shown as the search field's help, and in the node's param tooltip. */
export const SEARCH_SYNTAX_HELP =
  'Terms are combined with AND. `DNp01` matches any field (fuzzily); `"giant fiber"` keeps ' +
  'spaces; `!term` excludes; `/^LC[0-9]+$` is a regular expression over every field. ' +
  'Per-field: `class==sensory`, `status!=Traced`, `post>1000`, `type~^LC[0-9]+$`.'
