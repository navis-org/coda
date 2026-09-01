import type { ParamValues } from '../../core/node'
import { registerNode } from '../../core/registry'
import { T, attributeSchema } from '../../core/types'
import { isNetworkValue } from '../../core/values'
import { warnOverThreshold } from '../../core/limits'
import type { CentralityOptions } from '../lib/networkCentrality'
import {
  SWEEP_WORK_WARN,
  centralityNetworkSchema,
  centralityNodeSchema,
  centralitySummarySchema,
  needsSweep,
  networkCentrality,
  sweepSources,
} from '../lib/networkCentrality'

/**
 * Which node matters, by four different definitions of "matters", plus communities.
 *
 * The expensive half of the metrics pair. `net.metrics` answers everything that costs one pass
 * over the links; this answers the questions that need the whole graph walked from every node,
 * and is `expensive` for exactly that reason — it runs on **Run**, never on an edit. Splitting
 * them is not tidiness: `cost` is a property of a node type rather than of a run (invariant 6),
 * so one node holding both would make reading a graph's node count wait for a shortest-path
 * sweep.
 *
 * **Headless — no card.** Its output is columns, and the surface that draws columns is already
 * built: wire this into `net.metrics` and the tiles and the scatter pick up `betweenness` and
 * `community` alongside `degree`; wire it into the Network Viewer and they are a colour and a
 * size encoding. A card here would be a fifth place that has to know how to draw a distribution.
 *
 * **Three ports, mirroring `net.metrics`.** The network carries on with the chosen columns
 * written onto its node table, `Node stats` is the same numbers as a plain table, and `Summary`
 * is the graph-level row — mean path length, diameter, reachability, modularity — which has
 * nowhere else to go: those come off the same sweep as betweenness and are facts about the
 * graph rather than about any node.
 *
 * **Five switches, and the schema follows them.** Each metric turned off is a column that is not
 * offered rather than a column of nulls, which is the difference between a picker that works and
 * one that lies. The summary is the other way round — constant width, nulls for what was not
 * computed — because its use is being stacked across runs; `centralitySummarySchema`'s own note
 * has the reasoning.
 */

/** The node's params as the options the library takes. One reader, so the two cannot disagree. */
export function centralityOptions(params: ParamValues): CentralityOptions {
  return {
    betweenness: params['betweenness'] !== false,
    closeness: params['closeness'] !== false,
    pagerank: params['pagerank'] !== false,
    eigenvector: params['eigenvector'] === true,
    communities: params['communities'] !== false,
    weighted: params['weighted'] === true,
    samples: Math.max(0, Number(params['samples'] ?? 0)),
    seed: Number(params['seed'] ?? 1),
    resolution: Number(params['resolution'] ?? 1),
    damping: Number(params['damping'] ?? 0.85),
  }
}

