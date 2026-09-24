/**
 * Rank Plot: a heavy-tailed measure read as an ordering, with the share of the total beside it.
 *
 * The chart a connectome is full of and Coda could not draw. Influence scores, degree,
 * centrality, cluster sizes, NBLAST scores and synapse counts all span several orders of
 * magnitude over a long tail, and a bar chart is the wrong mark for every one of them: linear,
 * the largest bar is full and the rest are slivers; logged, a thousandfold difference draws as
 * a 1.7x difference in length, which is a plausible figure saying the measure is flat when it
 * is not. Length encodes ratio, and these ratios do not fit in a length.
 *
 * So: dots on a log axis against rank, and — the half that is not otherwise reachable — the
 * running **share of the total** underneath. A top-20 bar chart has no denominator, so a reader
 * cannot tell *a handful of strong drivers* from *diffusely driven*, which is usually the
 * finding. `out.histogram` already draws a cumulative curve and it answers a different
 * question: its share is over **rows** ("90% of neurons score below 1e-4") where this one is
 * over **values** ("the top 20 carry 60%").
 *
 * **A tap, like every other viewer here.** The table passes through by identity; `Selected`
 * carries the points that were clicked or lassoed.
 *
 * Three decisions rather than details.
 *
 * **Two panels, never two y-scales.** The obvious Pareto chart puts the cumulative on a second
 * axis against the same bars. Two measures of different scale sharing one drawing is the one
 * chart construction with no honest reading, so the share gets a panel of its own sharing the
 * rank axis — which also gives it room to carry its own annotation.
 *
 * **Everything is presentational except the two that decide what `Selected` means**, which is
 * `out.scatter`'s split exactly: `selection`, and `idColumn`, which decides what a selected
 * point is *called* and therefore which rows come back.
 *
 * **`Flag column` is a column picker and not a boolean.** On an Influence result it wants
 * `isSeed`, whose rows are kept in the table deliberately — a seed's score is its own seed mass
 * plus whatever came back round a loop. But nothing here knows about influence, and the same
 * gesture serves a `Traced` flag or a reference set. The rows are ringed, ranked, and left out
 * of the share; see `rankSeries.ts` for why they cannot be counted in it.
 */

import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { colorParams } from '../lib/encodingParams'
import { decodeLabels } from '../lib/chartSelection'
import { rowsWithKeys } from '../lib/rowIds'
import { tapPorts } from '../lib/tapPorts'

