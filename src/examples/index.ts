/**
 * Example graphs.
 *
 * Built programmatically rather than shipped as hand-written JSON: params come from each
 * node's own defaults, so an example cannot drift out of sync with a node's param set. A
 * test asserts every example is inference-clean, which makes these double as fixtures.
 *
 * Use the Save button to export any of them as a `.coda.json` file.
 */

import type { CodaGraph, GraphNode } from '../core/graph'
import { addEdge, addNode, emptyGraph } from '../core/graph'
import type { ParamValues } from '../core/node'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { COL_WIDTH, GRID_ORIGIN, ROW_HEIGHT } from '../layout/place'
import { noteNode } from './notes'

export interface ExampleGraph {
  id: string
  name: string
  /** One line, shown in the Examples menu. */
  summary: string
  build(): CodaGraph
}

interface Placement {
  id: string
  type: string
  /** Column index; converted to an x offset. */
  col: number
  /** Row offset within the column, in node heights. */
  row?: number
  params?: Record<string, unknown>
}

function place({ id, type, col, row = 0, params }: Placement): GraphNode {
  const def = requireNodeDef(type)
  return {
    id,
    type,
    position: {
      x: GRID_ORIGIN.x + col * COL_WIDTH,
      y: GRID_ORIGIN.y + row * ROW_HEIGHT,
    },
    params: { ...defaultParams(def), ...params } as ParamValues,
  }
}

type Link = [from: string, fromPort: string, to: string, toPort: string]

/**
 * A text note (`note.text`) placed around the pipeline rather than in it.
 *
 * The examples are the only documentation most people will read, and a graph explains what it
 * computes while saying nothing about why — which type pattern and on what grounds, why a
 * threshold is 10, what the chart at the end is supposed to show. So each one carries an
 * overview above the chain and a couple of step notes under it.
 *
 * Positioned absolutely, and deliberately not through `place`: the node grid is a row of
 * pipeline steps, while a note spans several of them and belongs above or below the whole row.
 * `col` still lines it up with the step it is about. Sizes are explicit because the text is
 * known here — a note left at the definition's default would clip its own last line.
 */
interface NoteSpec {
  id: string
  /** Column the note starts at, in the same grid the nodes use. */
  col: number
  /** Absolute y; notes sit above and below the pipeline, not in its rows. */
  y: number
  width: number
  height: number
  text: string
}

function placeNote({ id, col, y, width, height, text }: NoteSpec): GraphNode {
  return noteNode({ id, x: GRID_ORIGIN.x + col * COL_WIDTH, y, width, height, text })
}

function assemble(
  name: string,
  description: string,
  nodes: Placement[],
  links: Link[],
  notes: NoteSpec[] = [],
): CodaGraph {
  let graph = emptyGraph(name)
  graph = { ...graph, meta: { ...graph.meta, name, description } }
  for (const spec of nodes) graph = addNode(graph, place(spec))
  // Appended after the pipeline, so the saved file still reads as the graph followed by its
  // commentary. Nothing overlaps, so the stacking order this implies is not load-bearing.
  for (const spec of notes) graph = addNode(graph, placeNote(spec))
  for (const [source, sourceHandle, target, targetHandle] of links) {
    graph = addEdge(graph, { source, sourceHandle, target, targetHandle })
  }
  return graph
}

// ---------------------------------------------------------------------------

/**
 * The shape most connectivity questions take: search → connectivity → filter → group → sort →
 * table. Named for the *technique*, not for a finding — every example runs on the synthetic
 * Demo Data, so a title promising what some cell type does would be promising something the
 * numbers underneath cannot deliver.
 */
