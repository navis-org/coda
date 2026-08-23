/**
 * Paths: the routes between two sets of neurons.
 *
 * Where `Connectivity` answers "what is wired to this?", this answers "how does this reach
 * that?" — which is a different query and a different result. It emits a **network**, already
 * pruned to the feed-forward connections that lie on a route, plus the **layout** for it, so
 * the picture arrives arranged rather than as a force-directed blob somebody has to untangle.
 *
 * Three things are worth reading `lib/pathOps.ts` for before changing anything here:
 *
 *  - **The traversal runs on the collapsed graph.** With `Collapse types` on, `LC4` is one
 *    node and the hop expands every LC4 neuron. That finds pathways no neuron-level search
 *    can — see the module comment — and it means `Min synapses` is a threshold on type-level
 *    traffic, which is a much larger number than a single connection's weight.
 *  - **The search is bidirectional**, so the hop budget is halved on each side. That is what
 *    makes four hops a question anyone can afford to ask.
 *  - **A route's strength is its bottleneck**, and `N strongest` keeps whole routes by it.
 *
 * The layout is fixed ELK layered rather than configurable, deliberately. It is an *output
 * value*, so any knob on it would take part in the provenance key and stale everything
 * downstream when nudged — a spacing slider that re-runs the graph is a trap. Restyling the
 * picture is what the Network node's presentational params are for.
 */

import { canTracePaths } from '../../data/source'
import { pathStepFor } from '../../data/queries'
import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { TableValue } from '../../core/values'
import { isTableValue, makeLayout } from '../../core/values'
import { layoutNetwork } from '../../layout/network'
import { getColumn } from '../../core/values'
import type { PathNode } from '../lib/pathOps'
import {
  PATH_NETWORK_TYPE,
  PATH_TABLE_SCHEMA,
  pathStats,
  pathsTable,
  pathsToNetwork,
  prunePathGraph,
  rankPaths,
  traversePaths,
} from '../lib/pathOps'
import {
  connectivityRequest,
  requireDataset,
  sourceLabel,
  sourceSupports,
} from '../lib/datasetParam'
import { idText } from '../../core/ids'

/** Above this the fan-out is worth saying out loud. A warning, never a refusal. */
const NOISY_HOPS = 4

/**
 * Group keys for the neurons arriving on a port.
 *
 * Collapsing is decided here rather than by the source, because the *seed* has to be named in
 * the same vocabulary the hops will answer in — a seed of neuron id 1234 and a first hop
 * reporting `LC4` would never meet. A neuron with no type keeps its neuron id as its key even
 * when collapsing, since there is nothing to collapse it into.
 */
export function seedNodes(table: TableValue, collapseTypes: boolean): PathNode[] {
  const neuronIds = getColumn(table, 'neuronId')
  const types = table.data['type'] ?? []
  const seen = new Map<string, PathNode>()

  for (let i = 0; i < table.length; i++) {
    const neuronId = idText(neuronIds[i])
    if (neuronId === null) continue
    const raw = types[i]
    const type = raw === null || raw === undefined || raw === '' ? null : String(raw)
    const node: PathNode =
      collapseTypes && type
        ? { key: type, type, neuronId: null }
        : { key: neuronId, type, neuronId }
    if (!seen.has(node.key)) seen.set(node.key, node)
  }
  return [...seen.values()]
}

