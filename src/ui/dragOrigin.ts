/**
 * Which port a connection drag started on, and what that port's type is.
 *
 * Two surfaces ask both questions and each had its own copy of both answers: the canvas, to
 * colour the wire in flight, and every card, to dim the sockets that cannot accept it. Two
 * copies of "where did this drag start" is how the line arriving at a socket comes to disagree
 * with the socket about what is being dragged — which is the same class of drift that put a
 * green wire on a grey socket one file over.
 *
 * Its own module rather than `socketStyle.ts`, which is imported by the node guide's SSR build
 * and by the help figures: those have no React and no React Flow, and a hook here would pull
 * both into their bundles.
 */

import { useStore } from '@xyflow/react'
import { useMemo } from 'react'

import type { CodaGraph } from '../core/graph'
import { nodePorts } from '../core/graph'
import type { InferenceResult } from '../core/inference'
import type { CodaType } from '../core/types'

export interface DragOrigin {
  nodeId: string
  portId: string | null
  handleType: 'source' | 'target'
}

/**
 * The handle a drag started on, or `undefined` when nothing is being dragged.
 *
 * Three primitive selectors rather than one object, for invariant 7's reason and React Flow's:
 * `useStore` compares snapshots with `Object.is`, so a selector minting `{nodeId, portId}` would
 * loop. React Flow does replace `state.connection` on every pointer move — but these three are
 * read off `fromHandle`, which names the handle the gesture *began* on and is carried through
 * unchanged, so a subscriber re-renders once at the start of a drag and once at the end.
 */
export function useDragOrigin(): DragOrigin | undefined {
  const nodeId = useStore((s) =>
    s.connection.inProgress ? (s.connection.fromHandle?.nodeId ?? null) : null,
  )
  const portId = useStore((s) =>
    s.connection.inProgress ? (s.connection.fromHandle?.id ?? null) : null,
  )
  const handleType = useStore((s) =>
    s.connection.inProgress ? (s.connection.fromHandle?.type ?? null) : null,
  )
  return useMemo(
    () => (nodeId && handleType ? { nodeId, portId, handleType } : undefined),
    [nodeId, portId, handleType],
  )
}

/**
 * What a drag from that port carries — the inferred type on an output, the declared type on an
 * input.
 *
 * The asymmetry is the rule rather than a shortcut, and it is why this is not the same question
 * the socket's own fill answers. An input has no inferred type until something is wired to it,
 * and what a drag *from* an input is looking for is an output that port would accept: a wired
 * `any` input reporting `skeletons` here would grey out every output it can still legally take.
 * The card's fill asks the other question — what is flowing — and says so where it does.
 */
export function dragPortType(
  graph: CodaGraph,
  inference: InferenceResult,
  origin: DragOrigin,
): CodaType | undefined {
  const { nodeId, portId, handleType } = origin
  if (!portId) return undefined
  if (handleType === 'source') {
    const resolved = inference.nodes[nodeId]?.outputs[portId]
    if (resolved) return resolved
  }
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) return undefined
  const side = handleType === 'source' ? 'output' : 'input'
  return nodePorts(node, side).find((p) => p.id === portId)?.type
}
