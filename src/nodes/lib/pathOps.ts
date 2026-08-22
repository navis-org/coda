/**
 * Finding the routes between two sets of neurons, and turning them into a network.
 *
 * The shape of this file follows one decision: **the traversal runs on the collapsed graph,
 * not on the neuron graph it was collapsed from.** With `collapseTypes` on, a hop expands
 * every neuron of every frontier *type* and the result is aggregated back to types before
 * anything is pruned or expanded again — so the pathway `LC4 -> PLP1 -> DNp01` is found even
 * when no single PLP1 neuron both receives from an LC4 and projects to a DNp01. That is
 * usually the circuit somebody means, and it is not recoverable by collapsing a neuron-level
 * result afterwards: the neuron-level search would never have returned either edge.
 *
 * The aggregation therefore has to happen in the backend — see `PathStepRequest`. This module
 * takes the per-hop fetch as a callback and never touches a source, which is what lets the
 * whole thing be driven against a fake graph with no network.
 *
 * Three separable steps, in order:
 *
 *   1. `traversePaths`  — bidirectional BFS, collecting edges.
 *   2. `prunePathGraph` — keep only what lies on some source-to-target route within the budget.
 *   3. `rankPaths`      — enumerate routes and keep the strongest by bottleneck.
 */

import type { TableSchema } from '../../core/types'
import { T, column, tableSchema } from '../../core/types'
import type { CellValue, NetworkValue, TableValue } from '../../core/values'
import { getColumn, makeTable, tableFromRows } from '../../core/values'
import { idText } from '../../core/ids'
import type { NeuronId } from '../../core/ids'
import type { ConnectionDirection } from '../../data/source'

// ---------------------------------------------------------------------------
// The collapsed graph
// ---------------------------------------------------------------------------

/**
 * One node of the traversal graph.
 *
 * `key` is the identity — a cell type name when collapsing, a neuron id as a string otherwise.
 * `neuronId` is present exactly when the key names a single neuron, which is how a caller tells
 * whether to feed the key back to the source as a type or as an id. A neuron with no type
 * stands as its own node even when collapsing, because there is nothing to collapse it into.
 */
export interface PathNode {
  key: string
  type: string | null
  neuronId: string | null
}

export interface PathEdge {
  source: string
  target: string
  /** Synapses, summed over every neuron pair merged into this edge. */
  weight: number
  /** How many neuron-to-neuron connections were merged. 1 at neuron level. */
  pairs: number
}

export interface PathGraph {
  nodes: Map<string, PathNode>
  /** Keyed `source target`, so a pair can only appear once. */
  edges: Map<string, PathEdge>
}

function edgeKey(source: string, target: string): string {
  return `${source} ${target}`
}

/** The two lists a source needs to resolve a frontier. See `PathStepRequest`. */
export interface Frontier {
  types: string[]
  neuronIds: NeuronId[]
}

/** Split a set of group keys back into the two halves a query can index on. */
export function frontierOf(keys: Iterable<string>, graph: PathGraph): Frontier {
  const types: string[] = []
  const neuronIds: NeuronId[] = []
  for (const key of keys) {
    const node = graph.nodes.get(key)
    const neuronId = node?.neuronId
    if (neuronId !== null && neuronId !== undefined) neuronIds.push(neuronId)
    else types.push(key)
  }
  return { types, neuronIds }
}

/** One hop's worth of fetching. Injected so the traversal stays headless. */
export type PathStepFetch = (
  frontier: Frontier,
  direction: ConnectionDirection,
) => Promise<TableValue>

export interface TraverseOptions {
  sources: readonly PathNode[]
  targets: readonly PathNode[]
  /** Longest route to look for, in synapses. */
  maxHops: number
  fetch: PathStepFetch
  /** Called before each round with the round number, the total, and the frontier size. */
  onHop?: (
    round: number,
    rounds: number,
    frontier: number,
    direction: ConnectionDirection,
  ) => void
  signal?: AbortSignal
}

/**
 * How the two halves of a bidirectional search split the hop budget.
 *
 * Forward takes the ceiling. Any route of length L within the budget has every one of its
 * edges covered: the edge at position p is reached forwards when p is at most ceil(h/2), and
 * backwards otherwise, since then L - p is below L - ceil(h/2), which is at most floor(h/2).
 * Meeting in the middle is not an optimisation here so much as the difference between a
 * tractable question and an intractable one — each hop multiplies the frontier by the average
 * partner count, so halving the depth square-roots the work.
 */
