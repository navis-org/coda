import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { AggFn } from '../lib/tableOps'
import { AGG_OPTIONS, groupBySchema, groupByTable } from '../lib/tableOps'

/**
 * Group rows and aggregate. The output schema is *computed*, which is the hardest case
 * for schema propagation and therefore the one most worth getting right: change the
 * aggregation from sum to mean and every downstream column picker updates, before
 * anything re-runs.
 *
 * Always emits `n` (rows per group) alongside the aggregate — you almost always want to
 * know whether a mean came from 2 rows or 200.
 */
export const groupByNode = registerNode({
  type: 'core.groupBy',
  label: 'Group By',
  category: 'transform',
  description:
    'Collapse rows into groups and aggregate a value column. The result carries the group ' +
    'columns, a row count named `n`, and the aggregate renamed `<agg>_<column>` — so ' +
    'summing `weight` gives `sum_weight`, not `weight`.',
  guide:
    'Collapse rows into groups and aggregate a value — synapses per cell type, mean size per class. The output schema is computed rather than copied, so switching sum to mean renames the column and every picker downstream follows before anything re-runs. It always emits n alongside the aggregate, because you nearly always want to know whether a mean came from two rows or two hundred.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    { id: 'by', kind: 'columns', label: 'Group by', from: 'in', default: [] },
    {
      id: 'agg',
      kind: 'enum',
      label: 'Aggregate',
      default: 'sum',
      options: AGG_OPTIONS,
    },
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

  inferOutputs: (ctx) => {
    const agg = String(ctx.params.agg ?? 'sum') as AggFn
    const by = ctx.columns('by')
    const value = agg === 'count' ? undefined : ctx.column('value')
    const schema = groupBySchema(ctx.schema('in'), by, value, agg)
    return { out: schema ? T.table(schema) : T.table() }
  },

  validate: (ctx) => {
    if (ctx.columns('by').length === 0 && ctx.inputs.in) {
      return ['Pick at least one column to group by']
    }
    const agg = String(ctx.params.agg ?? 'sum') as AggFn
    if (agg !== 'count' && !ctx.column('value')) {
      return [`"${agg}" needs a numeric value column`]
    }
    return []
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    const agg = String(ctx.params.agg ?? 'sum') as AggFn
    const by = ctx.columns('by')
    if (by.length === 0) throw new Error('No group-by columns selected')
    return {
      out: groupByTable(table, by, agg === 'count' ? undefined : ctx.column('value'), agg),
    }
  },
})
