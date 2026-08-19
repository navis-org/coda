/**
 * Auto-wiring a new node's Dataset socket.
 *
 * Nearly every query node opens with the same question — which connectome? — and on a canvas
 * carrying one dataset node there is only ever one answer. Dragging that wire by hand is a
 * gesture with no decision in it, repeated for every node added to the graph.
 *
 * Deliberately narrow, and each of the limits is the design rather than an unfinished edge:
 *
 *  - **`dataset` sockets only.** A dataset handle is a fact about the *workspace* — this graph
 *    is about hemibrain — and not a step in a pipeline. Tables are the opposite: a canvas with
 *    one table on it is a canvas half built, so guessing there would wire a new node to whatever
 *    happened to be lying nearest, which is worse than an empty socket precisely because it
 *    looks deliberate.
 *
 *  - **One producer, or nothing at all.** Two dataset nodes is a real question and the editor
 *    has no way to answer it; a coin toss between two connectomes is the one wrong answer that
 *    nothing on screen would explain.
 *
 *  - **Counted over *nodes*, never over resolved dataset ids.** Reading two dataset nodes that
 *    both resolve to `hemibrain:v1.2.1` as "one dataset" is tempting and unsafe: a node left on
 *    `Latest` publishes *no* dataset id until the listing lands (see the `reportSourceLearned`
 *    invariant), so on a fresh tab two nodes pointing at different connectomes are
 *    indistinguishable — and that is exactly the moment the wrong guess would be made.
 *
 *  - **On add, never on load or on a later edit.** Same rule and same reason as
 *    `companion.ts`: a saved graph must reproduce itself exactly, and a socket somebody
 *    deliberately unplugged must stay unplugged. Nothing here repairs a graph.
 *
 * The caller's contract is that `node` has just been added, i.e. has no outgoing edges — which
 * is what makes a cycle check unnecessary here. Validity is otherwise the caller's business,
 * the same standing `reconnectEdge` has.
 */

import type { CodaGraph, GraphNode } from './graph'
import { addEdge, edgeInto } from './graph'
import { getNodeDef } from './registry'

/** The output port publishing a Dataset, if this node has one. */
function datasetOutput(node: GraphNode): string | undefined {
  const outputs = getNodeDef(node.type)?.outputs ?? []
  return outputs.find((port) => port.type.kind === 'dataset')?.id
}

/**
 * Wire `node`'s unconnected Dataset inputs to the graph's single dataset node.
 *
 * Returns the graph untouched when the node has no such input, when one is already fed, or
 * when the number of dataset nodes is anything but one — so every caller can route through
 * here unconditionally.
 */
export function autoWireDataset(graph: CodaGraph, node: GraphNode): CodaGraph {
  const open = (getNodeDef(node.type)?.inputs ?? []).filter(
    (port) => port.type.kind === 'dataset' && !edgeInto(graph, node.id, port.id),
  )
  if (open.length === 0) return graph

  let found: { nodeId: string; portId: string } | undefined
  for (const candidate of graph.nodes) {
    if (candidate.id === node.id) continue
    const portId = datasetOutput(candidate)
    if (!portId) continue
    // A second one makes the question ambiguous, and an ambiguous question goes unanswered.
    if (found) return graph
    found = { nodeId: candidate.id, portId }
  }
  if (!found) return graph

  const from = found
  return open.reduce(
    (g, port) =>
      addEdge(g, {
        source: from.nodeId,
        sourceHandle: from.portId,
        target: node.id,
        targetHandle: port.id,
      }),
    graph,
  )
}