export function hopSplit(maxHops: number): { forward: number; backward: number } {
  const hops = Math.max(1, Math.floor(maxHops))
  return { forward: Math.ceil(hops / 2), backward: Math.floor(hops / 2) }
}

function readStep(table: TableValue, graph: PathGraph): PathEdge[] {
  const source = getColumn(table, 'source')
  const sourceType = table.data['sourceType'] ?? []
  const sourceId = table.data['sourceId'] ?? []
  const target = getColumn(table, 'target')
  const targetType = table.data['targetType'] ?? []
  const targetId = table.data['targetId'] ?? []
  const weight = table.data['weight'] ?? []
  const pairs = table.data['pairs'] ?? []

  const stringOrNull = (cell: CellValue | undefined): string | null =>
    cell === null || cell === undefined || cell === '' ? null : String(cell)

  const found: PathEdge[] = []
  for (let i = 0; i < table.length; i++) {
    const from = String(source[i] ?? '')
    const to = String(target[i] ?? '')
    if (!from || !to) continue

    // First sighting wins: a node's identity is fixed, and a later row restating it with a
    // null type must not overwrite the name it already has.
    if (!graph.nodes.has(from)) {
      graph.nodes.set(from, {
        key: from,
        type: stringOrNull(sourceType[i]),
        neuronId: idText(sourceId[i]),
      })
    }
    if (!graph.nodes.has(to)) {
      graph.nodes.set(to, {
        key: to,
        type: stringOrNull(targetType[i]),
        neuronId: idText(targetId[i]),
      })
    }

    const edge: PathEdge = {
      source: from,
      target: to,
      weight: Number(weight[i] ?? 0) || 0,
      pairs: Number(pairs[i] ?? 1) || 1,
    }
    const key = edgeKey(from, to)
    // An edge found from both ends is one edge. Both halves report the same aggregate, so
    // the first is kept rather than the two being summed — which would double every weight
    // in the middle of the search, i.e. exactly the edges the ranking cares about most.
    if (!graph.edges.has(key)) graph.edges.set(key, edge)
    found.push(edge)
  }
  return found
}

/**
 * Bidirectional breadth-first search between two sets of group keys.
 *
 * Each round asks the source for one hop off the current frontier and folds the aggregated
 * edges into the graph; the far ends become the next frontier unless they have been expanded
 * already. `minWeight` does the pruning and it is applied by the source, *after* the
 * aggregation — so a type pair below the threshold is neither an edge nor a reason to expand.
 *
 * Nodes are expanded at most once per direction. Connectomes are full of recurrent loops, so
 * re-expanding a visited node would not terminate; the *edge* back into a visited node is
 * still recorded, which is what keeps a cycle visible in the result without traversing it.
 */
export async function traversePaths(opts: TraverseOptions): Promise<PathGraph> {
  const graph: PathGraph = { nodes: new Map(), edges: new Map() }
  for (const node of [...opts.sources, ...opts.targets]) {
    if (!graph.nodes.has(node.key)) graph.nodes.set(node.key, node)
  }

  const { forward, backward } = hopSplit(opts.maxHops)
  const rounds = forward + backward
  let round = 0

  const walk = async (
    seeds: readonly PathNode[],
    direction: ConnectionDirection,
    depth: number,
  ): Promise<void> => {
    const expanded = new Set(seeds.map((n) => n.key))
    let frontier = [...expanded]

    for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      round += 1
      opts.onHop?.(round, rounds, frontier.length, direction)

      const table = await opts.fetch(frontierOf(frontier, graph), direction)
      const next = new Set<string>()
      for (const edge of readStep(table, graph)) {
        // The far end is whichever end was not in the frontier for this direction.
        const far = direction === 'outputs' ? edge.target : edge.source
        if (!expanded.has(far)) next.add(far)
      }
      for (const key of next) expanded.add(key)
      frontier = [...next]
    }
  }

  await walk(opts.sources, 'outputs', forward)
  await walk(opts.targets, 'inputs', backward)
  return graph
}

// ---------------------------------------------------------------------------
// Pruning to what is actually on a route
// ---------------------------------------------------------------------------

interface Adjacency {
  out: Map<string, PathEdge[]>
  in: Map<string, PathEdge[]>
}

