import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'

export const barChartNode = registerNode({
  type: 'out.barChart',
  label: 'Bar Chart',
  category: 'visualisation',
  description: 'Bar chart of one numeric column, grouped by a category and optional series.',
  guide:
    'One numeric column, grouped by a category, optionally split into a series. The ordinary end of a Group By, and the fastest way to turn “synapses per partner type” into something you can read. Every knob on it is presentational, so restyling never marks anything stale.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      id: 'category',
      kind: 'column',
      label: 'Category',
      from: 'in',
      default: '',
      presentational: true,
    },
    {
      id: 'value',
      kind: 'column',
      label: 'Value',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: '',
      presentational: true,
    },
    {
      id: 'series',
      kind: 'column',
      label: 'Stack by',
      help: 'Optional second grouping, drawn as stacked segments.',
      from: 'in',
      default: '',
      presentational: true,
    },
    {
      id: 'useSeries',
      kind: 'boolean',
      label: 'Stacked',
      default: false,
      presentational: true,
    },
    {
      id: 'sortBars',
      kind: 'boolean',
      label: 'Sort by value',
      default: true,
      presentational: true,
    },
  ],

  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    return { out: T.table(schemaOf(input)) }
  },

  /**
   * Only what `validateColumnParams` cannot already say.
   *
   * "No numeric column available to plot" used to sit here beside the shared check's
   * "No columns of type i64/f64 available for \"Value\"", which is the same fact twice on one
   * badge — and it fired against a schema that had merely not arrived, since a `core.pivot`
   * upstream publishes none until it has run. The shared check now stays quiet there and this
   * one has nothing to add; what is left is the one thing it knows that the resolver does not.
   */
  validate: (ctx) => {
    if (!ctx.inputs.in || ctx.params.useSeries !== true) return []
    const series = ctx.column('series')
    return series && series === ctx.column('category')
      ? ['Stack-by and Category are the same column']
      : []
  },

  /**
   * Passes the table on whether or not there is anything to draw, and that is a fix rather
   * than a leniency — see invariant 5's corollary in CLAUDE.md.
   *
   * `out` is the input unchanged, so refusing because a picker is unset blocked every node
   * downstream for a reason that had nothing to do with them. It could not even be right
   * about it: `Pivot → Bar Chart` reloaded from a file resolves no columns until the pivot has
   * run, so the first Run failed on a table whose numeric column was sitting right there. The
   * warning above and the widget's own empty state are the right severity — the pipeline
   * works, the picture does not.
   */
  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    return { out: table }
  },
})
