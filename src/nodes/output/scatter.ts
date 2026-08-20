/**
 * Scatter plot node.
 *
 * The counterpart to Bar Chart for two continuous variables, modelled on seaborn's
 * `scatterplot`: x, y, and the three encoding channels hue, size and style. Two outputs —
 * the table passes through, because viewers are taps rather than dead ends, and a
 * `Selected` table carries whatever was lassoed.
 *
 * Everything here is presentational except two params, and the exceptions are the design:
 *
 *  - **`selection`** is data flowing *back* from a viewer, so it lives in the saved file and
 *    in the provenance key, exactly as it does on the Network and 3D nodes.
 *  - **`idColumn`** decides what a selected id *means*, so it decides which rows `Selected`
 *    carries. Marking it presentational would let a stale downstream result survive a change
 *    to the very thing that identifies the rows.
 *
 * Note what is *not* on that list. `Max points` thins the drawing and nothing else: `out` is
 * the table unchanged and a lasso is tested against every row rather than against the sample
 * (see `rowsInPolygon`), so no output can tell whether a point was painted. That is the
 * difference from the Network viewer's Filter tab, which genuinely does subtract from what
 * the node returns and has to say so.
 */

import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T, columnsOfType, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { colorParams, sizeParams } from '../lib/encodingParams'
import { rowsWithKeys } from '../lib/rowIds'

