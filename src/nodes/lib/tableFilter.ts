/**
 * The Table viewer's per-column filters: what a header cell means, and which rows survive.
 *
 * Headless, because both halves have to agree exactly. The widget filters its own copy of the
 * table on every keystroke and `evaluate` filters the real one on the committed param, and a
 * second implementation in the UI would draw a row count the `Filtered` port does not honour.
 * Same reasoning, and the same shape, as `neuronSearch.ts` — which this is built *on* rather
 * than beside.
 *
 * ## What goes in a cell
 *
 * The column is already known, so a cell holds the *right-hand side* of an Explore field term:
 *
 *   >10   >=10   <5   ==0   !=0        numeric comparison
 *   LC    ==LC4  !=LC4                 text: contains, exactly, not
 *   ~^LC[0-9]+$                        regex, unanchored, case-insensitive
 *   !frag  -frag                       exclude
 *
 * `>=10` here means exactly what `weight>=10` means in the Explore box — same operator table,
 * same null rule (a missing value satisfies `!=` and nothing else), same comparison semantics.
 * That is the whole reason the grammar was borrowed rather than invented: this app already had
 * a filter language, and a second one is a second thing to learn and a second thing to get
 * subtly different.
 *
 * The one thing a cell decides that a query token does not is what a **bare** value means, and
 * it is decided from the column's dtype rather than from the text. On a number, `10` is `== 10`
 * — nobody typing a number into a synapse-count column means "contains the digits 1 and 0",
 * and reading it as a substring would match 100 and 210 as well. On text it is a substring,
 * which is what a bare term does in the Explore box, compiled as an *escaped* regex so a value
 * like `LC4(R)` matches itself rather than being read as a group.
 *
 * That is also where the leading `/` of Explore's bare regex stops. A cell already knows its
 * column, so the pattern form here is `~^LC4$` — one character shorter than the slash, and
 * against the column somebody is typing under rather than against all of them. Adding a second
 * spelling would buy nothing and would change what an existing cell holding a path-like value
 * means; a cell keeps `/` a literal.
 *
 * ## Nothing here ever throws
 *
 * `out.table` is a tap. A cell somebody is halfway through typing, a regex that does not
 * compile, a column an upstream edit has removed — none of those are grounds to block every
 * node downstream, which is invariant 5's corollary in the place it bites hardest. So a clause
 * that cannot be applied is **dropped and reported**, never raised, and the reports are what
 * `validate` and the caption say out loud.
 *
 * Note which way that errs. Dropping a clause shows *more* rows than intended, where letting
 * an unresolvable column reach `prepareFieldTerms` marks it `unknown` — which matches no row,
 * so one stale column name would empty the table and read as a node that had broken. Same
 * unknown-is-not-empty rule `columnSchemaFor` draws, with the same reason for drawing it.
 *
 * ## It does not agree with the Filter node, and that is worth knowing
 *
 * The header *sort* shares `sortedRowIndices` with the Sort node on a stated rule: null
 * placement and collation must not differ between what a node does and what a column-header
 * click does. The header *filter* deliberately does not share with `core.filterTable`, because it
 * borrows Explore's grammar instead — and the two land on different answers for the same
 * question. Measured, not surmised:
 *
 *   `type == "lc4"`   Filter node keeps 0 rows (case-sensitive); a header cell keeps 1.
 *   `pre == 0`, null  Filter node keeps the null row (`Number(null)` is 0); a cell keeps none.
 *
 * Neither is wrong on its own — Explore's rules are the ones documented for a search box, and
 * `makePredicate`'s are the ones `core.filterTable` has always had — but a graph can hold both an
 * inch apart, so the disagreement is recorded here rather than left to be discovered. Folding
 * one onto the other is a real decision about which semantics wins, and it changes what every
 * saved `core.filterTable` returns; it is not a tidy-up.
 */

import type { DType, TableSchema } from '../../core/types'
import { findColumn, isNumericDType } from '../../core/types'
import type { TableValue } from '../../core/values'
import { selectRows } from '../../core/values'
import { decodePairs, encodePair } from './paramPairs'
import type { CompareOp, FieldTerm } from '../../data/terms'
import { escapeRegex, fieldTermsMatch, prepareFieldTerms } from '../../data/terms'
import { leadingOperator, regexError, unquote } from './neuronSearch'

