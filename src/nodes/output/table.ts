import { registerNode } from '../../core/registry'
import { T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { decodeClauses, filterTableByClauses, resolveFilters } from '../lib/tableFilter'

/**
 * Terminal viewer for tabular data.
 *
 * Passes its input straight through so viewers can be dropped mid-chain to inspect
 * intermediate results without breaking the graph — the `out.*` nodes are taps, not
 * dead ends. The UI renders whatever is in this node's output cache.
 *
 * ## Two ports, and only one of them is the tap
 *
 * `Table` is the pass-through and is what makes this a viewer. `Filtered` carries the rows
 * the header filters kept, which makes this the second viewer here — after `out.network` —
 * that stops being purely a tap. The `filters` param is therefore **not** presentational: it
 * changes what a port returns, so it belongs in the provenance key.
 *
 * Note what that costs, because it is not visible from the port that pays it. A cache key is
 * one per *node*, so editing a filter invalidates this node whole and stales everything
 * downstream of **both** ports — including a chain hanging off `Table`, whose bytes did not
 * change. That is the same bill `out.network`'s filters settle, taken for the same reason: a
 * port that quietly disagreed with the picture beside it would be worse.
 *
 * Sorting stays view-only and is deliberately not part of this. Clicking a column header is a
 * *reading* gesture — the cheapest thing anyone does to a table — and putting it in the
 * provenance key would stale the graph every time somebody looked at their data a different
 * way. The caption says which of the two is which.
 */
export const tableViewNode = registerNode({
  type: 'out.table',
  label: 'Table',
  category: 'visualisation',
  description: 'Show a table. Passes data through, so it can sit anywhere in the chain.',
  guide:
    'The plain view: rows and columns, sortable, paged, exportable as CSV. Like every viewer here it passes its input straight through, so it can be dropped into the middle of a chain to see what is actually on a wire without breaking anything downstream. Sorting is view-only and costs no run; the per-column filters under the headers are not, and what they keep leaves by the second port — type >10 under a count, LC under a type, ~^LC[0-9]+$ for a regex.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [
    { id: 'out', label: 'Table', type: T.table() },
    /*
     * Second, so every graph saved before this keeps its socket position and a link dragged
     * off the node still starts at the pass-through. Same call Explore's `All` and the wide
     * pivot's `Table` both make.
     */
    { id: 'filtered', label: 'Filtered', type: T.table() },
  ],
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
    {
      /*
       * One param for every column's filter, because the columns are not knowable when this
       * definition is written — a wide pivot names them after its data. `ids` is the kind for
       * an opaque list a viewer writes rather than a person types, which is exactly this; the
       * entries are `["column","expression"]` pairs, see `tableFilter.ts`.
       *
       * Not presentational, and not `internal` either: `internal` is for machinery a widget
       * keeps (a nonce, a pager), and this is somebody's decision about which rows they want.
       * It should be counted by the card's `… N more` line and clearable from the inspector.
       */
      id: 'filters',
      kind: 'ids',
      label: 'Filters',
      help: 'Per-column filters set from the table header. Each keeps the rows it matches; the Filtered port carries what survives all of them.',
      noun: 'filters',
      default: [],
    },
    {
      id: 'showFilters',
      kind: 'boolean',
      label: 'Show filter row',
      help: 'Show the filter fields under the column headers. Forced on whenever a filter is set, so a filtered table always says why.',
      default: false,
      advanced: true,
      // Whether the *controls* are on screen cannot change a byte of either port.
      presentational: true,
    },
  ],

  /*
   * Filtering never changes the schema or the kind — a subset of neurons is still neurons —
   * so both ports advertise exactly what arrived.
   */
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table(), filtered: T.table() }
    const type =
      input.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input))
    return { out: type, filtered: type }
  },

  /*
   * Reports what the filters could not do; never refuses over one. See `tableFilter.ts` —
   * a control nobody has finished typing has no business blocking the nodes downstream.
   */
  validate: (ctx) =>
    resolveFilters(schemaOf(ctx.inputs.in), decodeClauses(ctx.params.filters)).problems.map(
      (problem) => problem.message,
    ),

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    const { table: filtered } = filterTableByClauses(table, decodeClauses(ctx.params.filters))
    return { out: table, filtered }
  },
})
