/**
 * Turning a list of nodes and wires into a graph — the part every built graph does the same way.
 *
 * Its own module because `build.ts` and the node guide's demo builder (`demo.ts`) both read
 * `graphNode`. Placement is `layout/columns.ts`'.
 */

import type { CodaGraph, GraphNode, Wire } from '../core/graph'
import { addEdge, emptyGraph } from '../core/graph'
import { addNodeWithCompanion } from '../core/companion'
import type { ParamValues } from '../core/node'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'

/** A node at an absolute position, its params being the definition's own plus any overrides. */
export function graphNode(
  id: string,
  type: string,
  position: { x: number; y: number },
  params?: Record<string, unknown>,
): GraphNode {
  const def = requireNodeDef(type)
  return { id, type, position, params: { ...defaultParams(def), ...params } as ParamValues }
}

/**
 * Nodes and wires into a graph.
 *
 * Every node goes in through `addNodeWithCompanion`, so a dataset node here opens with its
 * Description card exactly as it does when somebody adds one by hand. A starter is the first
 * graph most people see and a generated workflow is the second, which makes both of them the
 * least defensible place to leave the credit out.
 */
export function assembleGraph(
  name: string,
  description: string,
  nodes: readonly GraphNode[],
  links: readonly Wire[],
): CodaGraph {
  let graph = emptyGraph(name)
  graph = { ...graph, meta: { ...graph.meta, name, description } }
  for (const spec of nodes) graph = addNodeWithCompanion(graph, spec)
  for (const [source, sourceHandle, target, targetHandle] of links) {
    graph = addEdge(graph, { source, sourceHandle, target, targetHandle })
  }
  return graph
}
