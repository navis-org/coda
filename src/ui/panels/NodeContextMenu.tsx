import { useRef } from 'react'

import { getNodeDef, isAnnotation } from '../../core/registry'
import { hasHelp } from '../../help/registry'
import { useGraphStore } from '../../store/graphStore'
import { LOCKED_HINT } from '../lockCopy'
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
  const def = getNodeDef(node.type)

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
            title="Drop the results here and downstream, so they are computed again"
            onClick={act(() => store.invalidateNode(nodeId))}
          >
            Invalidate Results
          </button>
          {/*
           * The second layer, and only on a node that has one. The title above used to say
           * "forcing a re-fetch", which was the false half: a node fetching through
           * `loadCachedTable` re-ran from IndexedDB in milliseconds with the same bytes.
           */}
          {def?.dataCache && (
            <button
              type="button"
              className="context-menu__item"
              title="Forget the data this node downloaded, so the next run fetches it again"
              onClick={act(() => store.clearNodeCache(nodeId))}
            >
              Clear Cache
            </button>
          )}
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
            title="Fold the parameter and port rows away, leaving the header, the body and the result"
            onClick={act(() => store.toggleParamRows(targets))}
          >
            {node.paramsCollapsed ? 'Show parameters & ports' : 'Hide parameters & ports'}
          </button>
        </>
      )}
      <button
        type="button"
        className="context-menu__item"
        onClick={act(() => store.duplicateSelection())}
        disabled={store.locked || store.selection.length === 0}
        title={store.locked ? LOCKED_HINT : undefined}
      >
        Duplicate <kbd>⌘D</kbd>
      </button>
      {/* Named "What this node does" rather than "Help", because a menu item called Help in an
          app with three published guides is ambiguous about which of them it opens. */}
      {def && hasHelp(def.type) && (
        <>
          <div className="context-menu__sep" />
          <button
            type="button"
            className="context-menu__item"
            onClick={act(() => store.openHelp(def.type))}
          >
            What this node does
          </button>
        </>
      )}
      <div className="context-menu__sep" />
      <button
        type="button"
        className="context-menu__item context-menu__item--danger"
        onClick={act(() => store.deleteNodes(targets))}
        disabled={store.locked}
        title={store.locked ? LOCKED_HINT : undefined}
      >
        Delete <kbd>⌫</kbd>
      </button>
    </div>
  )
}
