/**
 * Graph-building helpers shared by the test suites.
 *
 * `node` was written out byte for byte in forty-five test files before it lived here.
 */

import type { CodaGraph, GraphNode } from '../core/graph'
import { emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'

/**
 * A graph with a name and one real node — so it is not the blank, untouched canvas `openDocument`
 * reuses rather than minting a document beside it.
 */
export function namedGraph(name: string): CodaGraph {
  const graph = emptyGraph(name)
  graph.nodes.push({ id: `n_${name}`, type: 'out.table', position: { x: 0, y: 0 }, params: {} })
  return graph
}

/**
 * A node of `type` at the origin, its params the definition's defaults with `params` over them.
 *
 * The type must already be registered: import `../nodes`, or the one node module, first.
 */
export function node(
  id: string,
  type: string,
  params: Record<string, unknown> = {},
): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}
