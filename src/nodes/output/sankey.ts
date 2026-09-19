/**
 * Sankey: layered flow drawn as bands whose width is the quantity.
 *
 * The picture `Influence` needed and the one a node-link diagram could not be. Where the retired
 * `Network` port drew the induced subgraph of the top scorers — inviting a reader to trace a route
 * through a ball whose other routes were not on the page — a flow diagram's ribbons *are* the
 * drive, so a column's total is the whole of what reached that depth and nothing is missing
 * behind it.
 *
 * **General over a table, not built around influence.** Four pickers: which column says the
 * layer, which the two ends, and which the quantity. `Influence ▸ Transfers` fills them with no
 * configuration, and so does anything else shaped like layered flow — a region-split Connectivity
 * unpivoted, a Paths result folded to cell types.
 *
 * **A tap.** The table passes through by identity; `Selected` carries the rows behind whatever
 * was clicked.
 *
 * Three things are decisions rather than details.
 *
 * **Conservation is measured, not assumed.** A Sankey's grammar says inflow equals outflow at
 * every node, which is why the mark reads as it does — and why most connectome Sankeys are
 * quietly wrong, being drawn on synapse counts, which conserve nowhere. This node cannot refuse
 * such a table: flow between categories is a legitimate thing to draw. What it does instead is
 * put the number in the caption, so the claim the mark makes is one a reader can check. Warn,
 * never refuse.
 *
 * **Colour is off by default.** Width is already the quantity, and on a diagram of thirty labels
 * a categorical palette cycles and stops meaning anything. Pointing `Band colour` at the source
 * or target column is one click for somebody who wants to trace a stream.
 *
 * **The layer column is a picker with no default**, never a column guessed by name. That is
 * `out.flowChart`'s rule and the failure `resolveColumn` rule 3 already has a record of: a
 * required picker on its declared default takes the first compatible column, which here would lay
 * the whole diagram out by whatever integer came first.
 */

import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { colorParams } from '../lib/encodingParams'
import { decodeLabels } from '../lib/chartSelection'
import { rowsWithKeys } from '../lib/rowIds'
import { tapPorts } from '../lib/tapPorts'

