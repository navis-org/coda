/**
 * Box plot and violin plot node.
 *
 * One node, because they are one chart drawn two ways over the same five numbers plus a kernel
 * estimate — `style` picks which marks are shown and changes nothing else, so it is
 * `presentational`. Two node types would have been two glyphs, two emitters and two guide
 * entries for a boolean.
 *
 * **Horizontal by default, and that default is the argued half.** The groups here are ROI and
 * cell-type names, which read straight along a left-hand gutter and need rotating 45° as
 * columns — the same reasoning the Bar Chart records, and the reason it has no orientation
 * param at all. This node has one anyway, because a box plot is the panel that most often has
 * to sit in a figure beside other vertical ones, and matching them is worth the rotated labels.
 *
 * **`group` is not presentational; `value` is.** A selected box is stored as its *group label*
 * (`chartSelection.ts`), so the group column decides which rows `Selected` carries and belongs
 * in the cache key (invariant 4); the value column only decides what is drawn along the axis.
 * That is the opposite split from `out.histogram`, and the difference is exactly which column
 * the mark was named after.
 *
 * **The group cap drops rather than folds.** Every other chart here folds its tail into one
 * achromatic `Other`, which works for a bar and a slice because those are sums. Pooling fifty
 * cell types into one box makes a distribution that describes nothing, so the tail is dropped
 * and the caption says how many groups there were.
 */

import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { rowsWithLabels } from '../lib/chartSelection'
import { tapPorts } from '../lib/tapPorts'

registerNode({
  type: 'out.distribution',
  label: 'Box Plot',
  category: 'visualisation',
  description:
    'Box plot, violin plot or swarm of a numeric column, split by an optional group.',
  guide:
    "Draws one numeric column as a box, violin or swarm per group, with quartiles, whiskers and outliers. The whisker rule, a log axis and the number of groups are settings; click a box to send that group's rows out of Selected.",
  cost: 'cheap',
  // Tall enough for the value axis to be above the fold at the default group cap. Measured.
  defaultSize: { width: 460, height: 440 },
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
      presentational: true,
    },
    {
      id: 'group',
      kind: 'column',
      label: 'Group by',
      from: 'in',
      default: '',
      // `optional`, so empty means one box over every row rather than "the first column" — a
      // whole-table distribution is a real thing to ask for.
      optional: true,
      // Not presentational: it decides which rows a selected box names. See the header.
      help: 'One box per distinct value. Leave empty for a single box over all rows. Also sets what a selected box refers to.',
    },
    {
      id: 'style',
      kind: 'enum',
      label: 'Style',
      default: 'box',
      options: [
        { value: 'box', label: 'box' },
        { value: 'violin', label: 'violin' },
        { value: 'both', label: 'violin + box' },
        { value: 'swarm', label: 'swarm' },
        { value: 'swarmBox', label: 'swarm + box' },
      ],
      help: 'How each group is drawn. Swarms are thinned above 300 points per group; the caption says so.',
      presentational: true,
    },
    {
      id: 'orientation',
      kind: 'enum',
      label: 'Layout',
      default: 'rows',
      options: [
        { value: 'rows', label: 'groups down the side' },
        { value: 'columns', label: 'groups along the bottom' },
      ],
      help: '"Groups down the side" fits long names. "Groups along the bottom" is the conventional figure layout, with labels rotated 45°.',
      presentational: true,
    },
    {
      id: 'points',
      kind: 'enum',
      label: 'Points',
      default: 'outliers',
      options: [
        { value: 'outliers', label: 'outliers' },
        { value: 'none', label: 'none' },
      ],
      presentational: true,
      advanced: true,
    },
    {
      id: 'whiskers',
      kind: 'enum',
      label: 'Whiskers',
      default: 'tukey',
      options: [
        { value: 'tukey', label: '1.5 × IQR' },
        { value: 'p5p95', label: '5th–95th percentile' },
        { value: 'minmax', label: 'full range' },
      ],
      help: 'How far the whiskers reach. Each ends at the most extreme value within that range.',
      presentational: true,
      advanced: true,
    },
    {
      id: 'logAxis',
      kind: 'boolean',
      label: 'Log axis',
      help: 'Use a log scale for the value axis. Values at or below zero are dropped; the caption says how many.',
      default: false,
      presentational: true,
      advanced: true,
    },
    {
      id: 'sortGroups',
      kind: 'boolean',
      label: 'Sort by median',
      default: true,
      presentational: true,
      advanced: true,
    },
    {
      id: 'maxGroups',
      kind: 'int',
      label: 'Max groups',
      default: 24,
      min: 1,
      max: 100,
      help: 'How many groups to show, largest first. The rest are dropped; the caption says how many there were.',
      presentational: true,
      advanced: true,
    },
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'groups',
      default: [],
      help: 'Set by clicking boxes in the viewer. Feeds Selected.',
    },
  ],

  inferOutputs: (ctx) => tapPorts(ctx.inputs.in, ['out', 'selected']),

  /** Only what the shared column check cannot already say — see `out.histogram`'s note. */
  validate: (ctx) => {
    if (!ctx.inputs.in) return []
    const group = ctx.column('group')
    return group && group === ctx.column('value')
      ? ['`Group by` and `Value` are the same column. Pick a different column for one of them.']
      : []
  },

  /** A tap: the table passes through unconditionally. See `out.histogram`'s note. */
  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    return {
      out: table,
      selected: rowsWithLabels(table, ctx.column('group'), ctx.params.selection),
    }
  },
})
