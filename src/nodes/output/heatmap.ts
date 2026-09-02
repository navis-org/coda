/**
 * Heatmap: a matrix as a grid of coloured cells, in an order somebody chose.
 *
 * Two halves, and the split is the node's whole design. **Colour is presentational** — scale,
 * palette, printed values — and never enters the provenance key, so restyling a four-million-
 * cell picture is a repaint. **Order is data**: the `Order` tab reorders the matrix this node
 * *outputs*, so a Table beside the heatmap, the CSV export and the notebook all show what the
 * card shows. That is why the tab says downstream nodes go stale, and why the sort params are
 * not `presentational`.
 *
 * The clustering order is the one thing here that crosses the Python bridge, and it is the
 * clustermap's clustering rather than the Linkage node's: rows as vectors across the columns,
 * distances between vectors, leaf order. A node that stays `cheap` with a Pyodide call in it is
 * a real decision (invariant 6) and this one is made on purpose — the call is local, it runs
 * only when `clustering` is chosen, and a heatmap that needed a Run to sort itself would be a
 * viewer that stopped being live the moment somebody asked it to be useful. The first use
 * pays Pyodide's boot; after any NBLAST or Linkage it is milliseconds.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { EvalContext, ParamValues } from '../../core/node'
import type { MatrixValue } from '../../core/values'
import { isMatrixValue } from '../../core/values'
import { runClusterOrder } from '../../pyodide/linkage'
import {
  DIVERGING_PALETTE_OPTIONS,
  SEQUENTIAL_PALETTE_OPTIONS,
} from '../lib/heatmapParams'
import {
  LINKAGE_METHODS,
  checkClusterInput,
  warnUnrecordedCells,
} from '../lib/linkageOps'
import type { MatrixAxis, MatrixOrderOptions } from '../lib/matrixOrder'
import {
  CLUSTER_METRIC_OPTIONS,
  SORT_AXIS_OPTIONS,
  SORT_BY_OPTIONS,
  applyOrderPlan,
  labelsOf,
  orderAxis,
  orderPlan,
  readOrderOptions,
  reverseOrder,
} from '../lib/matrixOrder'

/** Whether an order has been chosen at all — the four Order controls hang off this. */
const ordering = (p: ParamValues): boolean => p.sortBy !== 'none'

