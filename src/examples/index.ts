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
 * The bread-and-butter neuPrint question: what does a cell type talk to, and how
 * strongly? Exercises search → connectivity → filter → group → sort → table.
 */
const partners: ExampleGraph = {
  id: 'partners',
  name: 'LC outputs by partner type',
  summary: 'Find LC neurons, pull downstream partners, aggregate synapses by partner type.',
  build: () =>
    assemble(
      'LC outputs by partner type',
      'Lobula columnar neurons and the central-brain types they drive, ranked by total synaptic weight.',
      [
        { id: 'ds', type: 'dataset.mock.opticlobe', col: 0 },
        {
          id: 'find',
          type: 'neuron.findNeurons',
          col: 1,
          params: { typePattern: 'LC.*', status: 'Traced' },
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
          y: -170,
          width: 700,
          height: 160,
          text: `
          ### What this graph answers

          Lobula columnar (LC) cells carry visual features out of the optic lobe. This asks which cell
          types they drive and how strongly — one row per partner type, ranked by total synaptic weight.

          Read it left to right: each node takes the table on its left and hands a new one to its right.
          Press Run, or ⇧R, to evaluate the whole chain.`,
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
  name: 'LC → descending neuron matrix',
  summary: 'Adjacency between two neuron sets, row-normalised, as a heatmap.',
  build: () =>
    assemble(
      'LC → descending neuron matrix',
      'Connection matrix from lobula columnar types onto their central-brain targets, normalised per row so each LC type sums to 1.',
      [
        { id: 'ds', type: 'dataset.mock.opticlobe', col: 0, row: 0.5 },
        {
          id: 'lc',
          type: 'neuron.findNeurons',
          col: 1,
          row: 0,
          params: { typePattern: 'LC.*|LPLC.*', status: 'Traced' },
        },
        {
          id: 'targets',
          type: 'neuron.findNeurons',
          col: 1,
          row: 1.1,
          params: { typePattern: 'DNp.*|PVLP.*|PLP.*|AOTU.*', status: 'Traced' },
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
          y: -180,
          width: 700,
          height: 170,
          text: `
          ### What this graph answers

          An adjacency matrix. Rows are the LC types found by the upper search, columns are the
          central-brain targets found by the lower one, and each cell is how strongly they connect.

          Two searches feed one node, which is what the layout is showing: the matrix is the only place
          in the graph where the two sets of neurons meet.`,
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
          *fraction* of that LC type's output reaches a target — comparable between a type with 200 cells
          and a type with 12. Delete the normalise node to see raw synapse counts instead.`,
        },
      ],
    ),
}

/**
 * Per-ROI innervation. The interesting bit for the type system is that GroupBy on two
 * keys produces the exact column set the stacked bar chart then picks up.
 */
const roiSummary: ExampleGraph = {
  id: 'roi-summary',
  name: 'Kenyon cell innervation by ROI',
  summary: 'Per-ROI postsynapse counts for KC types, as a stacked bar chart.',
  build: () =>
    assemble(
      'Kenyon cell innervation by ROI',
      'Where Kenyon cells receive input, split by KC subtype. Calyx dominates, as it should.',
      [
        { id: 'ds', type: 'dataset.mock.hemibrain', col: 0 },
        {
          id: 'find',
          type: 'neuron.findNeurons',
          col: 1,
          params: { typePattern: 'KC.*', status: 'Traced' },
        },
        { id: 'roi', type: 'neuron.roiCounts', col: 2 },
        {
          id: 'group',
          type: 'core.groupBy',
          col: 3,
          params: { by: ['roi', 'type'], agg: 'sum', value: 'post' },
        },
        {
          id: 'bar',
          type: 'out.barChart',
          col: 4,
          params: {
            category: 'roi',
            value: 'sum_post',
            series: 'type',
            useSeries: true,
            sortBars: true,
          },
        },
      ],
      [
        ['ds', 'dataset', 'find', 'dataset'],
        ['ds', 'dataset', 'roi', 'dataset'],
        ['find', 'neurons', 'roi', 'neurons'],
        ['roi', 'counts', 'group', 'in'],
        ['group', 'out', 'bar', 'in'],
      ],
      [
        {
          id: 'why',
          col: 0,
          y: -170,
          width: 700,
          height: 160,
          text: `
          ### What this graph answers

          Kenyon cells are the mushroom body's parallel fibres. This asks where they *receive* their
          input: postsynapse counts per brain region, split by KC subtype.

          The calyx should dominate the result. That expectation is the check on whether the pipeline is
          doing what it claims.`,
        },
        {
          id: 'step1',
          col: 2,
          y: 430,
          width: 520,
          height: 130,
          text: `
          **One row per neuron and region.** The ROI node explodes each neuron into its per-region
          counts, which is the shape the grouping then collapses. Two group keys go in, so what comes out
          carries a region column, a type column and a summed count.`,
        },
        {
          id: 'step2',
          col: 4,
          y: 430,
          width: 480,
          height: 130,
          text: `
          **Two keys make a stacked chart.** The chart reads region as the category, the summed count as
          the value and type as the series — the three columns the grouping just produced. Change either
          key and the chart follows.`,
        },
      ],
    ),
}

/**
 * Network view of a circuit, coloured by cell type and laid out feed-forward.
 *
 * Uses the type-level aggregation deliberately: a neuron-level network of the whole optic
 * lobe is thousands of nodes and reads as a hairball, whereas the type-level graph is the
 * circuit diagram people actually draw.
 */
const network: ExampleGraph = {
  id: 'network',
  name: 'LC circuit network',
  summary: 'Type-level connectivity as a node-link diagram, laid out feed-forward.',
  build: () =>
    assemble(
      'LC circuit network',
      'Lobula columnar neurons and their central-brain targets as a network. Node colour is cell type, node size is total outgoing weight, link width is synapse count.',
      [
        { id: 'ds', type: 'dataset.mock.opticlobe', col: 0 },
        {
          id: 'find',
          type: 'neuron.findNeurons',
          col: 1,
          params: { typePattern: 'LC.*|LPLC.*', status: 'Traced' },
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
          y: -180,
          width: 700,
          height: 170,
          text: `
          ### What this graph answers

          The same kind of connectivity as the first example, drawn as a circuit instead of a table:
          nodes are cell types, links are the synapses between them, laid out so the flow reads
          left to right.

          Type-level on purpose. A neuron-level network of this region is thousands of nodes and reads as
          a hairball; the type graph is the diagram people actually draw by hand.`,
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

/** Morphology: skeletons plus their synapses, coloured by cell type and polarity. */
const morphology: ExampleGraph = {
  id: 'morphology',
  name: 'LC4 morphology in 3D',
  summary: 'Skeletons and synapse locations in 3D, coloured by type and polarity.',
  build: () =>
    assemble(
      'LC4 morphology in 3D',
      'Lobula columnar type 4 neurons rendered in 3D, with their synapses as a point cloud coloured by polarity.',
      [
        { id: 'ds', type: 'dataset.mock.opticlobe', col: 0, row: 0.5 },
        {
          id: 'find',
          type: 'neuron.findNeurons',
          col: 1,
          row: 0.5,
          params: { typePattern: 'LC4|LC6', status: 'Traced' },
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
          y: -180,
          width: 660,
          height: 165,
          text: `
          ### What this graph answers

          What the cells look like. One search feeds two morphology queries — the skeletons and the
          synapse locations — and the 3D viewer draws both in the same space.

          Both queries are expensive, so nothing is fetched until you press Run. That is the hybrid
          model: cheap nodes re-run as you edit, network calls wait to be asked.`,
        },
        {
          id: 'step1',
          col: 1,
          y: 620,
          width: 520,
          height: 135,
          text: `
          **One search, two questions.** Both morphology nodes read the same neuron list, so the
          skeletons and the synapses are guaranteed to be about the same cells. The limits on each are
          what keeps a first look at a type from pulling hundreds of megabytes.`,
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

export const EXAMPLES: ExampleGraph[] = [partners, matrix, roiSummary, network, morphology]

export function getExample(id: string): ExampleGraph | undefined {
  return EXAMPLES.find((e) => e.id === id)
}
