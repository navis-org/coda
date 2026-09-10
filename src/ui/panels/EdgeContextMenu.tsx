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

import type { CodaGraph } from '../../core/graph'
import { getNodeDef } from '../../core/registry'
import { useGraphStore } from '../../store/graphStore'
import { LOCKED_HINT } from '../lockCopy'
import { nodePorts } from '../../core/graph'
import { ContextMenu } from '../menu/ContextMenu'

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
  const port = node ? nodePorts(node, side).find((p) => p.id === portId) : undefined
  return {
    node: node?.title ?? def?.label ?? node?.type ?? nodeId,
    port: port?.label ?? portId,
  }
}

export function EdgeContextMenu({ screenPosition, edgeId, onClose }: EdgeContextMenuProps) {
  /*
   * Field by field rather than `useGraphStore()` whole, which re-rendered this menu on every
   * change to the store while it was open. The actions are stable, so they are read once.
   */
  const graph = useGraphStore((s) => s.graph)
  const locked = useGraphStore((s) => s.locked)
  const actions = useGraphStore.getState()
  const edge = graph.edges.find((e) => e.id === edgeId)

  if (!edge) return null

  const from = endpointLabel(graph, edge.source, edge.sourceHandle, 'output')
  const to = endpointLabel(graph, edge.target, edge.targetHandle, 'input')

  return (
    <ContextMenu at={screenPosition} onClose={onClose}>
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
          actions.deleteEdges([edgeId])
          onClose()
        }}
        // The one item this menu has, so a locked canvas leaves a menu that only names the wire.
        // That is the point: naming which wire is under the pointer is worth something on its own.
        disabled={locked}
        title={locked ? LOCKED_HINT : undefined}
      >
        Delete link <kbd>⌫</kbd>
      </button>
    </ContextMenu>
  )
}