export const heatmapNode = registerNode({
  type: 'out.heatmap',
  label: 'Heatmap',
  category: 'visualisation',
  description: 'Render a matrix as a heatmap.',
  guide:
    'A matrix drawn as a grid of coloured cells — the natural end of Adjacency or Pivot. Sequential for counts and fractions, diverging when zero is a meaningful middle, as it is after a log-ratio. The Order tab sorts rows and columns — by total, by name, by one row or column, or by clustering — and the sorted matrix is what the node outputs.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Matrix', type: T.matrix() }],
  outputs: [{ id: 'out', label: 'Matrix', type: T.matrix() }],
  paramGroups: [
    { id: 'colour', label: 'Colour' },
    { id: 'order', label: 'Order', affectsData: true },
  ],
  params: [
    {
      id: 'scale',
      kind: 'enum',
      label: 'Colour scale',
      default: 'sequential',
      presentational: true,
      group: 'colour',
      options: [
        { value: 'sequential', label: 'sequential' },
        { value: 'diverging', label: 'diverging (0 centred)' },
      ],
    },
    /*
     * One palette per scale rather than one list for both: a diverging ramp has a middle and a
     * sequential one does not, so the two lists cannot mix, and a separate param is what lets a
     * choice survive toggling the scale and back. `visibleIf` keeps exactly one on screen and,
     * being excluded from the key by `presentational` anyway, costs nothing in provenance.
     */
    {
      id: 'palette',
      kind: 'enum',
      label: 'Palette',
      default: 'coda',
      presentational: true,
      group: 'colour',
      options: SEQUENTIAL_PALETTE_OPTIONS,
      visibleIf: (p) => p.scale !== 'diverging',
      help:
        'Coda blue is the validated ramp and reverses with the theme so an empty cell always ' +
        'recedes into the surface. The rest are matplotlib’s and seaborn’s, drawn as published ' +
        '— dark end low — on both themes, and named the same way in the exported notebook.',
    },
    {
      id: 'divergingPalette',
      kind: 'enum',
      label: 'Palette',
      default: 'coda',
      presentational: true,
      group: 'colour',
      options: DIVERGING_PALETTE_OPTIONS,
      visibleIf: (p) => p.scale === 'diverging',
      help:
        'Coda’s pair puts blue on the negative arm. The ColorBrewer sets run as published — ' +
        'RdBu has red at the negative end — so the name means what it means everywhere else.',
    },
    {
      id: 'showValues',
      kind: 'boolean',
      label: 'Show values',
      help: 'Only legible on small matrices; the viewer hides them automatically when cells get too small.',
      default: false,
      presentational: true,
      group: 'colour',
    },

    // --- order ------------------------------------------------------------
    {
      id: 'sortBy',
      kind: 'enum',
      label: 'Order by',
      default: 'none',
      group: 'order',
      options: SORT_BY_OPTIONS,
      help:
        'Reorders the matrix this node outputs, not just the picture, so a Table or a Linkage ' +
        'downstream sees the same order. Total is the sum of each row or column; one row or ' +
        'column sorts the other axis by that line’s values; clustering is seaborn’s clustermap ' +
        '— each row as a vector across the columns, nearest together. For clustering a score ' +
        'matrix by its own scores, use Linkage → Ordered instead.',
    },
    {
      id: 'sortKey',
      kind: 'string',
      label: 'Row or column',
      default: '',
      placeholder: 'a label',
      group: 'order',
      visibleIf: (p) => p.sortBy === 'value',
      help:
        'Ordering rows, the column whose values decide; ordering columns, the row. Typed, ' +
        'because a matrix’s labels are decided by the run. A label the matrix does not have ' +
        'leaves that axis as it arrived and says so on the card.',
    },
    {
      id: 'sortAxis',
      kind: 'enum',
      label: 'Apply to',
      default: 'rows',
      advanced: true,
      group: 'order',
      options: SORT_AXIS_OPTIONS,
      visibleIf: ordering,
      help: 'Which axis the criterion runs on. Both sorts each axis on its own.',
    },
    {
      id: 'sortFollow',
      kind: 'boolean',
      label: 'Other axis follows',
      default: true,
      advanced: true,
      group: 'order',
      visibleIf: (p) => ordering(p) && p.sortAxis !== 'both',
      help:
        'The other axis takes the same order, matched by label — on a square matrix over one ' +
        'population that keeps the diagonal on the diagonal. Labels the sorted axis does not ' +
        'have keep their place after them, so on a matrix whose axes share no labels this ' +
        'changes nothing.',
    },
    {
      id: 'sortReverse',
      kind: 'boolean',
      label: 'Reverse',
      default: false,
      advanced: true,
      group: 'order',
      visibleIf: ordering,
    },
    {
      id: 'clusterMethod',
      kind: 'enum',
      label: 'Linkage',
      default: 'average',
      advanced: true,
      group: 'order',
      options: LINKAGE_METHODS,
      visibleIf: (p) => p.sortBy === 'cluster',
      help: 'How the distance between two groups is measured. Average is seaborn’s default.',
    },
    {
      id: 'clusterMetric',
      kind: 'enum',
      label: 'Distance',
      default: 'euclidean',
      advanced: true,
      group: 'order',
      options: CLUSTER_METRIC_OPTIONS,
      visibleIf: (p) => p.sortBy === 'cluster',
      help:
        'How two rows are compared. Euclidean is seaborn’s default and is swayed by how much a ' +
        'row connects; correlation and cosine compare the shape of its profile instead. A row ' +
        'with nothing in it is unlike everything and lands at the end.',
    },
  ],

  evaluate: async (ctx) => {
    const matrix = ctx.input('in')
    if (!isMatrixValue(matrix)) throw new Error('Input is not a matrix')

    const options = readOrderOptions(ctx.params)
    if (options.by === 'none') return { out: matrix }

    const plan = orderPlan(options)
    // Once, not per axis: it walks every cell and the answer is the same for both.
    if (options.by === 'cluster') warnUnrecordedCells(ctx, matrix)
    const orders: Partial<Record<MatrixAxis, Int32Array>> = {}
    for (const axis of plan.lead) {
      if (options.by === 'cluster') {
        const order = await clusterAxis(ctx, matrix, axis, options)
        if (order) orders[axis] = order
        continue
      }
      const result = orderAxis(matrix, axis, options)
      if (result.order) orders[axis] = result.order
      else ctx.warn(result.problem)
    }
    return { out: applyOrderPlan(matrix, plan, orders) }
  },
})

/** One axis in clustermap order, or nothing to do for an axis with fewer than two lines. */
async function clusterAxis(
  ctx: Pick<EvalContext, 'warn' | 'progress' | 'signal'>,
  matrix: MatrixValue,
  axis: MatrixAxis,
  options: MatrixOrderOptions,
): Promise<Int32Array | undefined> {
  const n = labelsOf(matrix, axis).length
  if (n < 2) return undefined
  // Warns and refuses *before* anything is marshalled, which is where a warning is useful.
  checkClusterInput(ctx, matrix, axis)
  ctx.progress(0.01, `clustering ${n.toLocaleString()} ${axis}`)
  const order = await runClusterOrder(
    {
      // A copy: `callPython` transfers the buffer and this one is the upstream node's result.
      values: new Float64Array(matrix.values),
      rows: matrix.rowLabels.length,
      cols: matrix.colLabels.length,
      axis,
      method: options.method,
      metric: options.metric,
    },
    { onProgress: ctx.progress, signal: ctx.signal },
  )
  return options.reverse ? reverseOrder(order) : order
}
