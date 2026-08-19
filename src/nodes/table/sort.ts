import { registerNode } from '../../core/registry'
import { T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { sortTable } from '../lib/tableOps'

export const sortNode = registerNode({
  type: 'core.sort',
  label: 'Sort',
  category: 'transform',
  description: 'Order rows by a column, optionally keeping only the top N.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    { id: 'column', kind: 'column', label: 'By', from: 'in', default: '' },
    { id: 'descending', kind: 'boolean', label: 'Descending', default: true },
    {
      id: 'limit',
      kind: 'int',
      label: 'Top N',
      help: '0 keeps every row.',
      default: 0,
      min: 0,
      step: 5,
    },
  ],

  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    return {
      out: input.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)),
    }
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    const columnName = ctx.column('column')
    if (!columnName) throw new Error('No column selected')
    return {
      out: sortTable(
        table,
        columnName,
        ctx.params.descending !== false,
        Math.max(0, Number(ctx.params.limit ?? 0)),
      ),
    }
  },
})