const partners: ExampleGraph = {
  id: 'partners',
  name: 'Fetch and group connectivity by type',
  summary: 'Find neurons, pull their downstream partners, aggregate synapses by partner type.',
  build: () =>
    assemble(
      'Fetch and group connectivity by type',
      'Search → connectivity → filter → group → sort → table, the chain most connectivity questions are built from. Runs on synthetic data.',
      [
        { id: 'ds', type: 'dataset.mock.opticlobe', col: 0 },
        {
          id: 'find',
          type: 'neuron.findNeurons',
          col: 1,
          params: {
            filters: [
              '{"f":"type","op":"matches","v":["LC.*"]}',
              '{"f":"status","op":"is","v":["Traced"]}',
            ],
          },
        },
        {
          id: 'conn',
          type: 'neuron.connectivity',
          col: 2,
          params: { direction: 'outputs', minWeight: 3 },
        },
        {
          id: 'filter',
          type: 'core.filter',
          col: 3,
          params: { column: 'weight', op: 'ge', value: '10' },
        },
        {
          id: 'group',
          type: 'core.groupBy',
          col: 4,
          params: { by: ['postType'], agg: 'sum', value: 'weight' },
        },
        {
          id: 'sort',
          type: 'core.sort',
          col: 5,
          params: { column: 'sum_weight', descending: true, limit: 0 },
        },
        { id: 'view', type: 'out.table', col: 6 },
      ],
      [
        ['ds', 'dataset', 'find', 'dataset'],
        ['ds', 'dataset', 'conn', 'dataset'],
        ['find', 'neurons', 'conn', 'neurons'],
        ['conn', 'connections', 'filter', 'in'],
        ['filter', 'out', 'group', 'in'],
        ['group', 'out', 'sort', 'in'],
        ['sort', 'out', 'view', 'in'],
      ],
      [
        {
          id: 'why',
          col: 0,
          y: -210,
          width: 700,
          height: 200,
          text: `
          ### What this graph shows

          **How** to turn a type pattern into a ranked table: find the neurons, pull their downstream
          partners, drop the weak pairs, sum the weight per partner type, sort.

          Read it left to right — each node takes the table on its left and hands a new one to its
          right. Press Run, or ⇧R, to evaluate the whole chain.

          *The dataset is synthetic, generated in your browser from a seed. The pipeline is the point;
          the numbers are not a finding. Swap the dataset node for a real one to see actual data.*`,
        },
        {
          id: 'step1',
          col: 1,
          y: 430,
          width: 540,
          height: 115,
          text: `
          **1 · Choose the neurons.** The type pattern is a regex, anchored the way neuPrint anchors it:
          \`LC.*\` matches LC4 and LC6, but not LPLC1. Status keeps only reconstructions someone has
          checked.`,
        },
        {
          id: 'step2',
          col: 3,
          y: 430,
          width: 540,
          height: 130,
          text: `
          **2 · Reduce it.** The filter drops the weak pairs; the grouping sums weight per partner type,
          so thousands of neuron-to-neuron rows become one row per type; the sort ranks what is left.
          Three nodes rather than one, so each step can be read, re-ordered and re-run on its own.`,
        },
        {
          id: 'step3',
          col: 5,
          y: 430,
          width: 460,
          height: 105,
          text: `
          **3 · Look at it.** A viewer passes its input straight through, so it can sit in the middle of
          a chain instead of only ending one.`,
        },
      ],
    ),
}

/**
 * Two searches into one matrix — the query neuPrint's UI makes most awkward. Also the
 * example that shows a multi-input node and a non-table viewer.
 */
const matrix: ExampleGraph = {
  id: 'matrix',
  name: 'Build an adjacency matrix from two searches',
  summary: 'Adjacency between two neuron sets, row-normalised, as a heatmap.',
  build: () =>
    assemble(
      'Build an adjacency matrix from two searches',
      'Two independent searches feeding one matrix node, normalised per row so each row sums to 1. Runs on synthetic data.',
      [
        { id: 'ds', type: 'dataset.mock.opticlobe', col: 0, row: 0.5 },
        {
          id: 'lc',
          type: 'neuron.findNeurons',
          col: 1,
          row: 0,
          params: {
            filters: [
              '{"f":"type","op":"matches","v":["LC.*|LPLC.*"]}',
              '{"f":"status","op":"is","v":["Traced"]}',
            ],
          },
        },
        {
          id: 'targets',
          type: 'neuron.findNeurons',
          col: 1,
          row: 1.1,
          params: {
            filters: [
              '{"f":"type","op":"matches","v":["DNp.*|PVLP.*|PLP.*|AOTU.*"]}',
              '{"f":"status","op":"is","v":["Traced"]}',
            ],
          },
        },
        {
          id: 'adj',
          type: 'neuron.adjacency',
          col: 2,
          row: 0.5,
          params: { groupByType: true },
        },
        { id: 'norm', type: 'core.normalize', col: 3, row: 0.5, params: { mode: 'row' } },
        {
          id: 'heat',
          type: 'out.heatmap',
          col: 4,
          row: 0.5,
          params: { scale: 'sequential', showValues: true },
        },
      ],
      [
        ['ds', 'dataset', 'lc', 'dataset'],
        ['ds', 'dataset', 'targets', 'dataset'],
        ['ds', 'dataset', 'adj', 'dataset'],
        ['lc', 'neurons', 'adj', 'sources'],
        ['targets', 'neurons', 'adj', 'targets'],
        ['adj', 'matrix', 'norm', 'in'],
        ['norm', 'out', 'heat', 'in'],
      ],
      [
        {
          id: 'why',
          col: 0,
          y: -225,
          width: 700,
          height: 215,
          text: `
          ### What this graph shows

          **How** to build an adjacency matrix: two independent searches, one matrix node. Rows come
          from the upper search, columns from the lower one, and each cell is the connection strength
          between them.

          Two inputs into one node is what the layout is showing — the matrix is the only place in the
          graph where the two sets of neurons meet.

          *The dataset is synthetic. Its block structure was designed in, not discovered — what the
          heatmap demonstrates is the pipeline, not a circuit.*`,
        },
        {
          id: 'step1',
          col: 1,
          y: 620,
          width: 540,
          height: 120,
          text: `
          **Grouped by type, not by neuron.** The matrix node folds every cell of a type into one row
          and one column, so the picture is a type-by-type circuit rather than a several-thousand-cell
          grid nobody can read.`,
        },
        {
          id: 'step2',
          col: 3,
          y: 620,
          width: 540,
          height: 135,
          text: `
          **Row-normalised, so read across.** Each row is divided by its own total, so a cell says what
          *fraction* of that row's output reaches a given column — comparable between a type with 200
          cells and a type with 12. Delete the normalise node to see raw synapse counts instead.`,
        },
      ],
    ),
}

