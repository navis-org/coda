/**
 * Workflows written by hand for the nodes the demo search shows badly.
 *
 * `demo.ts` builds a `demo://` workflow by searching the wizard's own graphs for one the node can
 * be attached to. That is right for most of the registry, and exactly right where the node *is*
 * the wizard's end — a Sankey, a Heatmap. For a node that transforms something it is often wrong,
 * because the search asks what type-checks and never what the node is *for*. Audited, Select
 * Neurons came out selecting the very list its skeletons were fetched with, Split Neurons had no
 * rule so everything went to Rest, and Points in Volumes tested synapses against the neurons' own
 * meshes rather than against brain regions. So for those types this table answers first, and
 * every surface that opens a `demo://` workflow — the node guide, the in-app `?`, the changelog,
 * a link somebody typed — gets it.
 *
 * An example names the **types** it demonstrates (one workflow can show two nodes that belong
 * together) and a **focus** card. `curated.test.ts` runs every example on the synthetic dataset
 * and refuses one whose focus comes out empty on any output — the failure the search produced.
 * They arrive through `demoGraph`, so `demo.test.ts` holds each to the inference checks every
 * demo meets, and `placeGuards.test.ts` sweeps them for overlapping cards.
 *
 * Every example runs on the synthetic dataset, so it opens without an account and reaches no
 * server — **except those whose node has nothing to show there.** A Cortex node needs a cortical
 * frame, which only a published dataset has, and the demo search's own answer for it was a
 * MICrONS chain on "latest" with an empty search. Such an example sets its own `ds` card — a
 * version pinned, so the picture does not move as the dataset does — and says what it needs in
 * `published`, which replaces the synthetic note. `curated.test.ts` runs only the synthetic ones;
 * every example meets the inference and placement sweeps alike.
 */

import type { CodaGraph, GraphNode, Wire } from '../core/graph'
import { inputPorts } from '../core/ports'
import { requireNodeDef } from '../core/registry'
import { encodeRows, type FilterRow } from '../data/filterRows'
import { GRID_ORIGIN, placeInColumns } from '../layout/columns'
import { assembleGraph, graphNode } from './assemble'
import { DEMO_DATASET, type Placement } from './build'
import { SYNTHETIC_NOTE, noteNode } from './notes'

/**
 * The row for a card under a tall one — Find Neurons with a filter row, Filter Table. Rows are a
 * fixed 190px (`layout/columns.ts`), which such a card overruns; nothing knows a card's height
 * before the canvas draws it. Two viewers instead share a row, side by side, since a viewer grows
 * when it runs and one stacked under another would overlap it.
 */
const UNDER_TALL = 1.2

export interface ExampleSpec {
  /** The node types this workflow is the demo for. */
  types: readonly string[]
  /** What the example is about: the note's heading, and the document's name. */
  title: string
  /** What the note above the workflow says: what it shows and what to try. Markdown. */
  about: string
  /**
   * The card the example is about. `curated.test.ts` runs every example and refuses one whose
   * focus card produces nothing on any output — the failure the searched demos had.
   */
  focus: string
  cards: Placement[]
  wires: Wire[]
  /**
   * For an example on a published dataset (its `ds` card is not the synthetic one): what it needs
   * to open, said in the note where the synthetic one says its data is made up. Markdown.
   */
  published?: string
}

const DS = { id: 'ds', type: `dataset.${DEMO_DATASET}` }
const rows = (...list: FilterRow[]) => ({ filters: encodeRows(list) })
const typeIs = (type: string): FilterRow => ({ field: 'type', op: 'is', values: [type] })
const typeStarts = (prefix: string): FilterRow => ({
  field: 'type',
  op: 'startsWith',
  values: [prefix],
})
const find = (id: string, filter: FilterRow, row?: number): Placement => ({
  id,
  type: 'neuron.findNeurons',
  params: rows(filter),
  ...(row === undefined ? {} : { row }),
})

