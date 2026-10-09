/**
 * Cut Tree: groups out of a merge tree.
 *
 * A linkage is every partition at once. This is the node that picks one — either "give me six
 * groups" or "cut across at this distance" — and it is separate from Linkage because those are
 * different acts: the tree is computed once and expensively, and the cut is somebody trying a
 * number, looking at the dendrogram, and trying another. Folding it into Linkage would put a
 * spinner on an `expensive` node and re-run a Python call per press of it.
 *
 * **Two outputs, and the pass-through is the useful one.** `Clusters` is the table — join it
 * onto a neuron table and the 3D view, the network and the scatter can all colour by cluster.
 * `Tree` is the same tree with the cut recorded on it, so a Dendrogram wired after this one
 * colours its branches by group with no second input and no column picker.
 *
 * **`cheap`, and genuinely so**: this is a union-find over `n - 1` merges, no network and no
 * Python. Which is the whole reason it is its own node.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isLinkageValue } from '../../core/values'
import { qualifiedDataset } from '../../core/ids'
import {
  clusterSchema,
  clusterTable,
  cutByCount,
  cutByHeight,
  cutHomogeneous,
  linkageMaxHeight,
  withClusters,
} from '../lib/linkageOps'

registerNode({
  type: 'cluster.cut',
  label: 'Cut Tree',
  category: 'analysis',
  description:
    'Cut a merge tree into groups, by number of clusters or by distance. The Clusters table has the columns `label`, `cluster`, `order` and `size`.',
  guide:
    'Cuts a Linkage tree into groups: either a fixed number of clusters, at a distance ' +
    'threshold, or (for two connectomes clustered together) into groups that contain neurons from ' +
    'every dataset. Fast, so you can try different cuts while looking at the Dendrogram.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Tree', type: T.linkage() }],
  outputs: [
    { id: 'clusters', label: 'Clusters', type: T.table(clusterSchema()) },
    { id: 'tree', label: 'Tree', type: T.linkage() },
  ],
  params: [
    {
      id: 'mode',
      kind: 'enum',
      label: 'Cut by',
      default: 'count',
      options: [
        { value: 'count', label: 'number of clusters' },
        { value: 'height', label: 'distance' },
        { value: 'mixed', label: 'groups drawing from every dataset' },
      ],
      help: 'How to cut the tree. Use "groups drawing from every dataset" when co-clustering connectomes: it returns the tightest groups that mix all datasets.',
    },
    {
      id: 'count',
      kind: 'int',
      label: 'Clusters',
      default: 4,
      min: 1,
      // The linkage this cuts can carry eleven thousand leaves, and cutting one into thousands
      // of small groups is a normal thing to do with it — 500 was the dendrogram's readable
      // limit standing in for the tree's.
      max: 10_000,
      visibleIf: (params) => params.mode === 'count',
      help: 'Number of clusters to return. A tree with fewer leaves gives one cluster per leaf.',
    },
    {
      id: 'height',
      kind: 'number',
      label: 'Distance',
      default: 0.5,
      min: 0,
      step: 0.05,
      visibleIf: (params) => params.mode === 'height',
      help: 'Neurons joined at or below this distance stay in one cluster. Smaller is stricter.',
    },
    {
      id: 'maxShare',
      kind: 'number',
      label: 'Largest share',
      default: 0.8,
      min: 0.5,
      max: 1,
      step: 0.05,
      slider: true,
      visibleIf: (params) => params.mode === 'mixed',
      help: 'The largest share of a group any one dataset may hold; every dataset must also be present. 0.8 means at most four-fifths from one dataset.',
    },
  ],

  inferOutputs: () => ({ clusters: T.table(clusterSchema()), tree: T.linkage() }),

  validate: (ctx) => {
    // The one thing knowable at edit time. A negative distance cuts nothing and gives one
    // cluster per leaf, which reads as a broken node rather than as a number to change.
    if (String(ctx.params.mode) === 'height' && Number(ctx.params.height) < 0) {
      return [
        '`Distance` is negative, so nothing is joined and every neuron is its own cluster. Set it to 0 or more.',
      ]
    }
    /*
     * The `mixed` mode reads the dataset off the *label*, which is what a qualified id carries.
     * Nothing at edit time knows what the labels look like — the linkage has none until it has
     * run — so this is a note about the wiring rather than a check on it.
     */
    if (String(ctx.params.mode) === 'mixed') {
      return [
        "This mode reads each neuron's dataset from its qualified id (dataset:id). Without " +
          'qualified ids every neuron ends up in its own cluster, so put a Qualify Ids node before the Stack Tables node.',
      ]
    }
    return []
  },

  evaluate: (ctx) => {
    const tree = ctx.input('in')
    if (!isLinkageValue(tree)) throw new Error('Input is not a tree — wire a Linkage node in')

    const mode = String(ctx.params.mode)
    const byHeight = mode === 'height'
    const height = Number(ctx.params.height)

    if (mode === 'mixed') {
      const share = Number(ctx.params.maxShare)
      const { clusters, datasets, singletons } = cutHomogeneous(tree, qualifiedDataset, share)
      /*
       * One dataset means nothing was qualified, and the criterion then rejects every group —
       * every neuron comes back its own cluster, which reads as a broken node rather than as a
       * missing Qualify Ids. Said out loud, and still not a refusal: the partition is real.
       */
      if (datasets < 2) {
        ctx.warn(
          'The tree seems to hold neurons from only one dataset, so no group can mix datasets. Put a ' +
            'Qualify Ids node before the Stack Tables node that combined them.',
        )
      } else if (singletons > 0) {
        ctx.warn(
          `${singletons.toLocaleString()} neurons ended up in a cluster of their own because they ` +
            `have no counterpart in the other dataset. Changing the settings will not change this.`,
        )
      }
      return { clusters: clusterTable(tree, clusters), tree: withClusters(tree, clusters) }
    }

    const clusters = byHeight
      ? cutByHeight(tree, height)
      : cutByCount(tree, Number(ctx.params.count))

    if (byHeight && height > linkageMaxHeight(tree)) {
      // Not an error: one cluster is the true answer to "what groups at this distance" when
      // the distance is above the top of the tree. But it is worth reporting, because a table
      // of every neuron in cluster 1 otherwise reads as the node having failed.
      ctx.progress(
        1,
        `above the top of the tree (${linkageMaxHeight(tree).toFixed(2)}) — 1 cluster`,
      )
    }

    return { clusters: clusterTable(tree, clusters), tree: withClusters(tree, clusters) }
  },
})
