/**
 * Which of a matrix's rows and columns survive, and in what order — the Heatmap node's
 * `Filter` and `Order` tabs.
 *
 * Headless, for `linkageOps.ts`'s reason: what is decidable without Python is decided here,
 * where a test can see it, and the one thing that is not — the clustering — arrives as an
 * `Int32Array` from the bridge and goes through exactly the same plan as every other order.
 *
 * ## Why these are node operations and not viewer settings
 *
 * Both **change the matrix the node outputs**, on purpose. A sort or a filter that lived in the
 * drawing alone would leave a Table wired beside the heatmap showing something different from
 * the picture, and a CSV export disagreeing with the SVG next to it. So both sets of params are
 * in the provenance key, the tabs that hold them say so, and a Linkage downstream sees the same
 * matrix the card draws.
 *
 * ## A filter and a sort are one mechanism
 *
 * Each is a list of matrix indices per axis, and `takeMatrix` is the single place a new matrix
 * is built from such a list — a filter keeps fewer lines, a sort keeps every line in another
 * order, and either may be absent. **The filter runs first**, and the sort is then computed
 * against the filtered matrix, because a row total taken over columns somebody has just
 * excluded is not the number they asked for.
 *
 * ## Two axes, one order
 *
 * A matrix from Adjacency is square over one population and usually **not symmetric**, so the
 * natural request is "sort the columns and put the rows in the same order" — otherwise the
 * diagonal wanders off and the picture stops being readable as a connectome. `followOrder` is
 * that: the other axis takes the leading axis's order **matched by label**, and any label the
 * leader does not have keeps its place after them. On a matrix whose two axes share no labels
 * (types down, regions across) following is a no-op, which is the honest answer rather than a
 * refusal.
 *
 * ## What each criterion means
 *
 * - `total` — the sum of the finite cells in that row or column, largest first. Puts the
 *   strongest partners in the corner. It is the plain sum, not a magnitude: the `Colour scale`
 *   is presentational and cannot be allowed to change the output.
 * - `label` — natural order of the names, so `LC4` comes before `LC10`.
 * - `value` — one row or column's values decide. Ordering rows, `key` names a **column**;
 *   ordering columns, it names a **row**. Typed rather than picked, because a matrix's labels
 *   are data decided by the run and the picker cannot know them at edit time. A key the matrix
 *   does not have leaves that axis alone and warns.
 * - `cluster` — seaborn's `clustermap`: each row is a vector across the columns, rows are
 *   clustered by the distance between those vectors, and the leaf order is the order. Not the
 *   Linkage node's clustering, which reads the matrix itself as the distances — that is the
 *   right tool for an NBLAST score matrix, and `Linkage → Ordered → Heatmap` already does it.
 *
 * `reverse` flips whichever order came out, and `NaN` sorts last under every criterion.
 */

import type { ParamValues } from '../../core/node'
import type { MatrixValue } from '../../core/values'
import { makeMatrix } from '../../core/values'
import { bareRegex, regexError } from './neuronSearch'

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * One row or column filter, parsed.
 *
 * ## The grammar is Explore's, narrowed to one term
 *
 *   LC4              substring, case-insensitive
 *   /^LC[0-9]+$      regular expression, case-insensitive; the closing `/` is optional
 *   !LC4   -LC4      keep everything that does *not* match
 *
 * **A bare term is a literal and a pattern is opted into with `/`** — `neuronSearch.ts`'s rule,
 * and `bareRegex` is imported from there rather than restated, because the fiddly half is where
 * the pattern *ends*: `/^LC4$/` and `/^LC4$` are one filter, and a second reader of that rule is
 * how one box comes to search for a trailing slash. The reason for the opt-in is the same too:
 * cell-type labels are full of regex metacharacters — `LC4(R)`, `SMP001(a)` — so a box that
 * compiled every term would quietly match `LC4R` as well, and widening a filter by one row with
 * nothing on screen to say so is the failure this convention exists to prevent.
 *
 * There is deliberately **one term per axis**, where Explore's box takes several ANDed. Two
 * substrings ANDed against a single short label is almost always empty — `LC4 LC6` matches
 * nothing, which reads as a broken control — and the useful question there is an alternation,
 * which the regex already spells: `/^(LC4|LC6)$`.
 */
