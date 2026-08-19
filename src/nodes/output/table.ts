import { registerNode } from '../../core/registry'
import { T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'

/**
 * Terminal viewer for tabular data.
 *
 * Passes its input straight through so viewers can be dropped mid-chain to inspect
 * intermediate results without breaking the graph — the `out.*` nodes are taps, not
 * dead ends. The UI renders whatever is in this node's output cache.
 */
export const tableViewNode = registerNode({
  type: 'out.table',
  label: 'Table',
  category: 'visualisation',
  description: 'Show a table. Passes data through, so it can sit anywhere in the chain.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      id: 'pageSize',
      kind: 'enum',
      label: 'Rows / page',
      help: 'How many rows the viewer shows at a time. The data passes through intact.',
      default: '100',
      presentational: true,
      options: [
        { value: '25', label: '25' },
        { value: '50', label: '50' },
        { value: '100', label: '100' },
        { value: '500', label: '500' },
      ],
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
    return { out: table }
  },
})