/**
 * The same connectivity as `partners`, drawn as a node-link diagram instead of a table.
 *
 * Uses the type-level aggregation deliberately: a neuron-level network is thousands of nodes and
 * reads as a hairball, whereas the type-level graph is the circuit diagram people actually draw.
 */
const network: ExampleGraph = {
  id: 'network',
  name: 'Draw connectivity as a network diagram',
  summary: 'Type-level connectivity as a node-link diagram, laid out feed-forward.',
  build: () =>
    assemble(
      'Draw connectivity as a network diagram',
      'Connectivity aggregated to type level and drawn as a network: node colour is cell type, node size is total outgoing weight, link width is synapse count. Runs on synthetic data.',
      [
        { id: 'ds', type: 'dataset.mock.opticlobe', col: 0 },
        {
          id: 'find',
          type: 'neuron.findNeurons',
          col: 1,
          params: {
            filters: [
              '{"f":"type","op":"matches","v":["LC.*|LPLC.*"]}',
              '{"f":"status","op":"is","v":["Traced"]}',
            ],
          },
        },
        {
          id: 'conn',
          type: 'neuron.connectivity',
          col: 2,
          params: { direction: 'outputs', minWeight: 5 },
        },
        {
          id: 'group',
          type: 'core.groupBy',
          col: 3,
          params: { by: ['preType', 'postType'], agg: 'sum', value: 'weight' },
        },
        {
          id: 'net',
          type: 'net.build',
          col: 4,
          params: {
            source: 'preType',
            target: 'postType',
            weight: 'sum_weight',
            directed: true,
            aggregate: true,
          },
        },
        {
          id: 'view',
          type: 'out.network',
          col: 5,
          params: {
            layout: 'layered',
            nodeColorMode: 'categorical',
            nodeColorBy: 'id',
            nodeSizeBy: 'weightOut',
            edgeSizeBy: 'weight',
            showLabels: true,
          },
        },
      ],
      [
        ['ds', 'dataset', 'find', 'dataset'],
        ['ds', 'dataset', 'conn', 'dataset'],
        ['find', 'neurons', 'conn', 'neurons'],
        ['conn', 'connections', 'group', 'in'],
        ['group', 'out', 'net', 'edges'],
        ['net', 'network', 'view', 'in'],
      ],
      [
        {
          id: 'why',
          col: 0,
          y: -230,
          width: 700,
          height: 220,
          text: `
          ### What this graph shows

          **How** to get from a connectivity table to a drawing: the same chain as the first example,
          ending in a node-link diagram instead of a table. Nodes are cell types, links are the
          synapses between them, laid out so the flow reads left to right.

          Type-level on purpose. A neuron-level network is thousands of nodes and reads as a hairball;
          the type graph is the diagram people actually draw by hand.

          *The dataset is synthetic — this is what the layout and the encodings do, not a circuit
          anyone has traced.*`,
        },
        {
          id: 'step1',
          col: 2,
          y: 430,
          width: 540,
          height: 120,
          text: `
          **Collapse pairs into types.** Grouping by both ends of each connection turns a table of
          neuron-to-neuron rows into a table of type-to-type rows — which is exactly the edge list the
          network node expects.`,
        },
        {
          id: 'step2',
          col: 4,
          y: 430,
          width: 560,
          height: 145,
          text: `
          **Topology plus a table.** The network node emits node and edge attribute tables alongside the
          graph, and every encoding in the viewer — colour, node size, link width — is a column picker
          over those. Its filters are not decoration: they change what the node passes downstream, and
          the caption says how much was cut.`,
        },
      ],
    ),
}

