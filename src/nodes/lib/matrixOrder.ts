/**
 * Putting a matrix's rows and columns in an order — the Heatmap node's `Order` tab.
 *
 * Headless, for `linkageOps.ts`'s reason: what is decidable without Python is decided here,
 * where a test can see it, and the one thing that is not — the clustering — arrives as an
 * `Int32Array` from the bridge and goes through exactly the same plan as every other order.
 *
 * ## Why this is a node operation and not a viewer setting
 *
 * The order **changes the matrix the node outputs**, on purpose. A sort that lived in the
 * drawing alone would leave a Table wired beside the heatmap showing a different order from
 * the picture, and a CSV export disagreeing with the SVG next to it. So the sort params are in
 * the provenance key, the tab that holds them says so, and a Linkage downstream sees the same
 * matrix the card draws.
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
 * The matrix with its rows and/or columns permuted. Either order may be absent, meaning that
 * axis stays put; labels travel with their lines, and `valueLabel` and `measure` ride through.
 */
export function permuteMatrix(
  matrix: MatrixValue,
  rowOrder?: Int32Array,
  colOrder?: Int32Array,
): MatrixValue {
  const rows = matrix.rowLabels.length
  const cols = matrix.colLabels.length
  if (rowOrder && rowOrder.length !== rows) {
    throw new Error(`permuteMatrix: ${rowOrder.length} row positions for ${rows} rows`)
  }
  if (colOrder && colOrder.length !== cols) {
    throw new Error(`permuteMatrix: ${colOrder.length} column positions for ${cols} columns`)
  }
  if ((!rowOrder || isIdentityOrder(rowOrder)) && (!colOrder || isIdentityOrder(colOrder))) {
    return matrix
  }
  const values = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r++) {
    const from = (rowOrder ? rowOrder[r]! : r) * cols
    const to = r * cols
    if (colOrder) {
      for (let c = 0; c < cols; c++) values[to + c] = matrix.values[from + colOrder[c]!]!
    } else {
      values.set(matrix.values.subarray(from, from + cols), to)
    }
  }
  const rowLabels = rowOrder ? Array.from(rowOrder, (i) => matrix.rowLabels[i]!) : matrix.rowLabels
  const colLabels = colOrder ? Array.from(colOrder, (i) => matrix.colLabels[i]!) : matrix.colLabels
  return makeMatrix(rowLabels, colLabels, values, matrix.valueLabel, matrix.measure)
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
  return permuteMatrix(matrix, chosen.rows, chosen.columns)
}
