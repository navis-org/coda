/**
 * "See also": which other documented nodes a reader should look at next.
 *
 * A Python docstring's See Also section, and the same job. The overlay is a reading surface, and
 * the question a reader has at the foot of a document is usually *what is the other one of
 * these* — Explore Dataset and Find Neurons are two answers to one question, and neither
 * document said so.
 *
 * ## Why it is a table and not the cross-references the documents already have
 *
 * The obvious source is the prose: a document links another with `[Linkage](#cluster.linkage)`,
 * `help.test.ts` already refuses one whose target has no document, and mirroring those links
 * would need no list at all. Measured across the 64 documents before this existed: **105 links,
 * 74 distinct pairs, of which 12 mutual and 62 one-way** — and 13 documents in no pair at all.
 *
 * Both halves of that measurement argue against using it. The one-way links are one-way because
 * a document explains its own node: Find Neurons' document links nothing, and four documents link
 * *to* it, so the hub nodes — the ones most worth arriving at — were exactly the ones with no way
 * onward. And the pairs prose never states are the ones a reader most wants: Mirror and Transform,
 * the two CATMAID datasets, the three ways of choosing neurons. Nothing in the corpus relates
 * them because no document has a reason to mention its own sibling.
 *
 * So the relation is written down, once, here. It is **editorial** — the same line `guide` and
 * `coda-params` draw, where the registry knows what a node *is* and a person knows which other
 * one you actually wanted. A See Also derived from sharing a category or a socket type would
 * relate every viewer to every other, since they all take a table and almost none of them are
 * alternatives.
 *
 * The prose links stay what they were: a link inside a sentence, where the sentence explains why.
 * This is what to read next when the sentences have run out.
 *
 * ## Groups, not pairs, and not a field on the node
 *
 * A group means every member is worth reading next to every other, so a set of four is one line
 * rather than six pairs — five of which somebody would forget. The relation is symmetric by
 * construction rather than by anybody checking, which is the whole reason the user's example was
 * missing in the first place.
 *
 * **Not `NodeDefinition.seeAlso`.** The `?` exists because a file exists; a relation between two
 * documents is a fact about the documents, and a list on the definition would be free to name
 * nodes with nothing to open.
 */

import { helpTypes } from './registry'

/**
 * Every group of documented nodes worth reading next to one another.
 *
 * A node may appear in several — that is the point of groups over a single partition. Skeletons
 * is a thing you fetch, a thing NBLAST compares, and a thing the 3D view draws, and a reader
 * arriving at it from any of those wants the other two.
 *
 * A type with no document is dropped rather than being an error, so a group may name the node
 * whose document arrives next month; `seeAlso.test.ts` asserts the whole list is either
 * documented or deliberately ahead of one, and that every documented node ends up in at least
 * one group — which is the coverage claim that makes this worth having at all.
 */
