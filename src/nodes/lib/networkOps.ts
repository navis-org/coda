/**
 * Filtering a network down to what is worth drawing, and cutting a subgraph out of one.
 *
 * Headless, like the rest of `src/nodes/lib`, and deliberately a *data* operation rather
 * than a view one: the network viewer's filter params change what its `out` port carries, so
 * a downstream node sees the same graph the picture shows. The alternative — filtering only
 * in the viewer — makes the drawing disagree with everything wired after it.
 *
 * Three knobs, applied in a fixed order that matters:
 *
 *   1. drop links below a weight,
 *   2. keep the top N nodes, ranked over the links that survived step 1,
 *   3. drop nodes left with nothing attached.
 *
 * Ranking after the weight cut rather than before is the whole point of the order: "the ten
 * biggest players in the graph I am looking at" is the useful question, and ranking on links
 * that were about to be discarded answers a different one.
 *
 * ## The second half: a subgraph around a selection
 *
 * `expandSelection` + `induceSubnetwork` are `net.filter`'s, and a different question from the
 * three knobs above — not "what is worth drawing" but "what is *near* this". Here rather than
 * in the node because they share the part that is easy to get wrong: a subgraph that keeps a
 * node's `degreeOut` from the whole graph is a size encoding and a tooltip asserting links that
 * are not in the picture, which is what `recomputeRollups` exists to stop. One implementation
 * of that, reached by both.
 */

import type { TableSchema } from '../../core/types'
import type { ColumnData, NetworkValue, TableValue } from '../../core/values'
import { getColumn, makeTable, selectRows } from '../../core/values'

export interface NetworkFilter {
  /** Drop links weighing less than this. 0 keeps everything. */
  minWeight: number
  /** Keep only this many nodes, by total attached weight. 0 keeps everything. */
  topNodes: number
  /** Drop nodes with no links left. */
  hideIsolated: boolean
}

export interface FilteredNetwork {
  network: NetworkValue
  /** What the filter removed, for the viewer to admit in its caption. */
  dropped: { nodes: number; links: number }
}

export const NO_FILTER: NetworkFilter = { minWeight: 0, topNodes: 0, hideIsolated: false }

/**
 * Roll-ups `BuildNetwork` derives from the link set.
 *
 * They are recomputed after filtering, because they describe the graph rather than the
 * neurons: a node still claiming `degreeOut: 7` in a network where four of those links have
 * been cut is not merely stale, it is driving a size encoding and a tooltip that say
 * something untrue about the picture beside them.
 *
 * **These four names, and therefore only `BuildNetwork`'s graphs.** Two other producers derive a
 * column the same way and are not covered: `mapperNetwork`'s `nNeurons` is a label node's neuron
 * degree, and `pathsToNetwork`'s `paths`/`hop` are counted over the whole kept route set. Narrow
 * either graph and those keep describing the graph it came from.
 *
 * Adding them to this list would not fix it, which is why the limit is documented rather than
 * papered over: `nNeurons` is *derived* on a label node and *intrinsic* on a neuron group, so
 * whether a column needs recomputing is a fact about its producer rather than about its name.
 * Fixing it properly means `NetworkValue` carrying which of its columns are graph-derived, and
 * it has no field for that today.
 */
const ROLLUPS = ['degreeIn', 'degreeOut', 'weightIn', 'weightOut'] as const

function hasColumn(schema: TableSchema, name: string): boolean {
  return schema.columns.some((c) => c.name === name)
}

/**
 * A network's node ids as text, and its link ends.
 *
 * `String(cell ?? '')` rather than `idText`: these are *node* ids, which on a connectivity graph
 * are neuron ids but on `Match Cell Types`' label graph are `label/LC4` — the id column of a
 * `NetworkValue` is a join key, not the identity, which is the same reading `net.build` takes of
 * whatever it is handed. Written once because both walks below need all three and got them by
 * repeating the expression.
 */
function nodeIds(network: NetworkValue): string[] {
  return getColumn(network.nodes, 'id').map((cell) => String(cell ?? ''))
}

function linkEnds(network: NetworkValue): { sources: string[]; targets: string[] } {
  return {
    sources: getColumn(network.edges, 'source').map((cell) => String(cell ?? '')),
    targets: getColumn(network.edges, 'target').map((cell) => String(cell ?? '')),
  }
}

/**
 * The tables of a subgraph, given which rows of each survive.
 *
 * Both narrowings end here, and it is the roll-ups that make it worth one function rather than
 * two similar tails: they describe the *graph*, so on a smaller one they are a different number,
 * and a node still claiming its old `degreeOut` drives a size encoding that says something untrue
 * about the picture beside it. Neither caller should be able to forget that independently.
 */
