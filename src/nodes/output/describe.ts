import { warnOverThreshold } from '../../core/limits'
import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { DESCRIBE_CELLS_WARN, describeSchema, describeTable } from '../lib/describeOps'
import { tapPorts } from '../lib/tapPorts'

/**
 * What is in this table? — asked of the columns rather than of the rows.
 *
 * The question somebody asks of an intermediate result before they trust it: which columns
 * arrived, how much of each one is actually filled in, how many distinct values it holds, and
 * what range the numbers cover. `out.table` answers it by showing the data, which works up to
 * the point where there are four thousand rows of it and the interesting fact is that one
 * column is 40% null.
 *
 * A **tap**, like every other viewer here: the input leaves by `Table` unchanged, so this drops
 * into the middle of a chain without breaking anything downstream. What is unusual is the
 * second port. `out.table`'s `Filtered` and `out.network`'s subset are both *the input, less
 * some of it*; `Summary` is a different table entirely — one row per column of the input — and
 * it is real data rather than a drawing, so it sorts, filters, joins and exports like anything
 * else. That is the whole reason it is a port: "which of my columns are half empty" is a
 * question with an answer worth keeping, not just worth looking at.
 *
 * **`cheap`, and the cost is real but ordinary.** No network, one pass over every cell, and a
 * sort per numeric column for the quartiles — comparable to dropping a couple of Sort nodes in
 * the chain, which are also `cheap`. `DESCRIBE_CELLS_WARN` is where that stops being free and
 * says so; it warns and goes ahead, because a count is almost never a question with no useful
 * answer (see docs/limits.md).
 *
 * **No settings at all.** There was a version of this with a Columns picker and a switch for
 * the quartiles, and both are the same mistake: the statistics are what the node *is*, so a
 * control that turns one off is a control that makes the card disagree with its own name. A
 * summary of some of the columns is a Select node upstream, which is where it already was.
 */
export const describeNode = registerNode({
  type: 'out.describe',
  label: 'Describe Table',
  category: 'visualisation',
  description: 'Per-column summary of a table: how much is filled in, and the numeric spread.',
  guide:
    'Summarises a table one row per column — the dtype, how many values are present, how many ' +
    'are missing, how many are distinct, and for numeric columns the non-zero count, the ' +
    'five-number spread and the mean. The table itself passes straight through, and the summary ' +
    'leaves by a second port as ordinary data you can sort, filter or export. Text and boolean ' +
    'columns get the counts and nothing else, and so does the neuronId column: a mean neuron id ' +
    'identifies no neuron, and on an 18-digit id it would not even be arithmetic over the ids.',
  cost: 'cheap',
  /*
   * Wider than the chart viewers and shorter than Profile: twelve narrow numeric columns, and
   * as many rows as the input has columns — which for a connectivity table is three and for an
   * annotation table is sixty, so the height is where somebody will reach for the handle.
   */
  defaultSize: { width: 620, height: 360 },
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [
    /*
     * First, so a link dragged off this node starts at the pass-through — `out.table`'s call,
     * for `out.table`'s reason, and it is also what the card's footer summary reports.
     */
    { id: 'out', label: 'Table', type: T.table() },
    { id: 'summary', label: 'Summary', type: T.table(describeSchema()) },
  ],

  /*
   * The tap preserves `neurons`-ness; the summary never has it. A row here is *about* a column
   * and has no `neuronId` of its own, so declaring it as neurons would offer it to Connectivity
   * and every other node that takes a neuron table — all of which would fail at run time on a
   * table whose id column is the string `"column"`.
   *
   * Both halves are exact before anything runs, which is the point of `describeSchema` being a
   * constant: a picker downstream of `Summary` fills the moment the wire is drawn.
   */
  inferOutputs: (ctx) => ({
    ...tapPorts(ctx.inputs.in, ['out']),
    summary: T.table(describeSchema()),
  }),

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')

    // At the top, before the pass — a warning that arrives after the wait describes something
    // that already happened. See docs/limits.md.
    const cells = table.length * table.schema.columns.length
    if (cells > DESCRIBE_CELLS_WARN) {
      warnOverThreshold(ctx, {
        count: cells,
        threshold: DESCRIBE_CELLS_WARN,
        unit: 'cells',
        control: 'the size a summary is usually taken over',
        cost: 'Every cell is read once and every numeric column is sorted for its quartiles.',
      })
    }

    return { out: table, summary: describeTable(table) }
  },
})
