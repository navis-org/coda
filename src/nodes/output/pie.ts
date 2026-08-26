/**
 * Pie and donut node.
 *
 * One chart with a hole in it, so one node with a toggle: `shape` changes the inner radius and
 * nothing else, which is why it is `presentational` and why splitting this into two node types
 * would have been two of everything — params, glyph, emitter, guide — for one number.
 *
 * **A pie answers composition and only composition.** It reads shares of a whole well and
 * compares magnitudes badly, which is the reason the defaults are what they are: eight slices
 * and a residual rather than a wheel of forty, and percentages on the labels rather than raw
 * totals. For "which is bigger" there is a Bar Chart one row up the palette.
 *
 * **`value` is optional and that is the common case.** Left empty, each row counts once — "how
 * many neurons of each type" without a Group By in front of it.
 *
 * **`category` is not presentational, and everything else is.** A selected slice is stored as
 * its *label* (`chartSelection.ts`), so the category column is what decides which rows
 * `Selected` carries — the same call `out.scatter` makes for `idColumn`, and marking it
 * presentational would let a stale downstream result survive a change to it (invariant 4).
 * `maxSlices` looks like it belongs on that list and does not: folding the tail is a drawing
 * decision, and the viewer writes the folded categories out by name, so a click on `Other`
 * keeps meaning the categories it meant when it was clicked.
 */

import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { rowsWithLabels } from '../lib/chartSelection'
import { tapPorts } from '../lib/tapPorts'

export const pieNode = registerNode({
  type: 'out.pie',
  label: 'Pie Chart',
  category: 'visualisation',
  description: 'Pie or donut chart: shares of a whole, one slice per category.',
  guide:
    'Composition as a ring or a wheel — one slice per category, sized by a value column or by row count when none is picked. The tail past eight slices folds into one residual rather than taking a ninth colour, and clicking a slice sends its rows on as Selected. It answers “what fraction” well and “which is bigger” badly; for the latter use a Bar Chart.',
  cost: 'cheap',
  // A pie needs its legend and its caption as well as the ring, and at 320 the ring had no
  // height left at all — the card drew a key to a picture that was not there. Measured.
  defaultSize: { width: 420, height: 460 },
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [
    { id: 'out', label: 'Table', type: T.table() },
    { id: 'selected', label: 'Selected', type: T.table() },
  ],
  params: [
    {
      id: 'category',
      kind: 'column',
      label: 'Category',
      from: 'in',
      default: '',
      // Not presentational: it decides which rows a selected slice names. See the header.
      help: 'One slice per distinct value. Also what a selected slice means, so changing it re-runs anything downstream of Selected.',
    },
    {
      id: 'value',
      kind: 'column',
      label: 'Value',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: '',
      // `optional` is what makes empty mean empty rather than "the first numeric column" — and
      // empty is the useful default here, since counting rows is what a pie is usually for.
      optional: true,
      help: 'Summed per category. Leave empty to count rows instead. Negative values are dropped; the caption says how many.',
      presentational: true,
    },
    {
      id: 'shape',
      kind: 'enum',
      label: 'Shape',
      default: 'donut',
      options: [
        { value: 'donut', label: 'donut' },
        { value: 'pie', label: 'pie' },
      ],
      help:
        'The hole is where the total goes, and a ring compares arc lengths where a wheel asks ' +
        'you to compare angles at a point.',
      presentational: true,
    },
    {
      id: 'sortSlices',
      kind: 'boolean',
      label: 'Sort by size',
      default: true,
      presentational: true,
      // Off the card and in the inspector: the card's height is the ring's, and this is a
      // refinement rather than one of the three settings somebody sets first.
      advanced: true,
    },
    {
      id: 'maxSlices',
      kind: 'int',
      label: 'Max slices',
      default: 8,
      min: 2,
      max: 24,
      help:
        'Past this the tail folds into one achromatic residual rather than repeating a hue, ' +
        'which would imply two categories are the same thing. Clicking it selects everything ' +
        'inside it.',
      presentational: true,
      advanced: true,
    },
    {
      id: 'sliceLabels',
      kind: 'enum',
      label: 'Labels',
      default: 'percent',
      options: [
        { value: 'percent', label: 'percent' },
        { value: 'value', label: 'value' },
        { value: 'none', label: 'none' },
      ],
      help: 'Dropped automatically from any slice too narrow to hold one.',
      presentational: true,
      advanced: true,
    },
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'slices',
      default: [],
      help:
        'Set by clicking slices in the viewer. Holds category labels rather than row ids, so ' +
        'it stays small and survives an upstream re-run. Feeds Selected.',
    },
  ],

  inferOutputs: (ctx) => tapPorts(ctx.inputs.in, ['out', 'selected']),

  /** Only what the shared column check cannot already say — see `out.histogram`'s note. */
  validate: (ctx) => {
    if (!ctx.inputs.in) return []
    const value = ctx.column('value')
    return value && value === ctx.column('category')
      ? ['Value and Category are the same column']
      : []
  },

  /** A tap: the table passes through unconditionally. See `out.histogram`'s note. */
  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    return {
      out: table,
      selected: rowsWithLabels(table, ctx.column('category'), ctx.params.selection),
    }
  },
})
