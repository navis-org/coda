/**
 * Dropping an unconnected node onto a wire to insert it there.
 *
 * `A → B` with a Filter dropped on it becomes `A → Filter → B`. The gesture is worth having
 * because it is how somebody *thinks* about adding a step: the pipeline is on screen, the new
 * step goes in the middle of it, and the alternative is deleting a link, dragging two, and
 * remembering which ports.
 *
 * Headless, and separate from the hit test that finds the wire — that half needs the DOM and
 * cannot be tested here, where this half is all of the decisions and none of the geometry.
 *
 * **Only an isolated node splices.** Not a rule about tidiness: a node already wired is one
 * somebody is *rearranging*, and a drag across a busy canvas passes over many wires — so any
 * drop that happened to land on one would silently rewire a graph nobody asked to rewire. A node
 * with no links has nothing to lose and is almost always one just added.
 */

import type { CodaGraph, GraphEdge } from './graph'
import { addEdge, removeEdges } from './graph'
import type { InferenceResult } from './inference'
import { checkConnection, inferGraph } from './inference'
import { getNodeDef, isAnnotation } from './registry'

export interface SplicePorts {
  /** Port on the dragged node the upstream link lands on. */
  inPort: string
  /** Port on the dragged node the downstream link leaves from. */
  outPort: string
}

/**
 * Which pair of ports would let this node sit on this edge, or undefined if none would.
 *
 * **The second half is checked against a graph with the first half already in it**, which is the
 * only reason this works on the wiring people actually try. A node's output type routinely
 * depends on its input: `core.filter` isolated publishes `T.table()` and only becomes `neurons`
 * once something neurons-shaped is wired to it — so checking both links against the *current*
 * inference would refuse a Filter dropped on `Find Neurons → Skeletons`, which is the obvious
 * case and works perfectly once connected.
 *
 * One re-inference, not one per candidate pair: the first compatible input is taken and the
 * outputs are then judged against it. A node whose second input would have worked where its
 * first did not is missed, which is the same "first compatible" simplification the palette's
 * link-drag already makes, and no node in the registry is shaped that way today.
 */
export function spliceCandidate(
  graph: CodaGraph,
  inference: InferenceResult,
  nodeId: string,
  edge: GraphEdge,
): SplicePorts | undefined {
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node || isAnnotation(node.type)) return undefined
  // Isolated, per the note above. Also excludes the edge's own endpoints for free.
  if (graph.edges.some((e) => e.source === nodeId || e.target === nodeId)) return undefined

  const def = getNodeDef(node.type)
  if (!def) return undefined
  const inputs = def.inputs ?? []
  const outputs = def.outputs ?? []
  if (inputs.length === 0 || outputs.length === 0) return undefined

  for (const input of inputs) {
    const upstream = checkConnection(
      graph,
      inference,
      { nodeId: edge.source, portId: edge.sourceHandle },
      { nodeId: nodeId, portId: input.id },
    )
    if (!upstream.ok) continue

    // With the upstream link in place, so the node publishes what it will actually publish.
    const withUpstream = addEdge(graph, {
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: nodeId,
      targetHandle: input.id,
    })
    const inferred = inferGraph(withUpstream)

    for (const output of outputs) {
      const downstream = checkConnection(
        withUpstream,
        inferred,
        { nodeId: nodeId, portId: output.id },
        { nodeId: edge.target, portId: edge.targetHandle },
      )
      if (downstream.ok) return { inPort: input.id, outPort: output.id }
    }
    return undefined
  }
  return undefined
}

/**
 * The graph with the node spliced onto the edge.
 *
 * The original link is removed **explicitly**, though `addEdge` would in fact evict it on its
 * own: the downstream link targets the same `(node, port)`, which is exactly what its eviction
 * rule matches on. Leaving it to that would be correct by coincidence — it holds only while both
 * links land on the same input, which is true of a splice today and is not a property of
 * anything. Checked by mutation: swapping the order changes nothing, which is why this says so
 * rather than claiming an ordering that matters.
 */
export function spliceGraph(
  graph: CodaGraph,
  nodeId: string,
  edge: GraphEdge,
  ports: SplicePorts,
): CodaGraph {
  let next = removeEdges(graph, [edge.id])
  next = addEdge(next, {
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: nodeId,
    targetHandle: ports.inPort,
  })
  return addEdge(next, {
    source: nodeId,
    sourceHandle: ports.outPort,
    target: edge.target,
    targetHandle: edge.targetHandle,
  })
}
