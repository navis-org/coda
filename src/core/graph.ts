/**
 * Graph data model + structural operations.
 *
 * This is the serialised form: a `.coda.json` file *is* a `CodaGraph`. Keep it boring
 * and additive — old files must keep loading. Positions live here because the graph
 * file is the document; the UI owns nothing that a reload should lose.
 */

import type { ParamValues, ResolvedPort } from './node'
import { hasPortGroups, allInputPorts, inputPorts, outputPorts } from './ports'
import { getNodeDef, typesWithLoops, typesWithReferenceInputs } from './registry'

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
   * Folds the param rows *and* the port rows away, leaving the header, any body and the footer —
   * so on a viewer the drawing gains both bands. Distinct from `collapsed`, which keeps none of
   * those; the point here is a card that has been set up and now wants to be looked at.
   *
   * Named for the params alone because that is what it folded when it was written, and the name
   * is in saved files. Read it as "the rows are folded".
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

/**
 * The colours a group frame may be drawn in, by name.
 *
 * **A name and not a CSS colour**, and that is a safety property as well as a theming one. A
 * `.coda.json` arrives from a gist, from the Zoo, from a mailed file — and the frame's colour is
 * spent straight into an inline `style`, where an arbitrary string is a CSS injection with a
 * `--var` and a `url()` in it. A name off this list resolves to a token in `theme.css` at render
 * time, so the document carries a choice rather than a value, and the two themes each get the
 * hue that was validated for them (`ui/colors.ts`).
 */
export const GROUP_COLORS = [
  'grey',
  'blue',
  'orange',
  'green',
  'pink',
  'violet',
] as const
export type GroupColor = (typeof GROUP_COLORS)[number]

/**
 * A frame drawn around a set of cards, and the set itself.
 *
 * Membership is a **list of node ids**, not a parent link on the node and not a rectangle. Both
 * alternatives were available and both are worse here:
 *
 *  - React Flow's own `parentId` makes a child's `position` relative to its parent, which would
 *    change the meaning of a field every saved file, the layout engine, the splice hit test and
 *    the exporters already read absolutely. Groups are decoration; they have no business
 *    re-basing the document's coordinates.
 *  - A stored rectangle would need somebody to keep it in step with the cards inside it. The box
 *    is *derived* instead (`layout/groupBounds.ts`), so a card that moves, is resized, collapses
 *    or folds its params drags the frame with it and nothing can go stale.
 *
 * **A node belongs to at most one group and groups do not nest.** So "which box owns this card"
 * always has an answer — which is what the collapse-a-group feature will need, and what an
 * overlapping model could not give it. `createGroup` enforces it by moving a node out of its old
 * group rather than refusing.
 */
export interface GraphGroup {
  id: string
  /** Members, by node id. Never empty — an emptied group is dropped, see `pruneGroups`. */
  nodeIds: string[]
  /** Drawn above the frame's top-left corner. Absent means an unnamed frame. */
  title?: string
  /** Absent means the default grey. See `GROUP_COLORS`. */
  color?: GroupColor
  /** A tint inside the frame rather than outline-only. Off by default. */
  filled?: boolean
  /** A dashed outline rather than a solid one. Off by default. */
  dashed?: boolean
}

