/**
 * Static analysis pass: resolve the type of every port in the graph without executing
 * anything, and collect edit-time problems.
 *
 * Runs synchronously on every graph mutation, so it must stay cheap and must never
 * throw — a buggy `inferOutputs` in one node pack degrades to "unknown type" instead of
 * blanking the editor.
 */

import type { CodaGraph } from './graph'
import { inboundIndex, nodesById, portKey, topoSort } from './graph'
import { makeInferContext, validateColumnParams } from './node'
import { getNodeDef } from './registry'
import type { CodaType, TableSchema } from './types'
import { isAssignable, typeLabel } from './types'

export type IssueSeverity = 'error' | 'warning'

export interface NodeIssue {
  severity: IssueSeverity
  message: string
  /** Port this issue is attached to, when applicable — lets the UI mark the socket. */
  portId?: string
}

export interface NodeTypes {
  /** Resolved type per input port; undefined when unconnected. */
  inputs: Record<string, CodaType | undefined>
  /** Resolved type per output port. Always populated (falls back to declared type). */
  outputs: Record<string, CodaType>
  issues: NodeIssue[]
}

export interface InferenceResult {
  nodes: Record<string, NodeTypes>
  /** Nodes that sit on or downstream of a cycle. */
  cyclic: string[]
  /** True when every node is free of `error`-severity issues and no cycles exist. */
  ok: boolean
}

const EMPTY: NodeTypes = { inputs: {}, outputs: {}, issues: [] }

export interface InferOptions {
  /**
   * Table schema each node's last run actually produced, by node id.
   *
   * Runtime state, deliberately not part of the graph: it exists so a node whose shape the
   * backend decides (Raw Cypher) can populate downstream column pickers once it has run.
   * Empty before the first run and after a reload, which is the same lifetime as the
   * results themselves.
   */
  observedSchemas?: Readonly<Record<string, TableSchema | undefined>>
}

export function inferGraph(graph: CodaGraph, options: InferOptions = {}): InferenceResult {
  const { order, cyclic } = topoSort(graph)
  const nodes = nodesById(graph)
  const inbound = inboundIndex(graph)
  const result: Record<string, NodeTypes> = {}

  for (const nodeId of order) {
    const node = nodes.get(nodeId)!
    const def = getNodeDef(node.type)
    if (!def) {
      result[nodeId] = {
        inputs: {},
        outputs: {},
        issues: [{ severity: 'error', message: `Unknown node type "${node.type}"` }],
      }
      continue
    }

    const issues: NodeIssue[] = []

    // 1. Resolve input types from upstream outputs.
    const inputs: Record<string, CodaType | undefined> = {}
    for (const port of def.inputs ?? []) {
      const edge = inbound.get(portKey(nodeId, port.id))
      if (!edge) {
        inputs[port.id] = undefined
        if (port.required !== false) {
          issues.push({
            severity: 'error',
            message: `Input "${port.label ?? port.id}" is not connected`,
            portId: port.id,
          })
        }
        continue
      }
      const upstream = result[edge.source]?.outputs[edge.sourceHandle]
      inputs[port.id] = upstream
      if (upstream && !isAssignable(upstream, port.type)) {
        issues.push({
          severity: 'error',
          message: `Input "${port.label ?? port.id}" expects ${typeLabel(port.type)} but receives ${typeLabel(upstream)}`,
          portId: port.id,
        })
      }
    }

    // 2. Ask the node for its output types.
    const ctx = makeInferContext(
      def,
      node.params,
      inputs,
      def.observesOutputSchema ? options.observedSchemas?.[nodeId] : undefined,
    )
    const outputs: Record<string, CodaType> = {}
    for (const port of def.outputs ?? []) outputs[port.id] = port.type

    if (def.inferOutputs) {
      try {
        const inferred = def.inferOutputs(ctx)
        for (const [portId, type] of Object.entries(inferred)) {
          if (type) outputs[portId] = type
        }
      } catch (err) {
        issues.push({
          severity: 'warning',
          message: `Type inference failed: ${(err as Error).message}`,
        })
      }
    }

    // 3. Node-specific and generic param validation.
    try {
      issues.push(
        ...validateColumnParams(def, ctx).map(
          (message): NodeIssue => ({ severity: 'warning', message }),
        ),
      )
      if (def.validate) {
        issues.push(
          ...def.validate(ctx).map((message): NodeIssue => ({ severity: 'warning', message })),
        )
      }
    } catch (err) {
      issues.push({ severity: 'warning', message: `Validation failed: ${(err as Error).message}` })
    }

    result[nodeId] = { inputs, outputs, issues }
  }

  for (const nodeId of cyclic) {
    result[nodeId] = {
      inputs: {},
      outputs: {},
      issues: [{ severity: 'error', message: 'Node is part of a cycle' }],
    }
  }

  const ok =
    cyclic.length === 0 &&
    Object.values(result).every((n) => !n.issues.some((i) => i.severity === 'error'))

  return { nodes: result, cyclic, ok }
}

export function nodeTypes(inference: InferenceResult, nodeId: string): NodeTypes {
  return inference.nodes[nodeId] ?? EMPTY
}

/** Does this node have a blocking problem? Used to skip execution. */
export function hasErrors(inference: InferenceResult, nodeId: string): boolean {
  return nodeTypes(inference, nodeId).issues.some((i) => i.severity === 'error')
}

// ---------------------------------------------------------------------------
// Connection validation (drag-time)
// ---------------------------------------------------------------------------

export interface ConnectionCheck {
  ok: boolean
  reason?: string
}

/**
 * Can this link be made? Called continuously while dragging an edge, so it leans on the
 * already-computed inference result rather than re-deriving types.
 */
export function checkConnection(
  graph: CodaGraph,
  inference: InferenceResult,
  from: { nodeId: string; portId: string },
  to: { nodeId: string; portId: string },
): ConnectionCheck {
  if (from.nodeId === to.nodeId) return { ok: false, reason: 'Cannot connect a node to itself' }

  const sourceNode = graph.nodes.find((n) => n.id === from.nodeId)
  const targetNode = graph.nodes.find((n) => n.id === to.nodeId)
  if (!sourceNode || !targetNode) return { ok: false, reason: 'Missing node' }

  const targetDef = getNodeDef(targetNode.type)
  const inPort = (targetDef?.inputs ?? []).find((p) => p.id === to.portId)
  if (!inPort) return { ok: false, reason: 'Unknown input port' }

  const sourceType = nodeTypes(inference, from.nodeId).outputs[from.portId]
  if (!sourceType) return { ok: false, reason: 'Unknown output port' }

  if (!isAssignable(sourceType, inPort.type)) {
    return {
      ok: false,
      reason: `${typeLabel(sourceType)} does not fit ${typeLabel(inPort.type)}`,
    }
  }

  // Reachability check: target must not already reach source.
  if (createsCycle(graph, from.nodeId, to.nodeId)) {
    return { ok: false, reason: 'Would create a cycle' }
  }

  return { ok: true }
}

function createsCycle(graph: CodaGraph, source: string, target: string): boolean {
  const seen = new Set<string>()
  const stack = [target]
  while (stack.length) {
    const id = stack.pop()!
    if (id === source) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of graph.edges) if (e.source === id) stack.push(e.target)
  }
  return false
}

