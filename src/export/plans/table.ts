/**
 * What the table transforms' exports decide, before either language says it.
 *
 * Mostly refusals: a Sort with no column, a Join missing a key on one side, a mode a hand-edited
 * file names that no build of the node offered. Each was a test and a sentence written into both
 * emitters, and the sentence is the half that drifts — a card saying one thing and two documents
 * saying two others. So both halves are here, beside the values the renderers go on to read —
 * which column, which operator, which target name — resolved once through the node's own
 * helpers, and each emitter spells only the pandas or the dplyr.
 *
 * What stays with each renderer is *when* it asks for its library relative to a refusal, because
 * that is a line in the document and it differs: the notebook requests pandas before it reads a
 * Sample's or a Normalize's mode, and both documents request theirs between Group By's two
 * refusals — which is why that plan has two levels, `embedPlan`'s shape.
 */

import type { ParamValues } from '../../core/node'
import type { DType } from '../../core/types'
import { isNumericDType } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { rawFileUrl } from '../../data/rawFileUrl'
import type {
  AggFn,
  FilterOp,
  JoinHow,
  NormalizeMode,
  SampleMode,
} from '../../nodes/lib/tableOps'
import {
  FILTER_TABLE_DEFAULT_OP,
  NORMALIZE_OPTIONS,
  SAMPLE_OPTIONS,
  filterConditionIssues,
  filterTable,
  relabelTarget,
  resolveFilterOp,
} from '../../nodes/lib/tableOps'
import { qualifyTarget } from '../../nodes/table/qualifyIds'
import type { NeutralContext, Noted, Refusable } from '../neutral'
import { dtypeOf } from '../neutral'

/** What the table plans read: params, the input's schema and the column pickers. */
type TableContext = Pick<NeutralContext, 'params' | 'schema' | 'column' | 'columns'>

// ---------------------------------------------------------------------------
// Filter Table
// ---------------------------------------------------------------------------

/** One column compared against the typed value — Filter Table's, and Filter Network's condition. */
export type FilterComparison = {
  column: string
  op: FilterOp
  value: string
  /**
   * The error the canvas's `filterTable` throws on this condition, if it throws. Filter Table
   * refuses on it; Filter Network writes its seed half regardless.
   */
  canvasError?: string
} & (
  | {
      numeric: true
      /**
       * Whether a missing cell passes the comparison, as the canvas answers it: `makePredicate`
       * reads a null through `Number`, so on a numeric column it is **0** — kept by `== 0` and by
       * `!= 5`, dropped by `!= 0` and by every ordering. Each renderer spells it only where its
       * library's default for a missing value disagrees.
       */
      keepsNull: boolean
    }
  | {
      numeric: false
      /** Absent where the dtype is not known, or the canvas throws. No renderer reads it here. */
      keepsNull?: boolean
    }
)

/**
 * The canvas's own `filterTable` over a single null cell: whether it keeps the row, or the error
 * it throws.
 *
 * Asked of the node's code rather than restated, because both answers are in `makePredicate` and
 * a copy of either is how a document comes to filter differently from its card. It throws
 * before it reads a row, so one row is enough for both questions.
 */
