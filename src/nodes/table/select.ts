import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { selectSchema, selectTable } from '../lib/tableOps'

export const selectNode = registerNode({
  type: 'core.select',
  label: 'Select Columns',
  category: 'transform',
  description: 'Keep only the chosen columns, in the chosen order.',
  guide:
    'Keep only the columns you name, in the order you name them. Mostly for tidying a table before export or before a chart, where forty columns of neuPrint metadata get in the way of the four that matter. An empty selection means every column, so an unconfigured node passes its input through rather than emitting nothing.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [{ id: 'columns', kind: 'columns', label: 'Columns', from: 'in', default: [] }],

  inferOutputs: (ctx) => {
    const schema = selectSchema(ctx.schema('in'), ctx.columns('columns'))
    return { out: schema ? T.table(schema) : T.table() }
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    // No selection means pass everything through, which keeps a freshly-added node inert
    // instead of producing an empty table.
    return { out: selectTable(table, ctx.columns('columns')) }
  },
})