export const scatterNode = registerNode({
  type: 'out.scatter',
  label: 'Scatter Plot',
  category: 'visualisation',
  description: 'Plot two numeric columns against each other, with colour, size and shape.',
  guide:
    'Two numeric columns against each other, with colour, size and shape as three more channels — seaborn’s scatterplot, plus log axes and a linear fit. Drawn to a canvas rather than as SVG because an embedding of a whole dataset is a hundred thousand points, and export re-draws the same picture as vector so nothing is lost. Lasso a group of points and they come out of the Selected port as neurons, which is what makes it a way of choosing rather than only of looking.',
  cost: 'cheap',
  defaultSize: { width: 460, height: 380 },
  /*
   * Fourteen params is well past what the flat horizontal rail reads at, so the overlay gets
   * the tabbed styling panel instead. No tab declares `affectsData`: every param that reaches
   * one is presentational, which is the promise that makes the panel safe to touch. The two
   * that are not grouped are the two that are not — see the header.
   */
  paramGroups: [
    { id: 'axes', label: 'Axes' },
    { id: 'points', label: 'Points' },
    { id: 'trend', label: 'Trend' },
  ],
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [
    { id: 'out', label: 'Table', type: T.table() },
    { id: 'selected', label: 'Selected', type: T.table() },
  ],
  params: [
    /*
     * Named defaults rather than empty ones, and the reason is what an empty default means:
     * "the first compatible column", which is the same answer for both axes — so a scatter
     * node dropped on a neuron table would open drawing y against itself, a diagonal line
     * that looks like a broken viewer. `pre` and `post` are a real plot on the table this
     * app is mostly about, and `resolveColumn` falls back to the first numeric column
     * wherever they are absent, so nothing is worse off.
     */
    {
      id: 'x',
      kind: 'column',
      label: 'X',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: 'pre',
      presentational: true,
      group: 'axes',
    },
    {
      id: 'y',
      kind: 'column',
      label: 'Y',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: 'post',
      presentational: true,
      group: 'axes',
    },
    {
      id: 'xLog',
      kind: 'boolean',
      label: 'Log X',
      help:
        'Synapse counts and connection weights span orders of magnitude, where a linear ' +
        'axis piles most of the data into one corner. Values at or below zero have no ' +
        'logarithm and are dropped; the caption says how many.',
      default: false,
      presentational: true,
      advanced: true,
      group: 'axes',
    },
    {
      id: 'yLog',
      kind: 'boolean',
      label: 'Log Y',
      default: false,
      presentational: true,
      advanced: true,
      group: 'axes',
    },
    {
      id: 'aspect',
      kind: 'enum',
      label: 'Aspect',
      help:
        'Equal gives both axes the same units per pixel, which is what makes distance in a ' +
        'UMAP or t-SNE embedding mean the same thing in every direction. Fit fills the card.',
      default: 'fit',
      options: [
        { value: 'fit', label: 'fit the card' },
        { value: 'equal', label: 'equal scale' },
      ],
      presentational: true,
      advanced: true,
      group: 'axes',
    },

    // --- points ----------------------------------------------------------
    ...colorParams({
      prefix: 'point',
      from: 'in',
      label: 'Colour',
      defaultMode: 'constant',
      // Named rather than left empty: an empty default resolves to the first compatible
      // column, which on a neuron table is `bodyId` — one value per row, folded into eight
      // slots plus grey, which reads as category structure where there is none.
      defaultColumn: 'type',
      group: 'points',
    }),
    ...sizeParams({
      prefix: 'point',
      from: 'in',
      label: 'Size',
      defaultMin: 3,
      defaultMax: 12,
      advanced: true,
      group: 'points',
    }),
    {
      id: 'shapeBy',
      kind: 'column',
      label: 'Shape',
      help:
        'seaborn’s style channel. Six marks plus a residual, ranked by frequency like the ' +
        'colour slots — and the honest second channel when a category count is past what ' +
        'hue alone can carry.',
      from: 'in',
      default: '',
      optional: true,
      presentational: true,
      advanced: true,
      group: 'points',
    },
    {
      id: 'opacity',
      kind: 'number',
      label: 'Opacity',
      help: 'Overplotting is the default state of a real scatter; this is what reads through it.',
      default: 0.8,
      min: 0.05,
      max: 1,
      step: 0.05,
      presentational: true,
      advanced: true,
      group: 'points',
    },
    {
      id: 'labelBy',
      kind: 'column',
      label: 'Label',
      help: 'Named in the tooltip under the pointer. Defaults to the ID column.',
      from: 'in',
      default: '',
      optional: true,
      presentational: true,
      advanced: true,
      group: 'points',
    },
    {
      id: 'maxPoints',
      kind: 'int',
      label: 'Max points',
      help:
        'Above this, a stable stride through the rows is drawn and the caption says how many ' +
        'of how many. It thins the picture only — the table passes through whole and a ' +
        'lasso still catches every row inside it.',
      default: 50000,
      min: 100,
      step: 1000,
      presentational: true,
      advanced: true,
      group: 'points',
    },

    // --- trend -----------------------------------------------------------
    {
      id: 'trend',
      kind: 'enum',
      label: 'Trend',
      default: 'none',
      options: [
        { value: 'none', label: 'none' },
        { value: 'linear', label: 'linear fit' },
      ],
      help:
        'Least squares in the space the axes are drawn in, so a log-log fit is a power law ' +
        'and the line is straight on screen.',
      presentational: true,
      advanced: true,
      group: 'trend',
    },
    {
      id: 'trendPerGroup',
      kind: 'boolean',
      label: 'Per colour group',
      default: true,
      presentational: true,
      advanced: true,
      group: 'trend',
      visibleIf: (params) => params.trend === 'linear',
    },

    // --- identity and selection ------------------------------------------
    {
      id: 'idColumn',
      kind: 'column',
      label: 'ID column',
      help:
        'What a selected point is called downstream. An id survives an upstream re-run where ' +
        'a row position does not, so this is preferred — with the row index as the fallback ' +
        'when the table carries no usable id, which the caption admits to.',
      from: 'in',
      // `bodyId` when the table has one; `optional` is what makes the resolver answer
      // "nothing" rather than reaching for the first column when it does not.
      default: 'bodyId',
      optional: true,
      advanced: true,
    },
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'points',
      default: [],
      help: 'Set by lassoing points in the viewer. Feeds the Selected output.',
    },
  ],

  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table(), selected: T.table() }
    const schema = schemaOf(input)
    // Neurons-ness is preserved on both ports: a lassoed cluster is still neurons, which is
    // what keeps it pluggable straight back into Connectivity or the 3D viewer.
    const make = input.kind === 'neurons' ? T.neurons : T.table
    return { out: make(schema), selected: make(schema) }
  },

  /**
   * Unknown is not empty, and conflating the two puts a warning badge on a node that is
   * simply waiting for its input to run.
   *
   * `core.pivot` is the case that forced this: its wide table's columns *are* the distinct
   * values of its Columns field, so it declares `observesOutputSchema` and publishes no
   * schema until it has run — and none again after a reload. Reading that as "this table has
   * no numeric columns" is a specific and wrong claim where saying nothing is merely
   * unhelpful. Same call `out.profile` makes about a raw Cypher result.
   */
  validate: (ctx) => {
    const schema = schemaOf(ctx.inputs.in)
    if (!ctx.inputs.in || !schema) return []
    const numeric = columnsOfType(schema, NUMERIC_DTYPES)
    // Nothing said about *none*: `validateColumnParams` already names X and Y for that, and
    // three badges for one fact is how a list of issues stops being read. One numeric column
    // is the case it cannot see — both pickers fall back to the first compatible column, so
    // the plot comes out as a diagonal that reads as a broken viewer rather than as a table
    // with nothing to say.
    if (numeric.length !== 1) return []
    return [`Only "${numeric[0]!.name}" is numeric — X and Y would be the same column`]
  },

  /**
   * Nothing here refuses over an unpicked column, and that is the fix for a real failure
   * rather than a leniency.
   *
   * `out` is the input unchanged, so throwing because a *drawing* cannot be configured blocks
   * every node downstream for a reason that has nothing to do with them. It also cannot be
   * right on the graph that exposed it: a `Pivot → Scatter` reloaded from a file resolves no
   * columns until the pivot has run, so the first Run errored while holding a table whose
   * columns the error message then listed — "no numeric columns. Available: type (str),
   * Traced (f64)". Passing through instead lets the run finish, at which point the store
   * re-infers against the schema the pivot just published and the widget draws.
   *
   * What is left to say it is the node's warning and the widget's own empty state, which is
   * the right severity: the pipeline works, the picture does not.
   */
  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    return {
      out: table,
      // Independent of the axes: a selection is resolved by id, so it neither needs nor is
      // affected by whether there is anything to plot.
      selected: rowsWithKeys(table, ctx.params.selection, ctx.column('idColumn')),
    }
  },
})