export interface CodaGraph {
  version: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  /**
   * Frames drawn around sets of cards. Absent on every graph nobody has grouped anything in,
   * which is why it is optional rather than an empty array — an old file must round trip
   * byte-identically through a load and a save.
   */
  groups?: GraphGroup[]
  /** Restored on load so a saved graph reopens where you left it. */
  viewport?: { x: number; y: number; zoom: number }
  meta?: {
    name?: string
    description?: string
    /** ISO 8601. */
    createdAt?: string
    modifiedAt?: string
    /**
     * The gist this workflow was last shared to, if it has been.
     *
     * In the document rather than beside it because that is what lets Share *update* the link
     * somebody already has instead of littering a second gist every time it is pressed. A gist
     * id is public by construction, so nothing private travels with it.
     *
     * `owner` is what makes it safe to carry: a graph you were *sent* names somebody else's
     * gist, and sharing it must create your own rather than PATCH theirs and get a 404 with
     * nothing to explain it. See `data/share/gist.ts`.
     */
    gist?: { id: string; owner?: string }
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

/**
 * Whether this graph could contain a loop at all — `mayHaveReferences`' twin.
 *
 * Asked before `loopRegion` or `loopsIn` walk anything, so a graph with no `For Each` in it pays
 * a `Set` lookup per node and allocates nothing. The scheduler asks once per run and the canvas
 * once per frame memo.
 */
export function mayHaveLoops(nodes: readonly GraphNode[]): boolean {
  const types = typesWithLoops()
  return types.size > 0 && nodes.some((n) => types.has(n.type))
}

/**
 * The nodes a loop re-runs — everything reachable from its begin node that is not *past* an exit.
 *
 * The walk stops **at** a `loop: 'end'` node rather than before it, and that asymmetry is the
 * whole definition. An exit folds once per pass, so it is inside; everything after it reads the
 * finished accumulation, so it is outside. Stopping *before* the exit would leave the fold
 * running once on the last element, and stopping after it would re-run the whole tail of the
 * graph per element.
 *
 * Walking forward from the begin node rather than intersecting `descendants(begin)` with
 * `ancestors(exit)` is what makes a fan-out correct: a node reachable by a path that never
 * touches an exit is in the region even when *another* path to it goes through one, and the set
 * intersection quietly drops it.
 *
 * Includes the begin node itself, because it re-runs too — emitting a different element is what
 * a pass *is*.
 */
export function loopRegion(graph: CodaGraph, beginId: string): Set<string> {
  const index = neighbourIndex(graph.edges, 'source')
  const types = nodesById(graph)
  const out = new Set<string>([beginId])
  const stack = [beginId]
  while (stack.length) {
    const id = stack.pop()!
    for (const next of index.get(id) ?? []) {
      if (out.has(next)) continue
      out.add(next)
      const type = types.get(next)?.type
      if (type === undefined || getNodeDef(type)?.loop !== 'end') stack.push(next)
    }
  }
  return out
}

/**
 * Every loop in the graph, outermost first, as `beginId → region`.
 *
 * Ordered by region size descending so a nested loop is always listed after the loop containing
 * it. The scheduler relies on that: it claims region nodes for the outermost loop it finds, and
 * an inner loop then runs *inside* each of the outer one's passes rather than being hoisted out
 * of it — which would be the same nodes re-run in the wrong order with nothing saying so.
 */
export function loopsIn(graph: CodaGraph): Array<{ beginId: string; region: Set<string> }> {
  // No `mayHaveLoops` guard: the filter below is already a single pass that allocates an empty
  // array on a loop-free graph, so the memo would only walk the nodes a second time. It earns
  // its keep where the walk it guards is the expensive part — `resolveScope`.
  const loops = graph.nodes
    .filter((n) => getNodeDef(n.type)?.loop === 'begin')
    .map((n) => ({ beginId: n.id, region: loopRegion(graph, n.id) }))
  return loops.sort((a, b) => b.region.size - a.region.size)
}

/**
 * Whether this graph could contain a reference edge at all.
 *
 * Asked before anything walks the edges, because exactly one node type in the registry declares a
 * reference input — so on every graph without one the machinery below costs a `Set` lookup per
 * node and allocates nothing. It is worth the guard: `topoSort` runs twice per keystroke and
 * `wouldCreateCycle` once per pointer move of a link drag, and both used to build a node-type
 * index and a filtered edge array whatever the graph held. Measured at 1.4 µs → 0.13 µs.
 */
function mayHaveReferences(nodes: readonly GraphNode[]): boolean {
  const types = typesWithReferenceInputs()
  return types.size > 0 && nodes.some((n) => types.has(n.type))
}

/**
 * Whether a node type's port is declared a reference — see `PortDef.reference`.
 *
 * A question about a **port**, which is what the flag is on. It was phrased about an edge, which
 * meant `wouldCreateCycle` had to fabricate one with three placeholder fields to ask about a wire
 * that did not exist yet.
 */
function isReferencePort(nodeType: string | undefined, portId: string): boolean {
  if (!nodeType) return false
  const def = getNodeDef(nodeType)
  /*
   * Every arity, not this node's — there is no node here, only a type and a port id. A group
   * expanded at `max` covers every id the type could ever carry, so an id that is not in there
   * cannot be a reference at any count. See `core/ports.ts`.
   */
  return !!def && allInputPorts(def).some((p) => p.id === portId && p.reference === true)
}

/**
 * The edges that create an ordering dependency — every edge except one landing on a `reference`
 * port.
 *
 * **One filter, in the one place both the indegree count and its decrement derive from.** That is
 * not a stylistic choice: `topoSort`'s own note records the bug where the count came from
 * `graph.edges` and the decrement from `neighbourIndex`, so a target joined twice never reached
 * zero and came out `cyclic`. Filtering anywhere but here would re-introduce exactly that shape,
 * with a reference edge counted once and decremented never.
 *
 * A reference names a node rather than consuming its output — see `PortDef.reference`. It is
 * excluded here and in `wouldCreateCycle`, and **nowhere else**: invalidation still follows it, so
 * dropping a dataset's result still reaches the node that read its identity. That walk is
 * `descendantsOf` in `scheduler.ts` — *not* the `descendants` exported here, which has no
 * production caller. Whoever consolidates the two must keep it walking every edge.
 *
 * Returns `graph.edges` itself when nothing can be filtered, so the common graph allocates
 * nothing at all.
 */
function dataflowEdges(graph: CodaGraph): readonly GraphEdge[] {
  if (!mayHaveReferences(graph.nodes)) return graph.edges
  const types = new Map(graph.nodes.map((n) => [n.id, n.type]))
  return graph.edges.filter(
    (edge) => !isReferencePort(types.get(edge.target), edge.targetHandle),
  )
}

/**
 * The ids of every edge that names a node rather than carrying its output.
 *
 * A set rather than a predicate the caller asks per edge, because the caller is the canvas and
 * that would put a `getNodeDef` in the middle of the edge memo.
 */
export function referenceEdgeIds(graph: CodaGraph): Set<string> {
  const out = new Set<string>()
  if (!mayHaveReferences(graph.nodes)) return out
  const types = new Map(graph.nodes.map((n) => [n.id, n.type]))
  for (const edge of graph.edges) {
    if (isReferencePort(types.get(edge.target), edge.targetHandle)) out.add(edge.id)
  }
  return out
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
  const outgoing = neighbourIndex(dataflowEdges(graph), 'source')

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

/**
 * A topological order with every reference's source moved ahead of its reader, where it can be.
 *
 * `topoSort` deliberately ignores reference edges — that is what lets a node take a dataset it
 * also feeds, and it is the right order for *running*, where the reader waits on nothing.
 * Anything that instead **writes the nodes out**, so that one node's text can name another, wants
 * the opposite. `src/export/order.ts` is that caller and holds the reasoning; this is only the
 * transformation.
 *
 * **Only a node with no dataflow inputs is lifted**, and that condition is not a precaution — it
 * is the same one that makes a reference sound, made checkable. A reference is valid because the
 * referenced node's identity comes from its params alone; a node that *consumes* something cannot
 * be written above what it consumes, and the wiring references exist for is exactly that shape:
 * `CAVE table → Update root IDs → Dataset` puts the dataset after both nodes referencing it, so
 * hoisting it above them would classify it `blocked` by its own annotations and cascade a false
 * TODO to everything downstream — the very failure the hoist was added to prevent, arrived at
 * from the other side.
 *
 * A reader left ahead of its reference is not stranded: the walk does not treat an unbound
 * reference port as blocking, and an emitter reading one falls back to the referenced node's
 * *type*, which is all a reference ever promised.
 *
 * Relative order is preserved on both sides, so a graph with no references is untouched.
 */
export function referencesFirst(order: readonly string[], graph: CodaGraph): string[] {
  if (!mayHaveReferences(graph.nodes)) return [...order]
  const types = new Map(graph.nodes.map((n) => [n.id, n.type]))
  const referenced = new Set<string>()
  const consumes = new Set<string>()
  for (const edge of graph.edges) {
    if (isReferencePort(types.get(edge.target), edge.targetHandle)) referenced.add(edge.source)
    else consumes.add(edge.target)
  }
  const lift = (id: string): boolean => referenced.has(id) && !consumes.has(id)
  // No empty-set branch: with nothing lifted the two filters already produce an order-preserving
  // copy, and a special case for it is one more thing to read.
  return [...order.filter(lift), ...order.filter((id) => !lift(id))]
}

/**
 * Would adding source -> target introduce a cycle?
 *
 * Walks the **dataflow** edges, not all of them: a reference names a node and imposes no order,
 * so a wire that would only close a loop through one is not a loop. Without this the editor
 * refuses precisely the wiring references exist to allow.
 */
export function wouldCreateCycle(
  graph: CodaGraph,
  source: string,
  target: string,
  targetHandle: string,
): boolean {
  if (source === target) return true
  /*
   * The wire *being drawn* can itself be a reference, and then it can never close a loop — it
   * imposes no order. Without this the check refuses precisely the wiring references exist to
   * allow: `Dataset → CAVE table` is refused because `CAVE table → Dataset` already runs the
   * other way, which is the whole arrangement.
   *
   * `targetHandle` is required rather than optional. It was optional to spare three test call
   * sites, and the defaulted answer was the *wrong* one — the existing graph filtered but the new
   * wire treated as dataflow — so a caller that forgot it got a refusal reading as a real cycle.
   */
  const targetType = graph.nodes.find((n) => n.id === target)?.type
  if (isReferencePort(targetType, targetHandle)) return false
  // A cycle appears iff `source` is already reachable from `target` along dataflow edges.
  return closure(neighbourIndex(dataflowEdges(graph), 'source'), target).has(source)
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
  const nodes = graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n))
  /*
   * The prune lives here rather than on `setNodeParam` because this is the *generic* node patch
   * and `setNodeParam` is one caller of it. The assistant writes params straight through
   * `updateNode` (`assistant/apply.ts`), so a plan that lowered a variadic node's count would
   * otherwise leave edges on ports that are no longer drawn — see `pruneDanglingEdges`.
   */
  return pruneDanglingEdges({ ...graph, nodes }, id)
}

/**
 * A node's resolved ports, looked up and expanded in one step.
 *
 * Every caller that holds a `GraphNode` needs the same three lines — find the definition, guard
 * the unregistered case, pass `node.params` — and the migration to variadic ports wrote them out
 * at a dozen sites. Three of those also hand-rolled the `side === 'output' ? … : …` branch on
 * top. An unregistered type answers with no ports, which is what every one of those sites did
 * with its `?? []`.
 *
 * Here rather than in `core/ports.ts` because that module must not value-import the registry:
 * `registry.ts` already imports it, and the cycle would be real. `graph.ts` imports both
 * already.
 */
export function nodePorts(
  node: GraphNode,
  side: 'input' | 'output',
): readonly ResolvedPort[] {
  const def = getNodeDef(node.type)
  if (!def) return NO_PORTS
  return side === 'output' ? outputPorts(def, node.params) : inputPorts(def, node.params)
}

const NO_PORTS: readonly ResolvedPort[] = []

export function setNodeParam(
  graph: CodaGraph,
  id: string,
  paramId: string,
  value: ParamValues[string],
): CodaGraph {
  const node = graph.nodes.find((n) => n.id === id)
  if (!node) return graph
  return updateNode(graph, id, { params: { ...node.params, [paramId]: value } })
}

/**
 * Drop edges landing on ports `node` no longer has.
 *
 * A param can change a node's *port set* — see `PortGroupDef` — so lowering a comparison node's
 * dataset count from three to two leaves an edge pointing at `dataset3`, which is a socket that
 * is no longer drawn. Nothing downstream would report it: `inferGraph` and the scheduler both
 * walk the node's ports and look edges *up* by port key, so an edge on an id nobody asks about
 * is simply never read. It would sit in the file, survive a save/load round trip, and reappear
 * as a wire the moment the count went back up — carrying whatever it was wired to before.
 *
 * Here rather than in the store so the pruning is part of the same graph transform as the param
 * change, which is what makes the two undo as one step. `pruneGroups` is the precedent: a
 * mutation is responsible for the derived structure it invalidates.
 *
 * Returns the graph itself when there is nothing to do, which is every node without groups —
 * so `setNodeParam` pays one registry lookup and one boolean for the overwhelming majority.
 */
function pruneDanglingEdges(graph: CodaGraph, nodeId: string): CodaGraph {
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) return graph
  const def = getNodeDef(node.type)
  if (!def || !hasPortGroups(def)) return graph

