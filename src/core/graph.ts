/**
 * Graph data model + structural operations.
 *
 * This is the serialised form: a `.coda.json` file *is* a `CodaGraph`. Keep it boring
 * and additive — old files must keep loading. Positions live here because the graph
 * file is the document; the UI owns nothing that a reload should lose.
 */

import type { ParamValues } from './node'
import { getNodeDef } from './registry'

export const GRAPH_FORMAT_VERSION = 1

export interface GraphNode {
  id: string
  /** Registered node type, e.g. "core.filter". */
  type: string
  position: { x: number; y: number }
  params: ParamValues
  /** User-renamed header; falls back to the definition's label. */
  title?: string
  /** Collapsed nodes hide their body and show sockets only. */
  collapsed?: boolean
  /**
   * Folds the param rows away on a viewer card, leaving the drawing beneath them the space
   * they took. Distinct from `collapsed`, which hides the drawing as well — the point here is
   * a widget that has been set up and now wants to be looked at.
   */
  paramsCollapsed?: boolean
  /** Muted nodes pass through / produce nothing, without being deleted. */
  disabled?: boolean
  /**
   * User-set card size, in flow units. Absent means "whatever the node definition asks for",
   * which is the case for every node until someone drags a corner — so this stays out of the
   * saved file unless it carries a decision.
   */
  size?: { width: number; height: number }
}

export interface GraphEdge {
  id: string
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
}

export interface CodaGraph {
  version: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Restored on load so a saved graph reopens where you left it. */
  viewport?: { x: number; y: number; zoom: number }
  meta?: {
    name?: string
    description?: string
    /** ISO 8601. */
    createdAt?: string
    modifiedAt?: string
  }
}

export function emptyGraph(name = 'Untitled'): CodaGraph {
  return { version: GRAPH_FORMAT_VERSION, nodes: [], edges: [], meta: { name } }
}

/** Edges arriving at a node. */
export function incomingEdges(graph: CodaGraph, nodeId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.target === nodeId)
}

export function outgoingEdges(graph: CodaGraph, nodeId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.source === nodeId)
}

/** The single edge feeding an input port, if any. Input ports are single-connection. */
export function edgeInto(
  graph: CodaGraph,
  nodeId: string,
  portId: string,
): GraphEdge | undefined {
  return graph.edges.find((e) => e.target === nodeId && e.targetHandle === portId)
}

/**
 * Nodes keyed by id.
 *
 * Every pass over a graph — inference, key computation, state refresh, execution — walks the
 * topological order and needs the node behind each id. Done with `find` that is a linear scan
 * per step, i.e. O(N²) per pass and several passes per keystroke.
 */
export function nodesById(graph: CodaGraph): Map<string, GraphNode> {
  const index = new Map<string, GraphNode>()
  for (const node of graph.nodes) index.set(node.id, node)
  return index
}

/** Key for the single edge feeding one input port. */
export function portKey(nodeId: string, portId: string): string {
  return `${nodeId}\u0000${portId}`
}

/**
 * The edge feeding each input port, keyed by `portKey`.
 *
 * `edgeInto` scans every edge, and is asked once per input port of every node — so building
 * this once turns O(N·P·E) into O(E). Later edges do not displace earlier ones, matching
 * `edgeInto`'s `find`, though `addEdge` already keeps input ports single-connection.
 */
export function inboundIndex(graph: CodaGraph): Map<string, GraphEdge> {
  const index = new Map<string, GraphEdge>()
  for (const edge of graph.edges) {
    const key = portKey(edge.target, edge.targetHandle)
    if (!index.has(key)) index.set(key, edge)
  }
  return index
}

/** Direct upstream node ids, deduplicated. */
export function dependencies(graph: CodaGraph, nodeId: string): string[] {
  return [...new Set(incomingEdges(graph, nodeId).map((e) => e.source))]
}

export function dependents(graph: CodaGraph, nodeId: string): string[] {
  return [...new Set(outgoingEdges(graph, nodeId).map((e) => e.target))]
}

/**
 * Direct neighbours of every node, in one pass over the edges.
 *
 * `dependencies`/`dependents` each filter the whole edge list and allocate four arrays, which
 * is fine for one question and quadratic inside a traversal — and these traversals run on
 * every graph mutation, several times over. Built here instead so a walk costs O(N+E) rather
 * than O(N·E).
 *
 * First-appearance order is preserved, because `topoSort` promises ties break on the graph's
 * own order and its determinism reaches a provenance key.
 */
function neighbourIndex(
  edges: readonly GraphEdge[],
  from: 'source' | 'target',
): Map<string, string[]> {
  const to = from === 'source' ? 'target' : 'source'
  const index = new Map<string, string[]>()
  for (const edge of edges) {
    const key = edge[from]
    const list = index.get(key)
    if (!list) index.set(key, [edge[to]])
    else if (!list.includes(edge[to])) list.push(edge[to])
  }
  return index
}

