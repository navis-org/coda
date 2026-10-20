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

/**
 * Fit Model's demo runs its simulation and its fit at one step, so the recording and the fit are the
 * same arithmetic and the membrane comes back exactly rather than to the step's discretisation.
 */
const FIT_STEP = 0.025

/**
 * Both of that demo's models cut by length rather than by d_lambda: d_lambda cuts by Ra·Cm, so two
 * models with different membranes get different compartments, and a fit only rescales the tree it
 * starts from — the recording would come from another discretisation than the one fitted.
 */
const FIXED_CUT = { discretisation: 'maxLength' }

const EXAMPLES: readonly ExampleSpec[] = [
  {
    types: ['connectome:customDataset'],
    focus: 'custom',
    title: 'Custom Dataset',
    about:
      '**Custom Dataset** assembles a dataset from parts. Here every part comes from the synthetic connectome — the T4 neurons as the neuron table, their outgoing connections as the edge list, its skeletons as geometry — and the cards below it query the result like any other dataset.\n\n' +
      'Swap a part for your own: a sheet of cell types into **Neurons**, a Link Table file of connections or synapses into **Edges** or **Synapses**.',
    cards: [
      DS,
      find('find', typeStarts('T4')),
      {
        id: 'conn',
        type: 'neuron.connectivity',
        params: { direction: 'outputs', minWeight: 3 },
      },
      {
        id: 'custom',
        type: 'connectome:customDataset',
        params: { name: 'T4 and its targets', pre: 'preId', post: 'postId', weight: 'weight' },
      },
      find('again', typeStarts('T4'), UNDER_TALL),
      { id: 'skel', type: 'neuron.skeletons' },
      { id: 'view', type: 'out.viewer3d', params: BY_TYPE },
    ],
    wires: [
      ['find', 'neurons', 'conn', 'neurons'],
      ['find', 'neurons', 'custom', 'neurons'],
      ['conn', 'connections', 'custom', 'edges'],
      [DS.id, 'dataset', 'custom', 'skeletons'],
      ['custom', 'dataset', 'again', 'dataset'],
      ['custom', 'dataset', 'skel', 'dataset'],
      ['again', 'neurons', 'skel', 'neurons'],
      ['skel', 'skeletons', 'view', 'skeletons'],
    ],
  },

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
    types: ['connectome:connectionCompartments'],
    focus: 'compartments',
    title: 'Connection Compartments',
    about:
      'The T4a neurons’ outgoing connections, with each connection’s synapses counted by the compartment at either end: axo-dendritic, axo-axonic and so on. **Split Axon/Dendrite** labels the skeletons first, and the skeletons are fetched for Connectivity’s **Neuron Set**, so the neurons at both ends of every edge are split.\n\n' +
      'Set **Layout** to “long” for one row per class, or colour a 3D View of the **Synapses** output by `connection`.',
    cards: [
      DS,
      find('find', typeIs('T4a')),
      {
        id: 'conn',
        type: 'neuron.connectivity',
        params: { direction: 'outputs', minWeight: 3 },
      },
      { id: 'skel', type: 'neuron.skeletons' },
      { id: 'syn', type: 'neuron.synapses', row: UNDER_TALL },
      { id: 'split', type: 'neuron.splitCompartments' },
      { id: 'compartments', type: 'connectome:connectionCompartments' },
      { id: 'table', type: 'out.table' },
    ],
    wires: [
      ['find', 'neurons', 'conn', 'neurons'],
      ['conn', 'neuronSet', 'skel', 'neurons'],
      ['conn', 'neuronSet', 'syn', 'neurons'],
      ['skel', 'skeletons', 'split', 'skeletons'],
      ['syn', 'points', 'split', 'synapses'],
      ['conn', 'connections', 'compartments', 'edges'],
      ['split', 'out', 'compartments', 'skeletons'],
      ['compartments', 'edges', 'table', 'in'],
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
      { id: 'attach', type: 'neuron.attachAttributes' },
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
  {
    types: ['biophys:fit'],
    focus: 'fit',
    title: 'Fit Model Passive',
    about:
      '**Fit Model Passive** fits a compartment model’s passive membrane to a current-clamp recording. Here the recording is a simulation, so the answer is known: the top **Compartment Model** is the cell, with Rm 20,000 Ω·cm², Cm 1 µF/cm², Ra 150 Ω·cm and E leak −60 mV, injected with a current step in **Simulate Model**. Fit Model Passive starts from the second model’s published constants and recovers the first one’s.\n\n' +
      'Compare **Parameters** with the cell’s numbers, then swap Simulate Model for **Load Recording** and an ABF file of your own.',
    cards: [
      DS,
      find('find', typeIs('T4a')),
      { id: 'pick', type: 'core.selectOne' },
      { id: 'skel', type: 'neuron.skeletons' },
      {
        id: 'cell',
        type: 'biophys:model',
        params: { preset: 'custom', rm: 20_000, cm: 1, ra: 150, eLeak: -60, ...FIXED_CUT },
      },
      { id: 'start', type: 'biophys:model', row: UNDER_TALL, params: FIXED_CUT },
      {
        id: 'sim',
        type: 'biophys:simulate',
        params: {
          duration: 100,
          dt: FIT_STEP,
          clamp: true,
          amplitude: -0.01,
          clampDelay: 20,
          clampDuration: 50,
        },
      },
      { id: 'fit', type: 'biophys:fit', params: { dt: FIT_STEP } },
      { id: 'chart', type: 'out.lineChart', params: { x: 't', ys: ['recorded', 'fitted'] } },
      { id: 'table', type: 'out.table', row: UNDER_TALL },
    ],
    wires: [
      ['find', 'neurons', 'pick', 'in'],
      ['pick', 'item', 'skel', 'neurons'],
      ['skel', 'skeletons', 'cell', 'neuron'],
      ['skel', 'skeletons', 'start', 'neuron'],
      ['cell', 'model', 'sim', 'model'],
      ['start', 'model', 'fit', 'model'],
      ['sim', 'traces', 'fit', 'recording'],
      ['fit', 'traces', 'chart', 'in'],
      ['fit', 'parameters', 'table', 'in'],
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
 * Hemibrain as the Biophysics example uses it. A real neuron because a synthetic one is a
 * miniature (`packs/biophys/wizard.ts`): on the card's defaults every input drives it to the
 * synapses' reversal and the run is a flat line. One DA1 projection neuron, named rather than
 * searched for, because its painted regions are anchored to its own skeleton — and one whose soma
 * the skeleton labels, so the model's soma is where the cell body is. The Biophysics guide walks
 * through this exact model (`src/packs/biophys/guide/guide.md`).
 */
const DA1_PN = '754534424'
/** Where `DA1_PN` falls among the DA1_lPN neurons Find Neurons returns, for Select One. */
const DA1_PN_INDEX = 1
/** The skeleton's soma node, which "distal" in the strokes below is measured from, nm. */
const DA1_ROOT = [121200, 282101.59375, 185092.796875] as const
const HEMIBRAIN = {
  card: { id: 'ds', type: 'dataset.hemibrain' },
  note: '*Real data from the hemibrain connectome. It needs a neuPrint sign-in, under Connections (the branch icon in the toolbar).*',
  /*
   * The axon from where it leaves the dendrite (75 µm out along the primary neurite, the branch
   * point with 1.5 mm of dendrite on one side and 0.6 mm of axon on the other), then its first
   * 25 µm painted back as an initial segment — the guide's "later strokes paint over earlier ones".
   */
  regions: [
    {
      neuron: DA1_PN,
      at: [138320, 269008, 218944],
      scope: 'distal',
      region: 'AIS',
      root: DA1_ROOT,
    },
    {
      neuron: DA1_PN,
      at: [152720, 248688, 222784],
      scope: 'distal',
      region: 'axon',
      root: DA1_ROOT,
    },
  ].map((stroke) => JSON.stringify(stroke)),
  /**
   * Pospischil sodium and potassium on the axon, five times as dense on its initial segment. Swept
   * in a browser on this neuron with its three strongest partners firing: at Jaxley's 6:1 sodium to
   * potassium the axon sticks on a plateau near −20 mV, at 3:2 it fires a train and comes back to
   * rest.
   */
  channels: [
    { channel: 'pospischil.na', regions: ['axon'], value: 30 },
    { channel: 'pospischil.k', regions: ['axon'], value: 20 },
    { channel: 'pospischil.na', regions: ['AIS'], value: 150 },
    { channel: 'pospischil.k', regions: ['AIS'], value: 100 },
  ].map((row) => JSON.stringify({ ...row, mode: 'density', activation: 0, inactivation: 0 })),
  /**
   * Two record sites beside the soma: 10 µm into the dendrite past the branch point, and the axon's
   * farthest tip in the lateral horn, 455 µm from the soma.
   */
  traces: [
    JSON.stringify({ neuron: DA1_PN, at: [133040, 277168, 214784], name: 'dendrite' }),
    JSON.stringify({ neuron: DA1_PN, at: [34960, 188048, 112704], name: 'axon tip' }),
  ],
  /** The strongest ORN fires a train: 10 spikes from 10 ms, 5 ms apart. */
  train: { drive: 'trains', start: 10, number: 10, interval: 5 },
} as const

/*
 * Last, being the ones on a published dataset: the Biophysics example, whose neurons have to be
 * real ones, and the Cortex pack's, which have nothing to show on synthetic data — no synthetic
 * dataset has a cortical frame.
 */
const PUBLISHED: readonly ExampleSpec[] = [
  {
    types: ['biophys:simulate', 'biophys:model'],
    focus: 'sim',
    title: 'Simulate synaptic input',
    about:
      'One DA1 projection neuron as a compartment model, step by step as the Biophysics guide builds it: **Find Neurons** and **Select One** pick the neuron and **Skeletons** its shape; **Compartment Model** gives its axon sodium and potassium channels, denser where spikes start; **Synapses Between** places the synapses its ORN_DA1 partners make onto it. **Simulate Model** fires the strongest ORN and records at the soma, the base of the dendrite and the tip of the axon.\n\n' +
      'Expand Compartment Model (⤢) to see the regions and channels, or Simulate Model to watch the run spread over the neuron in **Playback**.',
    published: HEMIBRAIN.note,
    cards: [
      HEMIBRAIN.card,
      find('find', typeIs('DA1_lPN')),
      {
        id: 'pick',
        type: 'core.selectOne',
        params: { index: DA1_PN_INDEX, selected: DA1_PN_INDEX },
      },
      { id: 'skel', type: 'neuron.skeletons' },
      find('orns', typeIs('ORN_DA1'), UNDER_TALL),
      { id: 'syn', type: 'neuron.synapsesBetween', row: UNDER_TALL },
      {
        id: 'model',
        type: 'biophys:model',
        params: {
          paintedRegions: HEMIBRAIN.regions,
          channels: HEMIBRAIN.channels,
          synapsePreset: 'orn-pn-nicotinic',
        },
      },
      {
        id: 'sim',
        type: 'biophys:simulate',
        params: { fire: 'top', top: 1, ...HEMIBRAIN.train, traces: HEMIBRAIN.traces },
      },
      { id: 'chart', type: 'out.lineChart' },
      { id: 'spikes', type: 'out.table', row: UNDER_TALL },
    ],
    wires: [
      ['find', 'neurons', 'pick', 'in'],
      ['pick', 'item', 'skel', 'neurons'],
      ['orns', 'neurons', 'syn', 'sources'],
      ['pick', 'item', 'syn', 'targets'],
      ['skel', 'skeletons', 'model', 'neuron'],
      ['syn', 'points', 'model', 'synapses'],
      ['model', 'model', 'sim', 'model'],
      ['sim', 'traces', 'chart', 'in'],
      ['sim', 'outputSpikes', 'spikes', 'in'],
    ],
  },
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
 * The example as a graph: the dataset wired into every card with a `dataset` socket the example
 * does not wire itself — a card below a Custom Dataset reads *that* — the cards placed in columns
 * by dataflow, the note above them.
 */
export function exampleGraph(spec: ExampleSpec): CodaGraph {
  const fromDataset: Wire[] = spec.cards
    .filter(
      (c) =>
        c.id !== DS.id &&
        inputPorts(requireNodeDef(c.type), {}).some((p) => p.id === 'dataset') &&
        !spec.wires.some(([, , target, port]) => target === c.id && port === 'dataset'),
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