/** One column's filter, as it is stored and as the header cell shows it. */
export interface FilterClause {
  column: string
  /** Exactly what is in the cell — kept verbatim so the field redraws as it was typed. */
  expression: string
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * A clause as one param entry, JSON rather than a delimited pair.
 *
 * The encoding is `paramPairs.ts`, shared with `core.rename`'s remappings — the reasoning for
 * JSON over a separator is recorded there, and it is about column names that can hold anything
 * at all. What stays here is the named struct and the keep-rule below, which is the one thing
 * that genuinely differs between the two lists.
 */

/** Read a stored `filters` param. Anything unreadable is dropped rather than throwing. */
export function decodeClauses(raw: unknown): FilterClause[] {
  return (
    decodePairs(raw)
      .map(([column, expression]) => ({ column, expression }))
      // A cleared cell stores no clause at all, but a file can still carry an empty one — and
      // a clause with no column is not addressable by any header.
      .filter((c) => c.column && c.expression.trim())
  )
}

export function encodeClauses(clauses: readonly FilterClause[]): string[] {
  return clauses
    .filter((c) => c.expression.trim())
    .map((c) => encodePair(c.column, c.expression))
}

/** Set or clear one column's clause, keeping every other one in the order it was in. */
export function withClause(
  clauses: readonly FilterClause[],
  column: string,
  expression: string,
): FilterClause[] {
  const rest = clauses.filter((c) => c.column !== column)
  return expression.trim() ? [...rest, { column, expression }] : rest
}

/** What a header cell should show for a column — empty when it is not filtered. */
export function clauseFor(clauses: readonly FilterClause[], column: string): string {
  return clauses.find((c) => c.column === column)?.expression ?? ''
}

// ---------------------------------------------------------------------------
// Parsing one cell
// ---------------------------------------------------------------------------

export interface ParsedExpression {
  /** Undefined for a bare value, whose meaning depends on the column — see `bareTerm`. */
  op: CompareOp | undefined
  value: string
  negate: boolean
}

/**
 * Split a cell into operator, value and negation. Syntax only: `op` is left undefined for a
 * bare value, because what a bare value *means* depends on the column's dtype and parsing has
 * no business knowing it.
 */
export function parseExpression(text: string): ParsedExpression | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined

  let rest = trimmed
  let negate = false
  // `!` leads both a negation and the `!=` operator, so the operator wins. Read the other way
  // `!=0` becomes "not `=0`", which is the same answer by luck here and the wrong one the
  // moment a value is missing, since `!=` is the one operator a null satisfies. `-` negates
  // only when something follows it, or a lone dash while typing negates the next keystroke.
  if (
    (rest.startsWith('!') || rest.startsWith('-')) &&
    rest.length > 1 &&
    !leadingOperator(rest)
  ) {
    negate = true
    rest = rest.slice(1)
  }

  const split = leadingOperator(rest)
  if (!split) return { op: undefined, value: unquote(rest), negate }
  const value = unquote(split.rest.trim())
  // Mid-typing: `>=` with nothing after it is not an error, it is the state the cell is in
  // between two keystrokes. Reporting it would flash a message under the column header.
  if (!value) return undefined
  return { op: split.op, value, negate }
}

/** What a bare value means in a column of this type. See the header. */
function bareTerm(column: string, value: string, negate: boolean, dtype: DType): FieldTerm {
  // `ignoreCase` is the search box's rule, which is this file's whole premise: a header cell
  // means what the same text means in Explore. Written out rather than defaulted — see
  // `FieldTerm.ignoreCase`.
  if (isNumericDType(dtype)) {
    return { kind: 'field', field: column, op: 'eq', value, negate, ignoreCase: true }
  }
  return {
    kind: 'field',
    field: column,
    op: 'match',
    value: escapeRegex(value),
    negate,
    ignoreCase: true,
  }
}

// ---------------------------------------------------------------------------
// Resolving against a schema
// ---------------------------------------------------------------------------

/**
 * A clause that could not be applied, and why.
 *
 * The column travels *beside* the message rather than inside it. The cell that has to draw a
 * red border needs to know which column a problem belongs to, and recovering that by
 * substring-matching the prose is both fragile and wrong: `Filter on "pre": "abc" is not a
 * number` quotes the offending value too, so a table that also has a column called `abc` would
 * see that column marked broken. Same reasoning as `reportAuthFailure` — matching on message
 * text rots silently.
 */
export interface FilterProblem {
  column: string
  message: string
}

export interface ResolvedFilters {
  /** Ready for `prepareFieldTerms` — each one compiles and names a column that exists. */
  terms: FieldTerm[]
  /** Clauses that could not be applied, each with why. Reported, never thrown. */
  problems: FilterProblem[]
}

/**
 * Turn stored clauses into field terms against a particular schema.
 *
 * Deliberately not `resolveColumn`'s rule 2. A *chosen* column is kept there because reaching
 * for a different one is worse than failing loudly, and a picker has exactly one value to
 * keep. Here the clause names its own column, there is no substitution on offer and none
 * wanted, and an absent column cannot be tested at all — so it is dropped and named.
 */
