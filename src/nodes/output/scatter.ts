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
 * Note what is *not* on that list. `Vector marks` changes only how an exported file carries
 * the marks, so no output can tell; the Network viewer's Filter tab, by contrast, genuinely
 * subtracts from what the node returns and has to say so.
 *
 * There used to be a `Max points`, a stride sample of 50,000 that was there because a path
 * of circles rasterised at 3.4 µs a mark. Past `CIRCLES_MAX` visible marks the canvas now
 * writes pixels and draws every row, so the cap and its `showing N of M` caption went; a
 * stored value is an undeclared param and `normalizeParams` ignores it.
 */

import type { ParamValues } from '../../core/node'
import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T, columnsOfType, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { colorParams, shapeParams, sizeParams } from '../lib/encodingParams'
import { decodeLabels } from '../lib/chartSelection'
import { rowsWithKeys } from '../lib/rowIds'
import { tapPorts } from '../lib/tapPorts'

/** The point-label controls are shown while point labels are on. */
const labelsOn = (params: ParamValues) => params.pointLabels === true

registerNode({
  type: 'out.scatter',
  label: 'Scatter Plot',
  category: 'visualisation',
  description: 'Plot two numeric columns against each other, with colour, size and shape.',
  guide:
    'Plots two numeric columns against each other, with optional colour, size and shape ' +
    'channels, log axes and a linear trend. Typically wired from Embedding or any table; points ' +
    'you lasso come out of Selected.',
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
      help: 'Use a log scale for data spanning orders of magnitude. Values at or below zero are dropped; the caption says how many.',
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
      help: '"Equal" uses the same scale on both axes, as a UMAP or t-SNE embedding needs. "Fit" fills the card.',
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
      allowLiteral: true,
      valueScale: true,
      from: 'in',
      label: 'Colour',
      defaultMode: 'constant',
      // Named rather than left empty: an empty default resolves to the first compatible
      // column, which on a neuron table is `neuronId` — one value per row, folded into eight
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
    /*
     * seaborn's style channel, and the honest second channel once a category count is past
     * what hue alone can carry.
     *
     * This was a bare `shapeBy` column picker until the network viewer needed the same thing:
     * it is now the same factory as `Colour` and `Size`, so the three read alike and a shape
     * can be pinned per key. **The param ids changed** — `shapeBy` became `pointShapeBy` —
     * which resets the column on a scatter saved before this. Presentational, so nothing
     * downstream restyles or recomputes; the cost is one picker, and the alternative was two
     * spellings of one channel for as long as the node exists.
     */
    ...shapeParams({
      prefix: 'point',
      from: 'in',
      label: 'Shape',
      rowLabel: 'Shape',
      group: 'points',
      advanced: true,
      legend: true,
    }),
    {
      id: 'opacity',
      kind: 'number',
      label: 'Opacity',
      help: 'Point opacity. Lower it to see through overlapping points.',
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
      help: 'Shown in the tooltip, and beside points when `Labels on points` is ticked. Defaults to the `ID column`.',
      from: 'in',
      default: '',
      optional: true,
      presentational: true,
      advanced: true,
      group: 'points',
    },
    {
      id: 'hoverColumns',
      kind: 'columns',
      label: 'Hover shows',
      help: 'Extra columns to list in the tooltip, after the label, x, y and any colour or shape columns.',
      from: 'in',
      default: [],
      presentational: true,
      advanced: true,
      group: 'points',
    },
    {
      id: 'pointLabels',
      kind: 'boolean',
      label: 'Labels on points',
      help: 'Write each point\u2019s label beside it once few enough are in view (see `Label up to`). Zoom in to see more.',
      default: false,
      presentational: true,
      group: 'points',
    },
    {
      id: 'labelLimit',
      kind: 'number',
      label: 'Label up to',
      help: 'Draw labels only while at most this many points are in view.',
      default: 400,
      min: 1,
      max: 5000,
      step: 50,
      presentational: true,
      advanced: true,
      group: 'points',
      visibleIf: labelsOn,
    },
    {
      id: 'labelLines',
      kind: 'boolean',
      label: 'Label lines',
      help: 'Draw a thin line from each point to its label.',
      default: true,
      presentational: true,
      advanced: true,
      group: 'points',
      visibleIf: labelsOn,
    },
    {
      id: 'unplacedLabels',
      kind: 'enum',
      label: 'Labels that do not fit',
      help: 'A label with no free space around its point: left out, or drawn faintly beside it, under the others.',
      default: 'hide',
      options: [
        { value: 'hide', label: 'Leave out' },
        { value: 'dim', label: 'Draw faintly' },
      ],
      presentational: true,
      advanced: true,
      group: 'points',
      visibleIf: labelsOn,
    },
    {
      id: 'vectorMarks',
      kind: 'boolean',
      label: 'Vector marks',
      help: 'Export every point as a vector shape. Otherwise, SVGs with more than 10,000 points in view draw the points as one image.',
      default: false,
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
      help: 'A least-squares fit on the plotted axes, so on log-log axes it fits a power law.',
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
      help: 'Identifies each point, so a selection survives an upstream re-run. Without one, points are identified by row number.',
      from: 'in',
      // `neuronId` when the table has one; `optional` is what makes the resolver answer
      // "nothing" rather than reaching for the first column when it does not.
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
      help: 'Set by lassoing points in the viewer. Feeds the Selected output.',
    },
  ],

  // Neurons-ness is preserved on both ports: a lassoed cluster is still neurons, which is what
  // keeps it pluggable straight back into Connectivity or the 3D viewer. See `tapPorts`.
  inferOutputs: (ctx) => tapPorts(ctx.inputs.in, ['out', 'selected']),

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
    /*
     * Nothing said about *none*: `validateColumnParams` already names X and Y for that, and
     * three badges for one fact is how a list of issues stops being read.
     *
     * What it cannot see is the two pickers landing on the **same** column, which draws a
     * diagonal line that reads as a broken viewer rather than as a table with nothing to say.
     * Asked of the resolution rather than of the column count, which is the half that moved:
     * `resolveColumn`'s rule 3 hands a required picker still on its declared default the
     * *first* compatible column, and `pre`/`post` are absent from most tables — so `Embedding`,
     * whose whole purpose is to be plotted, gave a fresh Scatter `umap1` for both axes while a
     * count of two numeric columns said everything was fine. One numeric column is still the
     * case worth naming specially, because there the answer is upstream rather than in the
     * picker.
     */
    const x = ctx.column('x')
    const y = ctx.column('y')
    // Before `columnsOfType`, which allocates: this runs on every keystroke and the two pickers
    // naming different columns is the case that always holds.
    if (!x || !y || x !== y) return []
    return columnsOfType(schema, NUMERIC_DTYPES).length === 1
      ? [
          `Only "${x}" is numeric, so \`X\` and \`Y\` are the same column. Add a second numeric column upstream.`,
        ]
      : [
          `\`X\` and \`Y\` are both "${x}", which draws a diagonal line. Pick a different column for \`Y\`.`,
        ]
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
      selected: rowsWithKeys(table, decodeLabels(ctx.params.selection), ctx.column('idColumn')),
    }
  },
})
