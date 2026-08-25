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
import {
  clusterSchema,
  clusterTable,
  cutByCount,
  cutByHeight,
  linkageMaxHeight,
  withClusters,
} from '../lib/linkageOps'

export const cutTreeNode = registerNode({
  type: 'cluster.cut',
  label: 'Cut Tree',
  category: 'analysis',
  description: 'Take groups out of a merge tree, by count or by distance.',
  guide: 'Cut a tree into groups by count (exactly N clusters) or by distance threshold. Cheap — just union-find, no Python — so you can retry it while looking at the dendrogram. Clusters table joins back onto neurons. Tree carries the cut for Dendrogram to colour branches by group.',
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
      ],
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
      visibleIf: (params) => params.mode !== 'height',
      help:
        'Exactly this many groups come back. A tree of fewer leaves than this gives one ' +
        'cluster per leaf, which is as far as it can be cut.',
    },
    {
      id: 'height',
      kind: 'number',
      label: 'Distance',
      default: 0.5,
      min: 0,
      step: 0.05,
      visibleIf: (params) => params.mode === 'height',
      help:
        'Everything joined at or below this distance stays together. With NBLAST scores a ' +
        'distance of 0.5 is a score of 0.5, so smaller means stricter and more groups.',
    },
  ],

  inferOutputs: () => ({ clusters: T.table(clusterSchema()), tree: T.linkage() }),

  validate: (ctx) => {
    // The one thing knowable at edit time. A negative distance cuts nothing and gives one
    // cluster per leaf, which reads as a broken node rather than as a number to change.
    if (String(ctx.params.mode) === 'height' && Number(ctx.params.height) < 0) {
      return ['Distance is negative, so nothing is joined and every neuron is its own cluster']
    }
    return []
  },

  evaluate: (ctx) => {
    const tree = ctx.input('in')
    if (!isLinkageValue(tree)) throw new Error('Input is not a tree — wire a Linkage node in')

    const byHeight = String(ctx.params.mode ?? 'count') === 'height'
    const height = Number(ctx.params.height ?? 0.5)
    const clusters = byHeight
      ? cutByHeight(tree, height)
      : cutByCount(tree, Number(ctx.params.count ?? 4))

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