function adjacencyOf(graph: PathGraph): Adjacency {
  const out = new Map<string, PathEdge[]>()
  const inn = new Map<string, PathEdge[]>()
  for (const edge of graph.edges.values()) {
    const o = out.get(edge.source)
    if (o) o.push(edge)
    else out.set(edge.source, [edge])
    const i = inn.get(edge.target)
    if (i) i.push(edge)
    else inn.set(edge.target, [edge])
  }
  return { out, in: inn }
}

function bfsDistances(
  seeds: Iterable<string>,
  adjacent: Map<string, PathEdge[]>,
  step: (edge: PathEdge) => string,
  limit: number,
): Map<string, number> {
  const distance = new Map<string, number>()
  let frontier: string[] = []
  for (const seed of seeds) {
    if (!distance.has(seed)) {
      distance.set(seed, 0)
      frontier.push(seed)
    }
  }
  for (let hop = 1; hop <= limit && frontier.length > 0; hop++) {
    const next: string[] = []
    for (const key of frontier) {
      for (const edge of adjacent.get(key) ?? []) {
        const far = step(edge)
        if (distance.has(far)) continue
        distance.set(far, hop)
        next.push(far)
      }
    }
    frontier = next
  }
  return distance
}

export interface PrunedGraph extends PathGraph {
  /** Fewest hops from any source, per node. */
  fromSource: Map<string, number>
  /** Fewest hops to any target, per node. */
  toTarget: Map<string, number>
  adjacency: Adjacency
}

/**
 * Drop everything that is not on some source-to-target route within the hop budget.
 *
 * A node survives when `fromSource + toTarget <= maxHops`; an edge when
 * `fromSource[u] + 1 + toTarget[v] <= maxHops`. Both distances are measured on the *collected*
 * graph rather than on the connectome, and that is exact rather than approximate for this
 * purpose: every edge of every route within the budget was collected (see `hopSplit`), so a
 * node sitting at position p on such a route has `fromSource` at most p and `toTarget` at most
 * L - p, and cannot be pruned. What does get dropped is everything the two searches picked up
 * on the way that turned out to lead nowhere — which, after a hop into a hub, is most of it.
 *
 * This is also what makes the result **feed-forward**: an edge running against the flow, or
 * between two nodes at the same depth with no way onward, fails the inequality and never
 * reaches the network.
 */
export function prunePathGraph(
  graph: PathGraph,
  sources: readonly string[],
  targets: readonly string[],
  maxHops: number,
): PrunedGraph {
  const hops = Math.max(1, Math.floor(maxHops))
  const full = adjacencyOf(graph)
  const present = (keys: readonly string[]) => keys.filter((key) => graph.nodes.has(key))

  const fromSource = bfsDistances(present(sources), full.out, (e) => e.target, hops)
  const toTarget = bfsDistances(present(targets), full.in, (e) => e.source, hops)

  const nodes = new Map<string, PathNode>()
  for (const [key, node] of graph.nodes) {
    const df = fromSource.get(key)
    const db = toTarget.get(key)
    if (df === undefined || db === undefined || df + db > hops) continue
    nodes.set(key, node)
  }

  const edges = new Map<string, PathEdge>()
  for (const [key, edge] of graph.edges) {
    const df = fromSource.get(edge.source)
    const db = toTarget.get(edge.target)
    if (df === undefined || db === undefined || df + 1 + db > hops) continue
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue
    edges.set(key, edge)
  }

  const pruned: PathGraph = { nodes, edges }
  return { ...pruned, fromSource, toTarget, adjacency: adjacencyOf(pruned) }
}

// ---------------------------------------------------------------------------
// Ranking routes
// ---------------------------------------------------------------------------

export interface RankedPath {
  /** Node keys in order, source first, target last. */
  keys: string[]
  /** Edge weights along the route; one shorter than `keys`. */
  weights: number[]
  /** The weakest link. A route is only as strong as this. */
  bottleneck: number
  hops: number
}

/**
 * How many DFS steps the enumeration is allowed before it gives up.
 *
 * A brake rather than a budget: the branch-and-bound below normally converges in a tiny
 * fraction of this, and a run that reaches it is one where the pruned graph turned out to be
 * dense enough that the number of distinct routes is not a thing anybody wants listed. It is
 * reported rather than swallowed — a silently truncated ranking claims to be "the strongest"
 * when it is only "the strongest found".
 */
export const MAX_PATH_STEPS = 500_000

