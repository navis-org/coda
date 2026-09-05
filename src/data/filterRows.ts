/**
 * A neuron query as a list of `{field, operator, value}` rows.
 *
 * What Find Neurons stores, what the seam carries, and the one thing every backend is asked in
 * the same words. It replaces five named scalars on `FindNeuronsRequest` — `typePattern`,
 * `instancePattern`, `statuses`, `minSize` — that were neuPrint's fields spelled as an
 * interface, and whose cost was borne entirely by the other three backends: a **Min size** box
 * on a card whose datastack publishes no size, an **In ROI** dropdown of eighty real neuropils
 * that narrowed nothing, a `status` default of `Traced` filtering on a column CAVE does not
 * have. Each returned a wrong count rather than an error. See `refuseUnfilterable`, which
 * exists only to catch the two of those that were catchable.
 *
 * A row names a field from the dataset's **own discovered neuron schema**, so the whole class
 * goes away by construction: hemibrain offers `cellBodyFiber`, manc offers `hemilineage`,
 * FlyWire offers `super_class` and `cell_sub_class`, CATMAID offers `annotations` and
 * `cableLength`, and none of them can be asked for a field it does not publish.
 *
 * ## Rows are ANDed, and there is no bracketing
 *
 * Deliberately, and it is the same call `neuronSearch.ts` made for the search box: "every extra
 * operator is something a newcomer can get wrong, and the graph already has a Filter node for
 * anything this cannot express." Two further reasons apply here and not there. `NeuronCriteria`
 * — what the Python export emits for neuPrint — has **no disjunction at all**, so one OR group
 * would force every exported notebook to abandon it for a local pandas filter. And the thing
 * people actually reach for OR to say is a set, which `isIn` says directly *and* faster: it
 * compiles to an indexed `IN` list on neuPrint where an alternation forces a scan.
 *
 * ## Two lowerings, one meaning
 *
 * A row is not itself executable. It lowers two ways, and the pair is the whole design:
 *
 *  - **`toTerm`** → a `FieldTerm`, run by `fieldTermsMatch` against a neuron index a source
 *    already holds. CAVE, CATMAID and the mock all answer this way.
 *  - **`findNeuronsCypher`** → a `WHERE` clause, run by neuPrint's server.
 *
 * The friendly operators lower into the *existing* `CompareOp` vocabulary rather than widening
 * it — `contains` is an unanchored escaped regex, `matches` is an anchored one, `isIn` is an
 * anchored alternation — so `tableFilter.ts` and both export compilers needed no new cases and
 * cannot fall behind a row shape they have never heard of.
 *
 * ## Case is per row, and defaults to exact
 *
 * `LabelMatch` states the reason and it holds for every operator here: "a label is text somebody
 * copied out of a result — `SMP001(a)` and `5-HT` carry regex metacharacters, and reading those
 * as syntax turns a lookup into a different question with no error to say so." Exactness is the
 * house default, and the alternative is one visible toggle on the row rather than a rule that
 * differs per operator and cannot be seen.
 */

import type { DType, TableSchema } from '../core/types'
import { isNumericDType } from '../core/types'
import type { FieldTerm } from './terms'
import { anchoredPattern, escapeRegex, resolveColumn } from './terms'

/**
 * What a row can ask.
 *
 * **Labelled** to match `core.filterTable`'s `FilterOp` — "contains", "does not contain", "matches
 * regex", "≥" — so the app reads as one operator vocabulary rather than two that differ by a
 * word. The *identifiers* deliberately do not match (`is` here against `eq` there), and neither
 * does the type: an operator added there for a table filter would otherwise appear in this
 * dropdown with no lowering behind it, and `toTerm`'s exhaustive switch is what makes that a
 * compile error instead of a silently ignored row.
 *
 * The labels are consequently two lists that have to be kept saying the same words by hand.
 * Sharing them would mean moving them out of `tableOps.ts`, which `src/data` cannot import — the
 * same one-directional boundary that put `terms.ts` down here.
 */
export type RowOp =
  | 'is'
  | 'isNot'
  | 'isIn'
  | 'isNotIn'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'matches'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'isEmpty'
  | 'notEmpty'

