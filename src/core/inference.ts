/**
 * Static analysis pass: resolve the type of every port in the graph without executing
 * anything, and collect edit-time problems.
 *
 * Runs synchronously on every graph mutation, so it must stay cheap and must never
 * throw — a buggy `inferOutputs` in one node pack degrades to "unknown type" instead of
 * blanking the editor.
 */

import type { CodaGraph, GraphNode } from './graph'
import { inboundIndex, nodesById, portKey, topoSort, wouldCreateCycle } from './graph'
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
      /*
       * A reference names a node rather than consuming its output, so the source may not have
       * been ordered yet — it is excluded from `topoSort`, which is the whole point. Its type is
       * therefore computed *in isolation*: the source node's own `inferOutputs` with **no inputs
       * at all**.
       *
       * That cannot recurse, so the walk still terminates, and for a dataset it yields exactly
       * the identity — `sourceId` and `datasetId`, which come from that node's params — without
       * the annotations schema, which comes from its input. Which is the honest answer as well as
       * the terminating one: a node cannot read the annotations it is itself about to supply.
       */
      const upstream = port.reference
        ? referenceType(nodes.get(edge.source), edge.sourceHandle)
        : result[edge.source]?.outputs[edge.sourceHandle]
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
        ...validateColumnParams(def, ctx).map((message): NodeIssue => ({
          severity: 'warning',
          message,
        })),
      )
      if (def.validate) {
        issues.push(
          ...def.validate(ctx).map((message): NodeIssue => ({ severity: 'warning', message })),
        )
      }
    } catch (err) {
      issues.push({
        severity: 'warning',
        message: `Validation failed: ${(err as Error).message}`,
      })
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

/**
 * What a node publishes on a port when nothing is wired to it — the half of its output that is a
 * function of its params alone.
 *
 * Only for `reference` inputs; see `PortDef.reference`. Isolated by construction, since it is
 * handed no inputs, so it cannot reach back into the walk that called it.
 */
function referenceType(node: GraphNode | undefined, portId: string): CodaType | undefined {
  if (!node) return undefined
  const def = getNodeDef(node.type)
  if (!def) return undefined
  const declared = (def.outputs ?? []).find((p) => p.id === portId)?.type
  if (!def.inferOutputs) return declared
  try {
    return def.inferOutputs(makeInferContext(def, node.params, {}))[portId] ?? declared
  } catch {
    // `inferOutputs` must never throw (invariant 2), but a reference must not be the thing that
    // discovers it does — the declared type is a complete answer here.
    return declared
  }
}

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

  /*
   * Reachability: the target must not already reach the source. Through `wouldCreateCycle`
   * rather than a walk of its own — this was a second implementation of one question, and they
   * had to be found together the moment `reference` edges stopped counting as dependencies. One
   * of them knew and the other refused every wire the change existed to allow.
   */
  if (wouldCreateCycle(graph, from.nodeId, to.nodeId, to.portId)) {
    return { ok: false, reason: 'Would create a cycle' }
  }

  return { ok: true }
}

