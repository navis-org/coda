/**
 * Right-click menu for a link.
 *
 * The counterpart to `NodeContextMenu`, and deliberately much smaller: a wire has one thing
 * you can do to it. What it does carry is a header naming both ends, because wires overlap —
 * on a dense graph the one under the pointer is often not the one you meant, and a menu whose
 * only item is destructive should say what it is about to cut before you commit to it.
 *
 * Deletion goes through `deleteEdges`, so it is one undo step like every other graph edit.
 */

import { useRef } from 'react'

import type { CodaGraph } from '../../core/graph'
import { getNodeDef } from '../../core/registry'
import { useGraphStore } from '../../store/graphStore'
import { LOCKED_HINT } from '../lockCopy'
import { useDismissOnOutside } from '../useDismiss'

export interface EdgeContextMenuProps {
  screenPosition: { x: number; y: number }
  edgeId: string
  onClose: () => void
}

/** `Node title ▸ Port label` for one end of a link, falling back to raw ids. */
function endpointLabel(
  graph: CodaGraph,
  nodeId: string,
  portId: string,
  side: 'output' | 'input',
): { node: string; port: string } {
  const node = graph.nodes.find((n) => n.id === nodeId)
  const def = node ? getNodeDef(node.type) : undefined
  const ports = (side === 'output' ? def?.outputs : def?.inputs) ?? []
  const port = ports.find((p) => p.id === portId)
  return {
    node: node?.title ?? def?.label ?? node?.type ?? nodeId,
    port: port?.label ?? portId,
  }
}

export function EdgeContextMenu({ screenPosition, edgeId, onClose }: EdgeContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const store = useGraphStore()
  const edge = store.graph.edges.find((e) => e.id === edgeId)

  useDismissOnOutside(ref, onClose, { onEscape: true })

  if (!edge) return null

  const from = endpointLabel(store.graph, edge.source, edge.sourceHandle, 'output')
  const to = endpointLabel(store.graph, edge.target, edge.targetHandle, 'input')

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{
        left: Math.min(screenPosition.x, window.innerWidth - 210),
        top: Math.min(screenPosition.y, window.innerHeight - 110),
      }}
      role="menu"
    >
      <div className="context-menu__header">
        <div className="context-menu__endpoint">
          <span className="context-menu__endpoint-node">{from.node}</span>
          <span className="context-menu__endpoint-port">{from.port}</span>
        </div>
        <div className="context-menu__endpoint">
          <span className="context-menu__endpoint-arrow" aria-hidden="true">
            →
          </span>
          <span className="context-menu__endpoint-node">{to.node}</span>
          <span className="context-menu__endpoint-port">{to.port}</span>
        </div>
      </div>
      <div className="context-menu__sep" />
      <button
        type="button"
        className="context-menu__item context-menu__item--danger"
        onClick={() => {
          store.deleteEdges([edgeId])
          onClose()
        }}
        // The one item this menu has, so a locked canvas leaves a menu that only names the wire.
        // That is the point: naming which wire is under the pointer is worth something on its own.
        disabled={store.locked}
        title={store.locked ? LOCKED_HINT : undefined}
      >
        Delete link <kbd>⌫</kbd>
      </button>
    </div>
  )
}