const BY_TYPE = { skeletonColorMode: 'categorical', skeletonColorBy: 'type' }

/** Whether an example runs on the synthetic dataset — every one without its own `published`. */
export const isSynthetic = (spec: ExampleSpec): boolean => spec.published === undefined

const EXAMPLES: readonly ExampleSpec[] = [
  {
    types: ['neuron.selectNeurons'],
    focus: 'select',
    title: 'Select Neurons',
    about:
      'Skeletons are fetched once, for every T4 neuron. **Select Neurons** then picks out the ones a table names — here, the quarter of them with at least 200 postsynaptic sites — without fetching anything again.\n\n' +
      'Change the threshold on **Filter Table**, or wire any other table of neurons into the lower socket: a Table viewer’s filtered rows, a Scatter Plot’s selection.',
    cards: [
      DS,
      find('find', typeStarts('T4')),
      { id: 'skel', type: 'neuron.skeletons' },
      {
        id: 'filter',
        type: 'core.filterTable',
        row: UNDER_TALL,
        params: { column: 'post', op: 'ge', value: '200' },
      },
      { id: 'select', type: 'neuron.selectNeurons' },
      {
        id: 'view',
        type: 'out.viewer3d',
        params: BY_TYPE,
      },
    ],
    wires: [
      ['find', 'neurons', 'skel', 'neurons'],
      ['find', 'neurons', 'filter', 'in'],
      ['skel', 'skeletons', 'select', 'in'],
      ['filter', 'out', 'select', 'neurons'],
      ['select', 'out', 'view', 'skeletons'],
    ],
  },

  {
    types: ['neuron.splitNeurons'],
    focus: 'split',
    title: 'Split Neurons',
    about:
      '**Split Neurons** sends every skeleton to one of two outputs by a rule on its attributes. Here T4 and T5 neurons are fetched together and split by type, so each view gets one population.\n\n' +
      'Edit the rule on the card: a neuron either matches or goes to **Rest**, and none is dropped.',
    cards: [
      DS,
      find('find', { field: 'type', op: 'matches', values: ['T[45].*'] }),
      { id: 'skel', type: 'neuron.skeletons' },
      { id: 'split', type: 'neuron.splitNeurons', params: rows(typeStarts('T4')) },
      {
        id: 'viewT4',
        type: 'out.viewer3d',
        params: BY_TYPE,
      },
      {
        id: 'viewRest',
        type: 'out.viewer3d',
        params: BY_TYPE,
      },
    ],
    wires: [
      ['find', 'neurons', 'skel', 'neurons'],
      ['skel', 'skeletons', 'split', 'in'],
      ['split', 'matched', 'viewT4', 'skeletons'],
      ['split', 'rest', 'viewRest', 'skeletons'],
    ],
  },

  {
    types: ['neuron.synapsesBetween', 'neuron.synapseEdges'],
    focus: 'edges',
    title: 'Synapses Between',
    about:
      '**Synapses Between** fetches only the synapses from one set of neurons onto another — here T4 onto LPLC2 — and the 3D view draws them on LPLC2’s skeletons.\n\n' +
      '**Synapses to Edges** counts the same synapses into an edge list, one row per connected pair. Add a column under **Split by** to count per region.',
    cards: [
      DS,
      find('pre', typeStarts('T4')),
      find('post', typeIs('LPLC2'), UNDER_TALL),
      { id: 'between', type: 'neuron.synapsesBetween' },
      { id: 'skel', type: 'neuron.skeletons', row: UNDER_TALL },
      { id: 'edges', type: 'neuron.synapseEdges' },
      {
        id: 'view',
        type: 'out.viewer3d',
        params: {
          skeletonColorMode: 'constant',
          skeletonColor: 'muted',
          pointColorMode: 'categorical',
          pointColorBy: 'type',
          pointSize: 200,
        },
      },
      { id: 'table', type: 'out.table' },
    ],
    wires: [
      ['pre', 'neurons', 'between', 'sources'],
      ['post', 'neurons', 'between', 'targets'],
      ['post', 'neurons', 'skel', 'neurons'],
      ['between', 'points', 'edges', 'in'],
      ['between', 'points', 'view', 'points'],
      ['skel', 'skeletons', 'view', 'skeletons'],
      ['edges', 'out', 'table', 'in'],
    ],
  },

  {
    types: ['neuron.pointsInVolumes'],
    focus: 'inside',
    title: 'Points in Volumes',
    about:
      'A synapse carries no region of its own. **Points in Volumes** tests each one against a set of meshes — here the medulla and the lobula plate — and writes the one it sits in to a `roi` column.\n\n' +
      'T4a neurons take their inputs in the medulla and make their outputs in the lobula plate, which the colours show. Points outside every volume leave by the second output.',
    cards: [
      DS,
      find('find', typeIs('T4a')),
      { id: 'syn', type: 'neuron.synapses' },
      {
        id: 'rois',
        type: 'neuron.roiMeshes',
        row: UNDER_TALL,
        params: { rois: ['ME(R)', 'LOP(R)'] },
      },
      { id: 'inside', type: 'neuron.pointsInVolumes' },
      {
        id: 'view',
        type: 'out.viewer3d',
        params: { pointColorMode: 'categorical', pointColorBy: 'roi', pointSize: 200 },
      },
    ],
    wires: [
      ['find', 'neurons', 'syn', 'neurons'],
      ['syn', 'points', 'inside', 'points'],
      ['rois', 'meshes', 'inside', 'volumes'],
      ['inside', 'inside', 'view', 'points'],
      ['rois', 'meshes', 'view', 'volumes'],
    ],
  },

  {
    types: ['neuron.distance'],
    focus: 'distance',
    title: 'Distance between',
    about:
      '**Distance between** measures how close two sets of neurons come, from their skeletons: here each T4a neuron against each LPLC2 neuron, as the closest approach between the two.\n\n' +
      'Switch **Statistic** to mean or median for a distance over the whole arbour, or **Method** to *within* to ask what fraction of one neuron lies near the other.',
    cards: [
      DS,
      find('query', typeIs('T4a')),
      find('target', typeIs('LPLC2'), UNDER_TALL),
      { id: 'qskel', type: 'neuron.skeletons' },
      { id: 'tskel', type: 'neuron.skeletons', row: UNDER_TALL },
      { id: 'distance', type: 'neuron.distance' },
      { id: 'heatmap', type: 'out.heatmap' },
    ],
    wires: [
      ['query', 'neurons', 'qskel', 'neurons'],
      ['target', 'neurons', 'tskel', 'neurons'],
      ['qskel', 'skeletons', 'distance', 'query'],
      ['tskel', 'skeletons', 'distance', 'target'],
      ['distance', 'matrix', 'heatmap', 'in'],
    ],
  },

  {
    types: ['core.embed'],
    focus: 'embed',
    title: 'Embedding',
    about:
      'Each neuron is described by whom it connects to (**Partner Vectors**), and **Embedding** lays those descriptions out in two dimensions with UMAP: neurons with similar partners land close together.\n\n' +
      'Colour is cell type, which the embedding never saw — so types that form their own islands are types their connectivity alone tells apart. The seed makes the layout the same every run.',
    cards: [
      DS,
      find('find', { field: 'type', op: 'notEmpty', values: [] }),
      { id: 'conn', type: 'neuron.connectivity', params: { direction: 'both', minWeight: 3 } },
      { id: 'vectors', type: 'neuron.partnerVectors' },
      {
        id: 'embed',
        type: 'core.embed',
        params: { observations: 'neuronId', featureColumn: 'feature', value: 'weight' },
      },
      {
        id: 'scatter',
        type: 'out.scatter',
        params: {
          x: 'umap1',
          y: 'umap2',
          pointColorMode: 'categorical',
          pointColorBy: 'annotation',
          idColumn: 'label',
        },
      },
    ],
    wires: [
      ['find', 'neurons', 'conn', 'neurons'],
      ['conn', 'connections', 'vectors', 'in'],
      ['find', 'neurons', 'vectors', 'neurons'],
      ['vectors', 'out', 'embed', 'features'],
      ['find', 'neurons', 'embed', 'annotations'],
      ['embed', 'out', 'scatter', 'in'],
    ],
  },

  {
    types: ['core.reduceMatrix', 'neuron.attachAttributes'],
    focus: 'attach',
    title: 'Reduce Matrix and Attach Attributes',
    about:
      '**Adjacency** counts the synapses from every T4a neuron onto every LPLC2 neuron. **Reduce Matrix** sums each row, giving one number per T4a neuron, and **Attach Attributes** puts that number on its skeleton — so the 3D view can colour each neuron by how strongly it drives LPLC2.\n\n' +
      'Try `mean` or `max` in **Reduce Matrix**, or reduce the columns instead to ask the same of each LPLC2 neuron.',
    cards: [
      DS,
      find('pre', typeIs('T4a')),
      find('post', typeIs('LPLC2'), UNDER_TALL),
      { id: 'adj', type: 'neuron.adjacency', params: { groupByType: false } },
      { id: 'skel', type: 'neuron.skeletons', row: UNDER_TALL },
      { id: 'reduce', type: 'core.reduceMatrix', params: { stats: ['sum'] } },
      { id: 'attach', type: 'neuron.attachAttributes', params: { matchOn: 'label' } },
      {
        id: 'view',
        type: 'out.viewer3d',
        params: { skeletonColorMode: 'sequential', skeletonColorBy: 'sum' },
      },
    ],
    wires: [
      ['pre', 'neurons', 'adj', 'sources'],
      ['post', 'neurons', 'adj', 'targets'],
      ['pre', 'neurons', 'skel', 'neurons'],
      ['adj', 'matrix', 'reduce', 'in'],
      ['skel', 'skeletons', 'attach', 'in'],
      ['reduce', 'out', 'attach', 'table'],
      ['attach', 'out', 'view', 'skeletons'],
    ],
  },
]

