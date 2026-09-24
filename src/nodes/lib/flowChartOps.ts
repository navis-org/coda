/**
 * A network read as a feed-forward diagram: which layer each node sits in, and what each edge
 * does relative to those layers.
 *
 * Headless, and separate from the viewer for the reason `dendrogramLayout.ts` and
 * `networkLayout.ts` are: jsdom performs no layout, so anything left in the component is
 * covered by nothing at all. Separate from *those* because two readers need this and only one
 * of them is a viewer — both notebook exporters emit a layered drawing and have to agree with
 * the canvas about which node is in which column, and a layering rule written twice is a
 * layering rule that drifts.
 *
 * ## A layer is not a hop, and the difference is the whole of the layering control
 *
 * Longest-path layering is a fact about the *graph handed in*: a node sits one column right of
 * the furthest-back thing that reaches it. That is exactly right for a `Paths` network, which
 * is assembled from routes and whose `hop` column is longest-path layering by construction.
 *
 * It is wrong for an `Influence` network, and wrong in a way that looks fine. `hops` there is
 * the *fewest* synapses from the seed, and the induced subgraph of the top-scoring neurons is
 * full of long chains — so a neuron one synapse from the seed lands five columns away because
 * something else reaches it the long way round. Both pictures are internally consistent and
 * only one of them answers the question somebody asked.
 *
 * So the layer source is a **column picker, optional, empty meaning longest path**, and which
 * one ran is said in the caption. Deliberately not "automatic, preferring a column called
 * `hop` or `hops`": that is a substitution nobody asked for, and a network carrying a column of
 * that name meaning something else would be silently layered by it — the failure
 * `resolveColumn`'s rule 3 already has a record of on `zapbench:traces` and `out.scatter`.
 *
 * ## The four edge kinds, and why the classification is not the viewer's business
 *
 * A layering makes every edge one of four things, and a drawing that does not tell them apart
 * is the main thing wrong with drawing a connectome as a flow chart today. `forward` is the
 * ordinary case. `back` is a recurrent connection, and drawn like a forward edge it is an arrow
 * pointing right through the boxes between its ends — which reads as a data error rather than
 * as feedback. `within` joins two nodes in one column and has no length to be drawn along.
 * `self` is an autapse, which has no two ends at all.
 *
 * That is not a styling preference, it is what makes the node usable on anything but a `Paths`
 * result: a two-hop `Connectivity` fan is full of `back` and `within` edges, and so is an
 * `Influence` subgraph. Which is why the kinds are computed here, next to the layering that
 * defines them, rather than inferred from coordinates after a layout has run.
 */

import type { NetworkValue } from '../../core/values'
import { getColumn } from '../../core/values'

/**
 * What an edge does relative to the layering.
 *
 * `within` and `self` are separate because they fail differently: a `within` edge has two real
 * ends the drawing has to join sideways, and a `self` edge has one, so the only honest mark for
 * it is something attached to the box. Folded together, an autapse draws as a zero-length line.
 */
export type FlowEdgeKind = 'forward' | 'back' | 'within' | 'self'

/** Which rule produced the layering, for the caption. Inlined on `FlowGraph`; nothing imports it. */
type FlowLayerSource = 'column' | 'longest-path'

export interface FlowNode {
  id: string
  /** What the box says. Falls back to the id. */
  label: string
  /** Column index, 0-based, counting from the left of a left-to-right drawing. */
  layer: number
  /**
   * Row in the network's node attribute table, or `-1` for a box this module minted.
   *
   * Every encoding — colour, the tooltip, the size channel — resolves against that table by
   * row, so a synthesised box has to be able to say it has no row rather than borrow one.
   * `-1` rather than `undefined` because this is read in a loop per frame.
   */
  row: number
  /**
   * The ids this box stands for, when it stands for more than itself.
   *
   * Empty on an ordinary node. `foldFlowGraph` fills it, and it is what makes clicking a
   * folded box select its members rather than select nothing: the `Selected` port carries
   * neuron ids, and `+7 others` is not one.
   */
  folded: readonly string[]
}

export interface FlowEdge {
  source: string
  target: string
  /** Row in the network's edge attribute table, or `-1` for an edge this module merged. */
  row: number
  /** The additive channel, summed where edges merge. Null where the network has no weight. */
  weight: number | null
  kind: FlowEdgeKind
  /** How many of the network's own edges are behind this one. 1 unless something merged. */
  merged: number
}

