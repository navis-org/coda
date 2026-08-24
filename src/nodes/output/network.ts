/**
 * Network viewer node.
 *
 * Two outputs: the network passes through (viewers are taps, not dead ends) and a
 * `Selected` neuron table carries whatever you clicked in the viewer.
 *
 * That selection is the one place data flows *back* from a viewer into the graph, so it is
 * deliberately NOT presentational: it lives in the saved file, takes part in the provenance
 * key, and is undoable. Everything else here is presentational, so restyling never
 * invalidates the pipeline.
 */

import { registerNode } from '../../core/registry'
import type { TableSchema } from '../../core/types'
import { T, attributeSchema, column, tableSchema } from '../../core/types'
import type { ColumnData } from '../../core/values'
import { getColumn, isNetworkValue, makeTable } from '../../core/values'
import { colorParams, sizeParams } from '../lib/encodingParams'
import { filterNetwork } from '../lib/networkOps'

/**
 * Selection output schema: a `neuronId` column in front of the network's own node attributes.
 *
 * The output is typed `Neurons`, which promises `neuronId`, but network node ids are strings
 * — they may be neuron ids at neuron level or type names at type level. So neuronId is derived
 * by parsing the id, and is null when it isn't numeric. A type-level selection therefore
 * flows downstream as nulls and fails loudly at the next query rather than silently
 * pretending to be neurons.
 */
function selectionSchema(nodeSchema: TableSchema | undefined): TableSchema {
  const extra = (nodeSchema?.columns ?? []).filter((c) => c.name !== 'neuronId')
  return tableSchema(column('neuronId', 'i64'), ...extra)
}