export interface FilterRow {
  /** A column of the dataset's neuron schema. */
  field: string
  op: RowOp
  /**
   * The right-hand side. One entry for most operators, several for `isIn`/`isNotIn`, none for
   * `isEmpty`/`notEmpty`.
   *
   * A list even where one value is wanted, so the row has one shape to encode, decode and
   * validate. `arityOf` says what a given operator does with it.
   */
  values: string[]
  /** Compare the *value* case-insensitively. Absent means exact — see the header. */
  ignoreCase?: boolean
}

// ---------------------------------------------------------------------------
// The operator vocabulary
// ---------------------------------------------------------------------------

/** How many values an operator takes, which is what the card draws and what `decodeRows` keeps. */
export function arityOf(op: RowOp): 'none' | 'one' | 'many' {
  if (op === 'isEmpty' || op === 'notEmpty') return 'none'
  if (op === 'isIn' || op === 'isNotIn') return 'many'
  return 'one'
}

const TEXT_OPS: Array<{ value: RowOp; label: string }> = [
  { value: 'is', label: 'is' },
  { value: 'isNot', label: 'is not' },
  { value: 'isIn', label: 'is one of' },
  { value: 'isNotIn', label: 'is not one of' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'matches', label: 'matches regex' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'notEmpty', label: 'is not empty' },
]

/*
 * Symbols rather than words for the numeric set, which is `core.filterTable`'s choice and worth
 * copying: `size ≥ 100000` reads as the comparison it is, where "size is greater than or equal
 * to" spends half a narrow card on saying so.
 *
 * `isIn` is **absent here on purpose.** Its lowering is an alternation matched against
 * `String(cell)`, and a float column would compare `1` against `"1"` for some rows and `"1.0"`
 * for others depending on how the backend serialised it — a set membership that holds for part
 * of a column and not the rest, with nothing to say which.
 */
const NUMERIC_OPS: Array<{ value: RowOp; label: string }> = [
  { value: 'is', label: '=' },
  { value: 'isNot', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'ge', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'le', label: '≤' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'notEmpty', label: 'is not empty' },
]

const BOOL_OPS: Array<{ value: RowOp; label: string }> = [
  { value: 'is', label: 'is' },
  { value: 'isNot', label: 'is not' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'notEmpty', label: 'is not empty' },
]

/**
 * The operators worth offering for a column of this dtype.
 *
 * An unknown dtype falls through to the text set, which is the same call `opsForDType` makes in
 * `tableOps.ts`: a schema that has not arrived yet is not a schema saying the column is a
 * number, and offering `≥` for a name is a smaller wrong than offering nothing at all.
 */
export function rowOpsForDType(
  dtype: DType | undefined,
): Array<{ value: RowOp; label: string }> {
  if (!dtype) return TEXT_OPS
  if (isNumericDType(dtype)) return NUMERIC_OPS
  if (dtype === 'bool') return BOOL_OPS
  return TEXT_OPS
}