export interface FlowGraph {
  nodes: readonly FlowNode[]
  edges: readonly FlowEdge[]
  /** `layer` runs `0 .. layerCount - 1`. Zero only for an empty graph. */
  layerCount: number
  layerSource: FlowLayerSource
  /**
   * Edges naming an endpoint the node table does not have.
   *
   * Counted rather than thrown: a dangling endpoint makes ELK reject the whole graph, and one
   * bad row is no reason for a picture to refuse — `layoutNetwork` and `readTopology` already
   * drop them. Counted rather than dropped in silence because a filter upstream that removed
   * nodes and left their edges is a real mistake somebody should hear about.
   */
  dangling: number
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Above this many boxes a flow chart has stopped being one.
 *
 * `_WARN` rather than something more descriptive so `grep _WARN` finds the whole tier — see
 * docs/limits.md, which invites exactly that sweep. A warning and never a refusal: the picture
 * still draws, and a reader who wanted the Network Viewer's force layout can see at a glance
 * that this is the wrong node for what they wired in. A refusal would claim there is no useful
 * answer, which for "show me this graph" is never true.
 */
export const FLOW_NODES_WARN = 120

/**
 * Above this many boxes the labels are what makes the picture unreadable, so they come off.
 *
 * The decision behind it: a weight printed on every arrow is what makes this a circuit diagram
 * rather than a blob, and it is also the first thing to become illegible. Off by default would
 * mean the first thing somebody sees is a picture missing the quantity that motivated it; on at
 * every size means a sixty-region ROI graph arrives as overlapping digits. So the default is
 * `auto`, which is on below this and off above, **and the caption says which happened** — a
 * control that silently stops doing anything is worse than one that is visibly overridden, which
 * is the note `out.network`'s Layout socket carries for the same reason.
 *
 * Lower than `FLOW_NODES_WARN` on purpose. A graph is still worth drawing at eighty boxes and
 * its arrow labels are not.
 */
export const EDGE_LABEL_AUTO_MAX = 40

// ---------------------------------------------------------------------------
// Layering
// ---------------------------------------------------------------------------

/** Adjacency as index pairs, plus the rows they came from. */
interface Wiring {
  /** `[sourceIndex, targetIndex, row]` per edge whose both ends are known. */
  pairs: Int32Array
  count: number
  dangling: number
}

function readWiring(network: NetworkValue, index: Map<string, number>): Wiring {
  const sources = getColumn(network.edges, 'source')
  const targets = getColumn(network.edges, 'target')
  const pairs = new Int32Array(network.edges.length * 3)
  let count = 0
  let dangling = 0
  for (let row = 0; row < network.edges.length; row++) {
    const from = index.get(String(sources[row] ?? ''))
    const to = index.get(String(targets[row] ?? ''))
    if (from === undefined || to === undefined) {
      dangling++
      continue
    }
    pairs[count * 3] = from
    pairs[count * 3 + 1] = to
    pairs[count * 3 + 2] = row
    count++
  }
  return { pairs, count, dangling }
}

/**
 * Longest-path layers over the edges that are not back edges.
 *
 * Two passes, and the first one is the part that is easy to leave out. A connectome subgraph
 * routinely holds cycles — reciprocal connections above all, which are a *pair* of edges rather
 * than an exotic case — and longest-path layering over a graph with a cycle either never
 * terminates or terminates at a number that depends on which node the walk happened to start
 * at. So an iterative depth-first walk marks the edges that close a cycle, and the layering runs
 * over what is left.
 *
 * Iterative rather than recursive because the depth is the graph's, not the code's: a 120-box
 * chart is fine either way and a mis-wired `net.build` over a whole connectivity table is not.
 *
 * **Which edge of a cycle gets marked depends on the walk order, and that is accepted.** There
 * is no canonical answer — reciprocal neurons are genuinely both upstream and downstream of
 * each other — and the walk starts from the nodes with no incoming edges first, so on the graphs
 * this node is for (a set of sources, a set of targets, routes between them) the marked edge is
 * the one a reader would also call the feedback one. Deterministic given the node order, which
 * is what invariant 4 needs of anything that reaches a drawing.
 */
function longestPathLayers(count: number, wiring: Wiring): Int32Array {
  const out: number[][] = Array.from({ length: count }, () => [])
  const indegree = new Int32Array(count)
  for (let e = 0; e < wiring.count; e++) {
    const from = wiring.pairs[e * 3]!
    const to = wiring.pairs[e * 3 + 1]!
    if (from === to) continue
    out[from]!.push(to)
    indegree[to]!++
  }

  // Which (from, to) pairs close a cycle. Keyed `from * count + to`, so a reciprocal pair is
  // two distinct keys and only the one reached second is marked.
  const back = new Set<number>()
  const state = new Int8Array(count) // 0 unseen, 1 on the stack, 2 done

  /*
   * Roots first, then everything else. Starting from the nodes nothing feeds is what makes the
   * marked edge of a reciprocal pair the one pointing *back* towards the sources rather than an
   * arbitrary half — see the note above. The second loop catches nodes only reachable from
   * inside a cycle, which have no root to be found from.
   */
  const order: number[] = []
  for (let i = 0; i < count; i++) if (indegree[i] === 0) order.push(i)
  for (let i = 0; i < count; i++) if (indegree[i] !== 0) order.push(i)

  for (const root of order) {
    if (state[root] !== 0) continue
    // `at` is how far into the node's out-list the walk has got, so the stack is a real DFS
    // rather than a queue that revisits.
    const stack: Array<{ node: number; at: number }> = [{ node: root, at: 0 }]
    state[root] = 1
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const neighbours = out[frame.node]!
      if (frame.at >= neighbours.length) {
        state[frame.node] = 2
        stack.pop()
        continue
      }
      const next = neighbours[frame.at++]!
      if (state[next] === 1) {
        back.add(frame.node * count + next)
        continue
      }
      if (state[next] === 2) continue
      state[next] = 1
      stack.push({ node: next, at: 0 })
    }
  }