export const networkViewNode = registerNode({
  type: 'out.network',
  label: 'Network Viewer',
  category: 'visualisation',
  description: 'Node-link view of a network, with data-driven colour and size.',
  guide:
    'Draw an interactive network diagram: neurons or types as discs, connections as links, laid ' +
    'out by force, layers, a circle or a grouped ring. Colour and size are data-driven through ' +
    'the styling panel, and what you click leaves by the Selected port. Note that its three ' +
    'filters — minimum link weight, top N nodes, hide isolated — change what the node returns ' +
    'rather than only what it draws.',
  cost: 'cheap',
  /*
   * Tabs for the overlay's styling panel, Cytoscape's Style tab being the reference: the
   * node half and the link half of a network are styled separately, and layout is a third
   * concern that is not styling at all.
   *
   * Node first because it is what people reach for. Anything left ungrouped still reaches
   * the panel — see `groupParams` — so this is a reorganisation, never a gate.
   */
  paramGroups: [
    { id: 'node', label: 'Node' },
    { id: 'link', label: 'Link' },
    { id: 'layout', label: 'Layout' },
    // The odd one out, and flagged as such: everything else in this panel is presentational,
    // whereas these three change what the `out` port carries and stale everything downstream.
    { id: 'filter', label: 'Filter', affectsData: true },
  ],
  inputs: [
    { id: 'in', label: 'Network', type: T.network() },
    /*
     * Positions computed elsewhere — by `Paths`, or by anything else that knows more about
     * the arrangement than a generic algorithm can work out from the edges alone.
     *
     * An input rather than another entry in the `Layout` enum, because the positions are
     * *data*: they belong to a particular node set and are computed by whoever produced it.
     * It affects only the drawing, so `evaluate` ignores it entirely and wiring one up
     * invalidates nothing downstream — the same standing as every presentational param here,
     * arrived at by the value never reaching the output rather than by a flag.
     *
     * When connected it wins over the Layout param, and the caption says so: a control that
     * silently stops doing anything is worse than one that is visibly overridden.
     */
    { id: 'layout', label: 'Layout', type: T.layout(), required: false },
  ],
  outputs: [
    { id: 'out', label: 'Network', type: T.network() },
    { id: 'selected', label: 'Selected', type: T.neurons() },
  ],
  /*
   * **Only `Layout` reaches the card; everything else is `advanced`.**
   *
   * Thirty-three params is the largest set in the registry, and drawn as generic rows fifteen
   * of them showed at once on the default settings — a column of pickers stacked above the
   * drawing they configure, on the one node whose card is worth looking at. `advanced` here
   * costs nothing that a smaller node's would, because this node has two places for them to
   * go: they stay `presentational`, so the expanded view's styling panel offers every one
   * under the tab it was grouped for, and the inspector shows the full set for whatever is
   * selected. The card's `… N more` hint is what says they are there.
   *
   * `Layout` stays because it is the one control that decides what the picture *is* rather
   * than how it looks — and because a card drawing no rows at all would lose its `☰` fold and
   * read as a node with nothing to set, which is the state `out.neuroglancer` is in and which
   * a viewer this configurable should not be mistaken for.
   *
   * `selection` goes too, though it is neither styling nor layout. Its row said
   * `3 nodes · clear`, which the caption already says and clicking the canvas already does.
   */
  params: [
    {
      id: 'layout',
      kind: 'enum',
      label: 'Layout',
      default: 'forceatlas2',
      presentational: true,
      group: 'layout',
      // The algorithm's own knobs hang off it as extras: `visibleIf` already ensures only
      // the ones the current algorithm uses are showing.
      composite: { key: 'layout', role: 'primary', label: 'Layout' },
      options: [
        { value: 'forceatlas2', label: 'force-directed' },
        { value: 'circular', label: 'circular' },
        { value: 'layered', label: 'layered (feed-forward)' },
        { value: 'spectral', label: 'spectral' },
        { value: 'grouped', label: 'grouped by column' },
        { value: 'columns', label: 'from columns' },
      ],
    },
    {
      id: 'seed',
      kind: 'enum',
      label: 'Start from',
      default: 'circle',
      options: [
        { value: 'circle', label: 'circle' },
        { value: 'spectral', label: 'spectral embedding' },
      ],
      help:
        'Where the force layout begins. A spectral start should hand it the global ' +
        'arrangement and leave only local refinement — worth trying on a large graph, though ' +
        'no synthetic benchmark here could show the win, so the circle remains the default.',
      presentational: true,
      advanced: true,
      group: 'layout',
      composite: { key: 'layout', role: 'extra', facet: 'start from' },
      visibleIf: (params) => params.layout === 'forceatlas2',
    },
    {
      id: 'barnesHut',
      kind: 'enum',
      label: 'Quadtree',
      default: 'auto',
      options: [
        { value: 'auto', label: 'auto (on above 2k nodes)' },
        { value: 'on', label: 'always' },
        { value: 'off', label: 'never' },
      ],
      help:
        'Barnes-Hut approximation of the repulsion. Worth about 3× at 3,000 nodes and 5× at ' +
        '6,000; on automatically above 2,000, where the approximation stops being visible.',
      presentational: true,
      advanced: true,
      group: 'layout',
      composite: { key: 'layout', role: 'extra', facet: 'quadtree' },
      visibleIf: (params) => params.layout === 'forceatlas2',
    },
    {
      id: 'weightInfluence',
      kind: 'number',
      label: 'Weight pull',
      default: 1,
      min: 0,
      max: 1,
      step: 0.1,
      help:
        'How much a link’s weight pulls its endpoints together. Synapse counts are heavy-tailed, ' +
        'so a proportional pull lets a few very strong links dominate — lower it if strongly ' +
        'connected pairs collapse onto each other. Note 0 removes weight from the pull only: a ' +
        'node’s mass stays its weighted degree, so weight still tells in the spacing.',
      presentational: true,
      advanced: true,
      group: 'layout',
      composite: { key: 'layout', role: 'extra', facet: 'weight pull' },
      visibleIf: (params) => params.layout === 'forceatlas2',
    },
    {
      id: 'layoutOrientation',
      kind: 'enum',
      label: 'Direction',
      default: 'lr',
      options: [
        { value: 'lr', label: 'left to right' },
        { value: 'tb', label: 'top to bottom' },
      ],
      presentational: true,
      advanced: true,
      group: 'layout',
      composite: { key: 'layout', role: 'extra', facet: 'direction' },
      visibleIf: (params) => params.layout === 'layered',
    },
    {
      id: 'layerColumn',
      kind: 'column',
      label: 'Layer by',
      from: 'in',
      part: 'nodes',
      default: '',
      optional: true,
      help: 'Take each layer from this column instead of from how far downstream a node is.',
      presentational: true,
      advanced: true,
      group: 'layout',
      composite: { key: 'layout', role: 'extra', facet: 'layer by' },
      visibleIf: (params) => params.layout === 'layered',
    },
    {
      id: 'groupColumn',
      kind: 'column',
      label: 'Group by',
      from: 'in',
      part: 'nodes',
      default: '',
      help: 'Cluster nodes sharing a value — a class, a side, an ROI.',
      presentational: true,
      advanced: true,
      group: 'layout',
      composite: { key: 'layout', role: 'extra', facet: 'group by' },
      visibleIf: (params) => params.layout === 'grouped',
    },
    {
      id: 'iterations',
      kind: 'int',
      label: 'Iterations',
      default: 220,
      min: 10,
      max: 100000,
      step: 20,
      presentational: true,
      advanced: true,
      group: 'layout',
      composite: { key: 'layout', role: 'extra', facet: 'iterations' },
      visibleIf: (params) => params.layout === 'forceatlas2',
    },
    {
      id: 'xColumn',
      kind: 'column',
      label: 'X',
      from: 'in',
      part: 'nodes',
      default: '',
      presentational: true,
      advanced: true,
      group: 'layout',
      composite: { key: 'layout', role: 'extra', facet: 'x' },
      visibleIf: (params) => params.layout === 'columns',
    },
    {
      id: 'yColumn',
      kind: 'column',
      label: 'Y',
      from: 'in',
      part: 'nodes',
      default: '',
      presentational: true,
      advanced: true,
      group: 'layout',
      composite: { key: 'layout', role: 'extra', facet: 'y' },
      visibleIf: (params) => params.layout === 'columns',
    },

    ...colorParams({
      prefix: 'node',
      allowLiteral: true,
      from: 'in',
      part: 'nodes',
      label: 'Node colour',
      rowLabel: 'Colour',
      group: 'node',
      defaultMode: 'categorical',
      advanced: true,
    }),
    ...sizeParams({
      prefix: 'node',
      from: 'in',
      part: 'nodes',
      label: 'Node size',
      rowLabel: 'Size',
      group: 'node',
      defaultMin: 4,
      defaultMax: 18,
      advanced: true,
    }),
    {
      id: 'nodeBorderWidth',
      kind: 'number',
      label: 'Border',
      help: 'Outline in the background colour, so a node stays legible on a bundle of links. 0 removes it.',
      default: 1,
      min: 0,
      max: 4,
      step: 0.5,
      presentational: true,
      advanced: true,
      group: 'node',
      composite: { key: 'nodeBorder', role: 'primary', label: 'Border' },
    },
    /*
     * No `sequential` here, and it is a measured exclusion rather than an oversight.
     *
     * A link is a 0.5–6px line. The blue ramp's receding end is 1.46:1 against the dark
     * surface — fine under a heatmap cell or a node disc, where a low value *should* recede
     * into the page, and invisible on a hairline. Clamping the ramp to clear the 3:1 non-text
     * floor works, but squeezes adjacent steps to ΔL 0.047 against a 0.06 floor, so it buys
     * visibility with step separation. Link weight already has an honest channel in `Width`.
     */
    ...colorParams({
      prefix: 'edge',
      from: 'in',
      part: 'edges',
      label: 'Link colour',
      rowLabel: 'Colour',
      group: 'link',
      defaultMode: 'constant',
      // `muted` is the ink links have always been drawn in, so the default is a no-op.
      defaultColor: 'muted',
      modes: ['categorical'],
      advanced: true,
    }),
    {
      id: 'edgeOpacity',
      kind: 'number',
      label: 'Link opacity',
      help: 'Fade every link. The cheapest way to read a dense graph without dropping links.',
      default: 1,
      min: 0.1,
      max: 1,
      step: 0.1,
      presentational: true,
      advanced: true,
      group: 'link',
      composite: { key: 'edgeColor', role: 'extra', facet: 'opacity' },
    },
    ...sizeParams({
      prefix: 'edge',
      from: 'in',
      part: 'edges',
      label: 'Link width',
      rowLabel: 'Width',
      group: 'link',
      defaultMin: 0.5,
      defaultMax: 6,
      advanced: true,
    }),
    {
      id: 'showLabels',
      kind: 'boolean',
      label: 'Labels',
      default: true,
      presentational: true,
      advanced: true,
      group: 'node',
      composite: { key: 'nodeLabel', role: 'primary', label: 'Label' },
    },
    {
      id: 'labelColumn',
      kind: 'column',
      label: 'Label',
      from: 'in',
      part: 'nodes',
      default: '',
      presentational: true,
      advanced: true,
      group: 'node',
      composite: { key: 'nodeLabel', role: 'value' },
      visibleIf: (params) => params.showLabels !== false,
    },
    {
      id: 'arrows',
      kind: 'boolean',
      label: 'Arrows',
      default: true,
      presentational: true,
      advanced: true,
      group: 'link',
      help: 'Arrowheads at the target end. Ignored on an undirected network.',
    },
    {
      id: 'edgeLabels',
      kind: 'boolean',
      label: 'Link labels',
      default: false,
      presentational: true,
      advanced: true,
      group: 'link',
      composite: { key: 'edgeLabel', role: 'primary', label: 'Label' },
      help: 'Print each link’s weight beside it. Unreadable past a few hundred links.',
    },
    {
      id: 'edgeLabelColumn',
      kind: 'column',
      label: 'Link label',
      from: 'in',
      part: 'edges',
      default: '',
      presentational: true,
      advanced: true,
      optional: true,
      group: 'link',
      composite: { key: 'edgeLabel', role: 'value' },
      visibleIf: (params) => params.edgeLabels === true,
    },
    /*
     * Filters. Not presentational — they change what `evaluate` returns, so they belong in
     * the provenance key and they do mark the graph stale. `out.network` is `cheap`, so the
     * redraw still arrives on the ordinary 180ms pass and dragging a threshold reads as live;
     * what it costs is the expensive nodes downstream, which is the trade this node makes on
     * purpose rather than filtering only the picture and letting the two disagree.
     */
    {
      id: 'minLinkWeight',
      kind: 'number',
      label: 'Min link weight',
      help: 'Drop links below this weight. Applied before the node ranking.',
      default: 0,
      min: 0,
      step: 1,
      advanced: true,
      group: 'filter',
    },
    {
      id: 'topNodes',
      kind: 'int',
      label: 'Top nodes',
      help: 'Keep only this many nodes, ranked by total attached weight. 0 keeps all of them.',
      default: 0,
      min: 0,
      step: 10,
      advanced: true,
      group: 'filter',
    },
    {
      id: 'hideIsolated',
      kind: 'boolean',
      label: 'Hide isolated',
      help: 'Drop nodes left with no links, including ones stranded by the filters above.',
      default: false,
      advanced: true,
      group: 'filter',
    },
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'nodes',
      default: [],
      advanced: true,
      help: 'Set by clicking nodes in the viewer. Feeds the Selected output.',
    },
  ],

  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    const nodeSchema = attributeSchema(input, 'nodes')
    return {
      out: input?.kind === 'network' ? input : T.network(),
      // The selection carries the network's own node attributes, so a downstream Filter
      // sees the same columns the viewer coloured by.
      selected: T.neurons(selectionSchema(nodeSchema)),
    }
  },

  evaluate: (ctx) => {
    const input = ctx.input('in')
    if (!isNetworkValue(input)) throw new Error('Input is not a network')

    // Filtering happens here rather than in the viewer, so the picture and the `out` port
    // can never disagree — see `networkOps.ts`.
    const { network } = filterNetwork(input, {
      minWeight: Number(ctx.params.minLinkWeight ?? 0),
      topNodes: Number(ctx.params.topNodes ?? 0),
      hideIsolated: ctx.params.hideIsolated === true,
    })

    const selection = new Set(
      (Array.isArray(ctx.params.selection) ? ctx.params.selection : []).map(String),
    )

    const ids = getColumn(network.nodes, 'id')
    const keep: number[] = []
    for (let i = 0; i < network.nodes.length; i++) {
      if (selection.has(String(ids[i]))) keep.push(i)
    }

    // Emit a neurons-shaped table so the selection plugs straight into Connectivity et al.
    const schema = selectionSchema(network.nodes.schema)
    const data: Record<string, ColumnData> = {}
    data['neuronId'] = keep.map((index) => {
      const parsed = Number(ids[index])
      return Number.isFinite(parsed) ? parsed : null
    })
    for (const col of schema.columns) {
      if (col.name === 'neuronId') continue
      const source = network.nodes.data[col.name] ?? []
      data[col.name] = keep.map((index) => source[index] ?? null)
    }
    const selected = makeTable(schema, data, 'neurons')

    return { out: network, selected }
  },
})
