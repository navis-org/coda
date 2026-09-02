/**
 * Rule-based edits to a table: pandas' `.loc[rows, column] = value`, written down.
 *
 * What `Edit Table` stores and what it does, both halves in one file. The node exists so that a
 * wrong annotation can be overridden *inside* a graph — retype a handful of neurons, blank a
 * status somebody disagrees with, tag a set with a group of their own — and the same analysis
 * re-run without leaving Coda to hand-edit a CSV. So an edit has to be a **rule** rather than a
 * cell reference: a rule survives the table being re-fetched, re-filtered and re-joined, where
 * `row 412, column type` stops meaning anything the moment a row is dropped upstream.
 *
 * Outside `tableOps.ts` for `tableFilter.ts`'s reason: this needs the term model in
 * `src/data/terms.ts` and the query parser in `neuronSearch.ts`, and `tableOps.ts` deliberately
 * imports neither. Invariant 3's requirement is met the way it asks — `editSchema` and
 * `editTable` are side by side and `tableEdits.test.ts` asserts they agree.
 *
 * ## The three parts of a setter
 *
 * `where` is an **Explore query**, parsed by `parseSearch` — the same grammar as the search box
 * and, through `leadingOperator`, the same one a Table viewer's header cell takes. `type==LC4
 * side==left` is two terms ANDed; `pre>100`, `!status==Traced` and `type~^LPLC[0-9]+$` all mean here
 * what they mean there. Borrowed rather than invented, for `tableFilter.ts`'s stated reason: a
 * second filter language is a second thing to learn and a second thing to get subtly different.
 * An empty `where` is every row, which is `.loc[:, c] = v`.
 *
 * `column` names the column to write. One column per setter — two columns means two rows —
 * because a single value is rarely right across two dtypes, and a multi-column picker per row
 * would triple the width of the commonest card state to buy the rare case.
 *
 * `value` is a literal. It is `unquote`d, so `""` writes an **empty** value where a blank field
 * writes nothing at all; and it is coerced into the column's dtype, which is the part that has
 * a schema consequence.
 *
 * ## Everything errs towards editing *fewer* rows
 *
 * This is the one rule to keep, and it is the opposite of `tableFilter.ts`'s. There a clause
 * that cannot be applied is dropped, showing more rows than intended — acceptable for a tap. A
 * dropped term here would *widen what gets overwritten*, so a setter whose `where` cannot be
 * resolved is **disabled entirely** rather than broadened, and every reason is reported.
 *
 * Two of those reasons are worth naming, because both look harmless:
 *
 *  - **A bare term is refused.** `LC4` on its own means "any column contains LC4" in the search
 *    box, which is the right default for finding something and the wrong one for overwriting it
 *    — `LC4` also appears in `instance`, in `notes` and in somebody's `group`. It has to be
 *    written `type==LC4`.
 *  - **A `where` naming a column the table does not have disables the setter**, where the same
 *    clause in the Table viewer merely matches nothing. Not the same thing: `fieldTermsMatch`
 *    reads an unknown column as "did not match", and a *negated* term on an unknown column
 *    therefore matches **every row** — so `!typ==LC4`, one keystroke from `!type==LC4`, would
 *    overwrite the whole table rather than most of it.
 *
 * ## The schema is decided by `column` and `value`, never by `where`
 *
 * A setter naming a column the table lacks **creates** it, filled with null outside the rows it
 * matches; a value that does not fit the column's dtype **widens** the column. Both are
 * published by `editSchema` at edit time, so a downstream picker offers a column somebody has
 * just invented without waiting for a run.
 *
 * The `where` clause is deliberately not part of that decision. It is the part being typed, and
 * a column that appeared and disappeared from every downstream picker between two keystrokes of
 * a regex would be worse than a column that exists slightly too early. So a setter with a
 * broken filter still contributes its column — it simply changes no rows, and says so.
 *
 * Widening only ever goes one way (`i64` → `f64` → `str`), which is what makes it safe to apply
 * before anything is written: no existing value can fail to convert.
 *
 * ## Setters run in order, each seeing what the ones above it did
 *
 * `.loc` lines in a script read that way and this is the same object, so the second setter's
 * `where` is matched against the table the first one left. That is what lets one rule create a
 * column and the next one narrow on it. The cost is that reordering rows changes the answer,
 * which is true of the script it is modelled on.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { ColumnSchema, DType, TableSchema } from '../../core/types'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { inferDType } from '../../data/csv'
import type { FieldTerm } from '../../data/terms'
import { fieldTermsMatch, prepareFieldTerms, resolveColumn } from '../../data/terms'
import { parseSearch, unquote } from './neuronSearch'
import { mergedDType } from './tableOps'

/** One rule: which rows, which column, what to put in it. */
export interface EditSetter {
  /** An Explore query. Empty means every row. */
  where: string
  /** The column to write. A name the table does not have is created. */
  column: string
  /** The literal to write, as typed. Blank means the row is unfinished; `""` writes empty. */
  value: string
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * A setter as one entry of an `ids` param, JSON rather than a delimited triple.
 *
 * The reasoning is `paramPairs.ts`' and it is why this is not `encodePair`: a column name can
 * hold a comma, a colon or a space — a wide pivot names its columns after label values — and a
 * `where` clause holds all three by construction. Not `paramPairs` itself either, which is
 * documented as the *two-string* encoding; a setter is a struct, so it is spelled the way
 * `filterRows.ts` spells one.
 *
 * Lenient in the same way as both: an entry that cannot be read is dropped rather than thrown,
 * which is what stands between a hand-edited `.coda.json` and a crash.
 */
export function encodeSetters(setters: readonly EditSetter[]): string[] {
  return keptSetters(setters).map((s) =>
    JSON.stringify({ w: s.where, c: s.column, v: s.value }),
  )
}

/**
 * Setters worth storing.
 *
 * `RenameBody`'s rule rather than `FindNeuronsBody`'s: a row with a column and no value yet is
 * a row somebody is **mid-way through typing**, and dropping it here would delete it from under
 * the cursor the moment the param round-trips. It is inert meanwhile — `editPlan` will not make
 * a target of it — so nothing is at risk in keeping it, which is the difference from a query
 * row, where an incomplete filter would reach a shared production server.
 *
 * All three parts empty is an abandoned row rather than an unfinished one, and letting it go is
 * what lets `+ Add` draw a row the store never sees.
 */
function keptSetters(setters: readonly EditSetter[]): EditSetter[] {
  return setters.filter((s) => s.where !== '' || s.column !== '' || s.value !== '')
}

/** Read a stored `edits` param. Anything unreadable is dropped rather than throwing. */
export function decodeSetters(raw: unknown): EditSetter[] {
  if (!Array.isArray(raw)) return []
  const setters: EditSetter[] = []
  for (const entry of raw) {
    const setter = decodeSetter(entry)
    if (setter) setters.push(setter)
  }
  return keptSetters(setters)
}

function decodeSetter(raw: unknown): EditSetter | undefined {
  if (typeof raw !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const { w, c, v } = parsed as Record<string, unknown>
  if (typeof w !== 'string' || typeof c !== 'string' || typeof v !== 'string') return undefined
  return { where: w, column: c, value: v }
}

// ---------------------------------------------------------------------------
// The literal
// ---------------------------------------------------------------------------

/**
 * What a value field means, or `undefined` when it is blank.
 *
 * Trimmed before quotes are stripped, so a stray trailing space in a field somebody typed into
 * does not become part of a cell value — and quoting is how to ask for one that does. `""` is
 * consequently the way to write an *empty* cell, which is a real edit (clearing a status
 * somebody disagrees with) and has to be distinguishable from a field nobody has filled in.
 */
function literalText(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  return unquote(trimmed)
}

/**
 * The dtype a literal would want if nothing else constrained it — what a **new** column gets.
 *
 * `inferDType` rather than a `Number()` test of its own, and that is invariant 8 rather than
 * tidiness. The obvious predicate reads `864691135463487579` as a perfectly good integer,
 * `Number()` rounds it to `864691135463487600`, and the rule *meant* to stop that — "so an
 * id-shaped value does not arrive as `f64`" — was the thing letting it through. `csv.ts` is
 * where that was worked out once, for the import path, and it vetoes anything that does not
 * survive the round trip: a CAVE root id, `007`, `0x10`, `Infinity`. Same question, same
 * answer, and the import path's tests now cover this one.
 */
function naturalDType(text: string): DType {
  return inferDType([text])
}

/**
 * The literal as a cell of this dtype, or `undefined` when it does not fit.
 *
 * An empty literal is `null`, which fits every dtype — clearing a cell is not a reason to widen
 * a column. `null` and `undefined` are consequently different answers here, which is why the
 * return type is `CellValue | undefined` and every caller tests `=== undefined`: a `??` would
 * read a cleared cell as a value that did not fit.
 *
 * The numeric arms ask `naturalDType`, so a value's *reading* is decided in one place. Booleans
 * do not: `inferDType` calls `1` an integer, which is right for a column of them and wrong for a
 * single literal aimed at a column that is already `bool` — there, `1` can only mean true.
 */
function coerce(text: string, dtype: DType): CellValue | undefined {
  if (text === '') return null
  switch (dtype) {
    case 'i64':
      return naturalDType(text) === 'i64' ? Number(text) : undefined
    case 'f64': {
      const natural = naturalDType(text)
      return natural === 'i64' || natural === 'f64' ? Number(text) : undefined
    }
    case 'bool':
      if (/^(true|1)$/i.test(text)) return true
      if (/^(false|0)$/i.test(text)) return false
      return undefined
    case 'str':
      return text
  }
}

/** A dtype in the words the card and the warnings use, rather than its storage name. */
function dtypeWord(dtype: DType): string {
  switch (dtype) {
    case 'str':
      return 'text'
    case 'bool':
      return 'true/false'
    case 'i64':
      return 'a whole number'
    case 'f64':
      return 'a number'
  }
}

/**
 * The dtype two demands agree on. **Only ever wider**, never narrower.
 *
 * That one-directionality is what makes it safe to convert a column before any value is
 * written: every existing cell converts, so there is no row where the widening itself could
 * fail and no order in which the setters have to be applied for it to hold.
 *
 * `mergedDType` is the one statement of "can these two reconcile", shared with `stackColumns`
 * and `combinedDType`; what differs is only what each caller does with a *no*. A stack has found
 * two columns wearing one name and refuses; Combine Columns and this both widen to the dtype
 * that keeps every value, which is `combinedDType`'s reasoning one file over.
 */
function widenDType(a: DType, b: DType): DType {
  return mergedDType(a, b) ?? 'str'
}

/** The dtype a column ends up with, given what it starts as and everything written into it. */
function targetDType(existing: DType | undefined, texts: readonly string[]): DType {
  let dtype = existing
  for (const text of texts) {
    // Null fits anything, so clearing a cell never widens the column it is in.
    if (text === '') continue
    if (dtype === undefined) {
      dtype = naturalDType(text)
      continue
    }
    if (coerce(text, dtype) !== undefined) continue
    dtype = widenDType(dtype, naturalDType(text))
  }
  // A brand-new column whose only setter writes an empty value: text, because a column of
  // nothing but nulls has to be *some* dtype and text is the one that accepts whatever a later
  // edit puts in it.
  return dtype ?? 'str'
}

/** Existing values under a widened dtype. Only `→ str` actually converts; nulls stay null. */
function widenColumn(data: ColumnData, dtype: DType): ColumnData {
  if (dtype !== 'str') return data.slice()
  return data.map((cell) => (cell === null || cell === undefined ? null : String(cell)))
}

// ---------------------------------------------------------------------------
// The `where` clause
// ---------------------------------------------------------------------------

interface ResolvedWhere {
  /** Ready for `prepareFieldTerms` — each names a column that exists and compiles. */
  terms: FieldTerm[]
  /** Why this clause cannot be used. Non-empty disables the setter; see the header. */
  problems: string[]
}

/**
 * Parse one `where` clause and resolve it against the schema the setters produce.
 *
 * Against the *output* schema rather than the input's, so a rule can narrow on a column an
 * earlier rule created — which is the point of running them in order.
 *
 * An **absent schema is not an empty one**: a port publishes none before its first run, and
 * reporting every clause as naming a missing column would put a badge on a node that is
 * perfectly well configured. The terms are lowered unchecked in that case; `evaluate` always
 * has a real schema and is where the check actually bites.
 */
function resolveWhere(schema: TableSchema | undefined, where: string): ResolvedWhere {
  const parsed = parseSearch(where)
  const problems = [...parsed.errors]
  const terms: FieldTerm[] = []

  for (const term of parsed.terms) {
    if (term.kind !== 'field') {
      // Named per kind, because the two are fixed differently: a word becomes `column==word`
      // and a bare regex becomes `column~pattern`, which is the same pattern against one
      // column rather than against all of them.
      problems.push(
        term.kind === 'regex'
          ? `"/${term.value}" would match any column — write it as column~${term.value}`
          : `"${term.value}" would match any column — write it as column==value`,
      )
      continue
    }
    if (!schema) {
      terms.push(term)
      continue
    }
    const column = resolveColumn(schema, term.field)
    if (!column) {
      problems.push(`the table has no "${term.field}" column`)
      continue
    }
    // The column's own name, not the clause's spelling of it: `resolveColumn` matches
    // case-insensitively and every reader downstream addresses columns by exact name.
    terms.push({ ...term, field: column.name })
  }

  return { terms, problems }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** One setter, resolved: where it writes, what it writes, and whether it will. */
export interface EditTarget {
  setter: EditSetter
  /** Position among the stored setters — what a message names and a card marks. */
  index: number
  /** The column's exact name: the table's own spelling where it has one. */
  column: string
  /** The column's dtype in the output, after every setter writing it has had its say. */
  dtype: DType
  /** The value as it will be written, already coerced into `dtype`. */
  cell: CellValue
  terms: FieldTerm[]
  /** Why this setter changes nothing. Empty means it will be applied. */
  problems: string[]
}

export interface WidenedColumn {
  column: string
  from: DType
  to: DType
}

export interface AddedColumn {
  column: string
  /** Carried rather than looked back up: both emitters have to declare it, and `editPlan` is
   *  the only place that knows a new column's dtype without a schema lookup that cannot fail. */
  dtype: DType
}

export interface EditPlan {
  /** One per setter complete enough to write something, in the order they were written. */
  targets: EditTarget[]
  /**
   * The targets that will actually be applied — `problems` empty.
   *
   * On the plan rather than re-derived per caller, because `editTable` and both export emitters
   * all need it and the filter is the *definition* of "this rule runs". Two of those three are
   * across the export seam, where a disagreement emits `out = src` for a node that edits and
   * the golden only notices if the fixture happens to cover it.
   */
  active: EditTarget[]
  /**
   * Nothing to do: no rule runs, no column is added, none widens.
   *
   * Enumerates every kind of thing a plan can do, which is exactly why it belongs here — adding
   * a fifth kind must not mean remembering three pass-through checks in three files.
   */
  noop: boolean
  /** The output schema, or undefined when the input's is not known yet. */
  schema: TableSchema | undefined
  /** Columns this plan adds, in the order the setters name them. */
  added: AddedColumn[]
  widened: WidenedColumn[]
  /** Everything worth putting on the node, in row order. */
  issues: string[]
}

/**
 * Work out what a set of setters does to a schema, and what each one will write.
 *
 * The shared analysis, in `renamePlan`'s sense: `inferOutputs`, `validate`, the card's readout
 * and `editTable` all read this rather than each answering the same question, so a badge
 * counting broken rows and a run that skips them cannot disagree.
 */
export function editPlan(
  schema: TableSchema | undefined,
  setters: readonly EditSetter[],
): EditPlan {
  const kept = keptSetters(setters)
  const issues: string[] = []

  /*
   * Which rows are complete enough to write anything. This decides the output schema all by
   * itself — see the header: the `where` clause is the part being typed, and a column blinking
   * in and out of every downstream picker between two keystrokes is worse than one that exists
   * a little too early.
   */
  interface Candidate {
    setter: EditSetter
    index: number
    /** The column as it exists upstream, or undefined when this plan adds it. */
    existing: ColumnSchema | undefined
    column: string
    text: string
  }
  const candidates: Candidate[] = []
  kept.forEach((setter, index) => {
    const text = literalText(setter.value)
    if (!setter.column) {
      issues.push(`Edit ${index + 1}: pick a column to set`)
      return
    }
    if (text === undefined) {
      issues.push(`Edit ${index + 1}: no value for "${setter.column}" — use "" to clear it`)
      return
    }
    // Resolved once and carried, not looked up again below: `resolveColumn` matches
    // case-insensitively, so a second lookup by the normalised name only agrees by construction
    // — and would stop agreeing the day the normalisation moved.
    const existing = resolveColumn(schema, setter.column)
    candidates.push({ setter, index, existing, column: existing?.name ?? setter.column, text })
  })

  /*
   * Every literal aimed at one column, so the column's dtype is decided once for all of them
   * rather than per setter — a column has one dtype, and two setters disagreeing about it is
   * exactly the schema/value disagreement invariant 3 is about. `dtype` is filled in on the same
   * entry rather than in a second map keyed identically to this one.
   */
  interface Target {
    existing: ColumnSchema | undefined
    texts: string[]
    dtype: DType
  }
  const byColumn = new Map<string, Target>()
  for (const candidate of candidates) {
    let entry = byColumn.get(candidate.column)
    if (!entry) {
      entry = { existing: candidate.existing, texts: [], dtype: 'str' }
      byColumn.set(candidate.column, entry)
    }
    entry.texts.push(candidate.text)
  }
  for (const entry of byColumn.values()) {
    entry.dtype = targetDType(entry.existing?.dtype, entry.texts)
  }

  const added: AddedColumn[] = []
  const widened: WidenedColumn[] = []
  let outSchema: TableSchema | undefined
  if (schema) {
    for (const [name, entry] of byColumn) {
      if (entry.existing === undefined) added.push({ column: name, dtype: entry.dtype })
      else if (entry.existing.dtype !== entry.dtype) {
        widened.push({ column: name, from: entry.existing.dtype, to: entry.dtype })
      }
    }
    /*
     * The input schema itself where nothing about it changed, rather than an equal copy. Identity
     * is what every downstream `useMemo([schema])` and column picker keys on, and this runs on
     * every graph mutation — including every frame of a node drag — so an equal-but-fresh object
     * invalidates them all for a node that did nothing to the columns.
     */
    outSchema =
      added.length === 0 && widened.length === 0
        ? schema
        : {
            columns: [
              ...schema.columns.map((column) => {
                const entry = byColumn.get(column.name)
                if (!entry || entry.dtype === column.dtype) return column
                // The unit rides along: a `nm` column read as text is still nanometres, and
                // dropping it here would change a header two viewers away for no visible reason.
                return { ...column, dtype: entry.dtype }
              }),
              ...added.map((entry): ColumnSchema => ({
                name: entry.column,
                dtype: entry.dtype,
              })),
            ],
          }
  }

  const targets: EditTarget[] = candidates.map((candidate) => {
    const dtype = byColumn.get(candidate.column)!.dtype
    /*
     * Cannot fail: `targetDType` widened until every literal aimed at this column fits. Compared
     * against `undefined` rather than `??`-ed, because a cleared cell coerces to a perfectly good
     * `null` that a nullish fallback would read as "did not fit".
     */
    const coerced = coerce(candidate.text, dtype)
    const { terms, problems } = resolveWhere(outSchema, candidate.setter.where)
    return {
      setter: candidate.setter,
      index: candidate.index,
      column: candidate.column,
      dtype,
      cell: coerced === undefined ? candidate.text : coerced,
      terms,
      problems,
    }
  })

  /*
   * Widening first, and the order is the point. A disabled rule is already marked twice on the
   * card — a red field and a count — where a column quietly changing dtype has no marker at all
   * and is the one with consequences past this node. The card shows the first issue and keeps
   * the rest for the tooltip, so which comes first decides which one gets read.
   */
  for (const entry of widened) {
    const culprit = byColumn
      .get(entry.column)
      ?.texts.find((text) => coerce(text, entry.from) === undefined)
    issues.push(
      `"${entry.column}" becomes ${dtypeWord(entry.to)}: ` +
        `${culprit === undefined ? 'a value' : `"${culprit}"`} is not ${dtypeWord(entry.from)}`,
    )
  }
  for (const target of targets) {
    for (const problem of target.problems) {
      issues.push(`Edit ${target.index + 1} changes nothing: ${problem}`)
    }
  }
  /*
   * A warning, not a refusal, which is the house rule for a guard rail. Editing the id column
   * is a legitimate thing to do — an id that drifted, a qualified id being unqualified — but it
   * changes *which neuron a row is about*, and every downstream lookup follows it silently.
   */
  if (targets.some((t) => t.problems.length === 0 && t.column === ID_COLUMN_NAME)) {
    issues.push(`Editing "${ID_COLUMN_NAME}" changes which neuron a row is about`)
  }

  const active = targets.filter((target) => target.problems.length === 0)
  const noop = active.length === 0 && added.length === 0 && widened.length === 0
  return { targets, active, noop, schema: outSchema, added, widened, issues }
}

/** The schema half. `editTable` must agree with it; `tableEdits.test.ts` is what says it does. */
export function editSchema(
  schema: TableSchema | undefined,
  setters: readonly EditSetter[],
): TableSchema | undefined {
  return editPlan(schema, setters).schema
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface EditResult {
  table: TableValue
  plan: EditPlan
  /** Rows changed by each target, parallel to `plan.targets`. Zero for a disabled one. */
  matched: number[]
}

/**
 * The edited table.
 *
 * Hands back the input untouched when there is nothing to do, rather than a copy of every
 * column — columns are immutable by contract, so an identical table *is* the same table, and
 * that is what keeps a freshly-added node free.
 *
 * The columns it does touch are copied first, for the same contract: something upstream is
 * still holding the original arrays, and a cached result two nodes back must not change
 * because a rule was typed here.
 */
export function editTable(
  table: TableValue,
  setters: readonly EditSetter[],
  /** The plan, where the caller has already built one. Pure, so it is the same object. */
  precomputed?: EditPlan,
): EditResult {
  const plan = precomputed ?? editPlan(table.schema, setters)
  const matched = plan.targets.map(() => 0)
  if (plan.noop) return { table, plan, matched }
  const schema = plan.schema!

  /*
   * The incoming dtypes as a map rather than a `findColumn` per output column. The loop below is
   * over the output columns, so the linear scan inside made it O(columns²) — 26ms on a
   * 3,000-column pivot against 1ms at 500, measured, and this runs per keystroke on a `cheap`
   * node.
   */
  const before = new Map(table.schema.columns.map((column) => [column.name, column.dtype]))
  const written = new Set(plan.active.map((target) => target.column))
  const data: Record<string, ColumnData> = {}
  for (const column of schema.columns) {
    const original = table.data[column.name]
    if (!original) {
      // A column this plan adds. Null everywhere the rules do not reach, which is what makes an
      // unmatched row distinguishable from one somebody deliberately set to nothing.
      data[column.name] = new Array<CellValue>(table.length).fill(null)
      continue
    }
    if (before.get(column.name) !== column.dtype) {
      data[column.name] = widenColumn(original, column.dtype)
    } else if (written.has(column.name)) data[column.name] = original.slice()
    else data[column.name] = original
  }

  /*
   * The working table shares these arrays rather than copying them, which is what makes the
   * setters sequential: the second one's `where` is prepared against what the first one wrote.
   * `prepareFieldTerms` re-reads `data` per call, so nothing has to be rebuilt between rules.
   */
  const working = makeTable(schema, data, table.kind)
  plan.targets.forEach((target, i) => {
    if (target.problems.length > 0) return
    const column = data[target.column]!
    // A rule with no filter is every row, and asking `fieldTermsMatch` 165,000 times to be told
    // so is the one scan here that buys nothing.
    if (target.terms.length === 0) {
      column.fill(target.cell)
      matched[i] = working.length
      return
    }
    const prepared = prepareFieldTerms(working, target.terms)
    let count = 0
    for (let row = 0; row < working.length; row++) {
      if (!fieldTermsMatch(prepared, row)) continue
      column[row] = target.cell
      count++
    }
    matched[i] = count
  })

  return { table: working, plan, matched }
}

/**
 * What an exporter says about a rule Coda disabled.
 *
 * Shared between the two emitters rather than written twice: the sentence contains no pandas and
 * no dplyr — it states what *Coda* did — so the copy rule `tableFilters.ts` states, which is
 * about how each language assembles its predicates, does not reach it.
 */
export function disabledEditNote(target: EditTarget): string {
  return (
    `Edit ${target.index + 1} (${target.setter.where.trim() || 'all rows'} → ${target.column}) ` +
    `changes nothing in Coda: ${target.problems.join('; ')}. It is left out here too rather ` +
    'than translated into a rule that edits more rows.'
  )
}