export const networkCentralityNode = registerNode({
  type: 'net.centrality',
  label: 'Network Centrality',
  category: 'analysis',
  description: 'Betweenness, closeness, PageRank and communities for a network`s nodes.',
  guide:
    'Adds centrality columns to a network`s nodes: betweenness and harmonic closeness from a ' +
    'shortest-path sweep, PageRank, eigenvector centrality and Louvain communities. Expensive ' +
    'by nature — the sweep walks every link once per source node — so it runs only on Run, and ' +
    'Sample trades an exact answer for a much faster one. The network passes through carrying ' +
    'the new columns.',
  cost: 'expensive',
  inputs: [{ id: 'in', label: 'Network', type: T.network() }],
  outputs: [
    { id: 'out', label: 'Network', type: T.network() },
    { id: 'nodes', label: 'Node stats', type: T.table() },
    { id: 'summary', label: 'Summary', type: T.table(centralitySummarySchema()) },
  ],
  params: [
    {
      id: 'betweenness',
      kind: 'boolean',
      label: 'Betweenness',
      default: true,
      help: 'Share of shortest paths running through each node. The expensive one.',
    },
    {
      id: 'closeness',
      kind: 'boolean',
      label: 'Closeness',
      default: true,
      help: 'Harmonic closeness: how short the paths *into* a node are, averaged. Free once betweenness is running.',
    },
    {
      id: 'pagerank',
      kind: 'boolean',
      label: 'PageRank',
      default: true,
      help: 'Weight flowing in from upstream partners, and from theirs. Linear per iteration.',
    },
    {
      /*
       * The one that defaults off. On a directed graph eigenvector centrality gives zero to
       * everything upstream of no cycle, which on a feed-forward circuit is most of it — a
       * column of zeros that looks like a bug and is the measure working as defined.
       */
      id: 'eigenvector',
      kind: 'boolean',
      label: 'Eigenvector',
      default: false,
      help: 'Classical eigenvector centrality over incoming links. Tends to zero on feed-forward graphs.',
    },
    {
      id: 'communities',
      kind: 'boolean',
      label: 'Communities',
      default: true,
      help: 'Louvain modularity communities, numbered largest first.',
    },
    {
      id: 'weighted',
      kind: 'boolean',
      label: 'Weighted paths',
      default: false,
      visibleIf: (params) => params['betweenness'] !== false || params['closeness'] !== false,
      help: 'Treat a link`s length as 1/weight instead of one hop, so a strong connection is a short path.',
    },
    {
      /*
       * 0 is exact, and the label says pivots rather than "sample size" because that is what
       * the estimator draws: whole source nodes, each contributing one full sweep.
       */
      id: 'samples',
      kind: 'int',
      label: 'Sample',
      default: 0,
      min: 0,
      step: 50,
      visibleIf: (params) => params['betweenness'] !== false || params['closeness'] !== false,
      help: 'Source nodes to sweep from. 0 sweeps every node — exact, and nodes × links of work. A few hundred is usually within a percent.',
    },
    {
      id: 'seed',
      kind: 'int',
      label: 'Seed',
      default: 1,
      min: 0,
      advanced: true,
      visibleIf: (params) =>
        Number(params['samples'] ?? 0) > 0 || params['communities'] !== false,
      help: 'Pins the pivot draw and Louvain`s walk, so a re-run gives the same answer.',
    },
    {
      id: 'resolution',
      kind: 'number',
      label: 'Resolution',
      default: 1,
      min: 0.1,
      max: 5,
      step: 0.1,
      advanced: true,
      visibleIf: (params) => params['communities'] !== false,
      help: 'Louvain`s resolution. Above 1 finds more, smaller communities.',
    },
    {
      id: 'damping',
      kind: 'number',
      label: 'Damping',
      default: 0.85,
      min: 0.1,
      max: 0.99,
      step: 0.05,
      advanced: true,
      visibleIf: (params) => params['pagerank'] !== false,
      help: 'PageRank`s damping factor — the chance of following a link rather than restarting.',
    },
  ],

  inferOutputs: (ctx) => {
    const options = centralityOptions(ctx.params)
    const input = ctx.inputs['in']
    return {
      out: T.network(
        centralityNetworkSchema(attributeSchema(input, 'nodes'), options),
        attributeSchema(input, 'edges'),
      ),
      nodes: T.table(centralityNodeSchema(options)),
      summary: T.table(centralitySummarySchema()),
    }
  },

  validate: (ctx) => {
    const options = centralityOptions(ctx.params)
    if (
      !options.betweenness &&
      !options.closeness &&
      !options.pagerank &&
      !options.eigenvector &&
      !options.communities
    ) {
      return ['Nothing selected — turn on at least one measure']
    }
    return []
  },

  evaluate: async (ctx) => {
    const network = ctx.input('in')
    if (!isNetworkValue(network)) throw new Error('Input is not a network')
    const options = centralityOptions(ctx.params)

    /*
     * The guard rail before the await, not inside it — `EvalContext.warn`'s own rule, and the
     * same arrangement `net.metrics` uses. Both counts are read off the tables rather than off
     * an index this node would otherwise build only to throw away; dangling links can only make
     * the real figure smaller, so the estimate never understates the wait.
     */
    const sweepWork = sweepSources(options, network.nodes.length) * network.edges.length
    if (sweepWork > SWEEP_WORK_WARN) {
      warnOverThreshold(ctx, {
        count: sweepWork,
        threshold: SWEEP_WORK_WARN,
        unit: 'source-link steps',
        control: 'the size an exact shortest-path sweep is usually run over',
        cost:
          'Betweenness walks every link once per source node, so the cost is nodes \u00d7 ' +
          'links. Set Sample to a few hundred pivots for an estimate that is minutes rather ' +
          'than hours.',
      })
    }

    const result = await networkCentrality(network, options, {
      signal: ctx.signal,
      /*
       * The sweep is the only phase long enough to report, and it is reported as the whole bar
       * rather than as a slice of one: PageRank and Louvain together are a rounding error
       * beside it, and a bar that crawls to 95% and then sits there is worse than one that
       * finishes and is followed by a moment of nothing.
       */
      progress: (fraction) => ctx.progress(fraction, 'shortest paths'),
    })

    if (!needsSweep(options)) ctx.progress(1)
    return { out: result.network, nodes: result.nodeStats, summary: result.summary }
  },
})