/** Whether an operator may be used on a column of this dtype. What `resolveRows` reports. */
function opAllowsDType(op: RowOp, dtype: DType | undefined): boolean {
  return rowOpsForDType(dtype).some((entry) => entry.value === op)
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * A row as one entry of an `ids` param, JSON rather than a delimited tuple.
 *
 * The reasoning is `paramPairs.ts`', which says it about column names and it is truer here: a
 * CAVE annotation system or an uploaded CSV's header can hold a comma, a colon or a space, and
 * `isIn` values are arbitrary label text. Not `encodePair` itself, because that is documented as
 * the *two-string* encoding for two named lists and a row is a struct with an operator in it.
 *
 * Lenient in the same way and for the same reason: an entry that cannot be read is dropped
 * rather than thrown, which is what stands between a hand-edited `.coda.json` and a crash.
 */
export function encodeRows(rows: readonly FilterRow[]): string[] {
  return keptRows(rows).map((row) =>
    JSON.stringify({
      f: row.field,
      op: row.op,
      v: row.values,
      ...(row.ignoreCase ? { i: true } : {}),
    }),
  )
}

/**
 * Rows worth storing.
 *
 * A row with no field, or one whose operator wants a value it has not been given, is a row
 * somebody is **still filling in** — component state, never a param. Storing it would put a
 * half-typed control in the provenance key and mark every node downstream stale for a filter
 * that does not yet filter anything. `RenameBody` draws the same line and says so.
 *
 * Note which way this errs, because it is the opposite of `out.table`'s. There a dropped clause
 * shows more rows than intended and that is acceptable for a tap; here it would send an
 * unnarrowed query to a shared production server — so an *incomplete* row is dropped, and a
 * complete row naming a field the dataset lacks is a reported problem rather than a quiet skip.
 */
function keptRows(rows: readonly FilterRow[]): FilterRow[] {
  // Arity decides whether a value is *wanted*, not how many are enough: one is enough for both
  // `one` and `many`, and `none` ignores them. So this asks the only question that differs.
  return rows.filter(
    (row) =>
      row.field !== '' && (arityOf(row.op) === 'none' || row.values.some((v) => v !== '')),
  )
}

/** Read a stored `filters` param. Anything unreadable is dropped rather than throwing. */
export function decodeRows(raw: unknown): FilterRow[] {
  if (!Array.isArray(raw)) return []
  const rows: FilterRow[] = []
  for (const entry of raw) {
    const row = decodeRow(entry)
    if (row) rows.push(row)
  }
  return keptRows(rows)
}

const ROW_OPS = new Set<string>([
  ...TEXT_OPS.map((o) => o.value),
  ...NUMERIC_OPS.map((o) => o.value),
  ...BOOL_OPS.map((o) => o.value),
])

function decodeRow(raw: unknown): FilterRow | undefined {
  if (typeof raw !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const { f, op, v, i } = parsed as Record<string, unknown>
  if (typeof f !== 'string' || typeof op !== 'string' || !ROW_OPS.has(op)) return undefined
  if (!Array.isArray(v) || v.some((entry) => typeof entry !== 'string')) return undefined
  return {
    field: f,
    op: op as RowOp,
    // Empty entries dropped here rather than at use: an empty alternative in an `isIn` compiles
    // to `^(?:|LC4)$`, which matches the empty string and so silently widens the set.
    values: (v as string[]).filter((entry) => entry !== ''),
    ...(i === true ? { ignoreCase: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// Lowering to a term
// ---------------------------------------------------------------------------

/**
 * One row as a `FieldTerm`, for a source filtering an index it already holds.
 *
 * Every friendly operator lands on the existing `CompareOp` vocabulary — see the header. The
 * switch is exhaustive over `RowOp` so that adding an operator without deciding what it means
 * fails to compile rather than silently matching nothing.
 *
 * `isEmpty`/`notEmpty` are the one non-obvious pair. There is no "is null" operator, and there
 * does not need to be: `.` matches any single character, so it is true for every non-empty value
 * and false both for the empty string and — by the null rule, which fails every operator but
 * `ne` — for a missing one. `isEmpty` is that same term negated.
 */
export function toTerm(row: FilterRow): FieldTerm {
  const ignoreCase = row.ignoreCase === true
  const value = row.values[0] ?? ''
  const term = (op: FieldTerm['op'], v: string, negate: boolean): FieldTerm => ({
    kind: 'field',
    field: row.field,
    op,
    value: v,
    negate,
    ignoreCase,
  })

  switch (row.op) {
    case 'is':
      return term('eq', value, false)
    case 'isNot':
      // `ne` rather than a negated `eq`: it is the one operator a missing value satisfies, and
      // saying "is not Traced" about a neuron with no status at all is the answer somebody
      // auditing for gaps wants. The two happen to agree today; only this one says why.
      return term('ne', value, false)
    case 'isIn':
    case 'isNotIn': {
      const alternation = row.values.map(escapeRegex).join('|')
      return term('match', anchoredPattern(alternation), row.op === 'isNotIn')
    }
    case 'contains':
    case 'notContains':
      return term('match', escapeRegex(value), row.op === 'notContains')
    case 'startsWith':
      return term('match', `^${escapeRegex(value)}`, false)
    case 'endsWith':
      return term('match', `${escapeRegex(value)}$`, false)
    case 'matches':
      // Anchored, because the same row is compiled to Neo4j's `=~`, which matches the whole
      // value. An unanchored local match would train the wrong intuition and then change the
      // result the day the graph is pointed at neuPrint.
      return term('match', anchoredPattern(value), false)
    case 'gt':
      return term('gt', value, false)
    case 'ge':
      return term('ge', value, false)
    case 'lt':
      return term('lt', value, false)
    case 'le':
      return term('le', value, false)
    case 'isEmpty':
      return term('match', '.', true)
    case 'notEmpty':
      return term('match', '.', false)
  }
}

// ---------------------------------------------------------------------------
// Resolving against a schema
// ---------------------------------------------------------------------------

export interface RowProblem {
  /** Beside the message rather than inside it, so a card can mark the row without parsing prose. */
  field: string
  message: string
}

export interface ResolvedRows {
  /** Ready for `prepareFieldTerms`; each names a column that exists and compiles. */
  terms: FieldTerm[]
  /** Rows that cannot be applied, each with why. Never silently dropped — see below. */
  problems: RowProblem[]
}

/**
 * Turn stored rows into terms against a particular neuron schema.
 *
 * **A problem is reported, not swallowed, and the caller decides what that means.** This is the
 * one place the design departs from `resolveFilters` in `tableFilter.ts`, which drops an
 * unapplicable clause and shows more rows. `out.table` is a tap and can afford that; a query
 * cannot — dropping a filter here sends a broader question to a shared production server and
 * returns neurons nobody asked for, which looks exactly like a correct answer.
 *
 * So: Find Neurons' `validate` turns these into edit-time issues on the card, which it can do
 * because a Dataset socket carries its schema *before* anything runs, and `evaluate` refuses.
 * The case that reaches run time is a saved graph repointed at another backend — which is what
 * `refuseUnfilterable` was written for, one field at a time.
 *
 * An **absent schema is not an empty one**, and the rows are lowered anyway. A source that has
 * not listed its datasets yet publishes nothing, and there are two ways to get that wrong in
 * opposite directions: reporting every row as broken (the failure `columnSchemaFor` and
 * `resolveFilters` both name) or answering with *no terms*, which reads as a query that has no
 * filters — an exporter taking that literally would write a notebook whose filters had silently
 * vanished. So: no problems, and every row lowered without being checked.
 */
export function resolveRows(
  schema: TableSchema | undefined,
  rows: readonly FilterRow[],
): ResolvedRows {
  const kept = keptRows(rows)
  if (!schema) return { terms: kept.map(toTerm), problems: [] }

  const terms: FieldTerm[] = []
  const problems: RowProblem[] = []

  for (const row of kept) {
    const column = resolveColumn(schema, row.field)
    if (!column) {
      problems.push({
        field: row.field,
        message: `This dataset has no "${row.field}" — remove the filter or pick another field`,
      })
      continue
    }

    if (!opAllowsDType(row.op, column.dtype)) {
      problems.push({
        field: row.field,
        message: `"${row.field}" is a ${column.dtype} column, which cannot be filtered that way`,
      })
      continue
    }

    if (row.op === 'matches') {
      try {
        new RegExp(anchoredPattern(row.values[0] ?? ''))
      } catch (error) {
        problems.push({
          field: row.field,
          message: `Invalid regex for "${row.field}": ${(error as Error).message}`,
        })
        continue
      }
    }

    // Only the ordering comparisons need a number to mean anything; `is`/`is not` fall through
    // to a comparison that answers "no neuron holds that", which is true rather than broken.
    if (
      isNumericDType(column.dtype) &&
      (row.op === 'gt' || row.op === 'ge' || row.op === 'lt' || row.op === 'le') &&
      !Number.isFinite(Number(row.values[0]))
    ) {
      problems.push({
        field: row.field,
        message: `"${row.values[0]}" is not a number, so "${row.field}" cannot be compared to it`,
      })
      continue
    }

    // The column's own name, not the row's spelling of it: `resolveColumn` matches case
    // -insensitively, and every reader downstream addresses columns by exact name.
    terms.push(toTerm({ ...row, field: column.name }))
  }

  return { terms, problems }
}
