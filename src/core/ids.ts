/**
 * What a neuron id *is*, in one place.
 *
 * This module exists because the rule was written four times before it was written once, and
 * the copies had already drifted: two accepted a leading `-` and two did not, while the type's
 * own documentation asserted a grammar that no function enforced. An id is compared, joined and
 * spliced into queries by five different layers, so a disagreement between any two of them is a
 * silently dropped row rather than an error.
 *
 * It sits in `src/core` because that is the only layer every consumer can reach. The rule is
 * needed by the sources (`data/neuprint/cypher.ts` splices ids into Cypher), by the nodes
 * (`tableOps`, the traversal, the path decoder) and by both exporters — and `src/data` may not
 * import `src/nodes` (invariant 1), so anywhere higher leaves somebody out. `CellValue`, which
 * `idText` reads, is defined next door in `values.ts`; a future non-browser consumer gets the
 * rule without importing a backend module.
 *
 * One home means one import path. There is deliberately no re-export of these anywhere else:
 * a shim is how a symbol acquires two spellings and then a third.
 */

import type { CellValue } from './values'

/**
 * A neuron's identity, as an exact decimal string.
 *
 * A string rather than a number, and that is not a stylistic preference — it is the only
 * representation that survives every backend. `CellValue` is a JS number, so an `i64` column
 * is really a float64: neuPrint's nine-to-eleven digit body ids fit inside
 * `Number.MAX_SAFE_INTEGER` and are exact, while a CAVE root id is eighteen digits and is
 * not. `648518347529750614` parses to `648518347529750700` — a different id, silently, with
 * nothing anywhere to say so. In R the same id becomes `648518347529750528`, so it is not even
 * wrong in a consistent direction across the tools this data moves between.
 *
 * So an id crosses the `DataSource` seam as text and each source converts at its own edge:
 * neuPrint splices it into Cypher as an integer literal (no float ever forms), and the
 * precomputed reader hands it to `BigInt`, which is exact from a string and lossy from a
 * number — so the shard hash it feeds was quietly wrong for a wide id before this.
 *
 * Not a branded type: it would cost a cast at every literal for no safety a plain string lacks
 * here, since the only operations anyone performs on an id are equality and joining — both of
 * which strings already get right and numbers do not. Nothing else in this codebase brands a
 * type either.
 */
export type NeuronId = string

/**
 * The id grammar: digits, optionally signed. No separators, no exponent, no leading `+`.
 *
 * Signed because this is the *transport* grammar rather than the input grammar — a source may
 * hand back a negative id and the honest thing is to carry it through to a query that will say
 * so. Typed input is stricter (`parseIdList` refuses `-1` outright, since a negative body id
 * is almost always a mistyped range), and that asymmetry is deliberate: authored text is a
 * mistake somebody can fix, where data is data.
 */
const ID_GRAMMAR = /^-?\d+$/

/** Whether a string is a well-formed id, i.e. safe to splice into a query unquoted. */
export function isNeuronId(value: string): value is NeuronId {
  return ID_GRAMMAR.test(value)
}

/**
 * One table cell as an exact id, or null where it is not one.
 *
 * The single rule for turning a cell into an id, shared by the column reader, the connectivity
 * traversal and the path decoder — two copies of "what counts as an id" is how the ids a query
 * is *built from* come to disagree with the ids a result is *keyed by*, which shows up as edges
 * silently missing from a hop rather than as an error.
 *
 * The two cell kinds are handled apart deliberately:
 *
 * - A **string** cell is passed through untouched (trimmed). It is already exact, and reading
 *   it as a number first would throw away the precision this whole representation exists to
 *   keep — which is exactly what a CAVE source's `bodyId` column holds.
 * - A **number** cell is stringified only when it is a safe integer. `String(1e21)` is
 *   `"1e+21"` and `String(1.5)` is `"1.5"`, neither of which is an id, and a number past
 *   `Number.MAX_SAFE_INTEGER` has already lost the digits that identified the neuron — so
 *   there is nothing to recover and printing it would put a confident wrong id into a query.
 *
 * Note it does **not** apply `isNeuronId`: a `str` column holding `LC4` comes back as `'LC4'`.
 * Callers that need the grammar say so — `idsFromColumn` counts what it drops, and the query
 * builders drop silently, and those are different obligations.
 */
export function idText(cell: CellValue | undefined): string | null {
  if (typeof cell === 'string') {
    const trimmed = cell.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof cell === 'number' && Number.isSafeInteger(cell)) return String(cell)
  return null
}

/**
 * Numeric order over ids held as decimal text.
 *
 * Length first, then lexicographic — which *is* numeric order for non-negative integers of any
 * width, and unlike `Number(a) - Number(b)` it stays exact past `Number.MAX_SAFE_INTEGER`: two
 * adjacent eighteen-digit ids round to the same float64 and would compare equal, leaving their
 * order down to the sort's stability. Body ids are never negative, so the sign case does not
 * arise.
 *
 * Deliberately not `localeCompare(b, undefined, { numeric: true })`, which the table ops use for
 * sorting a column and which is also exact here. That call is a collator invocation per
 * comparison — measurably slower in the one place this is used, the tie-break of a traversal
 * sort over hundreds of thousands of edges — and it carries locale behaviour that a provenance
 * -bearing order has no business depending on.
 */
export function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

/**
 * An id as the JS number a backend keyed by numbers needs, or undefined where it is not one.
 *
 * The inverse of `idText`, and it belongs beside it for the same reason: this direction was
 * also written three times before it was written once, and the copies had drifted into three
 * different predicates — a bare `> Number.MAX_SAFE_INTEGER`, an `isSafeInteger`, and an
 * `isSafeInteger && >= 0`.
 *
 * **Undefined is the answer, not a rounded number.** Past `Number.MAX_SAFE_INTEGER` the digits
 * that identified the neuron are gone, so a caller has to decide what to do about it — the
 * mock drops the id, the Input IDs node warns. Handing back a nearby integer is the one thing
 * nobody wants, and it is what every ad-hoc `Number(id)` does.
 */
export function numericId(id: NeuronId): number | undefined {
  const n = Number(id)
  return Number.isSafeInteger(n) ? n : undefined
}
