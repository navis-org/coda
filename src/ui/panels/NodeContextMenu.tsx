import { useRef } from 'react'

import { isOnDashboard, placeableIds } from '../../core/dashboard'
import { groupsTouching } from '../../core/groups'
import { getNodeDef, isAnnotation } from '../../core/registry'
import { hasHelp } from '../../help/registry'
import { useGraphStore } from '../../store/graphStore'
import { LOCKED_HINT } from '../lockCopy'
import { shortcutKeys } from '../shortcuts'
import { useDismissOnOutside } from '../useDismiss'
import { AlignTools } from './AlignTools'

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
  /** The frames this menu's cards sit in — what Ungroup would take apart. */
  const touched = groupsTouching(store.graph, targets)

  /*
   * Half this menu is about evaluation — run it, drop its cache, mute it, collapse it — and none
   * of that means anything for an annotation, which is never evaluated and draws no header to
   * un-collapse from. Duplicate and Delete are the whole menu for a text note.
   */
  const dataflow = !isAnnotation(node.type)
  const def = getNodeDef(node.type)
  /*
   * Which half of the dashboard row is live, and over what.
   *
   * `every`, not `some`: with a mixed selection the useful act is to finish putting them all on,
   * and a row that removed the two already there would be reading the selection backwards. The
   * same rule the mute and collapse rows above follow, where the *clicked* node decides the
   * wording and the whole selection is what moves.
   *
   * Over `placeable` rather than `targets`, because the two differ: `dataflow` gates this row on
   * the node that was *clicked*, so a note caught by a rubber band alongside a viewer used to
   * reach `addToDashboard` and get a cell with nothing in it. `addCells` refuses it now either
   * way — this is what stops the row counting it and promising otherwise.
   */
  const placeable = placeableIds(store.graph, targets)
  const onDashboard =
    placeable.length > 0 && placeable.every((id) => isOnDashboard(store.graph, id))

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
          {/*
           * Not disabled by the lock, unlike every structural row below. A dashboard is the
           * other *view* rather than a change to the canvas, and freezing the canvas so it can
           * be used as one is exactly the moment somebody is assembling it — see
           * `addToDashboard` in the store.
           */}
          <button
            type="button"
            className="context-menu__item"
            title={
              onDashboard
                ? 'Take it off the grid. The node stays here.'
                : 'Put it on the grid view — the nodes worth looking at, without the canvas (D)'
            }
            disabled={placeable.length === 0}
            onClick={act(() =>
              onDashboard
                ? store.removeFromDashboard(placeable)
                : store.addToDashboard(placeable),
            )}
          >
            {onDashboard ? 'Remove from Dashboard' : 'Add to Dashboard'}
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
        Duplicate <kbd>{shortcutKeys('duplicate')}</kbd>
      </button>
      {/*
       * Grouping acts on `targets` for the reason mute and delete do — a right-click on an
       * unselected card is about that card, and on a selected one about the whole selection.
       * The frame that results is decoration, so this row sits with Duplicate rather than with
       * the run half of the menu, and it is refused by the lock like every other structural edit.
       */}
      <button
        type="button"
        className="context-menu__item"
        onClick={act(() => {
          store.setSelection(targets)
          store.groupSelection()
        })}
        disabled={store.locked}
        title={
          store.locked
            ? LOCKED_HINT
            : 'Draw one frame around these cards; dragging it moves all of them'
        }
      >
        Group Selection <kbd>{shortcutKeys('group')}</kbd>
      </button>
      {touched.length > 0 && (
        <button
          type="button"
          className="context-menu__item"
          onClick={act(() => store.ungroup(touched.map((g) => g.id)))}
          disabled={store.locked}
          title={store.locked ? LOCKED_HINT : 'The frame goes; the cards stay where they are'}
        >
          {touched.length > 1 ? `Ungroup ${touched.length} groups` : 'Ungroup'}{' '}
          <kbd>{shortcutKeys('ungroup')}</kbd>
        </button>
      )}
      <div className="context-menu__sep" />
      {/*
       * The alignment grid acts on `targets` like the rows above it — so a right-click on one
       * card of a selected row aligns the row, and a right-click on an unselected card offers
       * the tools greyed with the reason, which is where somebody finds out they exist.
       */}
      <div className="context-menu__caption">Align &amp; distribute</div>
      <AlignTools ids={targets} />

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
