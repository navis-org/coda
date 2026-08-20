/**
 * The Table viewer's per-column filters, as a pandas boolean mask.
 *
 * The interesting half is **null**, because Coda and pandas disagree about it by default and
 * the disagreement is silent — a mask that drops a row pandas would have kept changes a row
 * count and nothing else. `cellMatches` in `neuronSearch.ts` is the rule being reproduced: a
 * missing value satisfies `!=` and nothing else. So every mask below is explicit about `isna`
 * rather than leaning on whatever the operator happens to do with `NaN`, even where the two
 * agree — the ones that agree today are the ones that break quietly if this is ever edited.
 *
 * The other half is **case**. Coda compares text case-insensitively (`cellMatches` lowercases
 * both sides, and a `~` regex carries the `i` flag), where pandas is case-sensitive
 * throughout. Every text comparison therefore lowercases explicitly.
 */

import type { TableSchema } from '../../../core/types'
import { findColumn, isNumericDType } from '../../../core/types'
import type { FieldTerm } from '../../../nodes/lib/neuronSearch'
import { pyStr } from '../py'
import { PY_COMPARISON, col } from './table'

/**
 * One resolved field term as a pandas expression over `frame`.
 *
 * Returns undefined only for a term this cannot express, which nothing currently produces —
 * kept as a return type rather than a throw because an exporter that refuses mid-cell leaves a
 * half-written notebook.
 */
function maskFor(frame: string, term: FieldTerm, schema: TableSchema | undefined): string {
  const c = col(frame, term.field)
  const column = findColumn(schema, term.field)
  const numeric = column ? isNumericDType(column.dtype) : false

  let mask: string
  if (term.op === 'match') {
    // `case=False` is the `i` flag Coda's regexes carry; `na=False` keeps a missing value out,
    // which is the null rule rather than a convenience.
    mask = `${c}.astype(str).str.contains(${pyStr(term.value)}, regex=True, case=False, na=False)`
  } else if (numeric) {
    const number = Number(term.value)
    const literal = Number.isFinite(number) ? String(number) : pyStr(term.value)
    // A missing value satisfies `!=` and nothing else, which is the one place the two engines
    // would otherwise part company: `NaN != v` is already True in pandas, so this is written
    // the long way to say that it is intended rather than inherited.
    mask =
      term.op === 'ne'
        ? `(${c}.isna() | (${c} != ${literal}))`
        : `(${c}.notna() & (${c} ${PY_COMPARISON[term.op]} ${literal}))`
  } else {
    const value = pyStr(term.value.toLowerCase())
    const lowered = `${c}.astype(str).str.lower()`
    mask =
      term.op === 'ne'
        ? `(${c}.isna() | (${lowered} != ${value}))`
        : `(${c}.notna() & (${lowered} ${PY_COMPARISON[term.op]} ${value}))`
  }

  // Negation is applied *after* the null rule, exactly as `fieldTermsMatch` applies it — so
  // `!LC` keeps the rows with no type at all, which is what somebody hunting gaps means.
  return term.negate ? `~${mask}` : mask
}

/**
 * One mask per clause, for the caller to AND together.
 *
 * A list rather than a joined string because four clauses join into a 300-character line, and
 * the notebook is meant to be read and edited. Where they go is the emitter's business.
 */
export function filterMasks(
  frame: string,
  terms: readonly FieldTerm[],
  schema: TableSchema | undefined,
): string[] {
  return terms.map((term) => maskFor(frame, term, schema))
}

