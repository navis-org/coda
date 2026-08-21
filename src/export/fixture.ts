/**
 * The everything graph.
 *
 * Shared by every exporter rather than copied per language: this is a *graph*, and a second
 * copy is how two exporters end up being held to two different coverage bars.
 *
 * One fixture wiring up every node type that emits, because the five bundled examples all run
 * on synthetic connectomes and are refused by design — so without this the golden files would
 * cover nothing. Built in code rather than checked in as JSON so it cannot drift from the node
 * definitions: a param renamed in a definition changes the emitted cell here, and the golden
 * file shows it.
 *
 * It is deliberately not a workflow anybody would build. Coverage is the job; the branches
 * exist to reach node types, not to answer a question.
 */

import type { CodaGraph, GraphEdge, GraphNode } from '../core/graph'
import { addEdge, addNode, emptyGraph } from '../core/graph'
import type { ParamValues } from '../core/node'

interface Spec {
  id: string
  type: string
  params?: ParamValues
  /** Column and row on a coarse grid; only the x order reaches the notebook, via the notes. */
  col: number
  row?: number
}

function place(graph: CodaGraph, spec: Spec): CodaGraph {
  const node: GraphNode = {
    id: spec.id,
    type: spec.type,
    position: { x: spec.col * 260, y: (spec.row ?? 0) * 180 },
    params: spec.params ?? {},
  }
  return addNode(graph, node)
}

function wire(
  graph: CodaGraph,
  from: string,
  out: string,
  to: string,
  into: string,
): CodaGraph {
  const edge: Omit<GraphEdge, 'id'> = {
    source: from,
    sourceHandle: out,
    target: to,
    targetHandle: into,
  }
  return addEdge(graph, edge)
}

