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
import type { LayoutOptions } from './options'
import { elkNodeOptions, elkOptionsFor } from './options'

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

/** `--node-width` in `theme.css`, and a height that fits a header and two port rows. */
export const FALLBACK_NODE_SIZE: NodeSize = { width: 232, height: 120 }

export function resolveSize(node: GraphNode, measured?: MeasuredSizes): NodeSize {
  const seen = measured?.get(node.id)
  if (seen && seen.width > 0 && seen.height > 0) return seen
  return node.size ?? getNodeDef(node.type)?.defaultSize ?? FALLBACK_NODE_SIZE
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
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  options: LayoutOptions,
  measured?: MeasuredSizes,
): ElkNode {
  const included = new Set(nodes.map((n) => n.id))
  const nodeOptions = elkNodeOptions(options.direction)

  const children: ElkNode[] = nodes.map((node) => {
    const def = getNodeDef(node.type)
    const inputs = def?.inputs ?? []
    const outputs = def?.outputs ?? []
    const index = portIndices(inputs.length, outputs.length)
    const size = resolveSize(node, measured)

    return {
      id: node.id,
      width: size.width,
      height: size.height,
      layoutOptions: nodeOptions,
      ports: [
        ...outputs.map((port, i) => ({
          id: elkPortId(node.id, port.id),
          layoutOptions: {
            'elk.port.side': 'EAST',
            'elk.port.index': String(index.outputs[i]),
          },
        })),
        ...inputs.map((port, i) => ({
          id: elkPortId(node.id, port.id),
          layoutOptions: {
            'elk.port.side': 'WEST',
            'elk.port.index': String(index.inputs[i]),
          },
        })),
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
