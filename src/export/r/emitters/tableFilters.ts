/**
 * The Table viewer's per-column filters, as a `dplyr::filter` predicate.
 *
 * The counterpart of `export/python/emitters/tableFilters.ts`, and a **copy** rather than a
 * shared module — the same call the two walks make, and for the same reason: a change to how R
 * predicates are assembled must not be able to reach the notebook. What stops the two drifting
 * on *coverage* is the shared fixture, which exports both and compares two golden files.
 *
 * Two things about R make this more than a transcription, and both produce a wrong row count
 * rather than an error:
 *
 *  - **`dplyr::filter` drops `NA`.** A predicate that evaluates to `NA` is treated as false, so
 *    the rule Coda states — a missing value satisfies `!=` and nothing else — has to be written
 *    out. Every predicate below guards with `!is.na()` or `is.na() |` for exactly that, never
 *    leaning on what the operator does with `NA`.
 *  - **R's comparisons are case-sensitive and its `grepl` is too by default.** Coda's rule is
 *    per term rather than global — `FieldTerm.ignoreCase` — so both are written out from the
 *    flag rather than left to R's default agreeing with Coda's by accident.
 */

import type { TableSchema } from '../../../core/types'
import { findColumn, isNumericDType } from '../../../core/types'
import type { FieldTerm } from '../../../data/terms'
import { rNum, rStr } from '../r'
import { R_COMPARISON } from './table'

/**
 * A column reference inside `dplyr::filter`.
 *
 * `.data[["x"]]` rather than a bare name, because a Coda column can be called anything an
 * uploaded CSV's header can be — including a name that is not a syntactic R identifier, and
 * including one that shadows a variable in scope. The pronoun is unambiguous for both.
 */
function col(name: string): string {
  return `.data[[${rStr(name)}]]`
}

function predicateFor(term: FieldTerm, schema: TableSchema | undefined): string {
  const c = col(term.field)
  const column = findColumn(schema, term.field)
  const numeric = column ? isNumericDType(column.dtype) : false

  let predicate: string
  if (term.op === 'match') {
    // `perl = TRUE` is the closer of R's two engines to JavaScript's; `ignore.case` follows the
    // term's own flag, which is what keeps a Find Neurons regex case-sensitive here and an
    // Explore one insensitive — see `FieldTerm.ignoreCase`.
    predicate = `!is.na(${c}) & grepl(${rStr(term.value)}, as.character(${c}), ignore.case = ${term.ignoreCase ? 'TRUE' : 'FALSE'}, perl = TRUE)`
  } else if (numeric) {
    const number = Number(term.value)
    const literal = Number.isFinite(number) ? rNum(number) : rStr(term.value)
    predicate =
      term.op === 'ne'
        ? `(is.na(${c}) | ${c} != ${literal})`
        : `(!is.na(${c}) & ${c} ${R_COMPARISON[term.op]} ${literal})`
  } else {
    // `tolower` on both sides only where the term asks for it; a case-sensitive term compares
    // the characters as they are, which is what Neo4j's `=` does on the same clause.
    const value = rStr(term.ignoreCase ? term.value.toLowerCase() : term.value)
    const compared = term.ignoreCase
      ? `tolower(as.character(${c}))`
      : `as.character(${c})`
    predicate =
      term.op === 'ne'
        ? `(is.na(${c}) | ${compared} != ${value})`
        : `(!is.na(${c}) & ${compared} ${R_COMPARISON[term.op]} ${value})`
  }

  // Negation applies after the null rule, exactly as `fieldTermsMatch` applies it.
  return term.negate ? `!(${predicate})` : predicate
}

/**
 * One predicate per clause, for the caller to lay out.
 *
 * A list rather than a joined string because `dplyr::filter` **ANDs its arguments** — so the
 * clauses go in as separate arguments, one per line, which is both the idiomatic form and the
 * one a reader can comment a single clause out of.
 */
export function filterPredicates(
  terms: readonly FieldTerm[],
  schema: TableSchema | undefined,
): string[] {
  return terms.map((term) => predicateFor(term, schema))
}

