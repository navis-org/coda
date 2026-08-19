import { useRef } from 'react'

import { isAnnotation } from '../../core/registry'
import { useGraphStore } from '../../store/graphStore'
import { useDismissOnOutside } from '../useDismiss'

export interface NodeContextMenuProps {
  screenPosition: { x: number; y: number }
  nodeId: string
  onClose: () => void
}

export function NodeContextMenu({ screenPosition, nodeId, onClose }: NodeContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const store = useGraphStore()
  const node = store.graph.nodes.find((n) => n.id === nodeId)

  useDismissOnOutside(ref, onClose, { onEscape: true })

  if (!node) return null

  // The selection is what bulk actions apply to; a right-click on an unselected node
  // acts on that node alone.
  const targets = store.selection.includes(nodeId) ? store.selection : [nodeId]

  /*
   * Half this menu is about evaluation — run it, drop its cache, mute it, collapse it — and none
   * of that means anything for an annotation, which is never evaluated and draws no header to
   * un-collapse from. Duplicate and Delete are the whole menu for a text note.
   */
  const dataflow = !isAnnotation(node.type)

  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{
        left: Math.min(screenPosition.x, window.innerWidth - 190),
        top: Math.min(screenPosition.y, window.innerHeight - 230),
      }}
      role="menu"
    >
      {dataflow && (
        <>
          <button
            type="button"
            className="context-menu__item"
            onClick={act(() => void store.runNode(nodeId))}
          >
            Run this node <kbd>⏎</kbd>
          </button>
          <button
            type="button"
            className="context-menu__item"
            title="Drop cached results here and downstream, forcing a re-fetch"
            onClick={act(() => store.invalidateNode(nodeId))}
          >
            Invalidate cache
          </button>
          <div className="context-menu__sep" />
          <button
            type="button"
            className="context-menu__item"
            onClick={act(() => store.toggleDisabled(targets))}
          >
            {node.disabled ? 'Unmute' : 'Mute'} <kbd>M</kbd>
          </button>
          <button
            type="button"
            className="context-menu__item"
            onClick={act(() => store.toggleCollapsed(targets))}
          >
            {node.collapsed ? 'Expand' : 'Collapse'} <kbd>H</kbd>
          </button>
          <button
            type="button"
            className="context-menu__item"
            title="Fold the parameter rows away, leaving the ports, the result and the header"
            onClick={act(() => store.toggleParamRows(targets))}
          >
            {node.paramsCollapsed ? 'Show parameters' : 'Hide parameters'}
          </button>
        </>
      )}
      <button
        type="button"
        className="context-menu__item"
        onClick={act(() => store.duplicateSelection())}
        disabled={store.selection.length === 0}
      >
        Duplicate <kbd>⌘D</kbd>
      </button>
      <div className="context-menu__sep" />
      <button
        type="button"
        className="context-menu__item context-menu__item--danger"
        onClick={act(() => store.deleteNodes(targets))}
      >
        Delete <kbd>⌫</kbd>
      </button>
    </div>
  )
}
