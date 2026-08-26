/**
 * Histogram node.
 *
 * The one-variable counterpart to Scatter Plot: where a scatter asks how two columns relate, a
 * histogram asks what one of them looks like — and that is the question somebody actually has
 * about a synapse count, a NBLAST score or a cable length. Two outputs, because a viewer is a
 * tap rather than a dead end: the table passes through, and `Selected` carries the rows in
 * whichever bars were clicked.
 *
 * **Binning is presentational; the value column is not.** That split is the whole design and it
 * is forced rather than chosen. A stored selection holds the *value ranges* the bars covered
 * (`chartSelection.ts`), so changing the bin count leaves it naming a range that no longer
 * lines up with a bar — honest, and cheap, and nothing downstream needs re-running. Changing
 * the **value column** is different: it changes which rows those same ranges catch, so it has
 * to be in the cache key or a stale result would survive it (invariant 4). Same call
 * `out.scatter` makes for `idColumn`.
 *
 * Note what is *not* on that list. `Log axis` drops values at or below zero from the drawing,
 * and `Max bins` reshapes it — neither touches `out`, which is the input table unchanged, and
 * neither can move a range that is already stored.
 */

import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { rowsInRanges } from '../lib/chartSelection'
import { tapPorts } from '../lib/tapPorts'

export const histogramNode = registerNode({
  type: 'out.histogram',
  label: 'Histogram',
  category: 'visualisation',
  description: 'Distribution of one numeric column, binned, optionally split into series.',
  guide:
    'One numeric column binned into bars — the fastest way to see whether a score, a synapse count or a cable length is bimodal, skewed or all one number. Bins are chosen by the Freedman–Diaconis rule unless you set a count; a log axis, a cumulative curve and percent or density scaling are all there. Click a bar to send those rows on as Selected, which is how you pull out a tail.',
  cost: 'cheap',
  // Measured in a browser rather than guessed: the params take the top of the card, and at
  // 340 the plot was a fifty-pixel strip under them.
  defaultSize: { width: 460, height: 420 },
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [
    { id: 'out', label: 'Table', type: T.table() },
    { id: 'selected', label: 'Selected', type: T.table() },
  ],
  params: [
    {
      id: 'value',
      kind: 'column',
      label: 'Value',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: '',
      // Not presentational: it decides which rows a selected range catches. See the header.
      help: 'The column to bin. Also what a selected bar means, so changing it re-runs anything downstream of Selected.',
    },
    {
      id: 'binMode',
      kind: 'enum',
      label: 'Bins',
      default: 'auto',
      options: [
        { value: 'auto', label: 'automatic' },
        { value: 'fixed', label: 'a fixed number' },
      ],
      help:
        'Automatic is the Freedman–Diaconis rule, capped at 80 — on a heavy-tailed integer ' +
        'column it would otherwise ask for thousands of mostly empty bars.',
      presentational: true,
    },
    {
      id: 'bins',
      kind: 'int',
      label: 'Bin count',
      default: 30,
      min: 2,
      max: 200,
      visibleIf: (params) => params.binMode === 'fixed',
      presentational: true,
    },
    {
      id: 'series',
      kind: 'column',
      label: 'Split by',
      help: 'Optional second grouping, drawn as stacked segments within each bar.',
      from: 'in',
      default: '',
      optional: true,
      presentational: true,
    },
    {
      id: 'logX',
      kind: 'boolean',
      label: 'Log axis',
      help:
        'Synapse counts and connection weights span orders of magnitude, where linear bins ' +
        'pile most of the data into the first one. Values at or below zero have no logarithm ' +
        'and are dropped; the caption says how many.',
      default: false,
      presentational: true,
      advanced: true,
    },
    {
      id: 'normalize',
      kind: 'enum',
      label: 'Scale',
      default: 'count',
      options: [
        { value: 'count', label: 'row count' },
        { value: 'percent', label: 'percent of rows' },
        { value: 'density', label: 'density' },
      ],
      help:
        'Density divides each bar by its own width, which is the only scaling that stays ' +
        'comparable when a log axis makes the bars unequal.',
      presentational: true,
      advanced: true,
    },
    {
      id: 'cumulative',
      kind: 'boolean',
      label: 'Cumulative',
      default: false,
      // Hidden rather than disabled under density, because a cumulative density is not a
      // quantity anybody wants — and a hidden param is out of the cache key, so the pair
      // cannot leave a stale value behind either.
      visibleIf: (params) => params.normalize !== 'density',
      presentational: true,
      advanced: true,
    },
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'bins',
      default: [],
      help:
        'Set by clicking bars in the viewer. Holds the value ranges they covered rather than ' +
        'bar numbers, so a stored selection survives a change to the bin count. Feeds Selected.',
    },
  ],

  // A tap: both ports are the input, neurons-ness and all. See `tapPorts`.
  inferOutputs: (ctx) => tapPorts(ctx.inputs.in, ['out', 'selected']),

  /**
   * Only what `validateColumnParams` cannot already say.
   *
   * "No numeric column to bin" would be the shared check's message a second time on one badge,
   * and it would fire against a schema that has merely not *arrived* — a `core.pivot` upstream
   * publishes none until it has run. What is left is the one pick the resolver cannot see is
   * pointless.
   */
  validate: (ctx) => {
    if (!ctx.inputs.in) return []
    const series = ctx.column('series')
    return series && series === ctx.column('value')
      ? ['Split-by and Value are the same column']
      : []
  },

  /**
   * Passes the table on whether or not there is anything to draw — invariant 5's corollary.
   *
   * `out` is the input unchanged, so refusing because a picker is unset would block every node
   * downstream for a reason that has nothing to do with them, and would be wrong about it on
   * the graph that matters: a `Pivot → Histogram` reloaded from a file resolves no columns
   * until the pivot has run. The node's warning and the widget's own empty state are the right
   * severity — the pipeline works, the picture does not.
   */
  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    return {
      out: table,
      selected: rowsInRanges(table, ctx.column('value'), ctx.params.selection),
    }
  },
})