export function resolveFilters(
  schema: TableSchema | undefined,
  clauses: readonly FilterClause[],
): ResolvedFilters {
  const terms: FieldTerm[] = []
  const problems: FilterProblem[] = []

  for (const clause of clauses) {
    const parsed = parseExpression(clause.expression)
    if (!parsed) continue

    // An unknown schema is not a schema without this column in it: an upstream Pivot publishes
    // none until it has run, and complaining then reports every clause as broken on reload.
    if (!schema) continue

    const column = findColumn(schema, clause.column)
    if (!column) {
      problems.push({
        column: clause.column,
        message: `Filter on "${clause.column}": the table has no such column`,
      })
      continue
    }

    if (parsed.op === undefined) {
      terms.push(bareTerm(column.name, parsed.value, parsed.negate, column.dtype))
      continue
    }

    if (parsed.op === 'match') {
      const bad = regexError(parsed.value)
      if (bad) {
        problems.push({
          column: column.name,
          message: `Filter on "${column.name}": ${bad}`,
        })
        continue
      }
    }

    // Only the ordering comparisons need a number to mean anything. `==`/`!=` fall through to
    // a string compare that answers "no row holds that", which is true rather than broken.
    if (
      isNumericDType(column.dtype) &&
      !Number.isFinite(Number(parsed.value)) &&
      (parsed.op === 'gt' || parsed.op === 'ge' || parsed.op === 'lt' || parsed.op === 'le')
    ) {
      problems.push({
        column: column.name,
        message: `Filter on "${column.name}": "${parsed.value}" is not a number`,
      })
      continue
    }

    terms.push({
      kind: 'field',
      field: column.name,
      op: parsed.op,
      value: parsed.value,
      negate: parsed.negate,
      ignoreCase: true,
    })
  }

  return { terms, problems }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface FilterResult {
  /**
   * Surviving row indices, or **undefined meaning every row**.
   *
   * A sentinel rather than an identity array, because the unfiltered case is the common one and
   * a table here can be the whole of male-CNS: `Array.from({length}, (_, i) => i)` is 165,000
   * elements built and thrown away by both callers, one of which runs per render. Both already
   * treat "all rows" specially, so neither gains a branch it did not have.
   */
  rows: number[] | undefined
  problems: FilterProblem[]
}

/**
 * Row indices surviving every clause, in the table's own order.
 *
 * Order matters and is not incidental: `runSearch` ranks its hits by relevance, which is right
 * for a search box answering "where are these?" and wrong for a filter, whose result is a
 * *subset* that every node downstream expects in the order it arrived. Same call
 * `rowsWithKeys` makes, for the same reason.
 */
export function filterRowIndices(
  table: TableValue,
  clauses: readonly FilterClause[],
): FilterResult {
  const { terms, problems } = resolveFilters(table.schema, clauses)
  if (terms.length === 0) return { rows: undefined, problems }

  const prepared = prepareFieldTerms(table, terms)
  const rows: number[] = []
  for (let row = 0; row < table.length; row++) {
    if (fieldTermsMatch(prepared, row)) rows.push(row)
  }
  return { rows, problems }
}

/**
 * The filtered table.
 *
 * Hands back the input untouched when nothing was cut, rather than a copy of every column:
 * columns are immutable by contract, so an identical table *is* the same table — which is what
 * keeps an unfiltered Table node's second port free, sharing one set of arrays with its first.
 */
export function filterTableByClauses(
  table: TableValue,
  clauses: readonly FilterClause[],
): { table: TableValue; problems: FilterProblem[] } {
  const { rows, problems } = filterRowIndices(table, clauses)
  if (!rows || rows.length === table.length) return { table, problems }
  return { table: selectRows(table, rows), problems }
}

/**
 * Whether any clause is a regex, so an exporter can attach its flavour note once.
 *
 * Here rather than in each emitter: it is a fact about Coda's term model with nothing in it
 * about pandas or dplyr, and the two copies it replaced had already been written twice.
 */
export function usesRegex(terms: readonly FieldTerm[]): boolean {
  return terms.some((term) => term.op === 'match')
}

// ---------------------------------------------------------------------------
// Telling somebody what a cell takes
// ---------------------------------------------------------------------------

/** Placeholder for an empty cell — a shape that column actually accepts. */
export function filterHint(dtype: DType | undefined): string {
  if (!dtype) return 'filter'
  if (isNumericDType(dtype)) return '>10'
  if (dtype === 'bool') return 'true'
  return 'text'
}