function subnetworkOf(
  network: NetworkValue,
  ids: readonly string[],
  ends: { sources: readonly string[]; targets: readonly string[] },
  weight: readonly number[],
  nodeRows: number[],
  edgeRows: number[],
): NetworkValue {
  return {
    ...network,
    nodes: recomputeRollups(
      selectRows(network.nodes, nodeRows),
      nodeRows.map((row) => ids[row]!),
      edgeRows.map((i) => ({
        source: ends.sources[i]!,
        target: ends.targets[i]!,
        weight: weight[i]!,
      })),
    ),
    edges: selectRows(network.edges, edgeRows),
  }
}

/** Weight column read defensively — a network need not come from `BuildNetwork`. */
function weights(edges: TableValue): number[] {
  const missing = !hasColumn(edges.schema, 'weight')
  const data = missing ? [] : getColumn(edges, 'weight')
  return Array.from({ length: edges.length }, (_, i) => {
    // A network with no weights ranks by plain degree, which is what weighting every link
    // as 1 amounts to. One rule, degrading to the obvious thing.
    const value = Number(data[i] ?? 1)
    return Number.isFinite(value) ? value : 1
  })
}

export function isFiltering(filter: NetworkFilter): boolean {
  return filter.minWeight > 0 || filter.topNodes > 0 || filter.hideIsolated
}

