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
 *
 * **There are two graphs, and that is new.** The exporters no longer cover the same backends —
 * FlyWire emits caveclient in Python and nothing in R — so a CAVE node in `everythingGraph`
 * would make `canExportNotebook(graph, 'r')` refuse the whole thing and leave the R golden with
 * nothing in it. `caveGraph` is the CAVE half, exported as its own notebook and asserted to be
 * *refused* on the R side, which is the honest shape of a split neither language can hide.
 */

import type { CodaGraph, GraphEdge, GraphNode } from '../core/graph'
import { addEdge, addNode, emptyGraph } from '../core/graph'
import type { ParamValues } from '../core/node'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'

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
    /*
     * syNBLAST, off the synapse cloud. One node rather than two: its emitter branches on a
     * wired Target the same way NBLAST's does, but that branch is three lines of the same
     * closure — where NBLAST's is a different fastcore function — so the all-by-all is the
     * one worth recording and the pair is not.
     */
    {
      id: 'synblast',
      type: 'neuron.synblast',
      col: 3,
      row: 8,
      params: { symmetry: 'mean', polarityColumn: 'polarity', labelColumn: 'type' },
    },

    /*
     * Both cleaning nodes, and two of the first because its emitter's `method` is a three-way
     * branch that produces genuinely different fastcore calls — `resample_skeleton` returns
     * six arrays and interpolates the radii, `downsample_skeleton` returns four and gathers
     * them. One node would record whichever happened to be set. Same reasoning as the two
     * NBLAST nodes and the two Cut nodes.
     */
    {
      id: 'cleanskel',
      type: 'neuron.cleanSkeletons',
      col: 3,
      row: 9,
      params: { heal: true, healMaxDist: 10, smooth: 2, method: 'resample', spacing: 1 },
    },
    {
      id: 'cleanskeldown',
      type: 'neuron.cleanSkeletons',
      col: 3,
      row: 10,
      params: { method: 'downsample', factor: 4 },
    },
    /*
     * Every mesh step on at once. Unlike the skeleton pipeline these four are independent
     * `if`s rather than a branch, so one node with all of them set reaches every line.
     */
    {
      id: 'cleanmesh',
      type: 'neuron.cleanMeshes',
      col: 3,
      row: 11,
      params: {
        dropInternals: true,
        fillHoles: true,
        ratio: 0.25,
        smooth: 10,
        method: 'taubin',
        volumeCorrection: true,
      },
    },

    /*
     * All three match modes, because they are three different fastcore functions returning
     * three different shapes — and the two cutoff spellings, because `percentage` is a band
     * around each row's own best and `threshold` is one number, which is the pair most likely
     * to be conflated by whoever edits this next.
     */
    {
      id: 'matchtop',
      type: 'neuron.nblastMatches',
      col: 4,
      row: 8,
      params: { mode: 'top', n: 5, skipSelf: true, direction: 'higher' },
    },
    {
      id: 'matchabove',
      type: 'neuron.nblastMatches',
      col: 4,
      row: 9,
      params: { mode: 'above', cutoff: 'percentage', percentage: 0.05, skipSelf: true },
    },
    {
      id: 'matchcount',
      type: 'neuron.nblastMatches',
      col: 4,
      row: 10,
      params: { mode: 'count', cutoff: 'threshold', threshold: 0.4, skipSelf: false },
    },

    { id: 'linkage', type: 'cluster.linkage', col: 4, row: 5, params: { method: 'average' } },
    { id: 'cut', type: 'cluster.cut', col: 5, row: 5, params: { mode: 'count', count: 4 } },
    {
      id: 'cutH',
      type: 'cluster.cut',
      col: 5,
      row: 6,
      params: { mode: 'height', height: 0.6 },
    },
    /*
     * The mixed-dataset mode, which has no single-call equivalent in either language and emits a
     * TODO. In the fixture so the refusal is *recorded* — before this it fell through to a count
     * cut and both goldens showed a plausible, wrong analysis.
     */
    {
      id: 'cutMixed',
      type: 'cluster.cut',
      col: 5,
      row: 7,
      params: { mode: 'mixed', maxShare: 0.75 },
    },
    // A selection set, since that is the branch whose emitted frame is not simply empty.
    /*
     * The two label-to-neuron nodes, one on each branch of their shared emitter: `sel` has no
     * Neurons wired, so its labels are read as neuron ids, and `clu` has one, so it matches as
     * text and carries the cluster number across. One node would record only whichever branch
     * happened to be wired — the same reason there are two NBLAST nodes and two Select Ones.
     */
    { id: 'sel', type: 'cluster.selectedToNeurons', col: 7, row: 5 },
    {
      id: 'clu',
      type: 'cluster.clustersToNeurons',
      col: 6,
      row: 6,
      params: { matchColumn: 'type' },
    },

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
      type: 'core.filterTable',
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
    /*
     * `type` then `instance`, which is the shape this node is for: one fact spread over several
     * columns, the first filled-in one winning. A source column too, since that is a second
     * emitted line and a second generated helper — the branch a fixture without one records as
     * absent rather than as untested.
     */
    {
      id: 'combine',
      type: 'core.combineColumns',
      col: 3,
      row: 1,
      params: { columns: ['type', 'instance'], into: 'label', sourceColumn: 'label_from' },
    },
    /*
     * The `join` aggregation, which is the one that emits a generated helper rather than a
     * pandas method name — and the only route by which `coda_join` reaches a golden, where
     * `probe-py-helpers.py` can actually run it.
     */
    {
      id: 'joined',
      type: 'core.groupBy',
      col: 4,
      row: 1,
      params: { by: ['type'], agg: 'join', value: 'instance' },
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
    /*
     * Two more directions, because they are three branches the `left` node above cannot reach:
     * `outer` and `right` deduplicate *opposite* sides, and both keys are named differently
     * here, which is what makes pandas keep a second key column Coda does not publish — so the
     * fillna-and-drop only a golden would show ever gets written down.
     */
    {
      id: 'joinOuter',
      type: 'core.join',
      col: 9,
      row: 1,
      params: { leftKey: 'preType', rightKey: 'postType', how: 'outer', suffix: '_r' },
    },
    {
      id: 'joinRight',
      type: 'core.join',
      col: 9,
      row: 2,
      params: { leftKey: 'preType', rightKey: 'postType', how: 'right', suffix: '_r' },
    },
    /*
     * Two Relabels, because the branches that differ are the *target column* and `unmatched`,
     * and one node reaches one of each. The first appends under a name and puts the original
     * back where the mapping said nothing; the second rewrites in place and drops those rows —
     * so the golden carries both spellings of a helper call whose arguments are the whole
     * operation. `null`, the default and the third mode, is what `probe-py-helpers.py` runs.
     */
    {
      id: 'relabel',
      type: 'core.relabel',
      col: 5,
      row: 1,
      params: {
        column: 'type',
        keyColumn: 'type',
        valueColumn: 'label',
        into: 'shared',
        unmatched: 'keep',
      },
    },
    {
      id: 'relabelDrop',
      type: 'core.relabel',
      col: 6,
      row: 1,
      params: {
        column: 'preType',
        keyColumn: 'type',
        valueColumn: 'label',
        into: '',
        unmatched: 'drop',
      },
    },
    /*
     * A comparison over two synthetic "datasets", which is what the everything graph can offer:
     * the Labels sockets take any table, so the coalesce output stands in for a mapping. That is
     * not a workflow anybody would build — coverage is the job — but it is the only route by
     * which `coda_compare_connectivity` reaches a golden, where the probes can actually run it.
     */
    {
      id: 'compare',
      type: 'compare.connectivity',
      col: 7,
      row: 1,
      params: {
        datasetCount: 2,
        name1: 'flywire',
        pre1: 'preId',
        post1: 'postId',
        weight1: 'weight',
        name2: 'hemibrain',
        pre2: 'preId',
        post2: 'postId',
        // Empty on purpose: the second dataset counts one per row, which is the branch that
        // leaves `weight` out of the emitted spec entirely.
        weight2: '',
        idColumn: 'neuronId',
        labelColumn: 'label',
        minWeight: 2,
      },
    },
    /*
     * Both directions, because they are two branches of one helper and a fixture on `add` alone
     * records `remove` as absent rather than as untested. The second also names a dataset column,
     * which is the third branch.
     */
    {
      id: 'qualify',
      type: 'core.qualifyIds',
      col: 4,
      row: 2,
      params: { column: 'neuronId', direction: 'add', prefix: 'flywire' },
    },
    {
      id: 'unqualify',
      type: 'core.qualifyIds',
      col: 5,
      row: 2,
      params: { column: 'neuronId', direction: 'remove', into: 'dataset' },
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
     * Unpivot twice, because one instance reaches half of its emitter. Against a *known* schema
     * it can name the kept columns and does; against the pivot's wide table — which publishes no
     * schema until it has run — there is nothing to name, and the cell has to say "everything
     * not folded" as a rule rather than as a list. The second is also the pair read backwards,
     * which is the arrangement somebody will actually build.
     */
    {
      id: 'unpivot',
      type: 'core.unpivot',
      col: 4,
      row: 3,
      params: {
        columns: ['pre', 'post'],
        keep: ['neuronId', 'type'],
        nameInto: 'side',
        valueInto: 'synapses',
        dropEmpty: true,
      },
    },
    {
      id: 'unpivotWide',
      type: 'core.unpivot',
      col: 12,
      row: 1,
      params: {
        columns: ['DNp02', 'PVLP002'],
        keep: [],
        nameInto: 'postType',
        valueInto: 'weight',
      },
    },

    /*
     * The similarity pair, twice each, because both nodes have a branch a single instance
     * cannot reach. Partner Vectors emits a `neurons=` argument only when that optional port is
     * wired — the other route reads the `direction` column instead — and it omits `untyped`
     * entirely when partners are grouped by id, since `visibleIf` hides it and a hidden param
     * is not in the provenance key. Similarity has the two layouts, and Euclidean is the metric
     * whose Output setting is hidden, so `effectiveOutput` is only exercised by picking it.
     */
    {
      id: 'pvec',
      type: 'neuron.partnerVectors',
      col: 8,
      row: 2,
      params: { partnerBy: 'type', untyped: 'id', weight: 'weight', weighting: 'raw' },
    },
    {
      id: 'pvecId',
      type: 'neuron.partnerVectors',
      col: 8,
      row: 3,
      params: { partnerBy: 'id', weight: 'weight', weighting: 'fraction' },
    },
    /*
     * A third, wired to Labels — the arm that replaces `partner_by`/`untyped` with a mapping and
     * emits three different arguments. The two above cover the other branch twice over and
     * neither reaches this one, so renaming `labelId` would have passed CI in both languages.
     */
    {
      id: 'pvecLabels',
      type: 'neuron.partnerVectors',
      col: 8,
      row: 4,
      params: {
        weight: 'weight',
        weighting: 'raw',
        labelId: 'neuronId',
        labelName: 'label',
      },
    },
    {
      id: 'simil',
      type: 'core.similarity',
      col: 9,
      row: 3,
      params: {
        layout: 'long',
        observations: 'neuronId',
        features: 'feature',
        value: 'weight',
        metric: 'cosine',
        output: 'similarity',
      },
    },
    {
      id: 'similWide',
      type: 'core.similarity',
      col: 9,
      row: 4,
      params: {
        layout: 'wide',
        idColumn: 'neuronId',
        wideFeatures: ['pre', 'post'],
        metric: 'euclidean',
        output: 'similarity',
      },
    },

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

    /*
     * With `Space` set, which is the branch that emits code. Unset, both emitters refuse — the
     * canvas reads the space off the *value* and an exporter has only params — and a fixture
     * that took the refusal would put a TODO in both goldens and record nothing about the call.
     * The hemibrain fixture is genuinely `JRCFIB2018F`, so this is the honest setting as well
     * as the informative one.
     */
    {
      id: 'mirror',
      type: 'neuron.mirror',
      col: 3,
      row: 11,
      params: { space: 'JRCFIB2018F' },
    },

    /*
     * Its sibling, on the same skeletons and set the same way. `JRCFIB2018F` is a brain space,
     * so this takes the branch that *emits* — the nerve-cord branch refuses, and a fixture that
     * exercised the refusal would record nothing about the call it is here to pin.
     */
    {
      id: 'xform',
      type: 'neuron.xform',
      col: 3,
      row: 12,
      params: { space: 'JRCFIB2018F' },
    },

    /*
     * The mirrored set stacked back onto the original — the co-visualisation shape, and the one
     * that exercises the source column. Skeletons rather than synapses, so this takes the
     * NeuronList branch; the points branch is `core.stack`'s code and is covered by that node.
     */
    {
      id: 'stackneurons',
      type: 'neuron.stack',
      col: 4,
      row: 11,
      params: { sourceColumn: 'side', topLabel: 'Original', bottomLabel: 'Mirrored' },
    },

    /*
     * A second one, on points, because both emitters **branch on the input kind** and emit
     * unrelated cells for the two: a neuron list concatenates as an object, a point cloud as a
     * frame. One node would record whichever branch it happened to take. Same reasoning as the
     * two NBLAST nodes above.
     *
     * It also gives R a stack it can actually emit. The one above is fed by Mirror Neurons,
     * which R declines, so that cell is a cascade — which is the honest depiction of R's gap
     * rather than a hole in the coverage, but it does mean nothing would exercise the R
     * emitter's code without this.
     */
    /*
     * A custom registration, built from the uploaded table and wired into both consumers. Two
     * branches ride on it that nothing else reaches: `navis.xform` rather than `xform_brain`,
     * and `mirror_brain(warp=<transform>)` rather than a bool. Both are exact translations
     * where the registry branches are approximations, so a golden that skipped them would
     * record only the lossy half of this node.
     */
    {
      id: 'landmarks',
      type: 'core.landmarkTransform',
      col: 3,
      row: 13,
      params: {
        sourceX: 'x',
        sourceY: 'y',
        sourceZ: 'z',
        targetX: 'x2',
        targetY: 'y2',
        targetZ: 'z2',
        targetUnits: 'um',
        targetSpace: 'JRC2018U',
      },
    },
    {
      id: 'xformcustom',
      type: 'neuron.xform',
      col: 4,
      row: 13,
      params: {},
    },
    {
      id: 'stackpoints',
      type: 'neuron.stack',
      col: 4,
      row: 7,
      params: { sourceColumn: 'batch', topLabel: 'Run 1', bottomLabel: 'Run 2' },
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
    /*
     * On the URL branch because that is the chain this node exists for: somebody else's table,
     * whose id column is called `root_id` and whose cell typing is called `cell_type`, made to
     * speak Coda's two vocabulary words before anything downstream reads either by name. Its
     * schema is genuinely unknown at export time — `Table from URL` keeps one per URL in a
     * session-scoped map — so this also records the branch where `renameMapping` has nothing to
     * resolve against and emits the pairs as typed.
     */
    {
      id: 'rename',
      type: 'core.rename',
      col: 4,
      row: 5,
      params: { renames: ['["root_id","neuronId"]', '["cell_type","type"]'] },
    },
    /*
     * On the neuron branch rather than the URL one, because the schema has to be *known* for
     * this node to record anything: two of its three emitted steps — the cast of a widened
     * column and the creation of an added one — exist only where the incoming dtypes are. The
     * three rules are the three shapes worth pinning: an ordinary overwrite, a column that did
     * not exist, and a value that does not fit the column it is written into.
     */
    {
      id: 'edit',
      type: 'core.editTable',
      col: 3,
      row: 15,
      params: {
        edits: [
          '{"w":"type==LC4 status==Traced","c":"type","v":"LC4a"}',
          '{"w":"status==Traced","c":"group","v":"reviewed"}',
          '{"w":"type~^LPLC[0-9]+$","c":"pre","v":"unknown"}',
        ],
      },
    },
    /*
     * The one annotation source that is not backend-specific, which is why it is here rather
     * than in `caveGraph`: it needs no client and no credential, so it emits in **both**
     * languages and a fixture that only reached it through the CAVE graph would leave R's
     * golden with nothing in it. Chained onto the upload, since the join is a separate branch
     * of the emitter and an unwired one records only half the cell.
     */
    {
      id: 'gsheet',
      type: 'annotation.googleSheet',
      col: 4,
      row: 4,
      params: {
        sheet: 'https://docs.google.com/spreadsheets/d/1s0Pl9uTJ7Rl0Q1cQeXsp3s5kCsPRk9dU8jZ6yQnB4Vw/edit#gid=1874360847',
        idColumn: 'root_id',
        columns: 'cell_type, side',
      },
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

    /*
     * A subgraph around a selection. `hops` rather than `component` because it is the mode with
     * something to get wrong — the hop count and the walk direction both reach the emitted call,
     * where `component` is one library function with no arguments from the card.
     */
    {
      id: 'netfilter',
      type: 'net.filter',
      col: 8,
      row: 2,
      params: {
        column: 'weightOut',
        op: 'ge',
        value: '20',
        expand: 'hops',
        hops: 2,
        direction: 'downstream',
      },
    },

    /*
     * The regex arm of the same node, and it earns its cells: `matches` is the one operator
     * carrying a note — JavaScript semantics against Python `re` and against POSIX ERE — and no
     * fixture used it, in either language, for either Filter node. That gap is what let the R
     * `net.filter` silently drop the caveat its Python twin printed. A golden per language now
     * fails if either stops saying it.
     */
    {
      id: 'netregex',
      type: 'net.filter',
      col: 8,
      row: 3,
      params: { column: 'id', op: 'matches', value: '^LC[0-9]+$', expand: 'component' },
    },

    /*
     * The metrics pair, chained the way they compose on the canvas: Centrality writes its
     * columns onto the network and Metrics reads the result, so the golden records both the
     * helper calls and the vertex-attribute writeback that puts them back on the graph.
     *
     * `samples` is deliberately non-zero. It is the one setting where the two documents differ
     * from the canvas *and from each other* — Python drops the summary's path statistics,
     * because networkx will not say which distances its pivots saw, and R runs the exact sweep,
     * because igraph has no pivot sampling at all — and both emitters say so in a `NOTE`. A
     * golden with sampling off would record neither sentence.
     */
    {
      id: 'central',
      type: 'net.centrality',
      col: 9,
      row: 2,
      params: {
        betweenness: true,
        closeness: true,
        pagerank: true,
        eigenvector: true,
        communities: true,
        weighted: true,
        samples: 200,
        seed: 7,
        resolution: 1.2,
        damping: 0.85,
      },
    },
    {
      id: 'netmetrics',
      type: 'net.metrics',
      col: 10,
      row: 2,
      params: { plotX: 'degree', plotY: 'betweenness', bins: 12, logScale: true },
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
    /*
     * Describe Table, on `group` rather than on the pivot: its own emitter needs no schema,
     * but a summary of a table whose columns are only *observed* would be a summary of
     * nothing anybody can read back against the canvas.
     */
    { id: 'describe', type: 'out.describe', col: 12, row: 3 },
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
        // Real param ids. This said `colorColumn: 'type'`, which no param on `out.scatter` is
        // called — so the golden showed a seaborn call with no `hue=` and nothing said so.
        pointColorMode: 'categorical',
        pointColorBy: 'type',
        pointShapeMode: 'categorical',
        pointShapeBy: 'type',
        xLog: true,
        yLog: true,
        trend: 'linear',
        idColumn: 'neuronId',
        selection: ['1001'],
      },
    },
    /*
     * The three label-shaped selections, one of each: a histogram whose selection is a pair of
     * value *ranges*, a pie whose selection is a category label, and a box plot whose selection
     * is a group label. Each exporter resolves those into a `Selected` frame its own way, and
     * the branch that resolves nothing is already covered by every other viewer here.
     */
    {
      id: 'hist',
      type: 'out.histogram',
      col: 8,
      row: 4,
      params: {
        value: 'pre',
        series: 'type',
        logX: true,
        // Automatic bins on both sides, which is the branch where the two disagree and both
        // documents have to say so.
        binMode: 'auto',
        selection: ['10:100', '100:1000:c'],
      },
    },
    {
      id: 'pie',
      type: 'out.pie',
      col: 8,
      row: 5,
      params: {
        category: 'preType',
        value: 'sum_weight',
        shape: 'donut',
        maxSlices: 6,
        selection: ['LC4'],
      },
    },
    {
      id: 'dist',
      type: 'out.distribution',
      col: 8,
      row: 6,
      params: {
        value: 'pre',
        group: 'type',
        style: 'both',
        // The one whisker rule ggplot cannot express, so the R document's refusal note is in
        // the golden rather than only in the emitter.
        whiskers: 'p5p95',
        logAxis: true,
        maxGroups: 12,
        selection: ['LC4'],
      },
    },
    {
      /*
       * A second box plot, because `style` and `orientation` fan out into branches the first
       * one cannot reach: swarm-over-box, and the axis pair swapped. Both exporters read the
       * orientation off which of `x`/`y` is numeric, so a golden that only ever showed one way
       * round would record half the translation.
       */
      id: 'dist2',
      type: 'out.distribution',
      col: 8,
      row: 7,
      params: {
        value: 'pre',
        group: 'type',
        style: 'swarmBox',
        orientation: 'columns',
        maxGroups: 8,
      },
    },
    {
      id: 'netview',
      type: 'out.network',
      col: 8,
      row: 2,
      params: { minLinkWeight: 10, hideIsolated: true },
    },
    {
      // Named regions rather than the empty picker, so the golden shows the branch that puts a
      // literal list in the cell — the primary-set branch is the one `out.rois` already covers.
      id: 'roimesh',
      type: 'neuron.roiMeshes',
      col: 2,
      row: 9,
      params: { rois: ['EB', 'FB'] },
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
      type: 'core.filterTable',
      col: 9,
      row: 2,
      params: { column: 'weight', op: 'gt', value: '1' },
    },
  ]

  for (const spec of nodes) g = place(g, spec)

  const edges: Array<[string, string, string, string]> = [
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'summary', 'dataset'],
    ['ds', 'dataset', 'explore', 'dataset'],
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
    ['find', 'neurons', 'combine', 'in'],
    ['find', 'neurons', 'joined', 'in'],
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
    ['skel', 'skeletons', 'mirror', 'in'],
    ['skel', 'skeletons', 'xform', 'in'],
    ['skel', 'skeletons', 'stackneurons', 'top'],
    ['mirror', 'out', 'stackneurons', 'bottom'],
    ['upload', 'out', 'landmarks', 'in'],
    ['landmarks', 'transform', 'xformcustom', 'transform'],
    ['skel', 'skeletons', 'xformcustom', 'in'],
    ['landmarks', 'transform', 'mirror', 'warp'],
    ['syn', 'points', 'stackpoints', 'top'],
    ['syn', 'points', 'stackpoints', 'bottom'],
    ['group', 'out', 'select', 'in'],
    ['select', 'out', 'join', 'left'],
    ['group', 'out', 'join', 'right'],
    ['join', 'out', 'stack', 'top'],
    ['select', 'out', 'joinOuter', 'left'],
    ['group', 'out', 'joinOuter', 'right'],
    ['select', 'out', 'joinRight', 'left'],
    ['group', 'out', 'joinRight', 'right'],
    ['conn2', 'connections', 'stack', 'bottom'],
    ['conn', 'connections', 'pvec', 'in'],
    ['find', 'neurons', 'pvec', 'neurons'],
    ['conn2', 'connections', 'pvecId', 'in'],
    ['pvec', 'out', 'simil', 'in'],
    ['roi', 'counts', 'similWide', 'in'],
    ['find', 'neurons', 'relabel', 'in'],
    ['combine', 'out', 'relabel', 'map'],
    ['dedupe', 'out', 'relabelDrop', 'in'],
    ['combine', 'out', 'relabelDrop', 'map'],
    ['conn', 'connections', 'compare', 'edges1'],
    ['combine', 'out', 'compare', 'labels1'],
    ['conn2', 'connections', 'compare', 'edges2'],
    ['combine', 'out', 'compare', 'labels2'],
    ['find', 'neurons', 'qualify', 'in'],
    ['qualify', 'out', 'unqualify', 'in'],
    ['conn', 'connections', 'pvecLabels', 'in'],
    ['find', 'neurons', 'pvecLabels', 'neurons'],
    ['combine', 'out', 'pvecLabels', 'labels'],
    ['linkage', 'tree', 'cutMixed', 'in'],
    ['stack', 'out', 'pivot', 'in'],
    ['pivot', 'matrix', 'norm', 'in'],
    ['norm', 'out', 'heat', 'in'],
    ['pivot', 'table', 'table', 'in'],
    ['find', 'neurons', 'unpivot', 'in'],
    ['pivot', 'table', 'unpivotWide', 'in'],
    ['table', 'out', 'dl', 'in'],

    ['group', 'out', 'bar', 'in'],
    ['group', 'out', 'pie', 'in'],
    ['find', 'neurons', 'hist', 'in'],
    ['find', 'neurons', 'dist', 'in'],
    ['find', 'neurons', 'dist2', 'in'],
    ['group', 'out', 'tableFilt', 'in'],
    ['group', 'out', 'describe', 'in'],
    ['group', 'out', 'net', 'edges'],
    ['net', 'network', 'netview', 'in'],
    ['net', 'network', 'netfilter', 'in'],
    ['net', 'network', 'netregex', 'in'],
    ['net', 'network', 'central', 'in'],
    ['central', 'out', 'netmetrics', 'in'],
    ['syn', 'points', 'synblast', 'query'],
    ['skel', 'skeletons', 'cleanskel', 'in'],
    ['skel', 'skeletons', 'cleanskeldown', 'in'],
    ['mesh', 'meshes', 'cleanmesh', 'in'],
    ['nblast', 'scores', 'matchtop', 'in'],
    ['nblast', 'scores', 'matchabove', 'in'],
    ['nblast', 'scores', 'matchcount', 'in'],
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
    ['ds', 'dataset', 'roimesh', 'dataset'],
    ['roimesh', 'meshes', 'v3d', 'volumes'],
    ['stack', 'out', 'muted', 'in'],
    ['url', 'out', 'rename', 'in'],
    ['find', 'neurons', 'edit', 'in'],
    ['upload', 'out', 'gsheet', 'annotations'],
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

/**
 * The CAVE half.
 *
 * Kept apart from `everythingGraph` because R refuses it outright — see the note above — and
 * because it wants a shape the everything graph does not: the reference wiring that made
 * reference edges necessary in the first place. `CAVE table → Update root IDs → Dataset`, with
 * both nodes pointing their Dataset sockets *back* at the dataset they feed, which is two edges
 * between one pair in opposite directions and a cycle at node granularity.
 *
 * The `Custom CAVE` node is here for the reason all six neuPrint families are in the other
 * graph: it and `dataset.flywire` share an emitter but not the branch that resolves a
 * materialization, so a fixture reaching only one of them records only half the code.
 *
 * The chain is three sources deep — FlyTable, then a wide CAVE table, then a long one — because
 * what each adds is different: SeaTable is a whole other library, the wide and long CAVE forms
 * are two branches of one emitter, and only a chain exercises the outer join between them.
 */
export function caveGraph(): CodaGraph {
  let g = emptyGraph('CAVE')
  g.meta = { ...g.meta, description: 'The CAVE nodes, wired the way references exist for.' }

  const nodes: Spec[] = [
    { id: 'ds', type: 'dataset.flywire', col: 4, params: { version: '783' } },
    /*
     * The other two published datastacks, wired to nothing. They share `dataset.flywire`'s
     * generated emitter and reach no branch of it that FlyWire does not, so this is coverage
     * rather than a second assertion — but the coverage is the point: a family added to the
     * table with no fixture node is a dataset the exporter has never been run against.
     */
    { id: 'banc', type: 'dataset.banc', col: 4, row: 4, params: { version: '888' } },
    { id: 'minnie', type: 'dataset.minnie65', col: 4, row: 5, params: { version: '1822' } },
    // Both SeaTable registrations, since they share an emitter and differ in the host it
    // defaults to — a fixture reaching one records half the code.
    {
      id: 'sea',
      type: 'annotation.seaTable',
      col: -2,
      params: { base: 'my base', table: 'types', idColumn: 'root_id' },
    },
    {
      id: 'fly',
      type: 'annotation.flyTable',
      col: -1,
      params: { base: 'main', table: 'info', columns: 'cell_type, side', idColumn: 'root_id' },
    },
    {
      id: 'ann',
      type: 'annotation.caveTable',
      col: 0,
      params: { datastack: 'flywire_fafb_public:783', table: 'nuclei_v1', columns: 'volume' },
    },
    {
      id: 'annLong',
      type: 'annotation.caveTable',
      col: 1,
      params: {
        table: 'hierarchical_neuron_annotations',
        idColumn: 'target_id',
        pivotOn: 'classification_system',
        valueColumn: 'cell_type',
      },
    },
    { id: 'filter', type: 'core.filterTable', col: 2, params: { column: 'type', op: 'notEmpty' } },
    {
      id: 'repair',
      type: 'cave.updateRootIds',
      col: 3,
      params: { idColumn: 'neuronId', supervoxelColumn: 'supervoxel_id' },
    },
    { id: 'table', type: 'out.table', col: 5, row: 1 },
    { id: 'find', type: 'neuron.findNeurons', col: 5, params: { typePattern: 'LC.*' } },
    // A neuPrint-only node on a CAVE dataset: the walk turns an undeclared backend into a TODO,
    // and the golden is where that message is read. Find Neurons used to be this one, and is now
    // written for both — which is the shape of the whole exercise, so the marker moved rather
    // than the assertion being dropped.
    { id: 'summary', type: 'out.datasetSummary', col: 6, params: {} },
    /*
     * And one that *is* written for both, since only its index fetch is backend-specific. The
     * query and the selection are both set so the golden carries the search and the text-keyed
     * `isin` — a CAVE id column is `str`, and comparing it against Python ints matches nothing.
     */
    {
      id: 'explore',
      type: 'neuron.explore',
      col: 5,
      row: 2,
      params: { query: 'side=left', selection: ['720575940628857210'] },
    },
    {
      id: 'custom',
      type: 'dataset.cave',
      col: 0,
      row: 2,
      params: { datastack: 'wclee_aedes_brain', version: '117', neuronTable: 'nuclei' },
    },
    /*
     * The two discovery nodes, and they are here as a *pair* because between them they cover the
     * two ways a CAVE node learns its datastack — the branch `discoveryClient` exists for.
     * `tables` takes it from the Dataset wired to it, whose cell the walk has already bound, so
     * the golden records `<dataset>.client`; `info` takes it from its own field, so the golden
     * records a second `CAVEclient(...)` being constructed. One of them alone would record half
     * the emitter.
     */
    { id: 'tables', type: 'cave.tables', col: 5, row: 3, params: { includeViews: true } },
    {
      id: 'info',
      type: 'cave.tableInfo',
      col: 6,
      row: 3,
      params: { datastack: 'flywire_fafb_public:783', table: 'nuclei_v1' },
    },
  ]
  for (const spec of nodes) g = place(g, spec)

  const edges: Array<[string, string, string, string]> = [
    // The reference wiring: both of these name the dataset they feed.
    ['ds', 'dataset', 'annLong', 'dataset'],
    ['ds', 'dataset', 'repair', 'dataset'],
    ['sea', 'annotations', 'fly', 'annotations'],
    ['fly', 'annotations', 'ann', 'annotations'],
    ['ann', 'annotations', 'annLong', 'annotations'],
    ['annLong', 'annotations', 'filter', 'in'],
    ['filter', 'out', 'repair', 'in'],
    ['repair', 'out', 'ds', 'annotations'],
    ['repair', 'out', 'table', 'in'],
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'summary', 'dataset'],
    ['ds', 'dataset', 'explore', 'dataset'],
    ['ds', 'dataset', 'tables', 'dataset'],
  ]
  for (const [from, out, to, into] of edges) g = wire(g, from, out, to, into)
  return g
}

/**
 * A dataset node wired to one query node, both built over their declared defaults.
 *
 * The counterpart of `everythingGraph` for a setting that lives on the **dataset** and shows up
 * in every query cell below it. The everything graph cannot test one: `spec.params` above writes
 * params verbatim rather than over `defaultParams`, so its dataset nodes carry the population
 * checkboxes absent — which is off, and is what makes the unchanged goldens a proof that a graph
 * saved before those params existed still exports exactly as it did.
 *
 * Here rather than copied into both `export.test.ts` files, which is where it started: the two
 * were character-identical, and a graph builder that drifts between the languages is how their
 * two suites come to be checking different things while both stay green.
 */
export function twoNodeGraph(
  datasetType: string,
  datasetParams: ParamValues,
  queryType: string,
  queryParams: ParamValues = {},
): CodaGraph {
  let g = emptyGraph('two-node')
  for (const [id, type, params] of [
    ['ds', datasetType, datasetParams],
    ['q', queryType, queryParams],
  ] as const) {
    g = addNode(g, {
      id,
      type,
      position: { x: 0, y: 0 },
      params: { ...defaultParams(requireNodeDef(type)), ...params } as ParamValues,
    })
  }
  return addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'q',
    targetHandle: 'dataset',
  })
}