/** Walk a neighbour index transitively from `nodeId`, excluding the node itself. */
function closure(index: Map<string, string[]>, nodeId: string): Set<string> {
  const out = new Set<string>()
  const stack = [...(index.get(nodeId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    const next = index.get(id)
    if (next) stack.push(...next)
  }
  return out
}

/** Transitive downstream closure, excluding the node itself. */
export function descendants(graph: CodaGraph, nodeId: string): Set<string> {
  return closure(neighbourIndex(graph.edges, 'source'), nodeId)
}

/** Transitive upstream closure, excluding the node itself. */
export function ancestors(graph: CodaGraph, nodeId: string): Set<string> {
  return closure(neighbourIndex(graph.edges, 'target'), nodeId)
}

// ---------------------------------------------------------------------------
// Topological order
// ---------------------------------------------------------------------------

export interface TopoResult {
  /** Node ids in dependency order. Nodes inside cycles are omitted. */
  order: string[]
  /** Ids that could not be ordered because they sit on/behind a cycle. */
  cyclic: string[]
}

/**
 * Kahn's algorithm. Deterministic: ties break on the graph's node order.
 *
 * **The indegree is counted over `outgoing` rather than over `graph.edges`, and that is a fix
 * rather than a tidy-up.** `neighbourIndex` deduplicates — it answers "which nodes does this
 * one feed", which is what the closure walks need — so a pair of nodes joined by *two* wires
 * appears there once. Counting the edges instead gave the target an indegree of 2 against a
 * single decrement, so it never reached zero, never entered the order, and came out in
 * `cyclic`. Two nodes joined twice is not a cycle; it is `Paths → Network` handing over both
 * its network and its layout, or Explore's `Hits` and `Selected` arriving at one Join.
 *
 * The symptom is worth recognising because it does not look like a sort problem: the *link* is
 * allowed, since `wouldCreateCycle` is a different and correct walk, and then every column
 * picker on the target empties out — inference drops a cyclic node's types — while a result
 * cached from before the second wire went in stays on screen. So the node reads as having lost
 * its schema rather than as having been excluded from the order.
 *
 * Deriving the count from the very index that decrements it is what makes the two unable to
 * disagree again.
 */
export function topoSort(graph: CodaGraph): TopoResult {
  const outgoing = neighbourIndex(graph.edges, 'source')

  const indegree = new Map<string, number>()
  for (const n of graph.nodes) indegree.set(n.id, 0)
  for (const [source, targets] of outgoing) {
    // An edge with a dangling end belongs to neither count; the node it names does not exist.
    if (!indegree.has(source)) continue
    for (const target of targets) {
      if (!indegree.has(target)) continue
      indegree.set(target, (indegree.get(target) ?? 0) + 1)
    }
  }

  const ready = graph.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id)
  const order: string[] = []
  // A cursor rather than `shift()`, which is O(N) per pop and made Kahn's own loop quadratic.
  for (let head = 0; head < ready.length; head++) {
    const id = ready[head]!
    order.push(id)
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) ready.push(next)
    }
  }

  const ordered = new Set(order)
  const cyclic = graph.nodes.filter((n) => !ordered.has(n.id)).map((n) => n.id)
  return { order, cyclic }
}

/** Would adding source -> target introduce a cycle? */
export function wouldCreateCycle(graph: CodaGraph, source: string, target: string): boolean {
  if (source === target) return true
  // A cycle appears iff `source` is already reachable from `target`.
  return descendants(graph, target).has(source) || target === source
}

// ---------------------------------------------------------------------------
// Mutations (pure — always return a new graph)
// ---------------------------------------------------------------------------

let idCounter = 0