export function filterNetwork(network: NetworkValue, filter: NetworkFilter): FilteredNetwork {
  const none = { network, dropped: { nodes: 0, links: 0 } }
  if (!isFiltering(filter)) return none

  const ids = nodeIds(network)
  const { sources, targets } = linkEnds(network)
  const weight = weights(network.edges)

  // --- 1. weight cut -------------------------------------------------------
  let links: number[] = []
  for (let i = 0; i < network.edges.length; i++) {
    if (weight[i]! >= filter.minWeight) links.push(i)
  }

  // --- 2. top nodes, ranked over what survived -----------------------------
  const known = new Set(ids)
  let keptNodes = new Set(ids)
  if (filter.topNodes > 0 && filter.topNodes < ids.length) {
    const score = new Map<string, number>()
    for (const i of links) {
      const from = sources[i]!
      const to = targets[i]!
      if (known.has(from)) score.set(from, (score.get(from) ?? 0) + weight[i]!)
      if (known.has(to)) score.set(to, (score.get(to) ?? 0) + weight[i]!)
    }
    // Ties break on id so the result is deterministic — the provenance key depends on it.
    const ranked = [...ids].sort(
      (a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || a.localeCompare(b),
    )
    keptNodes = new Set(ranked.slice(0, filter.topNodes))
    links = links.filter((i) => keptNodes.has(sources[i]!) && keptNodes.has(targets[i]!))
  }

  // --- 3. isolated nodes ---------------------------------------------------
  if (filter.hideIsolated) {
    const attached = new Set<string>()
    for (const i of links) {
      attached.add(sources[i]!)
      attached.add(targets[i]!)
    }
    keptNodes = new Set([...keptNodes].filter((id) => attached.has(id)))
  }

  const nodeRows: number[] = []
  ids.forEach((id, row) => {
    if (keptNodes.has(id)) nodeRows.push(row)
  })

  if (nodeRows.length === ids.length && links.length === network.edges.length) return none

  return {
    network: subnetworkOf(network, ids, { sources, targets }, weight, nodeRows, links),
    dropped: {
      nodes: ids.length - nodeRows.length,
      links: network.edges.length - links.length,
    },
  }
}

/** Rewrite the derived degree columns over the surviving links, where the schema has them. */
function recomputeRollups(
  nodes: TableValue,
  order: string[],
  links: Array<{ source: string; target: string; weight: number }>,
): TableValue {
  const present = ROLLUPS.filter((name) => hasColumn(nodes.schema, name))
  if (present.length === 0) return nodes

  const acc = new Map(
    order.map((id) => [id, { degreeIn: 0, degreeOut: 0, weightIn: 0, weightOut: 0 }]),
  )
  for (const link of links) {
    const from = acc.get(link.source)
    const to = acc.get(link.target)
    if (from) {
      from.degreeOut += 1
      from.weightOut += link.weight
    }
    if (to) {
      to.degreeIn += 1
      to.weightIn += link.weight
    }
  }

  const data: Record<string, ColumnData> = { ...nodes.data }
  for (const name of present) {
    data[name] = order.map((id) => acc.get(id)?.[name] ?? 0)
  }
  return makeTable(nodes.schema, data, nodes.kind)
}

// ---------------------------------------------------------------------------
// A subgraph around a selection

/** How far past the seeds a selection reaches. */
export type NetworkExpansion = 'none' | 'hops' | 'component'

export const EXPANSION_OPTIONS: Array<{ value: NetworkExpansion; label: string }> = [
  { value: 'none', label: 'Just the selection' },
  { value: 'hops', label: 'Within N hops' },
  { value: 'component', label: 'The whole connected component' },
]

/** Which way an edge may be walked while expanding. */
export type WalkDirection = 'any' | 'downstream' | 'upstream'

export const WALK_OPTIONS: Array<{ value: WalkDirection; label: string }> = [
  { value: 'any', label: 'Either way along a link' },
  { value: 'downstream', label: 'Following links forwards' },
  { value: 'upstream', label: 'Following links backwards' },
]

export interface NetworkSelection {
  /** The node ids to start from. */
  seeds: ReadonlySet<string>
  expand: NetworkExpansion
  /** Hops, when expanding by them. */
  hops: number
  /**
   * Which way to walk.
   *
   * Ignored in two cases, and both are decided here rather than by the caller. For `component`,
   * because a connected component that respected arrows would be a *reachable set*, and calling
   * one the other is the kind of wrong answer that looks right. And on an **undirected** network,
   * where `source` and `target` are an arbitrary order — `Match Cell Types` emits one, and
   * `adjacency` there records every edge both ways, so honouring `downstream` on it would walk
   * half of each pair by construction order.
   *
   * The undirected rule cannot live on the node: `visibleIf` is handed `ParamValues` and cannot
   * see what is wired. It has to be here, which is also where both emitters land for free —
   * `nx.ego_graph` on an `nx.Graph` and `igraph::ego`'s `mode` on an undirected graph both
   * ignore direction already, so a canvas that did not would disagree with its own notebook.
   */
  direction: WalkDirection
}

/**
 * The seeds, grown outwards.
 *
 * Breadth-first over an adjacency built once, rather than repeated scans of the edge table:
 * `hops` scans would be `hops × edges`, and `component` has no bound to scan to. Both modes are
 * one walk over the same structure, which is also what keeps them agreeing about what a
 * neighbour is.
 *
 * A seed naming a node the network does not have is dropped rather than raised — the selection
 * usually comes from a filter or a wired table, and an id that has been filtered out upstream
 * is an ordinary state, not a broken graph.
 */
export function expandSelection(
  network: NetworkValue,
  selection: NetworkSelection,
): Set<string> {
  const known = new Set(nodeIds(network))
  const kept = new Set<string>()
  for (const seed of selection.seeds) if (known.has(seed)) kept.add(seed)

  const hops =
    selection.expand === 'component'
      ? Number.POSITIVE_INFINITY
      : selection.expand === 'hops'
        ? Math.max(0, Math.floor(selection.hops))
        : 0
  if (kept.size === 0 || hops === 0) return kept

  // Both the `component` rule and the undirected one — see `NetworkSelection.direction`.
  const both =
    selection.direction === 'any' || selection.expand === 'component' || !network.directed
  const forwards = both || selection.direction === 'downstream'
  const backwards = both || selection.direction === 'upstream'

  const near = new Map<string, string[]>()
  const link = (from: string, to: string) => {
    const held = near.get(from)
    if (held) held.push(to)
    else near.set(from, [to])
  }
  const { sources, targets } = linkEnds(network)
  for (let i = 0; i < network.edges.length; i++) {
    const from = sources[i]!
    const to = targets[i]!
    if (!known.has(from) || !known.has(to)) continue
    if (forwards) link(from, to)
    if (backwards) link(to, from)
  }

  let front = [...kept]
  for (let hop = 0; hop < hops && front.length; hop++) {
    const next: string[] = []
    for (const id of front) {
      for (const other of near.get(id) ?? []) {
        if (kept.has(other)) continue
        kept.add(other)
        next.push(other)
      }
    }
    front = next
  }
  return kept
}

/**
 * The subgraph on a set of node ids: those nodes, and every link with **both** ends in it.
 *
 * Both ends rather than either, which is what makes it a subgraph rather than a fringe — a link
 * to a node that is not drawn is an arrow into nothing. The roll-ups are recomputed for the
 * reason `recomputeRollups` records: they describe the graph, and this is a different graph.
 */
export function induceSubnetwork(
  network: NetworkValue,
  keep: ReadonlySet<string>,
): NetworkValue {
  const ids = nodeIds(network)
  const nodeRows: number[] = []
  ids.forEach((id, row) => {
    if (keep.has(id)) nodeRows.push(row)
  })

  const ends = linkEnds(network)
  const edgeRows: number[] = []
  for (let i = 0; i < network.edges.length; i++) {
    if (keep.has(ends.sources[i]!) && keep.has(ends.targets[i]!)) edgeRows.push(i)
  }

  /*
   * Nothing dropped, nothing to rebuild — `filterNetwork`'s guard, and it matters more here.
   * `net.filter` is `cheap`, so this runs per keystroke in the value box, and `expand` defaults
   * to `component`: a connectivity graph is normally one giant component, so the *default* state
   * of the node keeps every node and would otherwise rebuild an identical network. Measured on a
   * 50,000-node, 1,000,000-edge graph: 278 ms rebuilt against 1.3 ms for the test.
   *
   * Same accepted caveat as its sibling: returning the input unchanged skips `recomputeRollups`,
   * so roll-ups that arrived stale stay stale. Since nothing was dropped, recomputing would
   * reproduce whatever was correct on arrival.
   */
  if (nodeRows.length === ids.length && edgeRows.length === network.edges.length) return network

  return subnetworkOf(network, ids, ends, weights(network.edges), nodeRows, edgeRows)
}

// ---------------------------------------------------------------------------
// Components

/**
 * Which component each node belongs to, one number per node row, 1-based.
 *
 * **Undirected, like `expandSelection`'s `component`**, and for the same reason recorded on
 * `NetworkSelection.direction`: a component that respected arrows would be a *reachable set*,
 * and calling one the other is the kind of wrong answer that looks right. The two have to
 * agree — a viewer colouring by component beside a menu selecting one is two statements about
 * the same partition — so `networkOps.test.ts` asserts they do rather than trusting that two
 * walks written for one rule stay one rule.
 *
 * **Numbered by size, largest first**, ties broken by the first node's row. Two reasons, and
 * both are about the answer being the same twice: it reaches a categorical encoding, which
 * ranks its slots by frequency, so numbering by size makes the legend read in palette order —
 * and a connectome is usually one giant component with stragglers, where "1" meaning the giant
 * one is the reading everybody already has.
 *
 * Self-loops and links naming a node the network does not have are skipped rather than raised;
 * both are ordinary in a graph that has been filtered.
 */
/**
 * Connected components over an index-level edge list, numbered largest-first.
 *
 * The shared core, because there are two callers with different inputs and **one ordering
 * contract**: largest component first, ties broken by the earliest node in each. That contract
 * is what makes "colour by component" and the prefuse layout's per-component packing agree
 * about what a component is — and when it was written out twice, they disagreed, placing a
 * node in one group's colour inside another group's box. Nothing on screen says so, which is
 * why it is written once.
 *
 * Undirected: a component ignores arrows. Self-loops and edges naming an index the node set
 * does not have are skipped rather than treated as a join.
 */
export function componentsOfEdges(
  count: number,
  edges: Iterable<readonly [number, number]>,
): number[] {
  const near: number[][] = Array.from({ length: count }, () => [])
  for (const [from, to] of edges) {
    if (from === to) continue
    if (from < 0 || to < 0 || from >= count || to >= count) continue
    near[from]!.push(to)
    near[to]!.push(from)
  }

  // Breadth-first from every unvisited node. Iterative rather than recursive: a connectome
  // component is routinely tens of thousands of nodes deep, which is a stack overflow.
  const raw = new Array<number>(count).fill(-1)
  const size: number[] = []
  for (let start = 0; start < count; start++) {
    if (raw[start] !== -1) continue
    const id = size.length
    raw[start] = id
    let found = 0
    const queue = [start]
    for (let head = 0; head < queue.length; head++) {
      found++
      for (const other of near[queue[head]!]!) {
        if (raw[other] !== -1) continue
        raw[other] = id
        queue.push(other)
      }
    }
    size.push(found)
  }

  // Seeds are visited in increasing index order, so a component's id *is* its earliest node's
  // rank — which makes the id itself the tie-break, and the separate `first` table that used
  // to be built here redundant.
  const ranked = [...size.keys()].sort((a, b) => size[b]! - size[a]! || a - b)
  const rank = new Array<number>(size.length)
  ranked.forEach((component, place) => {
    rank[component] = place + 1
  })
  return raw.map((component) => rank[component]!)
}

export function connectedComponents(network: NetworkValue): number[] {
  const ids = nodeIds(network)
  const rowOf = new Map<string, number>()
  ids.forEach((id, row) => {
    if (!rowOf.has(id)) rowOf.set(id, row)
  })

  const { sources, targets } = linkEnds(network)
  const edges: Array<readonly [number, number]> = []
  for (let i = 0; i < network.edges.length; i++) {
    const from = rowOf.get(sources[i]!)
    const to = rowOf.get(targets[i]!)
    if (from === undefined || to === undefined) continue
    edges.push([from, to])
  }
  return componentsOfEdges(ids.length, edges)
}