  const ins = new Set(inputPorts(def, node.params).map((p) => p.id))
  const outs = new Set(outputPorts(def, node.params).map((p) => p.id))
  const kept = graph.edges.filter(
    (e) =>
      (e.target !== nodeId || ins.has(e.targetHandle)) &&
      (e.source !== nodeId || outs.has(e.sourceHandle)),
  )
  return kept.length === graph.edges.length ? graph : { ...graph, edges: kept }
}

export function removeNodes(graph: CodaGraph, ids: readonly string[]): CodaGraph {
  const dead = new Set(ids)
  return pruneGroups({
    ...graph,
    nodes: graph.nodes.filter((n) => !dead.has(n.id)),
    edges: graph.edges.filter((e) => !dead.has(e.source) && !dead.has(e.target)),
  })
}

/**
 * Drop group members that are not in the graph, and groups that are left with none.
 *
 * Here rather than in the store, and called from `removeNodes` rather than beside each caller,
 * because deletion arrives by four routes — the menu, the palette, React Flow's Delete key and
 * an assistant plan — and a membership list naming a node nobody can see is invisible until the
 * frame is dragged and moves fewer cards than it drew around.
 *
 * Returns the graph **unchanged by identity** when nothing needed pruning, which is what lets
 * the store's `commit` skip an undo step for a delete that touched no group.
 */
