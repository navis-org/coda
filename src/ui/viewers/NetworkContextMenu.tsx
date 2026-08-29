/**
 * Right-click menu for the network viewer.
 *
 * Wears `NodeContextMenu`'s clothes — `.context-menu` and its rows — because a right-click
 * should not look like a different kind of thing depending on which canvas it landed on. It
 * shares that menu's rule about what a command applies to, too: a right-click *inside* the
 * selection acts on the whole selection, one outside it acts on that mark alone. `seedsFor` is
 * the one implementation, and the drag reads it as well.
 *
 * Deliberately dumb: it is handed the anchors and a caption, and reports which command was
 * pressed. Everything that decides *which nodes* is in `networkSelect.ts`, where a test can
 * reach it — the same split the rest of this viewer is built on.
 *
 * `position: fixed`, in screen coordinates, unlike the tooltip beside it. A tooltip belongs to
 * a mark and has to flip inside the viewer's `overflow: hidden` box; a menu belongs to the
 * pointer and would be clipped by that box on its way to being useful.
 */

import { useRef } from 'react'

import { useDismissOnOutside } from '../useDismiss'
import type { SelectScope } from './networkSelect'

/** Rough menu box, for keeping it on screen. Mirrors `.context-menu`'s min-width. */
const MENU_WIDTH = 190
const MENU_HEIGHT = 250

export interface NetworkContextMenuProps {
  /** Where the pointer was, in client coordinates. */
  at: { x: number; y: number }
  /**
   * What the commands act on. Empty means the click landed on empty canvas, which has nothing
   * to expand from — so that menu offers the whole-graph verbs instead.
   */
  seeds: string[]
  /** What was right-clicked, said in words: a node's label, a link, or "N nodes". */
  caption: string
  /** Undirected networks get no upstream/downstream, because the walk would ignore them. */
  directed: boolean
  /** Drives the Clear row, which is worth nothing when nothing is selected. */
  selected: number
  /** Nodes in the whole network, for the Select-all row's count. */
  total: number
  onExpand: (scope: SelectScope) => void
  onSelectAll: () => void
  onClear: () => void
  /** Ids to the clipboard: the anchors, or the whole graph from the canvas menu. */
  onCopy: () => void
  onFit: () => void
  onClose: () => void
}

export function NetworkContextMenu({
  at,
  seeds,
  caption,
  directed,
  selected,
  total,
  onExpand,
  onSelectAll,
  onClear,
  onCopy,
  onFit,
  onClose,
}: NetworkContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useDismissOnOutside(ref, onClose, { onEscape: true })

  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }
  const anchored = seeds.length > 0

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{
        left: Math.min(at.x, window.innerWidth - MENU_WIDTH),
        top: Math.min(at.y, window.innerHeight - MENU_HEIGHT),
      }}
      role="menu"
    >
      <div className="context-menu__caption">{caption}</div>
      {anchored && (
        <>
          <button
            type="button"
            className="context-menu__item"
            title="Everything one link away, either direction. Run it again to reach one hop further."
            onClick={act(() => onExpand('connected'))}
          >
            Select connected
          </button>
          {/*
           * Only on a directed network. `expandSelection` ignores direction on an undirected
           * one — `source` and `target` are an arbitrary order there — so offering these would
           * be three rows that do the same thing.
           */}
          {directed && (
            <>
              <button
                type="button"
                className="context-menu__item"
                title="Follow links forwards: the targets of these nodes"
                onClick={act(() => onExpand('downstream'))}
              >
                Select downstream
              </button>
              <button
                type="button"
                className="context-menu__item"
                title="Follow links backwards: the sources of these nodes"
                onClick={act(() => onExpand('upstream'))}
              >
                Select upstream
              </button>
            </>
          )}
          <button
            type="button"
            className="context-menu__item"
            title="Everything reachable along links, ignoring their direction"
            onClick={act(() => onExpand('component'))}
          >
            Select connected component
          </button>
          <div className="context-menu__sep" />
        </>
      )}
      {!anchored && (
        <button type="button" className="context-menu__item" onClick={act(onSelectAll)}>
          Select all <kbd>{total.toLocaleString()}</kbd>
        </button>
      )}
      <button
        type="button"
        className="context-menu__item"
        onClick={act(onClear)}
        disabled={selected === 0}
        title={selected === 0 ? 'Nothing is selected' : undefined}
      >
        Clear selection <kbd>{selected > 0 ? selected.toLocaleString() : ''}</kbd>
      </button>
      <div className="context-menu__sep" />
      <button
        type="button"
        className="context-menu__item"
        title="The node ids themselves, one per line — what a segmentation viewer or a query wants"
        onClick={act(onCopy)}
      >
        {anchored ? `Copy ${seeds.length > 1 ? `${seeds.length} ids` : 'id'}` : 'Copy all ids'}
      </button>
      {!anchored && (
        <button type="button" className="context-menu__item" onClick={act(onFit)}>
          Fit to view
        </button>
      )}
    </div>
  )
}