  // Longest path over the acyclic remainder, by Kahn order so each node is finalised after
  // every predecessor that can reach it.
  const layers = new Int32Array(count)
  const forwardOut: number[][] = Array.from({ length: count }, () => [])
  const pending = new Int32Array(count)
  for (let e = 0; e < wiring.count; e++) {
    const from = wiring.pairs[e * 3]!
    const to = wiring.pairs[e * 3 + 1]!
    if (from === to || back.has(from * count + to)) continue
    forwardOut[from]!.push(to)
    pending[to]!++
  }
  const queue: number[] = []
  for (let i = 0; i < count; i++) if (pending[i] === 0) queue.push(i)
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!
    for (const next of forwardOut[node]!) {
      if (layers[next]! < layers[node]! + 1) layers[next] = layers[node]! + 1
      if (--pending[next]! === 0) queue.push(next)
    }
  }
  return layers
}

/**
 * Layers read off a column, densely renumbered.
 *
 * Renumbered because the numbers in the column are a measurement and the layers are positions:
 * an `Influence` result whose top scorers are 1, 2 and 5 hops from the seed should draw as three
 * adjacent columns, not as three columns with a gap of two empty ones where nothing scored. The
 * *order* is what the column says and the only thing taken from it.
 *
 * A row with no number lands in its own layer after every numbered one, rather than in layer 0.
 * Null is not zero — the trap `ui/encoding.ts`'s `numeric()` exists for — and a neuron the
 * traversal never reached being drawn in the seed's column is the specific lie that matters here.
 */
export function columnLayers(values: readonly unknown[], count: number): Int32Array {
  // A Set beside the array, not `seen.includes`: the picker is an unrestricted `column`, so a
  // high-cardinality one makes the membership test O(n x distinct) — 36,000 nodes of distinct
  // values is hundreds of millions of string compares, synchronously, before the draw cap is
  // even consulted. The array is still what carries first-seen order.
  const seen: string[] = []
  const known = new Set<string>()
  const keys: Array<string | null> = []
  for (let i = 0; i < count; i++) {
    const raw = values[i]
    if (raw === null || raw === undefined || raw === '') {
      keys.push(null)
      continue
    }
    const key = String(raw)
    if (!known.has(key)) {
      known.add(key)
      seen.push(key)
    }
    keys.push(key)
  }

  /*
   * Numerically where every distinct value is a number, lexically otherwise — the half that is
   * easy to leave out, and the reason `networkLayout.layersFromValues` delegates here rather
   * than keeping the second copy it used to be. The picker is an unrestricted `column`, so the
   * useful axis is often something the data already says in words: a `class` running sensory →
   * interneuron → motor, or an ROI ordering. Ranked by `Number()` alone every one of those
   * coerces to `NaN` and the whole network collapses into a single column, which reads as a
   * layering that did not run rather than as a column this cannot use.
   */
  const numeric = seen.every((key) => Number.isFinite(Number(key)))
  const ordered = [...seen].sort((a, b) =>
    numeric ? Number(a) - Number(b) : a.localeCompare(b),
  )
  const ranks = new Map(ordered.map((key, rank) => [key, rank]))

  // Everything unmeasured shares one layer, the last. One rather than one each, because the
  // question a reader has about them is "which ones" and not "in what order".
  const layers = new Int32Array(count)
  for (let i = 0; i < count; i++) {
    const key = keys[i]!
    layers[i] = key === null ? ordered.length : (ranks.get(key) ?? ordered.length)
  }
  return layers
}

