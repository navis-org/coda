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

export const cutTreeNode = registerNode({
  type: 'cluster.cut',
  label: 'Cut Tree',
  category: 'analysis',
  description: 'Take groups out of a merge tree, by count or by distance.',
  guide:
    'Cut a tree into groups by count (exactly N clusters), by distance threshold, or — for two ' +
    'connectomes clustered together — wherever a group is lopsided, so every group draws from ' +
    'both brains. Cheap, just union-find and no Python, so you can retry it while looking at ' +
    'the dendrogram. Clusters joins back onto neurons; Tree carries the cut for Dendrogram to ' +
    'colour branches by group.',
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
      help: 'The third is for co-clustering two connectomes: it cuts wherever a group is lopsided rather than to a number, because a group of forty neurons all from one brain is not a correspondence.',
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
      help:
        'A group is kept once no single dataset holds more than this much of it and every ' +
        'dataset is present; anything more lopsided is split again. 0.8 means no group may be ' +
        'more than four-fifths one brain.',
    },
  ],

  inferOutputs: () => ({ clusters: T.table(clusterSchema()), tree: T.linkage() }),

  validate: (ctx) => {
    // The one thing knowable at edit time. A negative distance cuts nothing and gives one
    // cluster per leaf, which reads as a broken node rather than as a number to change.
    if (String(ctx.params.mode) === 'height' && Number(ctx.params.height) < 0) {
      return ['Distance is negative, so nothing is joined and every neuron is its own cluster']
    }
    /*
     * The `mixed` mode reads the dataset off the *label*, which is what a qualified id carries.
     * Nothing at edit time knows what the labels look like — the linkage has none until it has
     * run — so this is a note about the wiring rather than a check on it.
     */
    if (String(ctx.params.mode) === 'mixed') {
      return [
        'Reads each neuron’s dataset from its qualified id (dataset:id) — put a Qualify Ids ' +
          'before the Stack Tables that combined them, or every neuron looks like one dataset ' +
          'and every group comes back a singleton.',
      ]
    }
    return []
  },

  evaluate: (ctx) => {
    const tree = ctx.input('in')
    if (!isLinkageValue(tree)) throw new Error('Input is not a tree — wire a Linkage node in')

    const mode = String(ctx.params.mode ?? 'count')
    const byHeight = mode === 'height'
    const height = Number(ctx.params.height ?? 0.5)

    if (mode === 'mixed') {
      const share = Number(ctx.params.maxShare ?? 0.8)
      const { clusters, datasets, singletons } = cutHomogeneous(tree, qualifiedDataset, share)
      /*
       * One dataset means nothing was qualified, and the criterion then rejects every group —
       * every neuron comes back its own cluster, which reads as a broken node rather than as a
       * missing Qualify Ids. Said out loud, and still not a refusal: the partition is real.
       */
      if (datasets < 2) {
        ctx.warn(
          'Every neuron carries the same dataset, so no group can draw from two — put a ' +
            'Qualify Ids before the Stack Tables that combined them. Ids look like ' +
            '"flywire:720575940623374218" once they are qualified.',
        )
      } else if (singletons > 0) {
        ctx.warn(
          `${singletons.toLocaleString()} neurons ended up alone, which is what a neuron with ` +
            `no counterpart in the other dataset looks like. Read that count as a result rather ` +
            `than as a setting to tune away.`,
        )
      }
      return { clusters: clusterTable(tree, clusters), tree: withClusters(tree, clusters) }
    }

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