/**
 * MICrONS minnie65 as the published examples use it: one materialization, so the two cannot drift
 * apart or away from the note naming it, and three cells whose inputs sit in different layers — a
 * neurogliaform cell (L1), a bipolar interneuron (L2/3) and a layer-4 pyramidal cell.
 */
const MINNIE_VERSION = '1822'
const MINNIE = {
  card: { id: 'ds', type: 'dataset.minnie65', params: { version: MINNIE_VERSION } },
  cells: ['864691136314078013', '864691135119630813', '864691135274968337'],
  // Italic like `SYNTHETIC_NOTE`, whose place it takes — and so nothing bold inside it, which
  // would render as literal asterisks.
  note: `*Real data from MICrONS minnie65, pinned to materialization ${MINNIE_VERSION}. It needs a CAVE sign-in, under Connections (the branch icon in the toolbar).*`,
} as const

/*
 * Last, being the ones on a published dataset: the Cortex pack's, which have nothing to show on
 * synthetic data — no synthetic dataset has a cortical frame.
 */
const PUBLISHED: readonly ExampleSpec[] = [
  {
    types: ['cortex:gallery'],
    focus: 'gallery',
    title: 'Cortex Gallery',
    about:
      'Every MICrONS cell with a proofread arbour, drawn side by side against depth with the layers behind them, grouped by type. Three are selected already — a neurogliaform cell, a bipolar interneuron and a layer-4 pyramidal cell — and go on as a table and as skeletons.\n\n' +
      'Click cells on the wall to change the selection, or open the card full size to browse by type.',
    published: MINNIE.note,
    cards: [
      MINNIE.card,
      {
        id: 'gallery',
        type: 'cortex:gallery',
        params: { selection: [...MINNIE.cells] },
      },
      { id: 'table', type: 'out.table' },
      // The skeletons carry the gallery's typing, so the scene colours by the type the wall shows.
      { id: 'view', type: 'out.viewer3d', row: UNDER_TALL, params: BY_TYPE },
    ],
    wires: [
      ['gallery', 'selected', 'table', 'in'],
      ['gallery', 'skeletons', 'view', 'skeletons'],
    ],
  },
  {
    types: ['cortex:laminarProfile', 'cortex:depth'],
    focus: 'depth',
    title: 'Laminar Profile',
    about:
      'Three MICrONS cells whose inputs sit in different layers: a neurogliaform cell, a bipolar interneuron and a layer-4 pyramidal cell. **Synapses** fetches their inputs, **Cortical Depth** places each one below the pia and types its partner, and **Laminar Profile** draws them against the layers, one panel per cell type.\n\n' +
      'Paste other root ids into **Input IDs**, or set **Facet by** to `neuronId` for a panel per neuron.',
    published: MINNIE.note,
    cards: [
      MINNIE.card,
      {
        id: 'ids',
        type: 'neuron.inputIds',
        params: { ids: MINNIE.cells.join('\n') },
      },
      { id: 'syn', type: 'neuron.synapses', params: { polarity: 'post' } },
      { id: 'depth', type: 'cortex:depth' },
      {
        id: 'view',
        type: 'cortex:laminarProfile',
        params: { facet: 'type', normalize: 'percent' },
      },
    ],
    wires: [
      ['ids', 'neurons', 'syn', 'neurons'],
      ['syn', 'points', 'depth', 'points'],
      ['depth', 'table', 'view', 'in'],
    ],
  },
]