/**
 * Morphology: skeletons plus their synapses, coloured by cell type and polarity.
 *
 * The one example where the framing matters most. `morphology.ts` generates a plausible *shape* —
 * a soma, a primary neurite, two arbors, tapering radii — and says in its own header that it is
 * not biologically accurate. A title like "LC4 morphology in 3D" over a generated tree is the
 * closest this app came to showing somebody a made-up neuron and naming a real cell.
 */
const morphology: ExampleGraph = {
  id: 'morphology',
  name: 'Render skeletons and synapses in 3D',
  summary: 'Skeletons and synapse locations in 3D, coloured by type and polarity.',
  build: () =>
    assemble(
      'Render skeletons and synapses in 3D',
      'One search feeding two morphology queries, both drawn in the same 3D scene, with synapses coloured by polarity. Runs on synthetic data.',
      [
        { id: 'ds', type: 'dataset.mock.opticlobe', col: 0, row: 0.5 },
        {
          id: 'find',
          type: 'neuron.findNeurons',
          col: 1,
          row: 0.5,
          params: {
            filters: [
              '{"f":"type","op":"isIn","v":["LC4","LC6"]}',
              '{"f":"status","op":"is","v":["Traced"]}',
            ],
          },
        },
        { id: 'skel', type: 'neuron.skeletons', col: 2, row: 0, params: { limit: 30 } },
        {
          id: 'syn',
          type: 'neuron.synapses',
          col: 2,
          row: 1.1,
          params: { polarity: '', minWeight: 10, limit: 30 },
        },
        {
          id: 'view',
          type: 'out.viewer3d',
          col: 3,
          row: 0.5,
          params: {
            skeletonColorMode: 'categorical',
            skeletonColorBy: 'type',
            pointColorMode: 'categorical',
            pointColorBy: 'polarity',
            pointSize: 90,
          },
        },
      ],
      [
        ['ds', 'dataset', 'find', 'dataset'],
        ['ds', 'dataset', 'skel', 'dataset'],
        ['ds', 'dataset', 'syn', 'dataset'],
        ['find', 'neurons', 'skel', 'neurons'],
        ['find', 'neurons', 'syn', 'neurons'],
        ['skel', 'skeletons', 'view', 'skeletons'],
        ['syn', 'points', 'view', 'points'],
      ],
      [
        {
          id: 'why',
          col: 0,
          y: -225,
          width: 660,
          height: 210,
          text: `
          ### What this graph shows

          **How** to draw morphology: one search feeding two morphology queries — the skeletons and the
          synapse locations — with the 3D viewer drawing both in the same space.

          Both queries are expensive, so nothing is fetched until you press Run. That is the hybrid
          model: cheap nodes re-run as you edit, network calls wait to be asked.

          *These shapes are generated, not traced. They have real branch structure to prune, measure
          and colour by — they are not what any of these cells actually looks like.*`,
        },
        {
          id: 'step1',
          col: 1,
          y: 620,
          width: 520,
          height: 135,
          text: `
          **One search, two questions.** Both morphology nodes read the same neuron list, so the
          skeletons and the synapses are guaranteed to be about the same cells. **Warn above** on each
          is set low here, so a first look at a type says what it is about to pull rather than
          quietly pulling hundreds of megabytes.`,
        },
        {
          id: 'step2',
          col: 3,
          y: 620,
          width: 480,
          height: 130,
          text: `
          **Colour comes from the table.** Skeletons and points each arrive with an attribute row per
          item, so colouring by cell type or by synapse polarity is a column picker rather than a special
          case inside the viewer.`,
        },
      ],
    ),
}

export const EXAMPLES: ExampleGraph[] = [partners, matrix, network, morphology]

export function getExample(id: string): ExampleGraph | undefined {
  return EXAMPLES.find((e) => e.id === id)
}