/** Monotonic, collision-free within a session; prefixed so ids stay readable in files. */
export function newId(prefix = 'n'): string {
  idCounter += 1
  return `${prefix}${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function addNode(graph: CodaGraph, node: GraphNode): CodaGraph {
  return { ...graph, nodes: [...graph.nodes, node] }
}

export function updateNode(
  graph: CodaGraph,
  id: string,
  patch: Partial<Omit<GraphNode, 'id'>>,
): CodaGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  }
}

export function setNodeParam(
  graph: CodaGraph,
  id: string,
  paramId: string,
  value: ParamValues[string],
): CodaGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === id ? { ...n, params: { ...n.params, [paramId]: value } } : n,
    ),
  }
}

export function removeNodes(graph: CodaGraph, ids: readonly string[]): CodaGraph {
  const dead = new Set(ids)
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !dead.has(n.id)),
    edges: graph.edges.filter((e) => !dead.has(e.source) && !dead.has(e.target)),
  }
}

/**
 * Add an edge, replacing any existing edge on the same *input* port. Input ports take a
 * single connection (Blender/ComfyUI behaviour) which keeps evaluation unambiguous.
 */
export function addEdge(
  graph: CodaGraph,
  edge: Omit<GraphEdge, 'id'> & { id?: string },
): CodaGraph {
  const id = edge.id ?? newId('e')
  const kept = graph.edges.filter(
    (e) => !(e.target === edge.target && e.targetHandle === edge.targetHandle),
  )
  return { ...graph, edges: [...kept, { ...edge, id }] }
}

export function removeEdges(graph: CodaGraph, ids: readonly string[]): CodaGraph {
  const dead = new Set(ids)
  return { ...graph, edges: graph.edges.filter((e) => !dead.has(e.id)) }
}

/**
 * Move one end of an existing link.
 *
 * **The edge keeps its id**, which is the whole reason this is not a delete followed by an add.
 * A rewire is one link changing where it lands, and React Flow keys its elements by id — a
 * fresh id would remount the wire mid-gesture, dropping the reconnect drag it is part of.
 *
 * The old edge is removed *before* the add, and that ordering is load-bearing too: `addEdge`
 * evicts whatever already occupies the destination input, which is not necessarily the edge
 * being moved, so adding first would leave two edges sharing one id.
 *
 * Validity is the caller's business — see `checkConnection`, which the store runs first.
 */
export function reconnectEdge(
  graph: CodaGraph,
  edgeId: string,
  next: Omit<GraphEdge, 'id'>,
): CodaGraph {
  return addEdge(removeEdges(graph, [edgeId]), { ...next, id: edgeId })
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function serializeGraph(graph: CodaGraph): string {
  const out: CodaGraph = {
    ...graph,
    version: GRAPH_FORMAT_VERSION,
    meta: { ...graph.meta, modifiedAt: new Date().toISOString() },
  }
  return JSON.stringify(out, null, 2)
}

/**
 * A stored card size, or undefined.
 *
 * Checked rather than trusted: a zero or negative size collapses the node to nothing on the
 * canvas with no way to grab it again, which is unrecoverable from the UI.
 */
function validSize(raw: unknown): { width: number; height: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { width, height } = raw as { width?: unknown; height?: unknown }
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined
  return { width: w, height: h }
}

export interface LoadResult {
  graph: CodaGraph
  /** Non-fatal problems: unknown node types, dropped edges, version drift. */
  warnings: string[]
}

/**
 * Parse and repair a graph file. Deliberately lenient: unknown node types are dropped
 * with a warning rather than failing the whole load, so a file made with a newer node
 * pack still opens.
 */
export function deserializeGraph(json: string): LoadResult {
  const warnings: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    throw new Error(`Not valid JSON: ${(err as Error).message}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error('Graph file must be a JSON object')

  const obj = raw as Partial<CodaGraph>
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    throw new Error('Graph file must contain "nodes" and "edges" arrays')
  }
  if (typeof obj.version === 'number' && obj.version > GRAPH_FORMAT_VERSION) {
    warnings.push(
      `File format v${obj.version} is newer than this build (v${GRAPH_FORMAT_VERSION}); some nodes may not load.`,
    )
  }

  const nodes: GraphNode[] = []
  for (const n of obj.nodes) {
    if (!n || typeof n.id !== 'string' || typeof n.type !== 'string') {
      warnings.push('Dropped a node with no id/type')
      continue
    }
    if (!getNodeDef(n.type)) {
      warnings.push(`Dropped unknown node type "${n.type}" (${n.id})`)
      continue
    }
    nodes.push({
      id: n.id,
      type: n.type,
      position: {
        x: Number(n.position?.x) || 0,
        y: Number(n.position?.y) || 0,
      },
      params: (n.params && typeof n.params === 'object' ? n.params : {}) as ParamValues,
      ...(n.title ? { title: n.title } : {}),
      ...(n.collapsed ? { collapsed: true } : {}),
      ...(n.paramsCollapsed ? { paramsCollapsed: true } : {}),
      ...(n.disabled ? { disabled: true } : {}),
      ...(validSize(n.size) ? { size: validSize(n.size) } : {}),
    })
  }

  const alive = new Set(nodes.map((n) => n.id))
  const edges: GraphEdge[] = []
  for (const e of obj.edges) {
    if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') continue
    if (!alive.has(e.source) || !alive.has(e.target)) {
      warnings.push(`Dropped edge ${e.source} → ${e.target} (endpoint missing)`)
      continue
    }
    edges.push({
      id: typeof e.id === 'string' ? e.id : newId('e'),
      source: e.source,
      sourceHandle: e.sourceHandle ?? 'out',
      target: e.target,
      targetHandle: e.targetHandle ?? 'in',
    })
  }

  return {
    graph: {
      version: GRAPH_FORMAT_VERSION,
      nodes,
      edges,
      ...(obj.viewport ? { viewport: obj.viewport } : {}),
      ...(obj.meta ? { meta: obj.meta } : {}),
    },
    warnings,
  }
}
