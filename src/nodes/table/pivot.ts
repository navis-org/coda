import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { AggFn } from '../lib/tableOps'
import { AGG_OPTIONS, matrixToTable, pivotTable } from '../lib/tableOps'

/**
 * Long table -> labelled matrix, and the same pivot as a wide table. The general route to a
 * heatmap from any table, e.g. connectivity pivoted preType × postType.
 *
 * **Two outputs of one pivot, not two pivots.** `Table` is `Matrix` reshaped — same
 * aggregation, same labels, same order — so the picture and the numbers beside it can never
 * disagree. A `Matrix` is what the heatmap and `Normalize` take and is what this node has
 * always emitted; it is also a dead end for every ordinary table op, since a matrix carries
 * no schema. The wide form is what makes a pivot sortable, filterable, joinable and
 * exportable as the CSV somebody actually wants, without a second node in between.
 *
 * `Matrix` stays first: it keeps its socket position in every saved graph, it is what a link
 * dragged off the node starts from, and it is the output the footer summarises.
 *
 * **The wide schema is observed, not derived**, which is the one thing here that needs
 * arguing. Its columns *are* the distinct values of the Columns field, so nothing short of
 * reading the data can name them and `inferOutputs` may not fetch (invariant 2). That is
 * exactly what `observesOutputSchema` is for — the same standing as Raw Cypher, and the same
 * lifetime: unknown-shaped until the first run and again after a reload, which reads
 * downstream as "columns unknown" rather than as a table with none.
 */
export const pivotNode = registerNode({
  type: 'core.pivot',
  label: 'Pivot',
  category: 'transform',
  description:
    'Reshape a long table into a matrix of rows × columns, as a matrix and a wide table.',
  guide:
    'Reshape a long table into rows × columns — the step between a connectivity result and a heatmap. It emits both shapes of the same pivot: a Matrix for the Heatmap and Normalize, and the same thing wide as an ordinary Table, which is what makes a pivot sortable, filterable and exportable without a second node. The wide table’s columns are the distinct values of the Columns field, so nothing can name them until it has run once.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [
    { id: 'matrix', label: 'Matrix', type: T.matrix() },
    { id: 'table', label: 'Table', type: T.table() },
  ],
  observesOutputSchema: true,
  params: [
    { id: 'rows', kind: 'column', label: 'Rows', from: 'in', default: '' },
    { id: 'columns', kind: 'column', label: 'Columns', from: 'in', default: '' },
    { id: 'agg', kind: 'enum', label: 'Aggregate', default: 'sum', options: AGG_OPTIONS },
    {
      id: 'value',
      kind: 'column',
      label: 'Of column',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: '',
      visibleIf: (params) => params.agg !== 'count',
    },
  ],

  inferOutputs: (ctx) => ({ matrix: T.matrix(), table: T.table(ctx.observed) }),

  validate: (ctx) => {
    const issues: string[] = []
    const rows = ctx.column('rows')
    const cols = ctx.column('columns')
    if (rows && cols && rows === cols) {
      issues.push('Rows and Columns point at the same column')
    }
    const agg = String(ctx.params.agg ?? 'sum') as AggFn
    if (agg !== 'count' && !ctx.column('value'))
      issues.push(`"${agg}" needs a numeric value column`)
    return issues
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    const rows = ctx.column('rows')
    const cols = ctx.column('columns')
    if (!rows || !cols) throw new Error('Pick both a row and a column field')
    /*
     * A refusal rather than the warning `validate` already carries, because a field pivoted
     * against itself can only be a diagonal — there is no partial result worth returning.
     *
     * It used to be reachable by accident: `Columns` named a property discovery had not
     * published yet, `resolveColumn` substituted the first column, and that was already what
     * `Rows` had resolved to. `resolveColumn` keeps a chosen column now, so reaching this
     * means somebody really did pick the same field twice.
     */
    if (rows === cols) {
      throw new Error(
        `Rows and Columns are both "${rows}", which pivots the field against itself and can ` +
          'only produce a diagonal. Pick a different Columns field — if the one you chose is ' +
          'missing, the node says so above.',
      )
    }
    const agg = String(ctx.params.agg ?? 'sum') as AggFn
    const matrix = pivotTable(
      table,
      rows,
      cols,
      agg === 'count' ? undefined : ctx.column('value'),
      agg,
    )
    return { matrix, table: matrixToTable(matrix, rows) }
  },
})