const RELATED: readonly (readonly string[])[] = [
  // --- getting neurons in ---------------------------------------------------
  // The first question every workflow answers, and its answers. The wizard asks it as a single
  // question (`StartId`), which is the plainest statement that these are alternatives.
  ['neuron.explore', 'neuron.findNeurons', 'neuron.inputIds', 'neuron.idsFromLabel'],
  // The escape hatch, beside the two nodes it replaces when they cannot express the question.
  ['neuron.rawCypher', 'neuron.findNeurons', 'neuron.connectivity'],
  // A table from somewhere that is not a connectome, and the way back out.
  ['core.uploadTable', 'core.tableFromUrl', 'out.download'],
  // The four annotation sources are alternatives in the plainest sense: same socket, same job.
  [
    'annotation.seaTable',
    'annotation.flyTable',
    'annotation.googleSheet',
    'annotation.caveTable',
  ],

  // --- datasets -------------------------------------------------------------
  // Whichever connectome somebody opened, the others answer "what else can I ask this of".
  [
    'dataset.hemibrain',
    'dataset.flywire',
    'dataset.cave',
    'dataset.catmaid.fafb',
    'dataset.catmaid.l1',
  ],
  // Both CATMAID, and the pair somebody comparing larva to adult wants.
  ['dataset.catmaid.fafb', 'dataset.catmaid.l1'],
  // A datastack, the tables it publishes, and the node that repairs ids proofreaders have moved.
  ['dataset.cave', 'annotation.caveTable', 'cave.updateRootIds'],
  // What a connectome holds before you have asked it anything.
  ['out.datasetSummary', 'out.rois', 'neuron.explore'],

  // --- reshaping a table ----------------------------------------------------
  // Rows in, fewer rows out. Filter is what people reach for first; the other two are what they
  // wanted about half the time.
  ['core.filterTable', 'core.sample', 'core.dedupe'],
  // Same rows, different shape.
  ['core.groupBy', 'core.pivot', 'core.join', 'core.stack'],
  // Choosing by hand rather than by predicate, and where you look at the result.
  ['core.editTable', 'core.selectOne', 'out.table'],

  // --- connectivity ---------------------------------------------------------
  // One hop, many hops, and the whole-network answer to the same question.
  ['neuron.connectivity', 'neuron.paths', 'neuron.influence', 'neuron.partnerVectors'],
  // An edge list, the graph it becomes, and the two things worth asking that graph.
  ['net.build', 'net.centrality', 'net.metrics', 'out.network'],
  // A matrix and the two ways to make one comparable before drawing it.
  ['core.pivot', 'core.normalize', 'out.heatmap', 'core.similarity'],

  // --- clustering -----------------------------------------------------------
  // How alike, from wiring or from shape, and the tree that follows.
  ['core.similarity', 'neuron.partnerVectors', 'cluster.linkage', 'neuron.nblast'],
  // A tree, the cut through it, and the two ways of getting neurons back out.
  [
    'cluster.linkage',
    'cluster.cut',
    'out.dendrogram',
    'cluster.clustersToNeurons',
    'cluster.selectedToNeurons',
  ],
  // All-by-all, and the same measure asked for one neuron's nearest matches.
  ['neuron.nblast', 'neuron.nblastKnn', 'neuron.skeletons'],
  // Putting two connectomes in one table.
  ['compare.matchTypes', 'compare.connectivity', 'core.similarity'],

  // --- geometry -------------------------------------------------------------
  // The three things a dataset will hand you in space.
  ['neuron.skeletons', 'neuron.meshes', 'neuron.roiMeshes'],
  // Both move geometry through a registration; Mirror is Transform with the sides swapped.
  ['neuron.mirror', 'neuron.xform'],
  // The two ways to look at neurons in space: Coda's own scene, and the viewer the field uses.
  ['out.viewer3d', 'out.neuroglancer', 'neuron.skeletons'],

  // --- regions --------------------------------------------------------------
  // Counts and completeness are per neuron, connectivity is region to region, and the viewer is
  // where you find out which regions there are.
  ['neuron.roiCounts', 'neuron.roiCompleteness', 'neuron.roiConnectivity', 'out.rois'],
  // A neuron's own summary, and the two queries it folds up.
  ['out.profile', 'neuron.connectivity', 'neuron.roiCounts'],

  // --- looking at it --------------------------------------------------------
  // A table, a chart of two of its columns, and a picture of the whole of it.
  ['out.table', 'out.scatter', 'out.heatmap'],

  // --- running it several times ---------------------------------------------
  // The pair: nothing else uses either.
  ['flow.forEach', 'flow.collect'],
]

/**
 * The relation, built once: every documented type to the documented types worth reading next.
 *
 * Mirrored as it goes in, so the map is symmetric by construction. Nothing is ordered here —
 * `seeAlsoFor` sorts, because the order a reader wants is by label and this module deliberately
 * has no registry to ask.
 */
let relation: ReadonlyMap<string, ReadonlySet<string>> | undefined

function related(): ReadonlyMap<string, ReadonlySet<string>> {
  if (relation) return relation
  const documented = new Set(helpTypes())
  const built = new Map<string, Set<string>>([...documented].map((type) => [type, new Set()]))
  for (const group of RELATED) {
    for (const a of group) {
      for (const b of group) {
        if (a !== b && documented.has(a) && documented.has(b)) built.get(a)?.add(b)
      }
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

/** The groups themselves, for the test that keeps them honest. */
export const SEE_ALSO_GROUPS = RELATED
