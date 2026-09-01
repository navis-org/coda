/**
 * Turning a list of nodes and wires into a graph — the part every hand-built graph does the same
 * way.
 *
 * Two builders exist: `starters.ts`, which opens a dataset for browsing, and `wizard/build.ts`,
 * which assembles a pipeline from four answers. Each had written these five statements itself —
 * `emptyGraph`, the `meta` spread, an `addNodeWithCompanion` loop, an `addEdge` loop — plus its
 * own `Link` tuple and its own "a node is `defaultParams` plus overrides" helper. Same reason
 * `notes.ts` exists next door: two graph builders, one way of doing the thing.
 *
 * What each keeps is its own *layout*, which is where they genuinely differ — a starter places
 * three fixed columns for a 520px Explore card, the wizard walks a grid and stacks notes.
 */

import type { CodaGraph, GraphNode } from '../core/graph'
import { addEdge, emptyGraph } from '../core/graph'
import { addNodeWithCompanion } from '../core/companion'
import type { ParamValues } from '../core/node'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'

/** One wire: source node, its port, target node, its port. */
export type Link = [from: string, fromPort: string, to: string, toPort: string]

/** A node at an absolute position, its params being the definition's own plus any overrides. */
export function graphNode(
  id: string,
  type: string,
  position: { x: number; y: number },
  params?: Record<string, unknown>,
  size?: { width: number; height: number },
): GraphNode {
  const def = requireNodeDef(type)
  return {
    id,
    type,
    position,
    params: { ...defaultParams(def), ...params } as ParamValues,
    ...(size ? { size } : {}),
  }
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
  links: readonly Link[],
): CodaGraph {
  let graph = emptyGraph(name)
  graph = { ...graph, meta: { ...graph.meta, name, description } }
  for (const spec of nodes) graph = addNodeWithCompanion(graph, spec)
  for (const [source, sourceHandle, target, targetHandle] of links) {
    graph = addEdge(graph, { source, sourceHandle, target, targetHandle })
  }
  return graph
}