export interface LabelFilter {
  /** What was typed, for the message that says how much it removed. */
  source: string
  /**
   * The needle or the pattern, with the slashes and the negation taken off.
   *
   * Carried beside `test` rather than left inside its closure because the notebook exporters
   * have to render the same decision in pandas and in base R, and a second parse of the
   * grammar in each of them is how three readers come to disagree about `/^LC4$/`.
   */
  pattern: string
  /** Whether `pattern` is a regular expression rather than a literal substring. */
  regex: boolean
  negate: boolean
  test: (label: string) => boolean
}

export interface ParsedLabelFilter {
  /** Absent when nothing was typed, or when the pattern will not compile. */
  filter?: LabelFilter
  /** Why the pattern will not compile. The caller warns; the axis is then left whole. */
  error?: string
}

export function parseLabelFilter(query: string): ParsedLabelFilter {
  const source = query.trim()
  if (!source) return {}

  // A lone `!` or `-` narrows nothing, the way a lone `/` does: it is what the box holds while
  // somebody types a negation, and one term is the whole filter here — so reading it as the
  // literal Explore would read it empties the picture for a keystroke. A label that really does
  // contain a hyphen is still reachable as `/-`.
  if (source === '!' || source === '-') return {}

  let body = source
  let negate = false
  if (body.startsWith('!') || body.startsWith('-')) {
    negate = true
    body = body.slice(1)
  }

  if (body.startsWith('/')) {
    const pattern = bareRegex(body)
    // `/` alone narrows nothing rather than erroring, exactly as it does in Explore's box.
    if (!pattern) return {}
    const bad = regexError(pattern)
    if (bad) return { error: bad }
    // Case-insensitive by flag rather than by lowercasing the pattern, which would turn
    // `[A-Z]` into a different question.
    const expression = new RegExp(pattern, 'i')
    return {
      filter: {
        source,
        pattern,
        regex: true,
        negate,
        test: (label) => expression.test(label) !== negate,
      },
    }
  }

  const needle = body.toLowerCase()
  return {
    filter: {
      source,
      pattern: body,
      regex: false,
      negate,
      test: (label) => label.toLowerCase().includes(needle) !== negate,
    },
  }
}

/** The indices of the labels a filter keeps, in their own order. */
export function keptLabels(labels: string[], filter: LabelFilter): Int32Array {
  const kept: number[] = []
  for (let i = 0; i < labels.length; i++) if (filter.test(labels[i]!)) kept.push(i)
  return Int32Array.from(kept)
}

export interface MatrixFilterOptions {
  rows: string
  columns: string
}

