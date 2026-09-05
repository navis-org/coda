/**
 * Coda graph → ELK graph. Pure, and deliberately so.
 *
 * Everything decided here — which nodes take part, how big each card is, which side and in
 * what order its sockets sit — is arithmetic over the document and the node registry. The
 * canvas supplies measured sizes and consumes the result; nothing in this file touches React,
 * the store or the DOM, which is what makes the mapping assertable without a browser.
 */

import type { ElkNode } from 'elkjs/lib/elk-api'

import type { CodaGraph, GraphEdge, GraphNode } from '../core/graph'
import { getNodeDef, isAnnotation } from '../core/registry'
import { inputPorts, outputPorts } from '../core/ports'
import type { LayoutOptions } from './options'
import { elkNodeOptions, elkOptionsFor } from './options'
import type { XY } from './place'

/**
 * Port id inside the ELK graph.
 *
 * Deliberately not `core/graph`'s `portKey`, which joins with a NUL byte. That is fine as a Map
 * key inside one process and a bad thing to send through `postMessage` into a GWT-compiled Java
 * port that will build strings out of it. These ids are internal to one layout call and are never
 * mapped back, so a plain readable separator is both safer and easier to read in a failure.
 */
export function elkPortId(nodeId: string, portId: string): string {
  return `${nodeId}#${portId}`
}

export interface NodeSize {
  width: number
  height: number
}

/**
 * How big a card is, as far as the layout is concerned.
 *
 * The canvas passes React Flow's *measured* dimensions where it has them, which is the only
 * honest answer: a card's height is decided by its param rows, its port count, its body widget
 * and whether it is collapsed, none of which the document records. The rest of the chain is
 * what a headless caller — and every test here — gets instead.
 */
export type MeasuredSizes = ReadonlyMap<string, NodeSize>

/**
 * Where each socket sits *within* its card, in flow units, keyed by node id and then port id.
 *
 * The same standing as `MeasuredSizes` and for the same reason: a socket's offset is decided by
 * the header height, the param band, the preview and how many port rows precede it, none of
 * which the document records. Absent for a node — a headless caller, a card not yet laid out —
 * means ELK places that node's ports itself, which is what it has always done.
 */
export type MeasuredPorts = ReadonlyMap<string, ReadonlyMap<string, XY>>

/** `--node-width` in `theme.css`, and a height that fits a header and two port rows. */
export const FALLBACK_NODE_SIZE: NodeSize = { width: 232, height: 120 }

export function resolveSize(node: GraphNode, measured?: MeasuredSizes): NodeSize {
  const seen = measured?.get(node.id)
  if (seen && seen.width > 0 && seen.height > 0) return seen
  return node.size ?? getNodeDef(node.type)?.defaultSize ?? FALLBACK_NODE_SIZE
}

/**
 * A node this pass may be handed: a card from the document, or something standing in for several.
 *
 * The extension is `ports`, and it is `resolveSize`'s arrangement exactly — *a node carrying its
 * own value beats the registry*. A collapsed group arrives as a pseudo card
 * (`layout/collapse.ts`) whose type is registered nowhere, so the ordinary lookup would answer
 * "no ports", and an ELK edge naming a port its node does not declare is not a silent
 * degradation but a rejected graph. Declared on the node, this file needs to know nothing about
 * that feature — which also keeps the two modules from importing each other.
 */
export interface LayoutNode extends GraphNode {
  ports?: { inputs: ReadonlyArray<{ id: string }>; outputs: ReadonlyArray<{ id: string }> }
}

/** The sockets a card offers the layout: its own where it declares them, else the registry's. */
export function layoutPorts(node: LayoutNode): {
  inputs: ReadonlyArray<{ id: string }>
  outputs: ReadonlyArray<{ id: string }>
} {
  if (node.ports) return node.ports
  const def = getNodeDef(node.type)
  if (!def) return { inputs: [], outputs: [] }
  return { inputs: inputPorts(def, node.params), outputs: outputPorts(def, node.params) }
}

/**
 * Nodes the layout is allowed to move.
 *
 * Annotations are excluded outright — a text note is not a step in the pipeline and never
 * moves; `place.ts` shifts the arranged block clear of them instead. Note this is `isAnnotation`
 * and not "has no ports": `dataset.description` has a Dataset input and takes an ordinary slot.
 */
export function arrangeable(nodes: readonly GraphNode[]): GraphNode[] {
  return nodes.filter((node) => !isAnnotation(node.type))
}

/**
 * ELK numbers the ports of a fixed-order node **clockwise, starting at the node's top-left**.
 *
 * With no north or south ports that walk is: every east port top to bottom, then every west
 * port *bottom to top*. So an output's index follows its declaration order and an input's is
 * the reverse of it, offset past the outputs.
 *
 * Getting this backwards mirrors every card's sockets against the wires arriving at them. It
 * throws nothing, fails no type check, and produces a layout that looks fine and crosses more
 * than it needs to — which is why `elkGraph.test.ts` pins the arithmetic and `engine.test.ts`
 * checks the convention against the real algorithm rather than against this comment.
 */
export function portIndices(
  inputCount: number,
  outputCount: number,
): {
  inputs: number[]
  outputs: number[]
} {
  return {
    outputs: Array.from({ length: outputCount }, (_, i) => i),
    inputs: Array.from({ length: inputCount }, (_, i) => outputCount + (inputCount - 1 - i)),
  }
}

/**
 * The ELK graph for a set of nodes and the edges among them.
 *
 * `edges` is filtered to those with both ends in `nodes`, so a caller arranging a selection
 * does not have to do it: an edge leaving the set has no port to attach to and ELK rejects the
 * whole graph over it.
 */