export function everythingGraph(): CodaGraph {
  let g = emptyGraph('Everything')
  g.meta = { ...g.meta, description: 'Every node type that emits, wired up once.' }

  const nodes: Spec[] = [
    { id: 'ds', type: 'dataset.hemibrain', col: 0, params: { version: 'v1.2.1' } },
    { id: 'desc', type: 'dataset.description', col: 0, row: 2 },
    {
      id: 'custom',
      type: 'dataset.neuprint',
      col: 0,
      row: 3,
      params: { server: 'https://neuprint.janelia.org', dataset: 'manc:v1.2.3' },
    },

    /*
     * The other families, wired to nothing. They share one generated emitter, so this is not
     * six copies of the same assertion: `mushroombody` carries no version in its dataset id at
     * all, and the legacy `neuron.dataset` reads its id from a param rather than from the
     * family table — both are branches of `resolveDatasetId` that `hemibrain` never reaches.
     */
    { id: 'malecns', type: 'dataset.malecns', col: 0, row: 4, params: { version: 'v1.0' } },
    { id: 'manc', type: 'dataset.manc', col: 0, row: 5, params: { version: 'v1.2.3' } },
    { id: 'optic', type: 'dataset.opticlobe', col: 0, row: 6, params: { version: 'v1.1' } },
    { id: 'fib19', type: 'dataset.fib19', col: 0, row: 7, params: { version: 'v1.0' } },
    { id: 'mb', type: 'dataset.mushroombody', col: 0, row: 8 },
    {
      id: 'legacy',
      type: 'neuron.dataset',
      col: 0,
      row: 9,
      params: { dataset: 'hemibrain:v1.1' },
    },

    {
      id: 'find',
      type: 'neuron.findNeurons',
      col: 1,
      params: { typePattern: 'LC.*', status: 'Traced', minSize: 50_000, limit: 200 },
    },
    { id: 'ids', type: 'neuron.inputIds', col: 1, row: 1, params: { ids: '1001, 1002, 1003' } },
    {
      id: 'labels',
      type: 'neuron.idsFromLabel',
      col: 1,
      row: 2,
      params: { field: 'type', labels: 'DNp01\nDNp02', match: 'exact', status: 'Traced' },
    },
    {
      id: 'explore',
      type: 'neuron.explore',
      col: 1,
      row: 3,
      params: { query: 'status!=Traced pre>100', limit: 500, selection: ['1001', '1005'] },
    },
    {
      id: 'cypher',
      type: 'neuron.rawCypher',
      col: 1,
      row: 4,
      params: { query: 'MATCH (n:Neuron)\nWHERE n.pre > 1000\nRETURN n.bodyId, n.type' },
    },

    {
      id: 'conn',
      type: 'neuron.connectivity',
      col: 2,
      params: { direction: 'outputs', hops: 1, minWeight: 5 },
    },
    {
      id: 'conn2',
      type: 'neuron.connectivity',
      col: 2,
      row: 1,
      params: { direction: 'both', hops: 3, minWeight: 10 },
    },
    { id: 'adj', type: 'neuron.adjacency', col: 2, row: 2, params: { groupByType: true } },
    { id: 'roi', type: 'neuron.roiCounts', col: 2, row: 3 },
    // Both cached summaries, and `primaryOnly: false` on one of them deliberately: the filter
    // is the default, so leaving it on everywhere would let the branch that skips it rot.
    {
      id: 'roicomp',
      type: 'neuron.roiCompleteness',
      col: 2,
      row: 8,
      params: { primaryOnly: false },
    },
    {
      id: 'roiconn',
      type: 'neuron.roiConnectivity',
      col: 2,
      row: 9,
      params: { measure: 'weight' },
    },
    {
      id: 'paths',
      type: 'neuron.paths',
      col: 2,
      row: 4,
      params: { maxHops: 3, minWeight: 10, topN: 20, collapseTypes: false },
    },

    { id: 'skel', type: 'neuron.skeletons', col: 2, row: 5, params: { limit: 20 } },
    { id: 'mesh', type: 'neuron.meshes', col: 2, row: 6, params: { limit: 10 } },
    { id: 'syn', type: 'neuron.synapses', col: 2, row: 7, params: { polarity: 'pre' } },

    /*
     * Two NBLAST nodes, for the reason there are two Select One nodes: the emitters branch on
     * whether a Target is wired, and one node would record only the branch that happens to be
     * an all-by-all. The symmetric one also takes the non-default `symmetry` so the golden
     * shows `nblast(x, x)` rather than `nblast_allbyall`, which is the substitution most
     * likely to go wrong unnoticed.
     */
    {
      id: 'nblast',
      type: 'neuron.nblast',
      col: 3,
      row: 5,
      params: { symmetry: 'mean', labelColumn: 'type' },
    },
    {
      id: 'nblastPair',
      type: 'neuron.nblast',
      col: 3,
      row: 6,
      params: { symmetry: 'none', resample: 0, useAlpha: true },
    },

    /*
     * One k-NN node, with a label column picked: that is the branch where the emitted frame
     * gains columns the notebook does not carry, so it is the one whose note has to appear.
     */
    {
      id: 'nblastKnn',
      type: 'neuron.nblastKnn',
      col: 3,
      row: 7,
      params: { k: 5, symmetry: 'mean', labelColumn: 'type' },
    },

    /*
     * The clustering trio, hung off the all-by-all NBLAST — which is the wiring it exists for,
     * and the only matrix in this graph that is square over one population. Two Cut nodes for
     * the reason there are two NBLAST nodes: the emitters branch on `mode`, and the two
     * branches are genuinely different calls (`cut_tree` against `fcluster`, `k =` against
     * `h =`), so one node would record only whichever happened to be the default.
     */
    { id: 'linkage', type: 'cluster.linkage', col: 4, row: 5, params: { method: 'average' } },
    { id: 'cut', type: 'cluster.cut', col: 5, row: 5, params: { mode: 'count', count: 4 } },
    { id: 'cutH', type: 'cluster.cut', col: 5, row: 6, params: { mode: 'height', height: 0.6 } },
    // A selection set, since that is the branch whose emitted frame is not simply empty.
    /*
     * The two label-to-neuron nodes, one on each branch of their shared emitter: `sel` has no
     * Neurons wired, so its labels are read as neuron ids, and `clu` has one, so it matches as
     * text and carries the cluster number across. One node would record only whichever branch
     * happened to be wired — the same reason there are two NBLAST nodes and two Select Ones.
     */
    { id: 'sel', type: 'cluster.selectedToNeurons', col: 7, row: 5 },
    { id: 'clu', type: 'cluster.clustersToNeurons', col: 6, row: 6, params: { matchColumn: 'type' } },

    {
      id: 'dendro',
      type: 'out.dendrogram',
      col: 6,
      row: 5,
      // Positions rather than labels, which is what the viewer writes — a label column can
      // name two leaves the same thing.
      params: { orientation: 'down', selection: ['0', '2'] },
    },

    {
      id: 'filter',
      type: 'core.filter',
      col: 3,
      params: { column: 'weight', op: 'ge', value: '10' },
    },
    {
      id: 'sort',
      type: 'core.sort',
      col: 4,
      params: { column: 'weight', descending: true, limit: 500 },
    },
    {
      id: 'sample',
      type: 'core.sample',
      col: 5,
      params: { mode: 'random', count: 200, seed: 7 },
    },
    {
      id: 'dedupe',
      type: 'core.dedupe',
      col: 6,
      // `last` rather than the default, so the golden records the argument that differs from
      // pandas' own default — a fixture on `first` would pass with the parameter omitted.
      params: { columns: ['preType', 'postType'], keep: 'last' },
    },
    {
      id: 'group',
      type: 'core.groupBy',
      col: 7,
      params: { by: ['preType', 'postType'], agg: 'sum', value: 'weight' },
    },
    {
      id: 'select',
      type: 'core.select',
      col: 8,
      params: { columns: ['preType', 'postType', 'sum_weight'] },
    },
    {
      id: 'join',
      type: 'core.join',
      col: 9,
      params: { leftKey: 'preType', rightKey: 'preType', how: 'left', suffix: '_r' },
    },
    {
      id: 'stack',
      type: 'core.stack',
      col: 10,
      params: { sourceColumn: 'origin', topLabel: 'Direct', bottomLabel: 'Indirect' },
    },
    {
      id: 'pivot',
      type: 'core.pivot',
      col: 11,
      params: { rows: 'preType', columns: 'postType', value: 'weight', agg: 'sum' },
    },
    { id: 'norm', type: 'core.normalize', col: 12, params: { mode: 'row' } },

    /*
     * Twice, and that is not redundancy: the emitter branches on the input's *kind*, because a
     * navis NeuronList slices as `nl[i:i+1]` where a frame needs `.iloc`. One on each side, or
     * the golden file records only the half that happens to be a DataFrame.
     */
    {
      id: 'pick',
      type: 'core.selectOne',
      col: 5,
      row: 1,
      params: { selected: 3, live: false },
    },
    {
      id: 'pickSkel',
      type: 'core.selectOne',
      col: 3,
      row: 10,
      params: { selected: 0, live: true },
    },

    {
      id: 'upload',
      type: 'core.uploadTable',
      col: 3,
      row: 3,
      params: { fileName: 'annotations.csv', idColumn: 'root_id', textColumns: ['cluster'] },
    },
    {
      id: 'url',
      type: 'core.tableFromUrl',
      col: 3,
      row: 4,
      params: { url: 'https://example.org/embedding.csv', textColumns: ['layer'] },
    },

    {
      id: 'net',
      type: 'net.build',
      col: 7,
      row: 2,
      params: {
        source: 'preType',
        target: 'postType',
        weight: 'sum_weight',
        directed: true,
        minWeight: 5,
      },
    },

    { id: 'table', type: 'out.table', col: 12 },
    /*
     * A second Table, filtered, for the same reason there are two Select One nodes: the first
     * one is fed by the **pivot**, whose wide schema is observed rather than inferred, so no
     * clause on it can resolve at export time and the golden would record only the branch that
     * binds `filtered = out`. This one hangs off `group`, whose columns are known — and its
     * four clauses are one of each shape the emitters branch on: a numeric comparison, a bare
     * text value (an escaped regex, case-insensitively), an explicit regex, and a negation.
     */
    {
      id: 'tableFilt',
      type: 'out.table',
      col: 12,
      row: 2,
      params: {
        filters: [
          '["sum_weight",">=10"]',
          '["preType","LC"]',
          '["postType","~^DN"]',
          '["n","!1"]',
        ],
      },
    },
    { id: 'heat', type: 'out.heatmap', col: 12, row: 1, params: { showValues: false } },
    {
      id: 'bar',
      type: 'out.barChart',
      col: 8,
      row: 1,
      params: { category: 'preType', value: 'sum_weight' },
    },
    {
      id: 'scatter',
      type: 'out.scatter',
      col: 8,
      row: 3,
      params: {
        x: 'pre',
        y: 'post',
        colorColumn: 'type',
        xLog: true,
        yLog: true,
        trend: 'linear',
        idColumn: 'neuronId',
        selection: ['1001'],
      },
    },
    {
      id: 'netview',
      type: 'out.network',
      col: 8,
      row: 2,
      params: { minLinkWeight: 10, hideIsolated: true },
    },
    { id: 'v3d', type: 'out.viewer3d', col: 3, row: 5 },
    { id: 'ng', type: 'out.neuroglancer', col: 3, row: 6 },
    { id: 'profile', type: 'out.profile', col: 3, row: 7, params: { selection: ['1001'] } },
    {
      id: 'summary',
      type: 'out.datasetSummary',
      col: 3,
      row: 8,
      params: { status: 'Traced', topTypes: 15 },
    },
    {
      id: 'rois',
      type: 'out.rois',
      col: 3,
      row: 9,
      params: { view: 'dorsal', explode: 40, colorBy: 'preCompleteness' },
    },
    {
      id: 'dl',
      type: 'out.download',
      col: 13,
      params: { filename: 'partners', format: 'csv' },
    },

    {
      id: 'note',
      type: 'note.text',
      col: 3,
      row: -1,
      params: { text: '## The transform chain\n\nEverything below runs locally.' },
    },
    {
      id: 'muted',
      type: 'core.filter',
      col: 9,
      row: 2,
      params: { column: 'weight', op: 'gt', value: '1' },
    },
  ]

  for (const spec of nodes) g = place(g, spec)

  const edges: Array<[string, string, string, string]> = [
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'ids', 'dataset'],
    ['ds', 'dataset', 'labels', 'dataset'],
    ['ds', 'dataset', 'explore', 'dataset'],
    ['ds', 'dataset', 'cypher', 'dataset'],
    ['ds', 'dataset', 'conn', 'dataset'],
    ['ds', 'dataset', 'conn2', 'dataset'],
    ['ds', 'dataset', 'adj', 'dataset'],
    ['ds', 'dataset', 'roi', 'dataset'],
    ['ds', 'dataset', 'roicomp', 'dataset'],
    ['ds', 'dataset', 'roiconn', 'dataset'],
    ['ds', 'dataset', 'paths', 'dataset'],
    ['ds', 'dataset', 'skel', 'dataset'],
    ['ds', 'dataset', 'mesh', 'dataset'],
    ['ds', 'dataset', 'syn', 'dataset'],
    ['ds', 'dataset', 'desc', 'dataset'],

    ['find', 'neurons', 'conn', 'neurons'],
    ['find', 'neurons', 'conn2', 'neurons'],
    ['find', 'neurons', 'adj', 'sources'],
    ['labels', 'neurons', 'adj', 'targets'],
    ['find', 'neurons', 'roi', 'neurons'],
    ['find', 'neurons', 'paths', 'sources'],
    ['labels', 'neurons', 'paths', 'targets'],
    ['find', 'neurons', 'skel', 'neurons'],
    ['find', 'neurons', 'mesh', 'neurons'],
    ['find', 'neurons', 'syn', 'neurons'],
    ['find', 'neurons', 'scatter', 'in'],
    ['find', 'neurons', 'profile', 'neurons'],
    ['ds', 'dataset', 'profile', 'dataset'],
    ['ds', 'dataset', 'summary', 'dataset'],
    ['ds', 'dataset', 'rois', 'dataset'],
    ['find', 'neurons', 'ng', 'neurons'],
    ['ds', 'dataset', 'ng', 'dataset'],

    ['conn', 'connections', 'filter', 'in'],
    ['filter', 'out', 'sort', 'in'],
    ['sort', 'out', 'sample', 'in'],
    ['sample', 'out', 'dedupe', 'in'],
    ['dedupe', 'out', 'group', 'in'],
    ['sort', 'out', 'pick', 'in'],
    ['skel', 'skeletons', 'pickSkel', 'in'],
    ['group', 'out', 'select', 'in'],
    ['select', 'out', 'join', 'left'],
    ['group', 'out', 'join', 'right'],
    ['join', 'out', 'stack', 'top'],
    ['conn2', 'connections', 'stack', 'bottom'],
    ['stack', 'out', 'pivot', 'in'],
    ['pivot', 'matrix', 'norm', 'in'],
    ['norm', 'out', 'heat', 'in'],
    ['pivot', 'table', 'table', 'in'],
    ['table', 'out', 'dl', 'in'],

    ['group', 'out', 'bar', 'in'],
    ['group', 'out', 'tableFilt', 'in'],
    ['group', 'out', 'net', 'edges'],
    ['net', 'network', 'netview', 'in'],
    ['skel', 'skeletons', 'nblastKnn', 'query'],
    ['skel', 'skeletons', 'nblast', 'query'],
    ['skel', 'skeletons', 'nblastPair', 'query'],
    ['skel', 'skeletons', 'nblastPair', 'target'],
    ['nblast', 'scores', 'linkage', 'in'],
    ['linkage', 'tree', 'cut', 'in'],
    ['linkage', 'tree', 'cutH', 'in'],
    // Through the Cut rather than off the Linkage, so the golden shows a Dendrogram reading a
    // tree that has been cut — which is the arrangement that colours its branches.
    ['cut', 'tree', 'dendro', 'in'],
    ['dendro', 'selected', 'sel', 'labels'],
    ['cut', 'clusters', 'clu', 'labels'],
    ['find', 'neurons', 'clu', 'neurons'],
    ['skel', 'skeletons', 'v3d', 'skeletons'],
    ['stack', 'out', 'muted', 'in'],
  ]
  for (const [from, out, to, into] of edges) g = wire(g, from, out, to, into)

  // Muted on the canvas: the notebook has to say so rather than quietly omitting it.
  g = {
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === 'muted' ? { ...n, disabled: true, title: 'Muted step' } : n,
    ),
  }
  return g
}
