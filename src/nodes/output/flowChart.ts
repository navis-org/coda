/**
 * Flow Chart: a small network drawn as a feed-forward circuit diagram.
 *
 * The picture a connectome paper prints — labelled boxes in columns, arrows whose thickness is
 * the connection strength, the number on the arrow — and the one Coda could not make. The
 * Network Viewer draws discs with the label beside them, which is the right trade for a graph of
 * thirty-six thousand nodes and the wrong one for a circuit of twelve, where the label *is* the
 * node and the quantity is the point.
 *
 * **A tap, like every other viewer here.** `Network` passes through unchanged, so this drops
 * into the middle of a chain; `Selected` carries the boxes that were clicked.
 *
 * Three things about it are decisions rather than details.
 *
 * **There is no `Layout` socket**, which departs from `out.network` deliberately. A
 * `LayoutValue` is centres, and `Paths` computes its own against `NETWORK_NODE_SIZE` — a
 * 120 x 36 placeholder that stands in for a disc, because nothing upstream of a renderer knows
 * what font a label will be drawn in. Honoured here those positions overlap every box whose text
 * is wider than the placeholder and waste the gap beside every box that is narrower. So this node
 * lays itself out, from boxes sized to their own text, and the Paths layout stays what it always
 * was: the arrangement for the viewer whose nodes are all the same size.
 *
 * **Every control is presentational except `selection`.** Restyling a figure must not stale the
 * `expensive` query above it, which is `out.network`'s contract and matters more here — this is
 * the node somebody adjusts twenty times while making a figure. The `Fold` control is the
 * interesting case: it changes which *boxes* exist, so it looks like it should reach the output.
 * It does not, and the cost is stated where it is paid — a folded network is not available
 * downstream — because the alternative is that nudging a figure's density re-runs a connectome
 * query.
 *
 * **The layering is a picker and empty means longest path**, never a column guessed by name.
 * `flowChartOps.ts`' header argues that one at length; the short version is that a column and
 * longest-path depth are different pictures, both internally consistent, and only the reader
 * knows which they asked for. A `Paths` network carries `hop`, which is longest-path layering by
 * construction and so agrees with the empty picker; anything assembled from a ball rather than
 * from routes wants a column of its own. (`Influence` used to be the worked example here and is
 * no longer wired for it: it emits a layered *flow* now, which `out.sankey` draws — a node-link
 * diagram of a ball invites tracing a route through paths that are not on the page.)
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { ColumnData } from '../../core/values'
import { getColumn, isNetworkValue, makeTable } from '../../core/values'
import { FLOW_NODES_WARN } from '../lib/flowChartOps'
import { networkSelectionSchema } from '../lib/networkSelection'
import { colorParams } from '../lib/encodingParams'

registerNode({
  type: 'out.flowChart',
  label: 'Flow Chart',
  category: 'visualisation',
  /*
   * The description carries the two words somebody searches for and the palette does not
   * otherwise hold — "circuit diagram" is what this figure is called in the literature, and
   * "Flow Chart" is what the shape is called everywhere else. `catalogue.ts` runs at `lean` and
   * drops every `help` string, so this line is also the assistant's only prose about the node.
   */
  description:
    'Draw a small network as a feed-forward circuit diagram: labelled boxes in layers, arrows weighted by connection strength.',
  /*
   * Under 400 characters, which `help.test.ts` enforces for a node that has a document: the
   * overlay prints this above the document under a `TL;DR` label. What this used to also say
   * about the layering lives in `src/help/nodes/out.flowChart.md`.
   */
  guide:
    'The circuit diagram of a feed-forward pathway — boxes in columns, arrows as thick as the ' +
    'connection is strong, the synapse count on them. Made for the dozen nodes a shortest-path ' +
    'result comes back with, where the Network Viewer’s force layout has nothing to arrange. ' +
    'Feedback connections are drawn dashed rather than hidden.',
  cost: 'cheap',
  // A viewer's card fills its wrapper — `category: 'visualisation'` is what makes that true.
  defaultSize: { width: 560, height: 380 },

  /*
   * Tabs for the expanded view's styling panel, `out.network`'s three-way split narrowed to what
   * this node has: the boxes, the arrows, and the arrangement. No `filter` tab, because nothing
   * here changes what the output carries — see the header on `Fold`.
   */
  paramGroups: [
    { id: 'node', label: 'Box' },
    { id: 'link', label: 'Arrow' },
    { id: 'layout', label: 'Layout' },
  ],

  inputs: [{ id: 'in', label: 'Network', type: T.network() }],
  outputs: [
    { id: 'out', label: 'Network', type: T.network() },
    { id: 'selected', label: 'Selected', type: T.neurons() },
  ],

  params: [
    // ---- Layout ----------------------------------------------------------
    {
      id: 'direction',
      kind: 'enum',
      label: 'Direction',
      default: 'lr',
      presentational: true,
      group: 'layout',
      options: [
        { value: 'lr', label: 'left to right' },
        { value: 'tb', label: 'top to bottom' },
      ],
      help: 'Which way the signal flows. Left to right fits more layers on a wide card; top to bottom fits more boxes per layer.',
    },
    {
      id: 'layerColumn',
      kind: 'column',
      label: 'Layer by',
      from: 'in',
      part: 'nodes',
      default: '',
      /*
       * `optional`, and that is load-bearing rather than tidy. `resolveColumn`'s rule 3 hands a
       * *required* picker on its declared default the first compatible column, so a default of
       * `hop` would silently layer by whatever came first on a network that has no such column
       * — the failure recorded on `zapbench.traces` and `out.scatter`. Empty is a decision here
       * and stays one.
       */
      optional: true,
      presentational: true,
      group: 'layout',
      help: 'Which column decides each box’s column in the drawing. Empty lays it out by longest path, which is right for a Paths result, whose hop column is longest-path layering already. Point it at a column of your own where the network was assembled some other way — and at one that runs in the direction the signal does, or every connection draws as feedback.',
    },
    {
      id: 'labelColumn',
      kind: 'column',
      label: 'Box label',
      from: 'in',
      part: 'nodes',
      default: '',
      optional: true,
      presentational: true,
      group: 'node',
      help: 'What each box says. Empty uses the node id, which on a neuron-level network is an 18-digit root id — point this at type or instance to get a readable diagram.',
    },
    {
      id: 'foldPerLayer',
      kind: 'int',
      label: 'Fold past',
      default: 0,
      min: 0,
      step: 1,
      presentational: true,
      group: 'layout',
      help: 'Keep this many boxes per layer, the busiest first, and fold the rest into one “+N others”. 0 keeps everything. Only the drawing changes — the Network output passes through whole.',
    },
    {
      id: 'routing',
      kind: 'enum',
      label: 'Arrows',
      default: 'orthogonal',
      presentational: true,
      group: 'link',
      options: [
        { value: 'orthogonal', label: 'right angles' },
        { value: 'curved', label: 'curves' },
        { value: 'straight', label: 'straight lines' },
      ],
      help: '"Right angles" and "curves" route around the boxes in between; "straight lines" joins the two ends directly and may cross whatever is in the way.',
    },

    // ---- Arrows ----------------------------------------------------------
    {
      id: 'weightedArrows',
      kind: 'boolean',
      label: 'Thickness by weight',
      default: true,
      presentational: true,
      group: 'link',
      help: 'Arrow thickness follows the connection weight. Off draws every arrow the same, which is the honest choice on a network whose weights are not comparable.',
    },
    {
      id: 'edgeLabels',
      kind: 'enum',
      label: 'Arrow labels',
      default: 'auto',
      presentational: true,
      group: 'link',
      options: [
        { value: 'auto', label: 'when there is room' },
        { value: 'on', label: 'always' },
        { value: 'off', label: 'never' },
      ],
      help: 'Print the weight on each arrow. "When there is room" draws them on a small diagram and drops them on a large one, and the caption says which happened.',
    },
    {
      id: 'edgeLabelColumn',
      kind: 'column',
      label: 'Label from',
      from: 'in',
      part: 'edges',
      default: '',
      optional: true,
      presentational: true,
      group: 'link',
      visibleIf: (params) => params.edgeLabels !== 'off',
      help: 'Which edge column is printed on the arrows. Empty prints the weight. Point it at weightNorm on a normalised Connectivity or Paths result to label them as fractions.',
    },

    // ---- Boxes -----------------------------------------------------------
    ...colorParams({
      prefix: 'node',
      from: 'in',
      part: 'nodes',
      label: 'Box colour',
      rowLabel: 'Colour',
      group: 'node',
      presentational: true,
      /*
       * A single colour by default, and `role` is what the *picker* starts on rather than what
       * gets drawn. Both halves matter.
       *
       * Constant, because `categorical` on a network with no `role` column falls to
       * `resolveColumn`'s rule 3 — the first compatible column, which on a network node table is
       * the id — and a categorical encoding over one value per row reads as category structure
       * where there is none. `ColorParamOptions.defaultColumn` carries that note.
       *
       * `role` all the same, because on a Paths network it is `source`/`target`/`via`, the one
       * encoding a route picture wants: switching the mode to categorical then lands on it
       * without a second choice.
       */
      defaultColumn: 'role',
      defaultMode: 'constant',
      defaultColor: 'muted',
    }),

    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'nodes',
      default: [],
      /*
       * The one control here that is not presentational: it lives in the saved file, takes part
       * in the provenance key and is undoable, because it is data flowing back out of a viewer.
       * `out.network`'s contract exactly.
       *
       * **Ids, not positions**, which is the opposite of `out.dendrogram`'s call and for the
       * reason that viewer records: a leaf label can repeat where a network node id is unique by
       * construction — it is the key the edge table joins on. So the stabler handle is available
       * here and is the one taken.
       */
      help: 'Set by clicking boxes in the viewer. Shift-click adds. Clicking a folded box selects the nodes behind it. Feeds Selected.',
    },
  ],

  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    const nodeSchema = input?.kind === 'network' ? input.nodeSchema : undefined
    return {
      out: input?.kind === 'network' ? input : T.network(),
      selected: T.neurons(networkSelectionSchema(nodeSchema)),
    }
  },

  evaluate: (ctx) => {
    const input = ctx.input('in')
    if (!isNetworkValue(input)) throw new Error('Input is not a network')

    /*
     * **Nothing here reads a single drawing control**, which is the property the node was
     * designed around rather than an omission: the network passes through by identity, so the
     * provenance key below it never moves when a figure is restyled. The fold in particular is
     * not applied — see the header.
     */
    /*
     * A count past the threshold is an admission, and it is made here rather than in `validate`
     * because `validate` is edit time and has types, not values — a network's *node count* is
     * data. Deliberately not `warnOverThreshold`, whose sentence ends "cancel and filter
     * upstream": there is nothing to cancel, this node is `cheap` and has already finished. The
     * `FOUND_NEURONS_WARN` precedent, for the same reason. A warning and never a refusal — the
     * picture still draws; what a reader needs is to know this is the wrong node for what they
     * wired in. `docs/limits.md` carries the row.
     */
    if (input.nodes.length > FLOW_NODES_WARN) {
      ctx.warn(
        `${input.nodes.length.toLocaleString()} nodes is past what a flow chart separates ` +
          `well (${FLOW_NODES_WARN.toLocaleString()}). Raise Fold past to group each layer's ` +
          `tail, filter upstream, or use the Network Viewer, whose force layout is built for ` +
          `a graph this size.`,
      )
    }

    const wanted = new Set(
      (Array.isArray(ctx.params.selection) ? ctx.params.selection : []).map(String),
    )

    /*
     * Column-wise, which is `out.network`'s shape — the two nodes fill one schema and the only
     * thing they may differ on is where the rows come from. Row-wise, as this was, the per-cell
     * `col.name === 'neuronId'` branch re-asked a question whose answer is fixed per column, and
     * a reader diffing the two files had to normalise the shape before the real difference
     * surfaced.
     *
     * The rows are found first, because nothing clicked is the ordinary state and the node count
     * is only *warned* about: scanning would stringify every id of a 36,000-node network to
     * answer with no rows at all.
     */
    const schema = networkSelectionSchema(input.nodes.schema)
    const ids = getColumn(input.nodes, 'id')
    const keep: number[] = []
    if (wanted.size > 0) {
      for (let row = 0; row < input.nodes.length; row++) {
        if (wanted.has(String(ids[row] ?? ''))) keep.push(row)
      }
    }

    const data: Record<string, ColumnData> = {}
    // Text, never `Number(...)`: `networkSelection.ts` carries the argument and invariant 8 the
    // failure it prevents.
    data['neuronId'] = keep.map((row) => String(ids[row] ?? ''))
    for (const col of schema.columns) {
      if (col.name === 'neuronId') continue
      const source = input.nodes.data[col.name] ?? []
      data[col.name] = keep.map((row) => source[row] ?? null)
    }

    return { out: input, selected: makeTable(schema, data, 'neurons') }
  },
})
