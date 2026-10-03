import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { selectSchema, selectTable } from '../lib/tableOps'

registerNode({
  type: 'core.select',
  label: 'Select Columns',
  category: 'transform',
  description:
    'Keep only the chosen columns, in the chosen order. With none chosen, every column is kept.',
  guide:
    'Keeps only the columns you pick, in the order you pick them, e.g. to cut forty columns of neuPrint metadata down to the four you need before an export or a chart. With no columns picked, the table passes through unchanged.',
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