export function toElkGraph(
  nodes: readonly LayoutNode[],
  edges: readonly GraphEdge[],
  options: LayoutOptions,
  measured?: MeasuredSizes,
  ports?: MeasuredPorts,
): ElkNode {
  const included = new Set(nodes.map((n) => n.id))
  /*
   * Sockets are only ever pinned under a horizontal direction, because that is the only place
   * `elkNodeOptions` fixes them at all — a vertical direction takes `FREE`, which is the
   * measured fix for the diagonal staircase. Supplying coordinates anyway is not the harmless
   * redundancy it looks like: ELK honours an explicit port position under `FREE` too, so the
   * offsets reinstate exactly the constraint the direction had just lifted, and a DOWN layout
   * goes back to a staircase — x-spread 319 rather than 39, with the option string still
   * plainly reading `FREE`.
   */
  const mayPin = options.direction === 'RIGHT' || options.direction === 'LEFT'

  const children: ElkNode[] = nodes.map((node) => {
    const { inputs, outputs } = layoutPorts(node)
    const index = portIndices(inputs.length, outputs.length)
    const size = resolveSize(node, measured)
    const offsets = ports?.get(node.id)

    /*
     * Pinned only when *every* socket on the card was measured. A partial answer is the worst
     * of the three: `FIXED_POS` takes each port's `x`/`y` literally, so an unmeasured one
     * silently lands at (0,0) — the card's top-left corner, on the wrong side — and ELK routes
     * confidently into it. Falling back per node rather than per port keeps the two readings
     * from being mixed on one card.
     */
    const pinned =
      mayPin &&
      offsets !== undefined &&
      inputs.every((port) => offsets.has(port.id)) &&
      outputs.every((port) => offsets.has(port.id))

    const side = (
      port: { id: string },
      at: 'EAST' | 'WEST',
      fallbackIndex: number | undefined,
    ) => {
      const offset = pinned ? offsets.get(port.id) : undefined
      return {
        id: elkPortId(node.id, port.id),
        // Zero-sized, so the port *is* the socket's centre rather than a box hanging off it.
        ...(offset ? { x: offset.x, y: offset.y, width: 0, height: 0 } : {}),
        layoutOptions: {
          'elk.port.side': at,
          'elk.port.index': String(fallbackIndex),
        },
      }
    }

    return {
      id: node.id,
      width: size.width,
      height: size.height,
      layoutOptions: elkNodeOptions(options.direction, pinned),
      ports: [
        ...outputs.map((port, i) => side(port, 'EAST', index.outputs[i])),
        ...inputs.map((port, i) => side(port, 'WEST', index.inputs[i])),
      ],
    }
  })

  return {
    id: 'root',
    layoutOptions: elkOptionsFor(options),
    children,
    edges: edges
      .filter((edge) => included.has(edge.source) && included.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        // Port ids, not node ids. Node-to-node edges would make `FIXED_ORDER` meaningless —
        // ELK would have no idea which socket each wire belongs to.
        sources: [elkPortId(edge.source, edge.sourceHandle)],
        targets: [elkPortId(edge.target, edge.targetHandle)],
      })),
  }
}

/** Positions out of a laid-out ELK graph, keyed by node id. */
export function positionsFrom(result: ElkNode): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 })
  }
  return positions
}

/**
 * The waypoints ELK bent an edge through, keyed by edge id. Empty entries are dropped.
 *
 * **These have always been in the result and were always discarded.** `elk.edgeRouting` is
 * never set: layered computes orthogonal bend points regardless, and the two settings that
 * would change them (`POLYLINE`, `SPLINES`) move the *nodes* as well, so they are a different
 * arrangement rather than a different drawing of one. Reading `sections` is therefore free —
 * the work was done and thrown away.
 *
 * Only the first section is read. Sections exist for hyperedges, which one source port and one
 * target port cannot produce; a `sources`/`targets` pair of length one always yields exactly
 * one. And only the bend points: the start and end are ELK's idea of where the sockets are,
 * where React Flow's are the truth. Under `FIXED_POS` the two agree, and where they do not the
 * edge component anchors on React Flow's and lets the middle be ELK's.
 *
 * An algorithm that routes nothing simply contributes nothing: `radial` returns no `sections`
 * at all, and `force`/`stress` return sections with no bend points. Both read here as "no
 * route", which is the same thing the canvas does with an edge it has never arranged.
 */
export function routesFrom(result: ElkNode): Map<string, XY[]> {
  const routes = new Map<string, XY[]>()
  for (const edge of result.edges ?? []) {
    const bends = edge.sections?.[0]?.bendPoints
    if (!bends || bends.length === 0) continue
    routes.set(
      edge.id,
      bends.map((point) => ({ x: point.x, y: point.y })),
    )
  }
  return routes
}

/**
 * The nodes and edges one arrange should touch.
 *
 * Two or more selected nodes mean "tidy these"; anything else means the whole graph. One
 * selected node is deliberately the second case — arranging a single node in place is a no-op,
 * and reading it as one would make the button appear broken for whoever had just clicked a card.
 */
export function arrangeScope(
  graph: CodaGraph,
  selection: readonly string[],
): { nodes: GraphNode[]; edges: GraphEdge[]; scoped: boolean } {
  const selected = new Set(selection)
  const inSelection = arrangeable(graph.nodes.filter((n) => selected.has(n.id)))
  if (inSelection.length >= 2) {
    const ids = new Set(inSelection.map((n) => n.id))
    return {
      nodes: inSelection,
      edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      scoped: true,
    }
  }
  const nodes = arrangeable(graph.nodes)
  const ids = new Set(nodes.map((n) => n.id))
  return {
    nodes,
    edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    scoped: false,
  }
}