/** One reader of the two filter params, so the node, the exporters and the tests agree. */
export function readFilterOptions(params: ParamValues): MatrixFilterOptions {
  return {
    rows: typeof params.rowFilter === 'string' ? params.rowFilter.trim() : '',
    columns: typeof params.colFilter === 'string' ? params.colFilter.trim() : '',
  }
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export type MatrixSortBy = 'none' | 'total' | 'label' | 'value' | 'cluster'
export type MatrixSortAxis = 'rows' | 'columns' | 'both'
export type MatrixAxis = 'rows' | 'columns'
export type ClusterMetric = 'euclidean' | 'correlation' | 'cosine'

export const SORT_BY_OPTIONS: Array<{ value: MatrixSortBy; label: string }> = [
  { value: 'none', label: 'as they arrive' },
  { value: 'total', label: 'total, largest first' },
  { value: 'label', label: 'label, A → Z' },
  { value: 'value', label: 'one row or column' },
  { value: 'cluster', label: 'clustering' },
]

export const SORT_AXIS_OPTIONS: Array<{ value: MatrixSortAxis; label: string }> = [
  { value: 'rows', label: 'rows' },
  { value: 'columns', label: 'columns' },
  { value: 'both', label: 'both, independently' },
]

/**
 * How two vectors are compared when clustering. `euclidean` is seaborn's default; correlation
 * and cosine ignore how *much* a neuron connects and compare the shape of its profile, which is
 * usually what "similar connectivity" means.
 */
export const CLUSTER_METRIC_OPTIONS: Array<{ value: ClusterMetric; label: string }> = [
  { value: 'euclidean', label: 'euclidean' },
  { value: 'correlation', label: 'correlation' },
  { value: 'cosine', label: 'cosine' },
]

export interface MatrixOrderOptions {
  by: MatrixSortBy
  axis: MatrixSortAxis
  /** The other axis takes the leading axis's order, matched by label. */
  follow: boolean
  reverse: boolean
  /** For `value`: the column (ordering rows) or row (ordering columns) whose values decide. */
  key: string
  method: string
  metric: ClusterMetric
}

/** One reader of the params, so the node, the exporters and the tests agree on the defaults. */
export function readOrderOptions(params: ParamValues): MatrixOrderOptions {
  const by = params.sortBy
  const axis = params.sortAxis
  const metric = params.clusterMetric
  return {
    by: isSortBy(by) ? by : 'none',
    axis: axis === 'columns' || axis === 'both' ? axis : 'rows',
    follow: params.sortFollow !== false,
    reverse: params.sortReverse === true,
    key: typeof params.sortKey === 'string' ? params.sortKey.trim() : '',
    method: typeof params.clusterMethod === 'string' ? params.clusterMethod : 'average',
    metric: metric === 'correlation' || metric === 'cosine' ? metric : 'euclidean',
  }
}

function isSortBy(value: unknown): value is MatrixSortBy {
  return SORT_BY_OPTIONS.some((o) => o.value === value)
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface OrderPlan {
  /** Axes ordered by the criterion itself. */
  lead: MatrixAxis[]
  /** The axis that copies the (single) leader's order by label, if any. */
  follower?: MatrixAxis
}

/** Which axes the criterion runs on, and which one copies. `both` never follows. */
export function orderPlan(options: Pick<MatrixOrderOptions, 'axis' | 'follow'>): OrderPlan {
  if (options.axis === 'both') return { lead: ['rows', 'columns'] }
  const other: MatrixAxis = options.axis === 'rows' ? 'columns' : 'rows'
  return options.follow ? { lead: [options.axis], follower: other } : { lead: [options.axis] }
}

export function labelsOf(matrix: MatrixValue, axis: MatrixAxis): string[] {
  return axis === 'rows' ? matrix.rowLabels : matrix.colLabels
}

// ---------------------------------------------------------------------------
// The criteria
// ---------------------------------------------------------------------------

/** Sum of the finite cells down each row or across each column. */
export function axisTotals(matrix: MatrixValue, axis: MatrixAxis): Float64Array {
  const rows = matrix.rowLabels.length
  const cols = matrix.colLabels.length
  const totals = new Float64Array(axis === 'rows' ? rows : cols)
  const values = matrix.values
  for (let r = 0; r < rows; r++) {
    const start = r * cols
    for (let c = 0; c < cols; c++) {
      const v = values[start + c]!
      if (!Number.isFinite(v)) continue
      totals[axis === 'rows' ? r : c]! += v
    }
  }
  return totals
}

/**
 * The values along one row or column, by the label of that row or column.
 *
 * Ordering rows, the key names a column and the result has one entry per row; ordering
 * columns, the other way about. `undefined` when the label is not there, which the caller turns
 * into a warning rather than a throw — an unmet picker is not grounds for blocking the graph
 * (invariant 5's corollary, applied to a typed key).
 */
export function axisVector(
  matrix: MatrixValue,
  axis: MatrixAxis,
  key: string,
): Float64Array | undefined {
  const rows = matrix.rowLabels.length
  const cols = matrix.colLabels.length
  if (axis === 'rows') {
    const c = matrix.colLabels.indexOf(key)
    if (c < 0) return undefined
    const out = new Float64Array(rows)
    for (let r = 0; r < rows; r++) out[r] = matrix.values[r * cols + c]!
    return out
  }
  const r = matrix.rowLabels.indexOf(key)
  if (r < 0) return undefined
  return matrix.values.slice(r * cols, r * cols + cols)
}

/**
 * Indices in descending order of score — stable, so equal totals keep their arrival order and
 * a re-run cannot shuffle ties — with anything non-finite last.
 */
export function orderByScores(scores: Float64Array, descending = true): Int32Array {
  const index = Array.from({ length: scores.length }, (_, i) => i)
  const sign = descending ? -1 : 1
  index.sort((a, b) => {
    const x = scores[a]!
    const y = scores[b]!
    const xf = Number.isFinite(x)
    const yf = Number.isFinite(y)
    if (xf !== yf) return xf ? -1 : 1
    if (!xf) return a - b
    return x === y ? a - b : sign * (x < y ? -1 : 1)
  })
  return Int32Array.from(index)
}

const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Natural order of the labels: `LC4` before `LC10`, case ignored, ties by arrival. */
export function labelOrder(labels: string[]): Int32Array {
  const index = Array.from({ length: labels.length }, (_, i) => i)
  index.sort((a, b) => NATURAL.compare(labels[a]!, labels[b]!) || a - b)
  return Int32Array.from(index)
}

export function reverseOrder(order: Int32Array): Int32Array {
  const out = new Int32Array(order.length)
  for (let i = 0; i < order.length; i++) out[i] = order[order.length - 1 - i]!
  return out
}

/**
 * The follower's order: the leader's labels, in the leader's new order, wherever the follower
 * has them — then everything the leader did not name, in the order it already had.
 *
 * Matched by label rather than by index, because "the same order" on a square matrix means the
 * same *neuron* in row 3 and column 3, and index-matching would silently do something else on
 * any matrix whose axes are not the identical list.
 */
export function followOrder(leadLabels: string[], followerLabels: string[]): Int32Array {
  const where = new Map<string, number[]>()
  followerLabels.forEach((label, i) => {
    const hits = where.get(label)
    if (hits) hits.push(i)
    else where.set(label, [i])
  })
  const taken = new Uint8Array(followerLabels.length)
  const out: number[] = []
  for (const label of leadLabels) {
    const hits = where.get(label)
    if (!hits) continue
    for (const i of hits) {
      if (taken[i]) continue
      taken[i] = 1
      out.push(i)
    }
  }
  for (let i = 0; i < followerLabels.length; i++) if (!taken[i]) out.push(i)
  return Int32Array.from(out)
}

function isIdentityOrder(order: Int32Array): boolean {
  for (let i = 0; i < order.length; i++) if (order[i] !== i) return false
  return true
}

/**
 * One axis's order under every criterion that needs no Python — `cluster` is the node's to
 * fetch and hand to `applyOrderPlan`. `undefined` means "leave it as it is", and comes with
 * the reason, which the caller puts on the card.
 */
export function orderAxis(
  matrix: MatrixValue,
  axis: MatrixAxis,
  options: Pick<MatrixOrderOptions, 'by' | 'key' | 'reverse'>,
): { order: Int32Array } | { order: undefined; problem: string } {
  const labels = labelsOf(matrix, axis)
  let order: Int32Array
  switch (options.by) {
    case 'total':
      order = orderByScores(axisTotals(matrix, axis))
      break
    case 'label':
      order = labelOrder(labels)
      break
    case 'value': {
      if (!options.key) {
        return {
          order: undefined,
          problem: `Ordering ${axis} by one ${axis === 'rows' ? 'column' : 'row'} needs its label — type one under Order.`,
        }
      }
      const vector = axisVector(matrix, axis, options.key)
      if (!vector) {
        return {
          order: undefined,
          problem: `No ${axis === 'rows' ? 'column' : 'row'} is called "${options.key}", so the ${axis} are left as they arrived.`,
        }
      }
      order = orderByScores(vector)
      break
    }
    default:
      return { order: undefined, problem: `Nothing here orders by "${options.by}"` }
  }
  return { order: options.reverse ? reverseOrder(order) : order }
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

/**
 * The matrix rebuilt from a list of row indices and a list of column indices.
 *
 * **The one place a reshaped matrix is built**, which is what lets a filter and a sort be the
 * same mechanism: an index list may keep every line in a new order (a sort), fewer lines in
 * their own order (a filter), or both at once. Either list may be absent, meaning that axis is
 * taken whole. Labels travel with their lines, and `valueLabel` and `measure` ride through.
 *
 * Returns the input untouched when neither list changes anything, so an unfiltered, unsorted
 * pass allocates nothing.
 */
export function takeMatrix(
  matrix: MatrixValue,
  rowIndices?: Int32Array,
  colIndices?: Int32Array,
): MatrixValue {
  const sourceCols = matrix.colLabels.length
  checkIndices(rowIndices, matrix.rowLabels.length, 'row')
  checkIndices(colIndices, sourceCols, 'column')
  if (isWholeAxis(rowIndices, matrix.rowLabels.length) && isWholeAxis(colIndices, sourceCols)) {
    return matrix
  }
  const rows = rowIndices ? rowIndices.length : matrix.rowLabels.length
  const cols = colIndices ? colIndices.length : sourceCols
  const values = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r++) {
    const from = (rowIndices ? rowIndices[r]! : r) * sourceCols
    const to = r * cols
    if (colIndices) {
      for (let c = 0; c < cols; c++) values[to + c] = matrix.values[from + colIndices[c]!]!
    } else {
      values.set(matrix.values.subarray(from, from + cols), to)
    }
  }
  const rowLabels = rowIndices
    ? Array.from(rowIndices, (i) => matrix.rowLabels[i]!)
    : matrix.rowLabels
  const colLabels = colIndices
    ? Array.from(colIndices, (i) => matrix.colLabels[i]!)
    : matrix.colLabels
  return makeMatrix(rowLabels, colLabels, values, matrix.valueLabel, matrix.measure)
}

/**
 * An index outside the matrix is a programming error rather than a user one, so it throws —
 * left alone it reads `undefined` through a non-null assertion, i.e. a matrix quietly full of
 * `NaN` with nothing to say where it came from.
 */
function checkIndices(indices: Int32Array | undefined, limit: number, what: string): void {
  if (!indices) return
  for (const i of indices) {
    if (i < 0 || i >= limit) {
      throw new Error(`takeMatrix: ${what} index ${i} is outside a matrix of ${limit}`)
    }
  }
}

/** Whether a list takes an axis exactly as it stands — every line, in order. */
function isWholeAxis(indices: Int32Array | undefined, length: number): boolean {
  if (!indices) return true
  return indices.length === length && isIdentityOrder(indices)
}

/**
 * The plan, carried out: the leading orders as given, the follower derived from the leader's
 * *new* labels. A leading axis with no order (a key that was not found) is left as it is, and
 * so, then, is anything that was to follow it.
 */
export function applyOrderPlan(
  matrix: MatrixValue,
  plan: OrderPlan,
  orders: Partial<Record<MatrixAxis, Int32Array>>,
): MatrixValue {
  const rowOrder = orders.rows
  const colOrder = orders.columns
  const chosen: Partial<Record<MatrixAxis, Int32Array>> = {}
  if (rowOrder) chosen.rows = rowOrder
  if (colOrder) chosen.columns = colOrder

  if (plan.follower && plan.lead.length === 1) {
    const leader = plan.lead[0]!
    const leadOrder = orders[leader]
    if (leadOrder) {
      const leadLabels = Array.from(leadOrder, (i) => labelsOf(matrix, leader)[i]!)
      chosen[plan.follower] = followOrder(leadLabels, labelsOf(matrix, plan.follower))
    }
  }
  return takeMatrix(matrix, chosen.rows, chosen.columns)
}
