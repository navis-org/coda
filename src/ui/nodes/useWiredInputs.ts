/**
 * Which of a node's input ports carry a wire — for `ParamBase.whenWired`, the one reader.
 *
 * Selects the graph's edge list, which keeps its identity through every write that moves or
 * edits a node, so the set is rebuilt only when an edge changes — not on each drag frame or run
 * tick (invariant 7's point, without the walk per write). And only for a definition that declares
 * `whenWired` at all — a scan of a few params per render — where every other card holds the shared
 * empty set, which draws every param.
 */

import { useMemo } from 'react'

import type { NodeDefinition } from '../../core/node'
import { useGraphStore } from '../../store/graphStore'

const NONE: ReadonlySet<string> = new Set()

export function useWiredInputs(
  nodeId: string,
  def: NodeDefinition | undefined,
): ReadonlySet<string> {
  const asks = (def?.params ?? []).some((param) => param.whenWired !== undefined)
  const edges = useGraphStore((s) => (asks ? s.graph.edges : undefined))
  return useMemo(() => {
    if (!edges) return NONE
    const wired = new Set<string>()
    for (const edge of edges) if (edge.target === nodeId) wired.add(edge.targetHandle)
    return wired
  }, [edges, nodeId])
}
