/**
 * The `filters` param, as the two nodes that carry it read it.
 *
 * `data/filterRows.ts` owns what a row *is* and how it lowers; this owns the one thing a node
 * has to agree about with its card, its `validate`, its `evaluate` and both emitters — that the
 * rows live in a param called `filters`, encoded as JSON strings.
 *
 * It was `findNeuronsRows.ts`' first export and moved here when `Split Neurons` grew the same
 * control. Moved rather than imported across: that file's header is an argument about what an
 * *empty* set of rows means at a backend seam, which is Find Neurons' decision and not this one
 * — `Split Neurons` filters a collection that has already arrived and has no seam to be wrong
 * about.
 * A second node importing `rowsFromParams` from a file named for the first is how a shared rule
 * comes to look like a special case of somebody else's.
 */

import type { ParamValue, ParamValues } from '../../core/node'
import type { FilterRow } from '../../data/filterRows'
import { ALL_ROW_OPS, arityOf, decodeRows, encodeRows } from '../../data/filterRows'

/** The param every node holding filter rows declares. One spelling, since the codec is shared. */
export const FILTERS_PARAM_ID = 'filters'

/**
 * Every row a node is asking for.
 *
 * A thin read of one param, and kept as a named function rather than inlined at each call site:
 * the value of this file is that a node's five readers of `filters` cannot come to disagree
 * about what a stored card asks. `decodeRows` spread across `evaluate`, `validate`, the card and
 * two emitters is four chances for one of them to grow a condition.
 */
export function rowsFromParams(params: ParamValues): FilterRow[] {
  return decodeRows(params[FILTERS_PARAM_ID])
}

/**
 * Rows as the param value a card writes back.
 *
 * The write half, beside the read half, because that is what this file is for — the encode and
 * the `ids`-param cast had been spelled out inside a React component, which put the codec's two
 * halves in two layers and made a non-UI writer (the wizard is already one) either import a
 * component module or re-derive the encode. `encodeRows` drops an incomplete row, so a card
 * cannot store the blank one somebody is still filling in.
 */
export function rowsParamValue(rows: readonly FilterRow[]): ParamValue {
  return encodeRows(rows) as unknown as ParamValue
}

/**
 * How a plan writes a `filters` param, generated rather than transcribed.
 *
 * `filters` is an `ids` param — a `string[]` whose entries are JSON — and nothing about that
 * kind says so, so the assistant catalogue has to carry the grammar (`ParamBase.catalogueNote`).
 *
 * **Every varying part is computed, not written out.** The example comes from `encodeRows`, the
 * operator names from `ALL_ROW_OPS`, and the arity groups from `arityOf` — the last being the
 * one that looked safe to transcribe and is not, since the sentence "isIn takes several, isEmpty
 * takes none, the rest take one" is `arityOf`'s switch copied into prose. Drift in any of them
 * is the bad kind: a plan naming a dead operator, or filling `v` for one that takes none, is
 * refused with a message about the *param*, which a model reads as "filters is wrong" rather
 * than "that detail is stale", so it tries again the same way.
 *
 * The two callers differ in exactly two sentences and both are about *their* node rather than
 * about the grammar — where `f` comes from, and what an empty list means — so each supplies its
 * own rather than this growing a mode. Both arrive as **lines**, since that is the shape a caller
 * writes them in and joining them twice invites the "is this one sentence or several?" question
 * each doc comment then has to settle in prose.
 */
export function rowGrammarNote(where: {
  /** Where a legal `f` comes from. */
  fields: readonly string[]
  /** What an empty list means for this node. */
  empty: readonly string[]
}): string {
  return [
    'A list of JSON *strings*, one per filter row, ANDed. A row is',
    '`{"f": <field>, "op": <operator>, "v": [<value>, …]}`, plus an optional `"i": true` to',
    'compare case-insensitively. For "type matches LC.*":',
    `  ${JSON.stringify(encodeRows([{ field: 'type', op: 'matches', values: ['LC.*'] }]))}`,
    ...where.fields,
    `\`op\` is one of: ${ALL_ROW_OPS.join(', ')}.`,
    `${byArity('many')} take several values in \`v\`; ${byArity('none')} take none; the rest take one.`,
    '`matches` is a whole-string pattern, so `LC.*` matches `LC4` and not `LPLC1`. Use',
    '`contains` for a substring and `isIn` for a set — a set is how you say OR, and it is faster.',
    ...where.empty,
  ].join('\n')
}

function byArity(want: ReturnType<typeof arityOf>): string {
  return ALL_ROW_OPS.filter((op) => arityOf(op) === want)
    .map((op) => `\`${op}\``)
    .join('/')
}