/**
 * The ceiling on the shortlist when `topN` is 0.
 *
 * "Every route" is not a thing that can be delivered on a dense graph — eight layers of nine
 * nodes is five million routes, each one an array — so 0 means "as many as are worth listing",
 * and hitting this reports `truncated` exactly as running out of steps does. It is also what
 * keeps the branch-and-bound working in that mode: with no shortlist there is no bound, and
 * without a bound the search degenerates into the full enumeration this exists to avoid.
 */
export const MAX_PATHS_KEPT = 5_000

export interface RankResult {
  paths: RankedPath[]
  /** True when `MAX_PATH_STEPS` ran out before the search was exhaustive. */
  truncated: boolean
}

function comparePaths(a: RankedPath, b: RankedPath): number {
  // Strongest first, then shortest, then by name — the last two only so that two runs of the
  // same query list the same routes in the same order.
  return (
    b.bottleneck - a.bottleneck ||
    a.hops - b.hops ||
    a.keys.join(' ').localeCompare(b.keys.join(' '))
  )
}

/**
 * A bounded shortlist keeping the *best* `capacity` routes, worst at the root.
 *
 * A heap rather than a sorted array, and that is a correctness matter as much as a speed one:
 * the search consults the shortlist's weakest member on every single branch, and re-sorting
 * the list on every insertion made the `topN: 0` case quadratic — the enumeration then never
 * returned at all, which reads as a hang rather than as a slow answer.
 *
 * Ordered by the same `comparePaths` the final result is sorted by, so which of two equally
 * strong routes survives eviction is decided by the same rule that would have ordered them —
 * not by whichever happened to arrive first.
 */
function makeShortlist(capacity: number) {
  const items: RankedPath[] = []
  const worse = (i: number, j: number): boolean => {
    const a = items[i]
    const b = items[j]
    return a !== undefined && b !== undefined && comparePaths(a, b) > 0
  }
  const swap = (i: number, j: number): void => {
    const a = items[i]
    const b = items[j]
    if (a === undefined || b === undefined) return
    items[i] = b
    items[j] = a
  }

  const up = (start: number): void => {
    let i = start
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!worse(i, parent)) break
      swap(i, parent)
      i = parent
    }
  }
  const down = (start: number): void => {
    let i = start
    for (;;) {
      const left = i * 2 + 1
      const right = left + 1
      let worst = i
      if (left < items.length && worse(left, worst)) worst = left
      if (right < items.length && worse(right, worst)) worst = right
      if (worst === i) break
      swap(i, worst)
      i = worst
    }
  }

  return {
    get size(): number {
      return items.length
    },
    /** The weakest route held, which is what a partial route has to beat. */
    worst(): RankedPath | undefined {
      return items[0]
    },
    /** True when the insertion pushed something out, i.e. the cap is biting. */
    add(path: RankedPath): boolean {
      if (items.length < capacity) {
        items.push(path)
        up(items.length - 1)
        return false
      }
      const root = items[0]
      if (root === undefined || comparePaths(path, root) >= 0) return true
      items[0] = path
      down(0)
      return true
    },
    drain(): RankedPath[] {
      return [...items].sort(comparePaths)
    },
  }
}

/**
 * The strongest routes from any source to any target, by bottleneck.
 *
 * A route's strength is its **weakest link** — the fewest synapses carried by any step along
 * it. That is the quantity that decides whether a signal can actually get through, and unlike
 * a sum or a product it is comparable between routes of different lengths.
 *
 * Depth-first with branch-and-bound rather than a full enumeration, because the number of
 * simple routes is exponential in the hop budget. Two prunes carry it:
 *
 *  - **Bottlenecks only ever fall.** Once `topN` routes are held, any partial route whose
 *    running minimum is already at or below the weakest of them cannot beat it, whatever
 *    comes next — so the whole subtree goes. Neighbours are visited strongest-first, which
 *    fills the shortlist with good routes early and makes the bound bite from the first
 *    branch rather than the last.
 *  - **Distance to a target is known.** `toTarget` was computed during pruning, so a partial
 *    route that cannot reach a target inside the remaining hops is abandoned at once.
 *
 * `topN` of 0 means every route, which switches the first prune off and leaves
 * `MAX_PATH_STEPS` as the only brake.
 */