registerNode({
  type: 'out.rank',
  label: 'Rank Plot',
  category: 'visualisation',
  /*
   * The words somebody searches for. "Pareto" and "rank abundance" are what this figure is
   * called in two different literatures and neither appears anywhere else in the palette;
   * `catalogue.ts` runs at `lean` and drops every `help` string, so this line is also the
   * assistant's only prose about the node.
   */
  description:
    'Plot a numeric column against its rank on log axes, with the cumulative share of the total beside it — a Pareto or rank-abundance chart.',
  guide:
    'A heavy-tailed column read as an ordering: value against rank on log axes, with the ' +
    'running share of the total underneath. Made for influence scores, degree and centrality, ' +
    'where a bar chart draws a thousandfold difference as a barely visible one. The share is ' +
    'of the values rather than of the rows, so it answers "the top twenty carry 60%" — and it ' +
    'is withheld, with a reason, on a column that can go negative.',
  cost: 'cheap',
  /*
   * Taller than the other charts, and the reason is the second panel rather than taste: the
   * card draws its param rows above the viewer, so a 400px wrapper leaves the share curve about
   * sixty pixels to live in and the ranking reads as a single line of dots. Measured in a
   * browser at the default four Axes controls.
   */
  defaultSize: { width: 540, height: 520 },

  paramGroups: [
    { id: 'axes', label: 'Axes' },
    { id: 'points', label: 'Points' },
  ],

  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [
    { id: 'out', label: 'Table', type: T.table() },
    { id: 'selected', label: 'Selected', type: T.table() },
  ],

  params: [
    // ---- Axes ------------------------------------------------------------
    {
      id: 'value',
      kind: 'column',
      label: 'Value',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: '',
      presentational: true,
      group: 'axes',
      help: 'The measure being ranked. On an Influence result this is influence — not influenceLog, which is already a transform and would be logged twice.',
    },
    {
      id: 'descending',
      kind: 'boolean',
      label: 'Largest first',
      default: true,
      presentational: true,
      group: 'axes',
      help: 'Off ranks smallest first, which is what a cost or a distance wants.',
    },
    {
      id: 'valueLog',
      kind: 'boolean',
      label: 'Log value',
      default: true,
      presentational: true,
      group: 'axes',
      /*
       * On by default, which is the opposite of `out.scatter`'s call and is the node. A scatter
       * is pointed at any two columns; this one exists for measures that span decades, and a
       * linear default would draw the picture it was built to replace.
       */
      help: 'On by default: the measures this chart is for span several orders of magnitude. Values at or below zero have no logarithm and are dropped, and the caption counts them.',
    },
    {
      id: 'rankLog',
      kind: 'boolean',
      label: 'Log rank',
      default: true,
      presentational: true,
      group: 'axes',
      help: 'Log rank makes a power law a straight line and keeps the head of the ranking readable on a table of thousands. Off spaces the ranks evenly, which is right for a few dozen rows.',
    },
    {
      id: 'showShare',
      kind: 'boolean',
      label: 'Cumulative share',
      default: true,
      presentational: true,
      group: 'axes',
      help: 'The second panel: the share of the total accumulated down the ranking. Of the values, not of the rows — it answers "the top twenty carry 60%".',
    },

    // ---- Points ----------------------------------------------------------
    {
      id: 'labelColumn',
      kind: 'column',
      label: 'Point label',
      from: 'in',
      default: '',
      optional: true,
      presentational: true,
      group: 'points',
      help: 'What the labelled points and the tooltip say. Empty uses the id column, which on a neuron table is an 18-digit root id — point this at type or instance for something readable.',
    },
    {
      id: 'labelTop',
      kind: 'int',
      label: 'Label top',
      default: 5,
      min: 0,
      max: 40,
      step: 1,
      presentational: true,
      group: 'points',
      help: 'How many of the leading points get a label drawn beside them. 0 draws none; every point still names itself on hover.',
    },
    {
      id: 'flagColumn',
      kind: 'column',
      label: 'Flag column',
      from: 'in',
      /*
       * Restricted, and that is what keeps three languages agreeing.
       *
       * Unrestricted, each surface invented its own truthiness: this side read `'yes'`/`'1'` as
       * true, pandas' `astype(bool)` reads *every* non-empty string as true — so a text column
       * silently emptied the notebook's share panel — and R's `as.logical` answers `NA`, which is
       * an error rather than a wrong number. The goldens compare emitted text, so nothing in the
       * suite could see any of it. Named here, `validateColumnParams` refuses a bad column at
       * edit time and all three fall back to their native cast, which agrees.
       */
      dtypes: ['bool', 'i64', 'f64'],
      default: '',
      /*
       * `optional`, which is load-bearing: `resolveColumn`'s rule 3 hands a *required* picker
       * still on its declared default the first compatible column, so an empty default here
       * would flag rows by whatever column happened to come first. Empty is a decision and
       * stays one — the failure recorded on `zapbench:traces` and `out.scatter`.
       */
      optional: true,
      presentational: true,
      group: 'points',
      help: 'Which rows to ring and keep out of the share — on an Influence result, isSeed. A true/false or 0/1 column. A seed is kept in the table on purpose, and left in the share it carries most of it and the curve says nothing.',
    },
    ...colorParams({
      prefix: 'point',
      from: 'in',
      label: 'Point colour',
      rowLabel: 'Colour',
      group: 'points',
      presentational: true,
      /*
       * Constant by default for `out.flowChart`'s reason: `categorical` with no column falls to
       * the first compatible one, which on a neuron table is `neuronId` — one value per row,
       * folded into eight slots plus grey, which reads as category structure where there is
       * none. `type` is what a neuron table wants when somebody does switch the mode.
       */
      defaultColumn: 'type',
      defaultMode: 'constant',
      defaultColor: '0',
    }),

    // ---- Identity and selection -----------------------------------------
    {
      id: 'idColumn',
      kind: 'column',
      label: 'ID column',
      help: 'What a selected point is called downstream. An id survives an upstream re-run where a row position does not; the row index is the fallback, and the caption says so.',
      from: 'in',
      // `out.scatter`'s exact declaration: a named default rather than an empty one, because
      // empty means "the first compatible column" and `optional` is what makes the resolver
      // answer "nothing" on a table with no `neuronId`.
      default: 'neuronId',
      optional: true,
      advanced: true,
    },
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'points',
      default: [],
      help: 'Set by clicking points in the viewer, or dragging a range across the ranking. Shift adds. Feeds the Selected output.',
    },
  ],

  // Neurons-ness is preserved on both ports, so a selected head of the ranking is still
  // neurons and wires straight into Skeletons or Connectivity. See `tapPorts`.
  inferOutputs: (ctx) => tapPorts(ctx.inputs.in, ['out', 'selected']),

  /*
   * Nothing is said about an unpicked Value column: `validateColumnParams` already names it,
   * and two badges for one fact is how a list of issues stops being read.
   *
   * What it cannot see is the pairing, which is the one mistake this node invites. An Influence
   * table carries both `influence` and `influenceLog`, and `influenceLog` is
   * `log(max(x, e^-24)) + 24` — already a transform. Logged again it is the log of a log, which
   * on a heavy tail is very nearly a straight line whatever the data does, i.e. a picture that
   * looks like a clean power law for reasons that have nothing to do with the connectome.
   */
  validate: (ctx) => {
    if (!ctx.inputs.in) return []
    const value = ctx.column('value')
    if (!value || ctx.params.valueLog === false) return []
    return /log$/i.test(value)
      ? [
          `"${value}" is already a logarithm and Log value would take it again. Point ` +
            `Value at the raw measure, or turn Log value off.`,
        ]
      : []
  },

  /**
   * Passes the table on whether or not there is anything to draw.
   *
   * `out` is the input unchanged, so refusing because a *drawing* cannot be configured would
   * block every node downstream for a reason that has nothing to do with them — invariant 5's
   * corollary, and the failure `out.scatter` and `out.barChart` each record: a `Pivot ▸ Rank
   * Plot` reloaded from a file resolves no columns until the pivot has run.
   */
  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    return {
      out: table,
      // Independent of the axes and of the ranking: a selection is resolved by id, so it
      // neither needs nor is affected by whether there is anything to plot.
      selected: rowsWithKeys(table, decodeLabels(ctx.params.selection), ctx.column('idColumn')),
    }
  },
})