export const pathsNode = registerNode({
  type: 'neuron.paths',
  label: 'Paths',
  category: 'query',
  description: 'Find the strongest routes from one set of neurons to another.',
  guide:
    'Not “what is wired to this?” but “how does this reach that?”. Sources in, targets in, and out come the strongest routes between them, ranked by their weakest link rather than by a sum — a chain is only as strong as its narrowest step. Collapse types traverses the type-level graph, which is usually the circuit somebody means: it finds LC4 → PLP1 → DNp01 even where no single PLP1 neuron both receives from an LC4 and projects to a DNp01. Three outputs — the pruned network, a layout for it, and one row per route.',
  cost: 'expensive',
  /*
   * No `defaultSize`, deliberately. It sizes React Flow's *wrapper*, and only a resizable card
   * — `data-sized`, i.e. a viewer — stretches to fill one. On any other node the wrapper ends
   * up taller than the card, and the state bar, whose containing block is the wrapper rather
   * than the unpositioned card, hangs out below it as a green line with nothing beside it.
   * The card's width comes from `NODE_BODIES` instead, which sets `--node-width`.
   */
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'sources', label: 'Sources', type: T.neurons() },
    { id: 'targets', label: 'Targets', type: T.neurons() },
  ],
  outputs: [
    { id: 'network', label: 'Network', type: PATH_NETWORK_TYPE },
    { id: 'layout', label: 'Layout', type: T.layout() },
    { id: 'paths', label: 'Paths', type: T.table(PATH_TABLE_SCHEMA) },
  ],
  params: [
    {
      id: 'maxHops',
      kind: 'int',
      label: 'Max hops',
      help: 'Longest route to look for, in synapses. The search runs from both ends at once, so this costs about half what the number suggests — but each hop still multiplies the frontier, and Min synapses is what divides it.',
      default: 3,
      min: 1,
      max: 8,
      step: 1,
    },
    {
      id: 'minWeight',
      kind: 'int',
      label: 'Min synapses',
      help: 'Discard connections below this many synapses. Applied after the grouping, so with Collapse types on it is a threshold on the total traffic between two cell types — a much larger number than a single connection carries.',
      default: 10,
      min: 1,
      step: 1,
    },
    {
      id: 'topN',
      kind: 'int',
      label: 'N strongest',
      help: 'Keep this many routes, ranked by their weakest link. The network is what those routes span. 0 keeps every route found.',
      default: 25,
      min: 0,
      step: 5,
    },
    {
      id: 'collapseTypes',
      kind: 'boolean',
      label: 'Collapse types',
      help: 'Trace the circuit between cell types rather than between individual neurons. This changes what is searched, not only what is drawn: a pathway through a population is found even when no single neuron carries the whole route.',
      default: true,
    },
  ],

  inferOutputs: () => ({
    // Fixed rather than derived from the dataset's neuron schema: a row here can stand for a
    // whole cell type, so there is nowhere to put a per-neuron column such as `status`.
    network: PATH_NETWORK_TYPE,
    layout: T.layout(),
    paths: T.table(PATH_TABLE_SCHEMA),
  }),

  validate: (ctx) => {
    const issues: string[] = []
    /*
     * Said before a run rather than only during one, which is what every other capability-gated
     * node here does. It is also the reader the dataset *type*'s `edges` flag exists for: an
     * attached edge set answers a hop locally, so a backend declaring `paths: false` — CAVE,
     * whose API has no server-side aggregation — goes from refusing outright to traceable, and a
     * refusal has to be right before anything runs.
     */
    if (ctx.inputs.dataset && !sourceSupports(ctx, 'paths')) {
      return [`${sourceLabel(ctx.inputs.dataset) ?? 'This data source'} cannot trace paths`]
    }
    const hops = Number(ctx.params.maxHops ?? 3)
    const minWeight = Number(ctx.params.minWeight ?? 10)
    /*
     * A warning rather than a cap — the same call `Find Neurons` makes about `limit: 0` and
     * `Connectivity` about deep traversals. What is worth saying is that the two multiply.
     */
    if (hops >= NOISY_HOPS && minWeight <= 1) {
      issues.push(
        `${hops} hops at Min synapses ${minWeight} expands almost every partner of every partner — this can reach a large fraction of the dataset. Raise Min synapses.`,
      )
    }
    if (hops >= NOISY_HOPS && ctx.params.collapseTypes === false) {
      issues.push(
        `At neuron level, ${hops} hops is a very large expansion — the frontier is inlined into each query. Collapse types keeps it to a few hundred nodes per hop.`,
      )
    }
    return issues
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    // One predicate, shared with `validate` above and with the funnel — see `canTracePaths`.
    if (!canTracePaths(source, dataset.datasetId, dataset.edges !== undefined)) {
      throw new Error(`${source.label} cannot trace paths`)
    }

    const sourceTable = ctx.input('sources')
    const targetTable = ctx.input('targets')
    if (!isTableValue(sourceTable)) throw new Error('Sources input is not a table')
    if (!isTableValue(targetTable)) throw new Error('Targets input is not a table')

    const collapseTypes = ctx.params.collapseTypes !== false
    const maxHops = Math.max(1, Math.floor(Number(ctx.params.maxHops ?? 3)))
    const minWeight = Math.max(1, Math.floor(Number(ctx.params.minWeight ?? 10)))
    const topN = Math.max(0, Math.floor(Number(ctx.params.topN ?? 25)))

    const sources = seedNodes(sourceTable, collapseTypes)
    const targets = seedNodes(targetTable, collapseTypes)
    if (sources.length === 0) throw new Error('No neuronIds in the incoming Sources table')
    if (targets.length === 0) throw new Error('No neuronIds in the incoming Targets table')

    ctx.progress(0.05, `${sources.length} to ${targets.length}`)
    const graph = await traversePaths({
      sources,
      targets,
      maxHops,
      signal: ctx.signal,
      // A hop's cost is unknown until its frontier is known, so progress paces the rounds and
      // the note carries the frontier size — the same shape Connectivity reports in.
      onHop: (round, rounds, frontier, direction) =>
        ctx.progress(
          0.05 + (0.75 * (round - 1)) / rounds,
          `${direction === 'outputs' ? 'downstream' : 'upstream'} hop ${round}/${rounds} · ${frontier} nodes`,
        ),
      fetch: (frontier, direction) =>
        pathStepFor(source, {
          ...connectivityRequest(dataset),
          types: frontier.types,
          neuronIds: frontier.neuronIds,
          direction,
          collapseTypes,
          minWeight,
          signal: ctx.signal,
        }),
    })

    ctx.progress(0.85, 'ranking routes')
    const sourceKeys = sources.map((n) => n.key)
    const targetKeys = targets.map((n) => n.key)
    const pruned = prunePathGraph(graph, sourceKeys, targetKeys, maxHops)
    const ranked = rankPaths(pruned, sourceKeys, targetKeys, maxHops, topN)

    const network = pathsToNetwork(pruned, ranked.paths, sourceKeys, targetKeys)
    const stats = pathStats(ranked.paths)
    if (stats.count === 0) {
      // Not an error: "these two are not connected within N hops at this threshold" is a real
      // and useful answer, and throwing would block everything downstream from ever drawing
      // the empty result that says so.
      ctx.progress(1, `no route within ${maxHops} hops`)
      return { network, layout: makeLayout({}, 'ELK layered'), paths: pathsTable([]) }
    }

    ctx.progress(0.95, 'laying out')
    const positions = await layoutNetwork(network)

    ctx.progress(
      1,
      `${stats.count} route${stats.count === 1 ? '' : 's'} · min ${stats.minHops} hops${
        ranked.truncated ? ' · search truncated' : ''
      }`,
    )
    return {
      network,
      layout: makeLayout(positions, 'ELK layered'),
      paths: pathsTable(ranked.paths),
    }
  },
})