registerNode({
  type: 'out.sankey',
  label: 'Sankey',
  category: 'visualisation',
  /*
   * "Alluvial" is what the same figure is called in the other literature that prints it, and
   * neither word appears anywhere else in the palette. `catalogue.ts` runs at `lean` and drops
   * every `help` string, so this line is also the assistant's only prose about the node.
   */
  description:
    'Draw layered flow as bands whose width is the quantity — a Sankey or alluvial diagram, from a table of layer, source, target and value.',
  guide:
    'Layered flow drawn as bands whose width is the quantity: where something came from, what ' +
    'it passed through, and how much. Wire it to an Influence node’s Transfers port and it ' +
    'needs no configuration. Because the mark claims that what arrives at a node also leaves ' +
    'it, the caption measures how far from true that is on your data rather than assuming it — ' +
    'a flow of synapse counts does not conserve, and the figure says so instead of pretending.',
  cost: 'cheap',
  // A viewer's card fills its wrapper — `category: 'visualisation'` is what makes that true.
  defaultSize: { width: 580, height: 440 },

  paramGroups: [
    { id: 'flow', label: 'Columns' },
    { id: 'style', label: 'Style' },
  ],

  /*
   * Labelled for the *shape* it wants rather than for the type it accepts, which is the split
   * every viewer here already makes: `out.rank` says `Table` because any table will do, and
   * `out.heatmap` says `Matrix` because one will not. A Sankey takes a table of a particular
   * shape — a layer, two ends and a quantity — so it says so, and the name is the one `Influence`
   * puts on the port that produces one.
   */
  inputs: [{ id: 'in', label: 'Transfers', type: T.table() }],
  outputs: [
    { id: 'out', label: 'Table', type: T.table() },
    { id: 'selected', label: 'Selected', type: T.table() },
  ],

  params: [
    // ---- Columns ---------------------------------------------------------
    {
      id: 'layerColumn',
      kind: 'column',
      label: 'Layer',
      from: 'in',
      default: '',
      /*
       * `optional`, which is load-bearing rather than tidy — see the header. Empty draws nothing
       * and says so, which is the honest state for a picker nobody has set.
       */
      optional: true,
      presentational: true,
      group: 'flow',
      help: 'Which column says where a row sits along the flow. The source end is at this layer and the target end at the next one. Values are renumbered densely, so 0, 2 and 5 draw as three adjacent columns.',
    },
    {
      id: 'sourceColumn',
      kind: 'column',
      label: 'From',
      from: 'in',
      default: '',
      optional: true,
      presentational: true,
      group: 'flow',
      help: 'What each band leaves. A label may repeat down the diagram — the same cell type at two depths is two boxes, which is what stops the flow becoming a graph with cycles in it.',
    },
    {
      id: 'targetColumn',
      kind: 'column',
      label: 'To',
      from: 'in',
      default: '',
      optional: true,
      presentational: true,
      group: 'flow',
      help: 'What each band arrives at, one layer further along.',
    },
    {
      id: 'valueColumn',
      kind: 'column',
      label: 'Value',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: '',
      optional: true,
      presentational: true,
      group: 'flow',
      help: 'The quantity a band’s width shows. Empty gives every band the same width, which draws a count of rows rather than a quantity.',
    },

    // ---- Style -----------------------------------------------------------
    {
      id: 'direction',
      kind: 'enum',
      label: 'Direction',
      default: 'lr',
      presentational: true,
      group: 'style',
      options: [
        { value: 'lr', label: 'left to right' },
        { value: 'tb', label: 'top to bottom' },
      ],
      help: 'Which way the flow runs. Left to right fits more layers; top to bottom fits more boxes per layer.',
    },
    {
      id: 'foldPerLayer',
      kind: 'int',
      label: 'Fold past',
      default: 0,
      min: 0,
      step: 1,
      presentational: true,
      group: 'style',
      /*
       * Unlike `out.flowChart`'s fold, this one costs nothing in honesty: summing merged bands
       * preserves every column total exactly, so the picture stays conserving and the caption
       * keeps reporting the same number. See `foldSankey`.
       */
      help: 'Keep this many boxes per layer, the largest first, and fold the rest into one “+N others”. 0 keeps everything. Column totals are unchanged, so the caption still reports the same flow.',
    },
    {
      id: 'labelValues',
      kind: 'boolean',
      label: 'Label the boxes',
      default: true,
      presentational: true,
      group: 'style',
      help: 'Print each box’s share beside its name. Off leaves the names alone, which is what a crowded diagram wants.',
    },
    ...colorParams({
      prefix: 'band',
      from: 'in',
      label: 'Band colour',
      rowLabel: 'Colour',
      group: 'style',
      presentational: true,
      /*
       * Constant by default, and that is the design rather than caution: a band's *width* is
       * already the quantity, so colour has nothing left to encode, and a categorical scale over
       * thirty labels cycles and reads as structure that is not there. Pointing it at the From
       * column is what somebody does to trace one stream, and then it earns its place.
       */
      defaultColumn: '',
      defaultMode: 'constant',
      defaultColor: 'muted',
    }),

    // ---- Identity and selection -----------------------------------------
    {
      id: 'idColumn',
      kind: 'column',
      label: 'ID column',
      help: 'What a selected row is called downstream. An id survives an upstream re-run where a row position does not; the row index is the fallback.',
      from: 'in',
      default: '',
      optional: true,
      advanced: true,
    },
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'rows',
      default: [],
      help: 'Set by clicking a band or a box in the viewer. Clicking a box selects every row it touches. Shift adds. Feeds Selected.',
    },
  ],

  inferOutputs: (ctx) => tapPorts(ctx.inputs.in, ['out', 'selected']),

  /*
   * Nothing is said about an unset picker: `validateColumnParams` already names each one, and
   * four badges for one fact is how a list of issues stops being read. There is no second thing
   * this knows that the resolver does not — the one property worth warning about, whether the
   * flow conserves, is a fact about a *value* and belongs in the caption where the number is.
   */

  /**
   * Passes the table on whether or not there is anything to draw.
   *
   * `out` is the input unchanged, so refusing because a drawing cannot be configured would block
   * every node downstream for a reason that has nothing to do with them — invariant 5's corollary
   * and the failure `out.scatter`, `out.barChart` and `out.rank` each record.
   */
  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    return {
      out: table,
      selected: rowsWithKeys(table, decodeLabels(ctx.params.selection), ctx.column('idColumn')),
    }
  },
})
