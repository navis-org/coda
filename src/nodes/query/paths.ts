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

import { canTotalGroups, canTracePaths, groupTotalsRefusal } from '../../data/source'
import { groupTotalsFor, pathStepFor } from '../../data/queries'
import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import type { TableValue } from '../../core/values'
import { isTableValue, makeLayout } from '../../core/values'
import { layoutNetwork } from '../../layout/network'
import { getColumn } from '../../core/values'
import type { PathNode } from '../lib/pathOps'
import {
  MAX_PATH_STEPS,
  PATH_NETWORK_TYPE,
  PATH_TABLE_SCHEMA,
  groupTotalsLookup,
  pathNetworkType,
  pathStats,
  pathTableSchema,
  pathsTable,
  pathsToNetwork,
  prunePathGraph,
  rankPaths,
  scoredEnd,
  traversePaths,
} from '../lib/pathOps'
import { normalizeSide, readBasis, readNormalizeBy } from '../lib/connectivityOps'
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
    'Not “what is wired to this?” but “how does this reach that?” — the strongest feed-forward ' +
    'routes from sources to targets, ranked by their weakest link rather than by a sum, since a ' +
    'chain is only as strong as its narrowest step. Collapse types traverses the type-level ' +
    'graph, which is usually the circuit somebody means. Three outputs: the pruned network, a ' +
    'layout for it, and one row per route.',
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
    {
      id: 'normalize',
      kind: 'boolean',
      label: 'Normalize',
      /*
       * `Connectivity`'s control, and the same two output columns — but the denominator here
       * belongs to a **group**. With `Collapse types` on, `LC4 → PLP1` is divided by everything
       * every PLP1 neuron receives, which is what `GroupTotalsRequest` exists to answer: the
       * frontier carries a type name and a per-neuron total cannot be asked about one.
       */
      help: 'Add weightNorm, each connection as a fraction of one group\u2019s total synapses, and weightTotal, the denominator it was divided by. With Collapse types on the denominator is the whole population\u2019s total, not one neuron\u2019s.',
      default: false,
    },
    {
      id: 'normalizeBy',
      kind: 'enum',
      label: 'Normalize by',
      help: 'Which end of the connection the denominator belongs to. These are different questions, not two views of one number.',
      default: 'postsynaptic',
      options: [
        { value: 'postsynaptic', label: 'the target\u2019s total input' },
        { value: 'presynaptic', label: 'the source\u2019s total output' },
      ],
      visibleIf: (params) => params.normalize === true,
    },
    {
      id: 'normalizeBasis',
      kind: 'enum',
      label: 'Denominator',
      help: 'All synapses counts everything the group makes, including synapses onto fragments nobody reconstructed. Reconstructed partners only counts synapses onto partners the dataset calls neurons, which is the denominator to use when comparing routes across connectomes proofread to different depths.',
      default: 'all',
      options: [
        { value: 'all', label: 'all synapses' },
        { value: 'connected', label: 'reconstructed partners only' },
      ],
      visibleIf: (params) => params.normalize === true,
    },
    {
      id: 'rankBy',
      kind: 'enum',
      label: 'Rank by',
      /*
       * The reason both numbers are emitted rather than one being swapped for the other. A
       * route's weakest link in synapses and its weakest link as a share of what the next
       * population receives are **different steps** as soon as the populations differ in size:
       * ranking by synapses prefers the route through the biggest population, which is the
       * failure normalising is usually reached for in the first place.
       */
      help: 'Which weakest link decides the ranking, and so which routes N strongest keeps. The two are different steps of the route as soon as the populations differ in size \u2014 synapses prefers a route through a large population, fraction prefers one that is a large share of what the next population receives.',
      default: 'synapses',
      options: [
        { value: 'synapses', label: 'synapses (weakest link)' },
        { value: 'fraction', label: 'fraction of the total' },
      ],
      visibleIf: (params) => params.normalize === true,
    },
    {
      id: 'minFraction',
      kind: 'number',
      label: 'Min fraction',
      /*
       * A second threshold rather than a replacement for `Min synapses`, because the two are
       * applied in different places and only one of them can be pushed down: the backend cuts
       * on the aggregated weight inside the hop's own query, where a fraction needs a
       * denominator that arrives a round trip later. So this prunes here, per hop, after the
       * totals for that hop have landed — an edge below it is neither an edge nor a reason to
       * expand, which is `minWeight`'s rule one layer out.
       *
       * No `max`: `connected` denominators can produce a fraction above 1, legitimately, for
       * `normalizeConnectivity`'s recorded reason.
       */
      help: 'Discard connections carrying less than this share of the denominator, and do not follow them. Applied per hop as the search grows, so it bounds the frontier the way Min synapses does. 0 is off, and a connection whose denominator the dataset does not publish is never dropped by it.',
      default: 0,
      min: 0,
      step: 0.01,
      visibleIf: (params) => params.normalize === true,
    },
  ],

  inferOutputs: (ctx) => {
    // Fixed rather than derived from the dataset's neuron schema: a row here can stand for a
    // whole cell type, so there is nowhere to put a per-neuron column such as `status`. The one
    // thing that does move is the pair of normalisation columns, and it moves with the control
    // that produces them — `connectivityOutputSchema`'s split, for its reason.
    const normalize = ctx.params.normalize === true
    return {
      network: pathNetworkType(normalize),
      layout: T.layout(),
      paths: T.table(pathTableSchema(normalize)),
    }
  },

  validate: (ctx) => {
    const issues: string[] = []
    /*
     * Said before a run rather than only during one, which is what every other capability-gated
     * node here does. It is also the reader the dataset *type*'s `edges` flag exists for: an
     * attached edge set answers a hop locally, so a backend declaring `paths: false` — CAVE,
     * whose API has no server-side aggregation — goes from refusing outright to traceable, and a
     * refusal has to be right before anything runs.
     */
    if (ctx.inputs.dataset && !sourceSupports(ctx.inputs.dataset, 'paths')) {
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
    /*
     * Said at edit time for the `paths` refusal's reason, and it is the same shape: a dataset
     * answering from an attached edge set reaches here too, because `canTotalGroups`
     * refuses one — a file's weights over the server's totals is one connectome divided by
     * another. The fix is named, since `Normalize` is a switch on this card rather than
     * something about the dataset the reader has to go and change.
     */
    if (
      ctx.params.normalize === true &&
      ctx.inputs.dataset &&
      !sourceSupports(ctx.inputs.dataset, 'groupTotals')
    ) {
      issues.push(groupTotalsRefusal(sourceLabel(ctx.inputs.dataset) ?? 'This source'))
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

    const normalize = ctx.params.normalize === true
    const by = readNormalizeBy(ctx.params.normalizeBy)
    const basis = readBasis(ctx.params.normalizeBasis)
    // Only meaningful while normalising, and only then read: `Rank by` is `visibleIf`-hidden
    // with `Normalize` off, so it is out of the provenance key there as well.
    const rankBy = normalize && ctx.params.rankBy === 'fraction' ? 'norm' : 'weight'
    const minFraction = normalize ? Math.max(0, Number(ctx.params.minFraction ?? 0)) : 0
    /*
     * The same predicate `validate` asks and the funnel asks again, said here so the message
     * names this node's own switch. `groupTotalsFor` would refuse anyway, one hop in — after a
     * round trip and with the reason attached to a query rather than to a control.
     */
    if (normalize && !canTotalGroups(source, dataset.datasetId, dataset.edges !== undefined)) {
      throw new Error(groupTotalsRefusal(source.label))
    }

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
      /*
       * A second query per hop, asked about the keys that hop returned. Not one query at the
       * end, because `Min fraction` prunes the frontier *as it grows* — a denominator that
       * arrives after the search is over can rank what was found and cannot change what was
       * followed.
       *
       * `connectivityRequest` rather than `datasetRequest`, so the edge set travels with it and
       * `groupTotalsFor` can refuse a dataset answering from a file.
       */
      normalize: normalize
        ? {
            by,
            minFraction,
            totals: async (frontier) =>
              groupTotalsLookup(
                await groupTotalsFor(source, {
                  ...connectivityRequest(dataset),
                  types: frontier.types,
                  neuronIds: frontier.neuronIds,
                  side: normalizeSide(by),
                  basis,
                  signal: ctx.signal,
                }),
              ),
          }
        : undefined,
    })

    ctx.progress(0.85, 'ranking routes')
    const sourceKeys = sources.map((n) => n.key)
    const targetKeys = targets.map((n) => n.key)
    const pruned = prunePathGraph(graph, sourceKeys, targetKeys, maxHops)
    const ranked = rankPaths(pruned, sourceKeys, targetKeys, maxHops, topN, rankBy)

    const network = pathsToNetwork(pruned, ranked.paths, sourceKeys, targetKeys, normalize)
    const stats = pathStats(ranked.paths)
    if (stats.count === 0) {
      // Not an error: "these two are not connected within N hops at this threshold" is a real
      // and useful answer, and throwing would block everything downstream from ever drawing
      // the empty result that says so.
      ctx.progress(1, `no route within ${maxHops} hops`)
      return {
        network,
        layout: makeLayout({}, 'ELK layered'),
        paths: pathsTable([], normalize),
      }
    }

    /*
     * The groups the dataset published no denominator for, counted off the pruned graph rather
     * than off the totals cache — what matters is how much of *this result* is unmeasured, and
     * the search asked about a great deal it then threw away.
     *
     * Said out loud for `normalizeConnectivity`'s reason, plus one this node adds: under
     * `Rank by: fraction` a route with an unscored step cannot be scored at all, so it sorts
     * below every route that can be — which is a silent demotion rather than a blank cell.
     */
    if (normalize) {
      const unmeasured = new Set<string>()
      for (const edge of pruned.edges.values()) {
        // `scoredEnd`, shared with the traversal that wrote these — which end owns a denominator
        // is one decision, and counting it against the other end is a plausible wrong number.
        if (edge.norm === null) unmeasured.add(scoredEnd(edge, by))
      }
      if (unmeasured.size > 0) {
        ctx.warn(
          `${unmeasured.size.toLocaleString()} ${collapseTypes ? 'groups' : 'neurons'} on the ` +
            `${by === 'postsynaptic' ? 'receiving' : 'sending'} end of a connection have no ` +
            `published total, so weightNorm is empty there` +
            (rankBy === 'norm'
              ? ' — and any route through one of them ranks below every route that could be scored.'
              : '.'),
        )
      }
    }

    /*
     * A truncated search is a *ranking that is not the ranking* — "the strongest found" wearing
     * the label "the strongest" — so it belongs on the card next to the result rather than in a
     * progress note that the next repaint wipes. The note stays as well: it is what is on screen
     * while the layout runs.
     */
    if (ranked.truncated) {
      ctx.warn(
        `The route search hit its step budget (${MAX_PATH_STEPS.toLocaleString()} steps), so ` +
          `these are the strongest routes *found* rather than the strongest routes. Raising ` +
          `Min synapses or lowering Max hops thins the graph the search walks.`,
      )
    }

    ctx.progress(0.95, 'laying out')
    const positions = await layoutNetwork(network)

    ctx.progress(
      1,
      `${stats.count} route${stats.count === 1 ? '' : 's'} · min ${stats.minHops} hops${
        rankBy === 'norm' ? ' · ranked by fraction' : ''
      }${ranked.truncated ? ' · search truncated' : ''}`,
    )
    return {
      network,
      layout: makeLayout(positions, 'ELK layered'),
      paths: pathsTable(ranked.paths, normalize),
    }
  },
})