/** Every example, for the tests. */
export const CURATED: readonly ExampleSpec[] = [...EXAMPLES, ...PUBLISHED]

/** Which example answers for each node type. */
const BY_NODE_TYPE = new Map(CURATED.flatMap((spec) => spec.types.map((type) => [type, spec])))

/** Whether a node type's demo is written by hand here rather than found by the search. */
export const isCurated = (type: string): boolean => BY_NODE_TYPE.has(type)

/** The hand-written workflow for a node type, or undefined for a type the search answers. */
export function curatedGraph(type: string): CodaGraph | undefined {
  const spec = BY_NODE_TYPE.get(type)
  return spec && exampleGraph(spec)
}

/** Height of the note above the workflow, and the gap under it. */
const NOTE = { width: 720, height: 210, gap: 30 }

/**
 * The example as a graph: the dataset wired into every card with a `dataset` socket, the cards
 * placed in columns by dataflow, the note above them.
 */
export function exampleGraph(spec: ExampleSpec): CodaGraph {
  const fromDataset: Wire[] = spec.cards
    .filter(
      (c) =>
        c.id !== DS.id &&
        inputPorts(requireNodeDef(c.type), {}).some((p) => p.id === 'dataset'),
    )
    .map((c) => [DS.id, 'dataset', c.id, 'dataset'])
  const wires = [...fromDataset, ...spec.wires]
  const origin = { x: GRID_ORIGIN.x, y: GRID_ORIGIN.y + NOTE.height + NOTE.gap }
  const at = placeInColumns(
    spec.cards.map((c) => ({ id: c.id, type: c.type, row: c.row ?? 0 })),
    wires,
    origin,
  )
  const nodes: GraphNode[] = spec.cards.map((c) =>
    graphNode(c.id, c.type, at.get(c.id) ?? origin, c.params),
  )
  nodes.push(
    noteNode({
      id: 'note-example',
      x: GRID_ORIGIN.x,
      y: GRID_ORIGIN.y,
      width: NOTE.width,
      height: NOTE.height,
      text: `### ${spec.title}\n\n${spec.about}\n\n${spec.published ?? SYNTHETIC_NOTE}`,
    }),
  )
  return assembleGraph(`Example · ${spec.title}`, spec.about, nodes, wires)
}