function onCanvas(
  dtype: DType,
  op: FilterOp,
  value: string,
): { keepsNull: boolean } | { error: string } {
  const probe = tableFromRows({ columns: [{ name: 'probe', dtype }] }, [{ probe: null }])
  try {
    return { keepsNull: filterTable(probe, 'probe', op, value).length === 1 }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

/**
 * The comparison, resolved as `evaluate` resolves it — `resolveFilterOp` against the column's
 * dtype — or the document filters on a different condition from the card it came from.
 */
export function filterComparison(
  params: ParamValues,
  column: string,
  dtype: DType | undefined,
  defaultOp: FilterOp,
): FilterComparison {
  const op = resolveFilterOp(params.op, dtype, defaultOp)
  const value = String(params.value)
  if (!dtype) return { column, op, value, numeric: false }
  const canvas = onCanvas(dtype, op, value)
  const base = {
    column,
    op,
    value,
    ...('error' in canvas ? { canvasError: canvas.error } : {}),
  }
  // A numeric condition the canvas throws on has a value that is not a number or an operator
  // that is not a comparison, and each renderer refuses both before it reads `keepsNull`.
  const keepsNull = 'keepsNull' in canvas ? canvas.keepsNull : undefined
  return isNumericDType(dtype)
    ? { ...base, numeric: true, keepsNull: keepsNull ?? false }
    : { ...base, numeric: false, ...(keepsNull === undefined ? {} : { keepsNull }) }
}

export type FilterTablePlan = Refusable<FilterComparison>

/**
 * Refused wherever the node's `evaluate` throws — an operator the column's dtype does not take,
 * a value that is not a number on a numeric column, a pattern that does not compile. A document
 * written for those would run a filter the card never could. The sentence is the one `validate`
 * already puts on the card (`filterConditionIssues`), and the thrown error where `validate` says
 * nothing, which is an invalid regex. The declared default giving way (`ge` becoming `eq` on a
 * text column) has happened by then, in `resolveFilterOp`, so it is never refused.
 */
export function filterTablePlan(ctx: TableContext): FilterTablePlan {
  const column = ctx.column('column')
  if (!column) return { refusal: 'No column is chosen on this Filter Table.' }
  const dtype = dtypeOf(ctx, 'in', column)
  const { canvasError, ...comparison } = filterComparison(
    ctx.params,
    column,
    dtype,
    FILTER_TABLE_DEFAULT_OP,
  )
  if (canvasError !== undefined) {
    const why = filterConditionIssues(dtype, comparison.op, comparison.value)[0] ?? canvasError
    return { refusal: `This Filter Table fails on the canvas too: ${why}.` }
  }
  return comparison
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

/** A note a Sort export may carry. The texts are each renderer's; *whether* is decided here. */
export type SortNote =
  /** The column is text, which Coda collates numeric-aware and neither library does. */
  'textCollation'

export type SortPlan = Refusable<{
  column: string
  descending: boolean
  /** `0` keeps every row. */
  limit: number
  notes: SortNote[]
}>

export function sortPlan(ctx: TableContext): SortPlan {
  const column = ctx.column('column')
  if (!column) return { refusal: 'No column is chosen on this Sort.' }
  const numeric = isNumericDType(dtypeOf(ctx, 'in', column) ?? 'str')
  return {
    column,
    descending: ctx.params.descending === true,
    limit: Number(ctx.params.limit),
    notes: numeric ? [] : ['textCollation'],
  }
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

/** The columns kept, or the note saying an empty picker keeps them all. */
export type SelectPlan = Noted<{ columns: string[] }>

/**
 * Empty means every column, which is what the node's own `selectTable` does — so the honest
 * translation is a copy rather than an empty frame.
 */
export function selectPlan(ctx: Pick<NeutralContext, 'columns'>): SelectPlan {
  const columns = ctx.columns('columns')
  return columns.length > 0
    ? { columns }
    : { note: 'No columns picked, which Coda reads as "keep them all".' }
}

// ---------------------------------------------------------------------------
// Relabel
// ---------------------------------------------------------------------------

export type RelabelPlan = Refusable<{
  column: string
  keyColumn: string
  valueColumn: string
  unmatched: string
  /**
   * `relabelTarget`'s, not `into or column`: both languages overwrite a column the typed name
   * collides with, where Coda suffixes.
   */
  target: string
}>

export function relabelPlan(ctx: TableContext): RelabelPlan {
  const column = ctx.column('column')
  const keyColumn = ctx.column('keyColumn')
  const valueColumn = ctx.column('valueColumn')
  if (!column || !keyColumn || !valueColumn) {
    return { refusal: 'This Relabel has no column chosen on one side.' }
  }
  return {
    column,
    keyColumn,
    valueColumn,
    unmatched: String(ctx.params.unmatched),
    target: relabelTarget(ctx.schema('in'), column, String(ctx.params.into)),
  }
}

// ---------------------------------------------------------------------------
// Group By
// ---------------------------------------------------------------------------

/**
 * The keys, then the aggregation — two levels of refusal, because both documents request their
 * library between the two, so a Group By refused for its aggregation still imports it.
 */
export type GroupByPlan = Refusable<{
  by: string[]
  aggregate: Refusable<{
    agg: AggFn
    /** Empty for `count`, which counts rows and reads no column. */
    values: string[]
  }>
}>

export function groupByPlan(ctx: TableContext): GroupByPlan {
  const by = ctx.columns('by')
  if (by.length === 0) return { refusal: 'No group-by columns are chosen.' }
  const agg = String(ctx.params.agg) as AggFn
  const values = agg === 'count' ? [] : ctx.columns('value')
  return {
    by,
    aggregate:
      agg !== 'count' && values.length === 0
        ? { refusal: `"${agg}" needs at least one value column.` }
        : { agg, values },
  }
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

export type JoinPlan = Refusable<{
  leftKey: string
  rightKey: string
  how: JoinHow
  suffix: string
}>

export function joinPlan(ctx: TableContext): JoinPlan {
  const leftKey = ctx.column('leftKey')
  const rightKey = ctx.column('rightKey')
  if (!leftKey || !rightKey) return { refusal: 'This Join has no key column on one side.' }
  return {
    leftKey,
    rightKey,
    // Cast, not validated: an unknown value reaches each renderer as it always has.
    how: String(ctx.params.how) as JoinHow,
    suffix: String(ctx.params.suffix),
  }
}

// ---------------------------------------------------------------------------
// Sample
// ---------------------------------------------------------------------------

export type SamplePlan = Refusable<{
  mode: SampleMode
  count: number
  /** At least 1, which is what the node strides by for anything smaller. */
  step: number
  seed: number
}>

/**
 * A mode the node's own option list does not offer is refused rather than guessed at: only a
 * hand-edited file reaches it, and every guess is a different set of rows.
 */
export function samplePlan(params: ParamValues): SamplePlan {
  const mode = SAMPLE_OPTIONS.find((option) => option.value === String(params.mode))?.value
  if (!mode) return { refusal: `Unknown sample mode "${String(params.mode)}".` }
  return {
    mode,
    count: Number(params.count),
    step: Math.max(1, Number(params.step)),
    seed: Number(params.seed),
  }
}

// ---------------------------------------------------------------------------
// Pivot
// ---------------------------------------------------------------------------

export type PivotPlan = Refusable<{
  rows: string
  columns: string
  agg: AggFn
  /** Absent counts rows, which is what a Pivot with no value column does. */
  value?: string
}>

export function pivotPlan(ctx: TableContext): PivotPlan {
  const rows = ctx.column('rows')
  const columns = ctx.column('columns')
  if (!rows || !columns) return { refusal: 'This Pivot needs both a Rows and a Columns field.' }
  const value = ctx.column('value')
  return { rows, columns, agg: String(ctx.params.agg) as AggFn, value }
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

/** The mode, or the refusal a mode the node does not offer becomes — `samplePlan`'s rule. */
export function normalizePlan(params: ParamValues): Refusable<{ mode: NormalizeMode }> {
  const mode = NORMALIZE_OPTIONS.find((option) => option.value === String(params.mode))?.value
  return mode ? { mode } : { refusal: `Unknown normalize mode "${String(params.mode)}".` }
}

// ---------------------------------------------------------------------------
// Qualify Ids
// ---------------------------------------------------------------------------

export type QualifyIdsPlan = Refusable<{
  column: string
  direction: string
  /** Present exactly when the direction adds a prefix — possibly empty, which is still passed. */
  prefix?: string
  /**
   * Where a stripped id goes, when somewhere other than back into its column. Through the node's
   * own `qualifyTarget`, not the typed name: it suffixes a name the table already has where both
   * languages would overwrite — `relabelTarget`'s reason, one node over.
   */
  into?: string
}>

export function qualifyIdsPlan(ctx: TableContext): QualifyIdsPlan {
  const column = ctx.column('column')
  if (!column) return { refusal: 'This Qualify Ids has no id column chosen.' }
  const direction = String(ctx.params.direction)
  const into = qualifyTarget(ctx.schema('in'), String(ctx.params.into))
  return {
    column,
    direction,
    prefix: direction === 'add' ? String(ctx.params.prefix).trim() : undefined,
    into: direction === 'remove' && into ? into : undefined,
  }
}

// ---------------------------------------------------------------------------
// Table from URL
// ---------------------------------------------------------------------------

export type TableFromUrlPlan = Refusable<{
  /** The link as pasted, which the note names when it differs from `url`. */
  typed: string
  /**
   * What is read — `rawFileUrl`, since a reader pointed at a github.com file page reads the
   * page's HTML rather than failing. The note saying so names each language's reader.
   */
  url: string
}>

export function tableFromUrlPlan(params: ParamValues): TableFromUrlPlan {
  const typed = String(params.url).trim()
  if (!typed) return { refusal: 'This Table from URL node has no URL.' }
  return { typed, url: rawFileUrl(typed) }
}