export function pruneGroups(graph: CodaGraph): CodaGraph {
  if (!graph.groups?.length) return graph
  const alive = new Set(graph.nodes.map((n) => n.id))
  let changed = false
  const groups: GraphGroup[] = []
  for (const group of graph.groups) {
    const nodeIds = group.nodeIds.filter((id) => alive.has(id))
    if (nodeIds.length === group.nodeIds.length) {
      groups.push(group)
      continue
    }
    changed = true
    if (nodeIds.length > 0) groups.push({ ...group, nodeIds })
  }
  if (!changed) return graph
  const next = { ...graph }
  // Deleted rather than set to `undefined`: a graph nobody has grouped anything in must not
  // grow a key, so that a file round trips through a load and a save byte-identically.
  if (groups.length) next.groups = groups
  else delete next.groups
  return next
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

/**
 * The document as JSON.
 *
 * Indented by default, because a `.coda.json` is a file people read and diff. `compact` is for
 * the share link, where the indentation is dead weight — and where the obvious spelling,
 * `JSON.stringify(JSON.parse(serializeGraph(g)))`, walks the whole document three times and
 * holds a throwaway copy of it to undo work this function had just done.
 */
export function serializeGraph(graph: CodaGraph, options: { compact?: boolean } = {}): string {
  const out: CodaGraph = {
    ...graph,
    version: GRAPH_FORMAT_VERSION,
    meta: { ...graph.meta, modifiedAt: new Date().toISOString() },
  }
  return options.compact ? JSON.stringify(out) : JSON.stringify(out, null, 2)
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

/**
 * A stored `meta` block, with anything malformed dropped.
 *
 * `meta` used to be a name and two timestamps that nothing did anything with but display, so
 * passing it through whole was harmless. It is not any more: `meta.gist` names a gist that
 * `updateGist` will PATCH with the user's token, and a `.coda.json` is a file people mail each
 * other. So it goes through the same lenient-but-checked pass `validSize` gives a card size —
 * known keys kept when they are the right shape, everything else dropped rather than trusted.
 */
function validMeta(raw: unknown): CodaGraph['meta'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { name, description, createdAt, modifiedAt, gist } = raw as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const id = typeof gist === 'object' && gist ? (gist as Record<string, unknown>) : undefined
  const gistId = text(id?.['id'])
  const gistOwner = text(id?.['owner'])
  return {
    ...(text(name) !== undefined ? { name: text(name) } : {}),
    ...(text(description) !== undefined ? { description: text(description) } : {}),
    ...(text(createdAt) !== undefined ? { createdAt: text(createdAt) } : {}),
    ...(text(modifiedAt) !== undefined ? { modifiedAt: text(modifiedAt) } : {}),
    ...(gistId ? { gist: { id: gistId, ...(gistOwner ? { owner: gistOwner } : {}) } } : {}),
  }
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
/**
 * One end of a stored edge resolved against the ports the node actually has.
 *
 * Returns the port id to use, or undefined when the edge names a socket that is not there. A
 * stored handle that matches is kept as-is; a **missing** one falls back to the node's sole port
 * where it has exactly one, and only then to the historical default — a file old enough to omit
 * handles predates any node with two ports on a side, so "the only port" is what it meant.
 */
function healHandle(
  ports: readonly { id: string }[],
  stored: string | undefined,
  legacy: string,
): string | undefined {
  if (typeof stored === 'string') return ports.some((p) => p.id === stored) ? stored : undefined
  if (ports.length === 1) return ports[0]!.id
  return ports.some((p) => p.id === legacy) ? legacy : undefined
}

/**
 * Why an edge could not be attached to a port, in words a user can act on.
 *
 * Two different failures reach the same branch and they read as one if the stored handle is
 * simply interpolated: a handle naming a port that is not there, and **no handle recorded at
 * all** on a node with no single port to heal to. The second printed `no output "undefined"`,
 * which describes nothing and is surfaced verbatim by the Zoo's graph validator.
 */
function droppedHandle(
  side: 'output' | 'input',
  nodeType: string,
  nodeId: string,
  stored: string | undefined,
  ports: readonly { id: string }[],
): string {
  const where = `Dropped edge ${side === 'output' ? 'from' : 'into'} ${nodeType} (${nodeId})`
  if (typeof stored === 'string') return `${where}: no ${side} "${stored}"`
  const has = ports.length === 0 ? `it has no ${side}s` : `it has ${ports.length}`
  return `${where}: the file records no ${side} port, and ${has}`
}

/**
 * A stored node's params, with any `absentMeans` filled in.
 *
 * The one place "this document predates that control" is turned into a value. It is deliberately
 * **not** a general backfill of declared defaults: `findNeuronsRows.ts` records why a load-time
 * migration is the wrong tool for the ordinary case — `addNode` and `defaultParams` never come
 * through here, so it would reach saved files and miss every starter graph, fixture and test that
 * builds a node by hand, leaving two populations that behave differently.
 *
 * What it is for is the narrow case where absent and the default are *different answers*. Then
 * absence is not a value waiting to be filled in, it is a fact about when the document was
 * written, and something has to record it before the graph reaches a card — because `ParamField`
 * renders an absent param as its default and would otherwise draw a control that disagrees with
 * the query beneath it. See `ParamBase.absentMeans`.
 *
 * Lenient like everything else here: an unknown type has already been dropped by the time this
 * runs, and a param the definition no longer declares survives untouched.
 */
function storedParams(raw: unknown, type: string): ParamValues {
  const params = { ...((raw && typeof raw === 'object' ? raw : {}) as ParamValues) }
  for (const param of getNodeDef(type)?.params ?? []) {
    if (param.absentMeans !== undefined && !(param.id in params)) {
      params[param.id] = param.absentMeans
    }
  }
  return params
}

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
      params: storedParams(n.params, n.type),
      ...(n.title ? { title: n.title } : {}),
      ...(n.collapsed ? { collapsed: true } : {}),
      ...(n.paramsCollapsed ? { paramsCollapsed: true } : {}),
      ...(n.disabled ? { disabled: true } : {}),
      ...(validSize(n.size) ? { size: validSize(n.size) } : {}),
    })
  }

  const alive = new Map(nodes.map((n) => [n.id, n]))
  const edges: GraphEdge[] = []
  for (const e of obj.edges) {
    if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') continue
    const from = alive.get(e.source)
    const to = alive.get(e.target)
    if (!from || !to) {
      warnings.push(`Dropped edge ${e.source} → ${e.target} (endpoint missing)`)
      continue
    }
    /*
     * Both handles are resolved against the node's *actual* ports rather than trusted.
     *
     * A port set can be a function of the node's params (`PortGroupDef`), so a file written by a
     * build whose `max` was higher — or edited by hand — can name a socket this node does not
     * have. Such an edge is invisible and inert: every walk looks edges up *by* port key, so
     * nothing ever asks for it, and it would sit in the document being re-saved forever and
     * reappear as a live wire if the count later rose. Dropping it with a warning is the same
     * call the missing-endpoint branch above already makes.
     *
     * The `?? 'out'` / `?? 'in'` fallbacks were load-bearing for old files that omitted the
     * handle, and were also wrong for every node whose single port is called something else. A
     * node with exactly one port on that side now heals to *that* port, which is what those
     * defaults were reaching for.
     */
    const outs = outputPorts(getNodeDef(from.type)!, from.params)
    const ins = inputPorts(getNodeDef(to.type)!, to.params)
    const sourceHandle = healHandle(outs, e.sourceHandle, 'out')
    const targetHandle = healHandle(ins, e.targetHandle, 'in')
    if (!sourceHandle) {
      warnings.push(droppedHandle('output', from.type, e.source, e.sourceHandle, outs))
      continue
    }
    if (!targetHandle) {
      warnings.push(droppedHandle('input', to.type, e.target, e.targetHandle, ins))
      continue
    }
    edges.push({
      id: typeof e.id === 'string' ? e.id : newId('e'),
      source: e.source,
      sourceHandle,
      target: e.target,
      targetHandle,
    })
  }

  const groups = validGroups(obj.groups, new Set(alive.keys()))

  return {
    graph: {
      version: GRAPH_FORMAT_VERSION,
      nodes,
      edges,
      ...(groups.length ? { groups } : {}),
      ...(obj.viewport ? { viewport: obj.viewport } : {}),
      ...(validMeta(obj.meta) ? { meta: validMeta(obj.meta) } : {}),
    },
    warnings,
  }
}