export function rankPaths(
  graph: PrunedGraph,
  sources: readonly string[],
  targets: readonly string[],
  maxHops: number,
  topN: number,
): RankResult {
  const hops = Math.max(1, Math.floor(maxHops))
  const keep = Math.max(0, Math.floor(topN))
  // 0 means "as many as are worth listing" rather than literally all of them; see MAX_PATHS_KEPT.
  const capacity = keep > 0 ? keep : MAX_PATHS_KEPT
  const targetSet = new Set(targets.filter((key) => graph.nodes.has(key)))
  const shortlist = makeShortlist(capacity)
  let steps = 0
  let truncated = false
  /** Whether the shortlist's ceiling — not the caller's `topN` — changed what was searched. */
  let capped = false

  // Neighbours strongest-first, once, rather than inside the walk: the same node is reached
  // many times over and re-sorting its out-edges at each visit is the difference between this
  // being linear in the edge count and quadratic in it.
  const ordered = new Map<string, PathEdge[]>()
  for (const [key, edges] of graph.adjacency.out) {
    ordered.set(
      key,
      [...edges].sort((a, b) => b.weight - a.weight || a.target.localeCompare(b.target)),
    )
  }

  /** The bottleneck a partial route has to beat, or -Infinity while the shortlist is short. */
  const bound = (): number =>
    shortlist.size >= capacity ? (shortlist.worst()?.bottleneck ?? -Infinity) : -Infinity

  const record = (path: RankedPath): void => {
    if (shortlist.add(path) && keep === 0) capped = true
  }

  const visited = new Set<string>()
  const keys: string[] = []
  const weights: number[] = []

  const walk = (key: string, bottleneck: number): void => {
    if (truncated) return
    if (keys.length - 1 >= hops) return

    for (const edge of ordered.get(key) ?? []) {
      if (++steps > MAX_PATH_STEPS) {
        truncated = true
        return
      }
      const next = edge.target
      if (visited.has(next)) continue

      const running = Math.min(bottleneck, edge.weight)
      // Bottlenecks only fall, so a subtree that is already no better than the shortlist's
      // weakest member cannot produce anything that beats it. In `topN: 0` mode that bound
      // exists only because of `MAX_PATHS_KEPT`, so a prune there is the ceiling biting.
      if (running <= bound()) {
        if (keep === 0) capped = true
        continue
      }

      // `keys.length` is the hop count once this edge is taken, so this is what is left of
      // the budget after it — and `toTarget` says whether a target is still in reach.
      const remaining = hops - keys.length
      const toGo = graph.toTarget.get(next)
      if (toGo === undefined || toGo > remaining) continue

      keys.push(next)
      weights.push(edge.weight)
      visited.add(next)

      if (targetSet.has(next)) {
        record({
          keys: [...keys],
          weights: [...weights],
          bottleneck: running,
          hops: keys.length - 1,
        })
      }
      walk(next, running)

      visited.delete(next)
      weights.pop()
      keys.pop()
      if (truncated) return
    }
  }

  for (const source of sources) {
    if (!graph.nodes.has(source)) continue
    if (truncated) break
    keys.push(source)
    visited.add(source)
    walk(source, Infinity)
    visited.delete(source)
    keys.pop()
  }

  /*
   * A full shortlist is the *point* of the ranking when `topN` was asked for, and a truncated
   * answer when it was not. Both conditions are needed: a graph with exactly `MAX_PATHS_KEPT`
   * routes fills the list without anything being cut, and calling that truncated is the same
   * kind of lie as staying silent when it was.
   */
  return {
    paths: shortlist.drain(),
    truncated: truncated || (capped && shortlist.size >= capacity),
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const PATH_NODE_SCHEMA: TableSchema = tableSchema(
  column('id', 'str'),
  column('type', 'str'),
  column('neuronId', 'i64'),
  // Where the node sits in the circuit: `source`, `target` or `via`. A categorical colour
  // straight off this is the one encoding every path picture wants.
  column('role', 'str'),
  // Fewest hops from a source *along a kept route*, which is what the layout layers by.
  column('hop', 'i64'),
  column('paths', 'i64'),
)

export const PATH_EDGE_SCHEMA: TableSchema = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64', 'synapses'),
  column('pairs', 'i64'),
  column('paths', 'i64'),
  column('hop', 'i64'),
)

export const PATH_TABLE_SCHEMA: TableSchema = tableSchema(
  column('rank', 'i64'),
  column('source', 'str'),
  column('target', 'str'),
  column('hops', 'i64'),
  column('bottleneck', 'f64', 'synapses'),
  column('path', 'str'),
)

export const PATH_NETWORK_TYPE = T.network(PATH_NODE_SCHEMA, PATH_EDGE_SCHEMA)

/** How a route is written out in the `path` column and in the caption. */
export const PATH_ARROW = ' → '

/**
 * The network the kept routes span — their nodes and their edges, and nothing else.
 *
 * Built from the routes rather than from the pruned graph, so `N strongest` means what it
 * says: a node reachable within the hop budget but not on any of the routes that survived
 * the ranking is not in the picture. `paths` on each node and edge counts how many of the
 * kept routes run through it, which is the closest thing to a betweenness this can offer for
 * free and reads well as a size encoding.
 */
export function pathsToNetwork(
  graph: PathGraph,
  paths: readonly RankedPath[],
  sources: readonly string[],
  targets: readonly string[],
): NetworkValue {
  const sourceSet = new Set(sources)
  const targetSet = new Set(targets)

  const nodeHop = new Map<string, number>()
  const nodePaths = new Map<string, number>()
  const edgeHop = new Map<string, number>()
  const edgePaths = new Map<string, number>()
  // Insertion order is the row order of the attribute table, so it is seeded from the
  // ranking: the strongest route's nodes come first.
  const order: string[] = []

  for (const path of paths) {
    path.keys.forEach((key, i) => {
      if (!nodePaths.has(key)) order.push(key)
      nodePaths.set(key, (nodePaths.get(key) ?? 0) + 1)
      const hop = nodeHop.get(key)
      if (hop === undefined || i < hop) nodeHop.set(key, i)
      if (i === 0) return
      const previous = path.keys[i - 1]
      if (previous === undefined) return
      const pair = edgeKey(previous, key)
      edgePaths.set(pair, (edgePaths.get(pair) ?? 0) + 1)
      const at = edgeHop.get(pair)
      if (at === undefined || i - 1 < at) edgeHop.set(pair, i - 1)
    })
  }

  const nodeData: Record<string, CellValue[]> = {
    id: [],
    type: [],
    neuronId: [],
    role: [],
    hop: [],
    paths: [],
  }
  const push = (data: Record<string, CellValue[]>, name: string, value: CellValue): void => {
    const columnData = data[name]
    if (columnData) columnData.push(value)
  }
  for (const key of order) {
    const node = graph.nodes.get(key)
    push(nodeData, 'id', key)
    push(nodeData, 'type', node?.type ?? null)
    push(nodeData, 'neuronId', node?.neuronId ?? null)
    push(
      nodeData,
      'role',
      sourceSet.has(key) ? 'source' : targetSet.has(key) ? 'target' : 'via',
    )
    push(nodeData, 'hop', nodeHop.get(key) ?? 0)
    push(nodeData, 'paths', nodePaths.get(key) ?? 0)
  }

  const edgeData: Record<string, CellValue[]> = {
    source: [],
    target: [],
    weight: [],
    pairs: [],
    paths: [],
    hop: [],
  }
  for (const [pair, count] of edgePaths) {
    const edge = graph.edges.get(pair)
    if (!edge) continue
    push(edgeData, 'source', edge.source)
    push(edgeData, 'target', edge.target)
    push(edgeData, 'weight', edge.weight)
    push(edgeData, 'pairs', edge.pairs)
    push(edgeData, 'paths', count)
    push(edgeData, 'hop', edgeHop.get(pair) ?? 0)
  }

  return {
    kind: 'network',
    directed: true,
    nodes: makeTable(PATH_NODE_SCHEMA, nodeData),
    edges: makeTable(PATH_EDGE_SCHEMA, edgeData),
  }
}

/** One row per kept route, strongest first. */
export function pathsTable(paths: readonly RankedPath[]): TableValue {
  return tableFromRows(
    PATH_TABLE_SCHEMA,
    paths.map((path, i) => ({
      rank: i + 1,
      source: path.keys[0] ?? '',
      target: path.keys[path.keys.length - 1] ?? '',
      hops: path.hops,
      bottleneck: path.bottleneck,
      path: path.keys.join(PATH_ARROW),
    })),
  )
}

export interface PathStats {
  count: number
  /** Fewest hops among the kept routes; 0 when there are none. */
  minHops: number
  /** The best bottleneck found — the strongest route's weakest link. */
  bottleneck: number
}

export function pathStats(paths: readonly RankedPath[]): PathStats {
  if (paths.length === 0) return { count: 0, minHops: 0, bottleneck: 0 }
  let minHops = Infinity
  let bottleneck = 0
  for (const path of paths) {
    if (path.hops < minHops) minHops = path.hops
    if (path.bottleneck > bottleneck) bottleneck = path.bottleneck
  }
  return { count: paths.length, minHops, bottleneck }
}