// ---------------------------------------------------------------------------
// Reading a network as a flow graph
// ---------------------------------------------------------------------------

export interface FlowGraphOptions {
  /** Column naming each box. Empty or missing falls back to the node id. */
  labelColumn?: string | undefined
  /** Column the layer is read from. Empty or missing means longest path. */
  layerColumn?: string | undefined
  /** Column carrying the additive channel. Defaults to `weight` where the network has one. */
  weightColumn?: string | undefined
}

/**
 * Read a `NetworkValue` as a layered diagram.
 *
 * Pure, and the only thing it needs from the drawing is nothing at all — which is what lets
 * both notebook exporters call it and emit the same layering the canvas drew.
 */
export function flowGraph(network: NetworkValue, options: FlowGraphOptions = {}): FlowGraph {
  const ids = getColumn(network.nodes, 'id').map((cell) => String(cell ?? ''))
  const count = ids.length
  if (count === 0) {
    return { nodes: [], edges: [], layerCount: 0, layerSource: 'longest-path', dangling: 0 }
  }

  // First occurrence wins a repeated id, which is also which row the attribute table's
  // encodings will read. A network with duplicate ids is malformed; drawing one box for them
  // beats drawing two in the same place.
  const index = new Map<string, number>()
  ids.forEach((id, i) => {
    if (!index.has(id)) index.set(id, i)
  })

  const wiring = readWiring(network, index)

  const layerName = options.layerColumn
  const layerValues = layerName ? network.nodes.data[layerName] : undefined
  const layers = layerValues
    ? columnLayers(layerValues, count)
    : longestPathLayers(count, wiring)
  const layerSource: FlowLayerSource = layerValues ? 'column' : 'longest-path'

  const labelName = options.labelColumn
  const labelValues = labelName ? network.nodes.data[labelName] : undefined

  const nodes: FlowNode[] = ids.map((id, row) => {
    const raw = labelValues?.[row]
    const label = raw === null || raw === undefined || raw === '' ? id : String(raw)
    return { id, label, layer: layers[row]!, row, folded: [] }
  })

  const weightName =
    options.weightColumn ?? (network.edges.data['weight'] ? 'weight' : undefined)
  const weights = weightName ? network.edges.data[weightName] : undefined

  const edges: FlowEdge[] = []
  for (let e = 0; e < wiring.count; e++) {
    const from = wiring.pairs[e * 3]!
    const to = wiring.pairs[e * 3 + 1]!
    const row = wiring.pairs[e * 3 + 2]!
    const raw = weights?.[row]
    const weight = raw === null || raw === undefined || raw === '' ? null : Number(raw)
    edges.push({
      source: ids[from]!,
      target: ids[to]!,
      row,
      weight: weight !== null && Number.isFinite(weight) ? weight : null,
      kind: edgeKind(layers[from]!, layers[to]!, from === to),
      merged: 1,
    })
  }

  // A loop rather than `Math.max(...)`: the node count is warned about at `FLOW_NODES_WARN`
  // and never refused, so a spread here is a stack overflow on a graph somebody merely mis-wired.
  let deepest = 0
  for (const node of nodes) if (node.layer > deepest) deepest = node.layer

  return {
    nodes,
    edges,
    layerCount: deepest + 1,
    layerSource,
    dangling: wiring.dangling,
  }
}

/** The classification, in one place, so the four names cannot be spelled two ways. */
function edgeKind(sourceLayer: number, targetLayer: number, selfLoop: boolean): FlowEdgeKind {
  if (selfLoop) return 'self'
  if (targetLayer > sourceLayer) return 'forward'
  if (targetLayer < sourceLayer) return 'back'
  return 'within'
}

// ---------------------------------------------------------------------------
// Folding a layer's tail
// ---------------------------------------------------------------------------

/** Id of the box standing for a layer's folded tail. Never a neuron id — see `folded`. */
export function foldedBoxId(layer: number): string {
  return ` others:${layer}`
}

