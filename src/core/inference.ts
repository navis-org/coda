/**
 * Static analysis pass: resolve the type of every port in the graph without executing
 * anything, and collect edit-time problems.
 *
 * Runs synchronously on every graph mutation, so it must stay cheap and must never
 * throw — a buggy `inferOutputs` in one node pack degrades to "unknown type" instead of
 * blanking the editor.
 */

import type { CodaGraph, GraphNode } from './graph'
import { inboundIndex, nodePort, nodesById, portKey, topoSort, wouldCreateCycle } from './graph'
import type { InferContext, NodeDefinition } from './node'
import { makeInferContext, validateColumnParams } from './node'
import { getNodeDef } from './registry'
import { findInputPort, inputPorts, outputPorts } from './ports'
import type { Socket } from './sockets'
import { resolvedSocket, socketAccepts, socketLabel } from './sockets'
import type { CodaType, TableSchema } from './types'
import { isAssignable, typeLabel } from './types'

export type IssueSeverity = 'error' | 'warning'

export interface NodeIssue {
  severity: IssueSeverity
  message: string
  /** Port this issue is attached to, when applicable — lets the UI mark the socket. */
  portId?: string
  /**
   * Set on the issues `validateColumnParams` raises, and on nothing else.
   *
   * A column issue is the one kind that is routinely **not** a mistake: a picker pointing at a
   * column a Pivot has not published yet, or a dataset property whose schema has not arrived,
   * reads exactly like a picker pointing at nothing. Every surface that shows issues to a person
   * shows these too — the card is where you *see* that a schema is late. The assistant is the
   * one reader that must not, because its own rules already tell the model that a column it
   * cannot know yet is fine, so raising them again in `newConcerns` contradicts the system
   * prompt with a list the model was told to ignore.
   *
   * A flag rather than a second array, so nothing that renders issues has to learn about it.
   */
  aboutColumns?: true
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

/**
 * A node's output types: the declared ones, overlaid with whatever `inferOutputs` says.
 *
 * One statement of the three rules — seed from `def.outputs`, let `inferOutputs` override, never
 * throw — because there are two callers and they had already parted company. The walk merged with
 * `if (type)` while `referenceType` used `?? declared`; identical for the object types in play
 * today, different the moment one is falsy, and nothing type-checks the pair. The walk also
 * passes `observedSchemas` where the reference path must not, which is a real difference and now
 * a visible one: it rides on the context the caller builds.
 *
 * `error` rather than a thrown one, so the walk can turn it into an issue on the node and the
 * reference path — which has no node to report against — can ignore it. `inferOutputs` must never
 * throw (invariant 2), and this is what keeps a node that does from taking the pass down.
 */
function outputTypesFor(
  def: NodeDefinition,
  ctx: InferContext,
): { outputs: Record<string, CodaType>; error?: string } {
  const outputs: Record<string, CodaType> = {}
  for (const port of outputPorts(def, ctx.params)) outputs[port.id] = port.type
  if (!def.inferOutputs) return { outputs }
  try {
    for (const [portId, type] of Object.entries(def.inferOutputs(ctx))) {
      if (type) outputs[portId] = type
    }
    return { outputs }
  } catch (err) {
    return { outputs, error: (err as Error).message }
  }
}

/**
 * What a node publishes on a port when nothing is wired to it — the half of its output that is a
 * function of its params alone.
 *
 * Only for `reference` inputs; see `PortDef.reference`. Isolated by construction, since it is
 * handed no inputs, so it cannot reach back into the walk that called it — and no `observed`
 * schema either, which would be a fact from a *run* rather than from the params.
 *
 * Through `outputTypesFor`, so "a reference is the same node inferred with no inputs" is literally
 * true rather than a second implementation that resembles it.
 */
function referenceType(node: GraphNode | undefined, portId: string): CodaType | undefined {
  if (!node) return undefined
  const def = getNodeDef(node.type)
  if (!def) return undefined
  return outputTypesFor(def, makeInferContext(def, node.params, {})).outputs[portId]
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
    for (const port of inputPorts(def, node.params)) {
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
      /*
       * **`isAssignable`, deliberately, where `checkConnection` forty lines down asks
       * `socketAccepts`** — and the asymmetry is a decision, not the last unmigrated site.
       *
       * Asking `socketAccepts` here is the obvious move: this is the only gate a wire *nobody
       * dragged* passes through, since `deserializeGraph` checks that a port exists and
       * `insertFragment` checks nothing, so a paste or a share link is not covered by the drag
       * check at all. It was built, and it is wrong twice over. **Every port that declares
       * `PortDef.kinds` took that array from a `validate` that already reports the mismatch** —
       * all seven of them — so the general check is not a backstop, it is a second sentence on
       * every card that has one. And it is the *worse* sentence: `socketLabel` can only name a
       * set that has a name, so `Select One` would gain "expects Any but receives Matrix"
       * beside its own "Select One steps through a Table, Skeletons or Meshes. A matrix has no
       * elements to step through."
       *
       * So the node keeps it. What that costs is a pasted graph carrying a wire no gesture would
       * have made: it loads, and the card that receives it says so in its own words rather than
       * in the type system's. `registerNode` has no way to require a `validate` beside a `kinds`,
       * which is the thing that would make this safe to generalise.
       */
      if (upstream && !isAssignable(upstream, port.type)) {
        issues.push({
          severity: 'error',
          message: `Input "${port.label ?? port.id}" expects ${socketLabel(port)} but receives ${typeLabel(upstream)}`,
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
    const { outputs, error } = outputTypesFor(def, ctx)
    if (error) {
      issues.push({ severity: 'warning', message: `Type inference failed: ${error}` })
    }

    // 3. Node-specific and generic param validation.
    try {
      issues.push(
        ...validateColumnParams(def, ctx).map((message): NodeIssue => ({
          severity: 'warning',
          message,
          aboutColumns: true,
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

/**
 * What is on a node's output port: the declaration and the inferred type, joined.
 *
 * The one accessor for a question five surfaces were each answering their own way, and all five
 * the same way *wrongly* — by reading `inference.nodes[id].outputs[portId]` and stopping. That
 * is a `CodaType`, and for an unwired passthrough it is a perfectly truthy `T.any()`, so the
 * declaration that says *skeletons, meshes or points* was discarded exactly where it was the
 * only thing that knew. The visible half was one bug reported as one sentence: `Mirror Neurons`'
 * output drew violet, the wire leaving it drew grey, and it could be dropped on a `Dataset`.
 *
 * Here rather than in `sockets.ts`, which holds the *rule* (`resolvedSocket`) and may not import
 * this module — `inference.ts` already imports `sockets.ts`, so the arrow runs one way.
 */
export function outputSocket(
  node: GraphNode,
  inference: InferenceResult,
  portId: string,
): Socket {
  return resolvedSocket(
    nodePort(node, 'output', portId),
    nodeTypes(inference, node.id).outputs[portId],
  )
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
  const inPort = targetDef ? findInputPort(targetDef, targetNode.params, to.portId) : undefined
  if (!inPort) return { ok: false, reason: 'Unknown input port' }

  const sourceType = nodeTypes(inference, from.nodeId).outputs[from.portId]
  if (!sourceType) return { ok: false, reason: 'Unknown output port' }

  /*
   * `socketAccepts` over the *resolved sockets*, not `isAssignable` over two types.
   *
   * `PortDef.kinds` was a declaration and not a constraint at first, on `producedBy`'s precedent
   * — offer fewer nodes, dim more sockets, and let the node's own `validate` name the remedy on
   * a wire somebody drew anyway. That was reported as a bug within the round, and rightly: the
   * socket **draws** as Geometries, and a violet ring you can drop on a `Dataset` port is a
   * promise the picture makes and the behaviour breaks. The precedent does not stretch this far
   * either — `producedBy` and `exclusiveGroup` are not *kind* facts, and refusing kind mismatches
   * with a reason is exactly this function's job. Before `kinds` existed the socket drew grey
   * `Any` and taking anything was honest; it is not honest now.
   *
   * `resolvedSocket` is what makes both ends say what they mean: an unwired passthrough infers
   * `T.any()`, so reading the inferred type alone throws away the only declaration that knows.
   * An unresolved socket is still never a refusal — `socketAccepts` passes a bare `any` on either
   * end — so a half-built graph is unaffected.
   */
  if (!socketAccepts(outputSocket(sourceNode, inference, from.portId), inPort)) {
    return {
      ok: false,
      reason: `${socketLabel(outputSocket(sourceNode, inference, from.portId))} does not fit ${socketLabel(inPort)}`,
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
