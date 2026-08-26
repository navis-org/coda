/**
 * The term model: what one `{field, operator, value}` comparison means, and how it is tested
 * against a row.
 *
 * Down here in `src/data` rather than beside the query language that grew it, and the move is
 * the point rather than tidying. Two layers need this and only this:
 *
 *  - **`src/nodes`** — Explore's search box (`neuronSearch.ts`, which parses text into these)
 *    and the Table viewer's per-column cells (`tableFilter.ts`, which parses cells into these).
 *  - **`src/data`** — every source that answers `findNeurons` from a neuron index it already
 *    holds. CAVE and CATMAID both do, and each used to carry its own hand-rolled loop over
 *    `typeRe`, `instanceRe`, a status `Set` and a label test. `neuronFilter.ts`' header names
 *    the hazard in that arrangement: "a second copy of these two functions is how two backends
 *    come to disagree about whether `LC.*` matches `LPLC1`."
 *
 * `src/nodes` imports `src/data` and never the reverse, so a shared matcher had exactly one
 * place it could live if both were to call the same code rather than agree to behave alike.
 *
 * ## Nulls, once
 *
 * A missing value satisfies `ne` and **nothing else** — so `status!=Traced` returns the
 * untraced *and* the unlabelled, which is what someone auditing a dataset for gaps is asking
 * for. SQL's three-valued logic would drop the unlabelled from both sides of the comparison and
 * never say it had. Every other operator, `eq` included, reads null as "no value to compare".
 *
 * Negation applies *after* that rule (see `fieldTermsMatch`), which is why a negated term keeps
 * the rows with no value at all. Both export compilers write this out the long way rather than
 * inheriting whatever pandas and dplyr do with `NaN`/`NA`, and anything compiling these to a
 * server dialect has to do the same: Cypher's `WHERE` keeps only *true*, so `NOT (n.p = 'x')`
 * over a null `p` silently drops the neuron.
 */

import type { ColumnSchema, TableSchema } from '../core/types'
import { isNumericDType } from '../core/types'
import type { CellValue, ColumnData, TableValue } from '../core/values'

/**
 * Escape a literal so it can ride inside a regex — what makes a bare `LC4(R)` match itself
 * rather than being read as a group.
 *
 * Here rather than in each caller because there are now three, and a literal that is escaped in
 * one place and not another is a filter that silently matches a different set: `SMP001(a)` read
 * as syntax matches `SMP001a`, with no error anywhere to say a lookup became a pattern.
 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * One pattern, anchored to the whole string.
 *
 * The rule is neuPrint's, because neuPrint is the one with a server semantic to match: Neo4j's
 * `=~` matches the **whole** value, so `LC.*` matches `LC4` but not `LPLC1`. Everything that
 * builds a whole-string match goes through this — `neuronFilter.ts` compiling a request pattern,
 * and `filterRows.ts` lowering a builder row — so the decision cannot be made twice and then
 * drift on the day one of them grows a flag.
 *
 * `(?:…)` rather than bare concatenation: a user pattern carrying a top-level `|` would
 * otherwise have its alternation spliced into the surrounding one and quietly match a superset
 * of what it means on its own.
 */
export function anchoredPattern(pattern: string): string {
  return `^(?:${pattern})$`
}

export type CompareOp = 'eq' | 'ne' | 'gt' | 'lt' | 'ge' | 'le' | 'match'

export interface FieldTerm {
  kind: 'field'
  /** As typed; resolved against the schema case-insensitively at match time. */
  field: string
  op: CompareOp
  value: string
  negate: boolean
  /**
   * Whether the *value* compares case-insensitively. Nothing to do with `field`, which is
   * always resolved case-insensitively because a column name is not somebody's data.
   *
   * **Required, and written out at every construction site rather than defaulted**, because the
   * two surfaces building these genuinely disagree and a default would silently hand one of
   * them the other's rule. A search box is case-insensitive — nobody typing `dnp01` means to
   * miss `DNp01` — so `parseSearch` and the table viewer's cells set `true`. Find Neurons sets
   * `false` by default, because its terms are also compiled to Cypher and Neo4j's `=~` and `=`
   * are case-*sensitive*; a builder defaulting the other way would return one set of neurons
   * from a CAVE index and another from neuPrint for the same graph.
   *
   * That divergence is not new — Explore's `~` has always been case-insensitive where
   * `findNeuronsCypher`'s `=~` was not — it was simply unrepresentable, and so lived as an
   * undocumented difference between two files. Here it is a value that travels with the term.
   */
  ignoreCase: boolean
}

/**
 * The column a term names, matched case-insensitively.
 *
 * Insensitive because a *field name* is not somebody's data — it is typed in a search box, read
 * out of a hand-edited file, or carried over from a graph built against another dataset, and
 * `Type` meaning nothing where `type` means something is a distinction no one intends. The
 * *value* is a separate question and a per-term one; see `FieldTerm.ignoreCase`.
 *
 * Takes the schema rather than the table so that the edit-time half can call it too. That is not
 * a convenience: `resolveRows` decides whether to report a row as unfilterable, and if it
 * answered that with a case-*sensitive* lookup it would report a row that `prepareFieldTerms`
 * would then have matched perfectly well — the two halves of one decision, disagreeing.
 */
export function resolveColumn(
  schema: TableSchema | undefined,
  field: string,
): ColumnSchema | undefined {
  const lower = field.toLowerCase()
  return schema?.columns.find((c) => c.name.toLowerCase() === lower)
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

  const left = term.ignoreCase ? String(cell).toLowerCase() : String(cell)
  const right = term.ignoreCase ? term.value.toLowerCase() : term.value
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

/**
 * One field term with everything that does not vary by row already resolved.
 *
 * Split out from `runSearch` because the table viewer's per-column filters are field terms
 * and nothing else, so they get to reuse the *semantics* — the null rule, numeric-versus-
 * lexicographic comparison, case-insensitive regex — rather than agreeing with them. Two
 * loops over one matcher; the alternative is two matchers that drift on the first null.
 *
 * Precondition: a `match` term's value must already compile, which `parseSearch` and
 * `resolveFilters` both guarantee by dropping the ones that do not. Constructing it here
 * rather than per row is most of what makes a 165k-row scan affordable.
 */
export interface PreparedFieldTerm {
  term: FieldTerm
  data: ColumnData | undefined
  numeric: boolean
  regex: RegExp | undefined
  /** The column is not in this table, so nothing can match it. */
  unknown: boolean
}

export function prepareFieldTerms(
  table: TableValue,
  terms: readonly FieldTerm[],
): PreparedFieldTerm[] {
  return terms.map((term) => {
    const column = resolveColumn(table.schema, term.field)
    const data = column ? table.data[column.name] : undefined
    return {
      term,
      data,
      numeric: column ? isNumericDType(column.dtype) : false,
      regex:
        term.op === 'match' ? new RegExp(term.value, term.ignoreCase ? 'i' : '') : undefined,
      // An unknown field cannot match anything; `validateSearch` is what tells the user why.
      unknown: !column || !data,
    }
  })
}

/** Whether one row satisfies every prepared term. */
export function fieldTermsMatch(prepared: readonly PreparedFieldTerm[], row: number): boolean {
  for (const entry of prepared) {
    const matched = entry.unknown
      ? false
      : cellMatches(entry.data![row] ?? null, entry.term, entry.numeric, entry.regex)
    if (matched === entry.term.negate) return false
  }
  return true
}
