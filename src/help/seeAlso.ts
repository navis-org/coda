/**
 * "See also": which other nodes a reader should look at next, listed at the foot of a help
 * document. The same job as a docstring's See Also section.
 *
 * It is a hand-written table rather than derived from the links in the documents, because those
 * are mostly one-way: a document explains its own node, so the nodes everybody links *to* had no
 * way onward, and siblings (Mirror and Transform, the two CATMAID datasets) never mention each
 * other. Deriving it from category or socket type would relate every viewer to every other.
 * See docs/help.md for the measurement.
 *
 * Any registered node may be listed, documented or not. The overlay links the ones that have a
 * document and names the rest.
 */

/**
 * Every group of nodes worth reading next to one another.
 *
 * A group is a clique: every member is listed under every other. So a group must only hold nodes
 * where *each pair* is worth reading together. If one node relates to several others that do not
 * relate to each other (a star), write it as several small groups instead. "3D View, Neuroglancer,
 * Skeletons" as one group listed Skeletons under Neuroglancer, which nobody wanted.
 *
 * A node may appear in several groups. A member does not need a help document: the overlay lists
 * an undocumented node by name and description, without a link.
 */
const RELATED: readonly (readonly string[])[] = [
  // --- getting neurons in ---------------------------------------------------
  // The ways of choosing which neurons to work with.
  ['neuron.explore', 'neuron.findNeurons', 'neuron.inputIds', 'neuron.idsFromLabel'],
  // Raw Cypher, for when Find Neurons or Connectivity cannot express the question.
  ['neuron.rawCypher', 'neuron.findNeurons', 'neuron.connectivity'],
  // Tables from outside a connectome, and the way back out.
  ['core.uploadTable', 'core.tableFromUrl', 'out.download'],
  ['core.linkTable', 'core.readRows'],
  ['connectome:customDataset', 'core.linkTable', 'core.uploadTable', 'core.tableFromUrl'],
  // Annotation sources: same socket, same job.
  [
    'annotation.seaTable',
    'annotation.flyTable',
    'annotation.googleSheet',
    'annotation.caveTable',
  ],

  // --- datasets -------------------------------------------------------------
  // By backend: the published datasets and the custom node for any other server.
  [
    'dataset.hemibrain',
    'dataset.malecns',
    'dataset.manc',
    'dataset.opticlobe',
    'dataset.neuprint',
  ],
  ['dataset.flywire', 'dataset.banc', 'dataset.minnie65', 'dataset.cave'],
  ['dataset.catmaid.fafb', 'dataset.catmaid.l1', 'dataset.catmaid'],
  // One flagship per backend, for "what else is there".
  ['dataset.hemibrain', 'dataset.flywire', 'dataset.catmaid.fafb'],
  // A datastack and the node that repairs outdated root ids.
  ['dataset.cave', 'dataset.flywire', 'cave.updateRootIds'],
  // Finding and reading a datastack's tables.
  ['annotation.caveTable', 'cave.tables', 'cave.tableInfo'],
  // What a connectome holds before you have asked it anything.
  ['out.datasetSummary', 'out.rois', 'neuron.explore'],
  // A neuroglancer source: geometry in, and the viewer it comes from.
  ['dataset.ngsource', 'out.neuroglancer'],
  ['dataset.ngsource', 'neuron.meshes', 'neuron.skeletons'],

  // --- reshaping a table ----------------------------------------------------
  // Fewer rows out.
  ['core.filterTable', 'core.sample', 'core.dedupe'],
  // Top N is a sort followed by a sample.
  ['core.sort', 'core.sample'],
  // The same verb on a table and on a collection of neurons.
  ['neuron.splitNeurons', 'core.filterTable'],
  // Working on columns.
  ['core.select', 'core.rename', 'core.combineColumns'],
  // Renaming a column vs. rewriting its values.
  ['core.rename', 'core.relabel'],
  // Grouping and reshaping.
  ['core.groupBy', 'core.pivot', 'core.reduceMatrix'],
  ['core.pivot', 'core.unpivot'],
  // Putting two tables together: side by side, or end to end.
  ['core.join', 'core.stack'],
  ['core.stack', 'neuron.stack'],
  // Choosing rows by hand, and where you look at them.
  ['core.editTable', 'core.selectOne', 'out.table'],
  ['out.table', 'out.describe'],

  // --- connectivity ---------------------------------------------------------
  // One hop, many hops, and the whole-network answer to the same question.
  ['neuron.connectivity', 'neuron.paths', 'neuron.influence'],
  // Partners as a list, as a matrix within a set, and as a vector per neuron.
  ['neuron.connectivity', 'neuron.adjacency', 'neuron.partnerVectors'],
  // An edge list, the graph it becomes, and what to ask of it.
  ['net.build', 'net.filter', 'net.centrality', 'net.metrics', 'out.network'],
  // A local motif query, its graph, and its results as a network or table.
  ['net.dotmotif', 'net.build', 'out.network', 'out.table'],
  // The two ways to draw a network: boxes and arrows for a few dozen nodes, WebGL for thousands.
  ['out.flowChart', 'out.network'],
  ['out.flowChart', 'neuron.paths'],
  // Influence's Transfers output is drawn as a Sankey.
  ['out.sankey', 'neuron.influence'],
  // Matrices, made comparable and drawn.
  ['core.pivot', 'core.normalize', 'out.heatmap'],
  ['neuron.adjacency', 'out.heatmap'],

  // --- synapses -------------------------------------------------------------
  // Synapse points, and turning them into connectivity.
  ['neuron.synapses', 'neuron.synapsesBetween', 'neuron.synapseEdges'],
  ['neuron.synapseEdges', 'neuron.connectivity'],
  // Which region a synapse sits in.
  ['neuron.synapses', 'neuron.pointsInVolumes', 'neuron.roiMeshes'],

  // --- clustering -----------------------------------------------------------
  // Similarity matrices, from wiring or from shape, and the clustering that follows.
  ['core.similarity', 'neuron.partnerVectors', 'cluster.linkage'],
  ['neuron.nblast', 'cluster.linkage'],
  // The NBLAST family.
  ['neuron.nblast', 'neuron.nblastKnn', 'neuron.nblastMatches', 'neuron.synblast'],
  ['neuron.nblast', 'neuron.skeletons'],
  // A tree, cutting it, and getting neurons back out.
  [
    'cluster.linkage',
    'cluster.cut',
    'out.dendrogram',
    'cluster.clustersToNeurons',
    'cluster.selectedToNeurons',
  ],
  // Linkage's Ordered output goes to a Heatmap.
  ['cluster.linkage', 'out.heatmap'],
  // Groups as a tree vs. neighbourhoods as a picture.
  ['cluster.linkage', 'core.embed', 'out.scatter'],
  // What an Embedding takes.
  ['core.embed', 'neuron.nblastKnn'],
  ['core.embed', 'neuron.partnerVectors'],
  // Two connectomes in one table.
  ['compare.matchTypes', 'compare.connectivity', 'core.qualifyIds'],
  ['compare.matchTypes', 'core.relabel'],

  // --- geometry -------------------------------------------------------------
  // What a dataset hands you in space, and where it is drawn.
  ['neuron.skeletons', 'neuron.meshes', 'out.viewer3d'],
  ['neuron.skeletons', 'neuron.cleanSkeletons', 'neuron.skeletonPoints'],
  // Splitting a neuron, what to split it from, and where the split is drawn.
  ['neuron.splitCompartments', 'neuron.synapses', 'out.viewer3d'],
  ['neuron.splitCompartments', 'out.topology'],
  ['neuron.splitCompartments', 'neuron.cleanSkeletons'],
  ['neuron.meshes', 'neuron.cleanMeshes'],
  // How alike two neurons are in shape vs. how far apart they are.
  ['neuron.distance', 'neuron.nblast'],
  ['neuron.distance', 'neuron.skeletons', 'neuron.meshes'],
  // Columns onto geometry, and the two nodes that read them.
  ['neuron.attachAttributes', 'neuron.splitNeurons', 'neuron.selectNeurons'],
  // Fewer neurons than were fetched.
  ['neuron.selectNeurons', 'neuron.splitNeurons', 'core.selectOne'],
  // Combining collections.
  ['neuron.stack', 'neuron.splitNeurons'],
  // Moving geometry through a registration.
  ['neuron.mirror', 'neuron.xform', 'core.landmarkTransform'],
  // The two 3D viewers: Coda's own, and neuroglancer.
  ['out.viewer3d', 'out.neuroglancer'],
  // Region shells: published, or your own.
  ['core.uploadMesh', 'neuron.roiMeshes', 'out.viewer3d'],
  ['core.uploadMesh', 'core.uploadTable'],

  // --- regions --------------------------------------------------------------
  ['neuron.roiCounts', 'neuron.roiCompleteness', 'neuron.roiConnectivity', 'out.rois'],

  // --- single neurons -------------------------------------------------------
  ['out.profile', 'neuron.connectivity', 'neuron.roiCounts'],
  ['out.profile', 'out.topology', 'out.neuronbridge'],
  // One neuron's arbour: its skeleton, measured, drawn flat, or drawn in 3D.
  ['out.neuronDendrogram', 'out.topology', 'neuron.skeletons', 'out.viewer3d'],

  // --- charts ---------------------------------------------------------------
  ['out.barChart', 'out.pie', 'out.histogram', 'out.distribution', 'out.rank'],
  ['out.histogram', 'out.describe'],

  // --- running it several times ---------------------------------------------
  ['flow.forEach', 'flow.collect'],
]