/**
 * Stored group frames, with anything malformed dropped.
 *
 * The same lenient-but-checked pass `validSize` and `validMeta` give the rest of the file, and
 * for the same three reasons here. A member id whose node was dropped as an unknown type would
 * make a frame that draws around fewer cards than it moves. A colour is a *name* off
 * `GROUP_COLORS` and an unknown one falls back to the default rather than reaching a stylesheet
 * — see the note there. And a group with no members left is not a frame, it is a rectangle of
 * nothing, so it goes.
 *
 * Silent rather than warned about, unlike a dropped node: the document still means what it said,
 * minus decoration, and a warning per stale membership on a file somebody was sent would bury
 * the warnings that are about their data.
 */
function validGroups(raw: unknown, alive: ReadonlySet<string>): GraphGroup[] {
  if (!Array.isArray(raw)) return []
  const groups: GraphGroup[] = []
  const claimed = new Set<string>()
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue
    const { id, nodeIds, title, color, filled, dashed } = g as Record<string, unknown>
    if (typeof id !== 'string' || !Array.isArray(nodeIds)) continue
    // A node in two groups cannot be drawn honestly by either — first one wins, as
    // `createGroup` would have done.
    const members = nodeIds.filter(
      (n): n is string => typeof n === 'string' && alive.has(n) && !claimed.has(n),
    )
    if (members.length === 0) continue
    for (const n of members) claimed.add(n)
    const named = GROUP_COLORS.find((c) => c === color)
    groups.push({
      id,
      nodeIds: members,
      ...(typeof title === 'string' && title ? { title } : {}),
      ...(named ? { color: named } : {}),
      ...(filled === true ? { filled: true } : {}),
      ...(dashed === true ? { dashed: true } : {}),
    })
  }
  return groups
}
