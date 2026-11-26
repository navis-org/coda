/**
 * Params a run keeps a record in (`ParamBase.runRecord`): what the ⟳ empties.
 *
 * The writing is the scheduler's (`EvalContext.record`, `SchedulerHost.onRecord`) and the store's;
 * this is the other half, headless so a test can hold it — the ⟳ means "decide afresh", so it
 * empties what the node's runs have recorded, and touches nothing else.
 */

import type { CodaGraph } from './graph'
import { setNodeParam } from './graph'
import { getNodeDef } from './registry'

/** `graph` with the node's run records emptied — or `graph` itself where they already are. */
export function emptyRecords(graph: CodaGraph, nodeId: string): CodaGraph {
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) return graph
  let out = graph
  for (const param of getNodeDef(node.type)?.params ?? []) {
    const held = node.params[param.id]
    if (param.runRecord && held !== undefined && held !== '') {
      out = setNodeParam(out, nodeId, param.id, '')
    }
  }
  return out
}