/**
 * The relation, built once: every type named in a group to the other types it shares a group with.
 * Mirrored as it goes in, so it is symmetric by construction. `seeAlsoFor` does the sorting.
 */
let relation: ReadonlyMap<string, ReadonlySet<string>> | undefined

function related(): ReadonlyMap<string, ReadonlySet<string>> {
  if (relation) return relation
  const built = new Map<string, Set<string>>()
  for (const group of SEE_ALSO_GROUPS) {
    for (const a of group) {
      const set = built.get(a) ?? new Set<string>()
      for (const b of group) if (a !== b) set.add(b)
      built.set(a, set)
    }
  }
  relation = built
  return relation
}

/**
 * Who to read next after this node, or an empty list.
 *
 * `order` is `getNodeDef(...).label` in the app, passed in rather than looked up, so this module
 * needs no registry and `seeAlso.test.ts` can assert the relation without one.
 */
export function seeAlsoFor(type: string, order: (type: string) => string = (t) => t): string[] {
  return [...(related().get(type) ?? [])].sort((a, b) => order(a).localeCompare(order(b)))
}

/*
 * A node pack's groups, from `src/packs/<id>/seeAlso.ts` — by file, like the pack's documents,
 * since the relation is a fact about documents rather than about node definitions.
 */
const PACK_GROUPS = import.meta.glob('../packs/*/seeAlso.ts', {
  eager: true,
  import: 'default',
}) as Record<string, readonly (readonly string[])[]>

/** The groups themselves, built in and from packs, for the relation and the test that keeps them honest. */
export const SEE_ALSO_GROUPS: readonly (readonly string[])[] = [
  ...RELATED,
  ...Object.values(PACK_GROUPS).flat(),
]