/**
 * Keep the `perLayer` busiest boxes in each layer and fold the rest into one.
 *
 * **Ranked by total incident weight**, largest first, ties by arrival order — which for a
 * `Paths` network is the ranking that built the node table (strongest route first) and for
 * everything else is the row order. Not by degree: a box wired to twenty things by one synapse
 * each is exactly what somebody folding a layer wants folded away.
 *
 * Merged edges carry a **summed weight and nothing else**, which is `net.build`'s rule for
 * parallel links and its stated reason: `weight` is the one additive channel, and a folded
 * edge standing for eleven connections across four regions has no single region. `merged`
 * says how many are behind it.
 *
 * Presentational, so this runs in the viewer and never in `evaluate`. The `Network` port hands
 * on what arrived — which is why a fold can be adjusted without staling anything downstream,
 * and why the folded network is deliberately not available to the next node.
 */
export function foldFlowGraph(graph: FlowGraph, perLayer: number): FlowGraph {
  if (perLayer <= 0) return graph

  const throughput = new Map<string, number>()
  for (const node of graph.nodes) throughput.set(node.id, 0)
  for (const edge of graph.edges) {
    const weight = edge.weight ?? 0
    throughput.set(edge.source, (throughput.get(edge.source) ?? 0) + weight)
    throughput.set(edge.target, (throughput.get(edge.target) ?? 0) + weight)
  }

  const byLayer = new Map<number, FlowNode[]>()
  for (const node of graph.nodes) {
    const bucket = byLayer.get(node.layer)
    if (bucket) bucket.push(node)
    else byLayer.set(node.layer, [node])
  }

  /** Where each surviving id goes; a folded id maps to its layer's box. */
  const rename = new Map<string, string>()
  const kept: FlowNode[] = []

  for (const [layer, members] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    if (members.length <= perLayer) {
      for (const node of members) kept.push(node)
      continue
    }
    // `row` breaks ties rather than `id`, so the ranking that built the table survives.
    const ranked = [...members].sort(
      (a, b) => (throughput.get(b.id) ?? 0) - (throughput.get(a.id) ?? 0) || a.row - b.row,
    )
    const survivors = new Set(ranked.slice(0, perLayer))
    const folded = ranked.slice(perLayer)
    // Back in table order, so the picture's within-layer order is the network's and not the
    // ranking's — the ranking decides *which* boxes stay, never where they sit.
    for (const node of members) if (survivors.has(node)) kept.push(node)
    const boxId = foldedBoxId(layer)
    for (const node of folded) rename.set(node.id, boxId)
    kept.push({
      id: boxId,
      label: `+${folded.length} others`,
      layer,
      row: -1,
      folded: folded.map((node) => node.id),
    })
  }

  if (rename.size === 0) return graph

  const merged = new Map<string, FlowEdge>()
  for (const edge of graph.edges) {
    const source = rename.get(edge.source) ?? edge.source
    const target = rename.get(edge.target) ?? edge.target
    const untouched = source === edge.source && target === edge.target
    const key = `${source} ${target}`
    const held = merged.get(key)
    if (held) {
      held.weight =
        held.weight === null && edge.weight === null
          ? null
          : (held.weight ?? 0) + (edge.weight ?? 0)
      held.merged += edge.merged
      // A merged edge is nobody's row: two rows cannot both be it, and borrowing the first
      // would point every encoding and tooltip at one arbitrary member.
      held.row = -1
      continue
    }
    merged.set(key, {
      source,
      target,
      row: untouched ? edge.row : -1,
      weight: edge.weight,
      /*
       * A fold cannot move an edge between layers: a box is renamed to `foldedBoxId(its own
       * layer)`, and a survivor keeps the layer it had. So the only reclassification possible is
       * two endpoints collapsing into *one* box, which makes the edge a self loop.
       */
      kind: source === target ? 'self' : edge.kind,
      merged: edge.merged,
    })
  }

  return {
    nodes: kept,
    edges: [...merged.values()],
    layerCount: graph.layerCount,
    layerSource: graph.layerSource,
    dangling: graph.dangling,
  }
}

/**
 * Whether arrow labels are drawn, resolving the `auto` setting against the size of the picture.
 *
 * One function because three surfaces ask: the drawing, the caption that admits it, and the
 * exporters, which have to write the same choice into the notebook or the figure disagrees with
 * the card it was exported from.
 */
export function showsEdgeLabels(mode: 'auto' | 'on' | 'off', nodeCount: number): boolean {
  if (mode === 'on') return true
  if (mode === 'off') return false
  return nodeCount <= EDGE_LABEL_AUTO_MAX
}
