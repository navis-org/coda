/**
 * A viewer pinned down the right-hand side of the canvas.
 *
 * The overlay's non-modal twin, and the difference is the whole feature: an expanded viewer is
 * something you *look at* and dismiss, so it takes the screen and blocks the graph; a pinned one
 * is something you work beside. Pin a Neuroglancer node and the scene stays up, live, while the
 * wires feeding it are rewired one at a time in the half of the window it left you.
 *
 * **It is a grid column, not a floating panel.** `.app` already laid the shell out as
 * `'canvas inspector'`; the dock is a third area between them, so the canvas is genuinely
 * narrower rather than partly covered — React Flow re-measures, the minimap stays in its corner,
 * and nothing has to be pushed out of the way. The width lives on `.app` as `--dock-width`
 * because that is where the column is declared; see `App.tsx`.
 *
 * **The card behind it stands down.** `showPreview` in `CodaNodeView` already refused to draw a
 * preview for the node the overlay owns — three WebGL contexts and 3 × 170 kB measured for one
 * 21-neuron scene — and the dock is a third mount site for the same node, so it joins that test.
 * That is also why the store refuses to hold one node in both at once. Two *different* nodes it
 * allows: a glance at a table has no business costing somebody the scene they pinned.
 *
 * **No ⛶ and no ⤢.** Both would mean handing *this* node to the overlay, which is the one case
 * the exclusion refuses — so the button somebody pressed to see it bigger is the button that
 * loses the thing they pinned when they close it again. The dock resizes instead, up to 70% of
 * the window, which is the same request answered without a remount. A neuroglancer embed pays
 * for every remount in a camera (`sceneMemo` recovers it same-origin, and cannot cross-origin),
 * so a surface whose whole point is to stay put should not offer one.
 */

import { useCallback, useRef } from 'react'

import { useGraphStore } from '../../store/graphStore'
import {
  DOCK_MAX_FRACTION,
  DOCK_MIN_FRACTION,
  clampDockFraction,
} from '../../store/persistence'
import { ViewerSurface, useViewerNode } from './ViewerSurface'

/** How far one arrow-key press moves the edge. */
const KEY_STEP = 0.05

interface Drag {
  /**
   * The dock's right edge, read once at pointerdown.
   *
   * Measured from the dock rather than from the window because the inspector may be open to the
   * right of it — 320px that would otherwise be added silently to every width the drag computes.
   * It cannot move during the gesture, since this is the only column changing.
   */
  right: number
  /** What the fraction resolves against, so the pixel floor can be applied as the drag goes. */
  total: number
  /** The last painted value, committed on release — a cancel must not leave the DOM ahead. */
  fraction: number
}

export function ViewerDock() {
  const nodeId = useGraphStore((s) => s.pinnedNodeId)
  const pinNode = useGraphStore((s) => s.pinNode)
  const setDockFraction = useGraphStore((s) => s.setDockFraction)
  const fraction = useGraphStore((s) => s.dockFraction)
  const found = useViewerNode(nodeId)

  const asideRef = useRef<HTMLElement>(null)
  const dragRef = useRef<Drag | undefined>(undefined)

  /*
   * A drag paints the column directly and commits to the store once, on release.
   *
   * Routing every pointer sample through `setDockFraction` was the obvious version and the
   * expensive one: it writes `localStorage` synchronously, and the tick that follows re-renders
   * the whole shell — `ViewerSurface` and the viewer inside it included, which is the one
   * surface whose entire design goal is to stay up untouched. Sixty times a second, while
   * somebody drags its edge. The width is a CSS custom property, so the gesture can write it
   * where it is read and leave React out: one store write and one `localStorage` write per
   * gesture rather than one of each per sample.
   */
  const paint = useCallback((next: number) => {
    asideRef.current
      ?.closest<HTMLElement>('.app')
      ?.style.setProperty('--dock-width', `${next * 100}%`)
  }, [])

  const onGripDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const aside = asideRef.current
      const total = document.documentElement.clientWidth
      if (!aside || total <= 0) return
      event.preventDefault()
      /*
       * Pointer capture retargets every later move and the release to this element, which is
       * what lets the three JSX handlers below carry the whole gesture — the shape `GroupLayer`
       * and the scatter viewer's brush already use, rather than a hand-rolled listener triple
       * with its own teardown to keep correct.
       */
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { right: aside.getBoundingClientRect().right, total, fraction }
    },
    [fraction],
  )

  const onGripMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      drag.fraction = clampDockFraction((drag.right - event.clientX) / drag.total, drag.total)
      paint(drag.fraction)
      // The separator announces what it is showing, not what the store has yet to be told.
      event.currentTarget.setAttribute('aria-valuenow', String(Math.round(drag.fraction * 100)))
    },
    [paint],
  )

  const onGripUp = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = undefined
    setDockFraction(drag.fraction, drag.total)
  }, [setDockFraction])

  // Arrow keys, because a drag grip that only responds to a drag is a control a keyboard cannot
  // reach — and `role="separator"` with `aria-valuenow` promises exactly this.
  const onGripKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step =
        event.key === 'ArrowLeft' ? KEY_STEP : event.key === 'ArrowRight' ? -KEY_STEP : 0
      if (step === 0) return
      event.preventDefault()
      setDockFraction(fraction + step, document.documentElement.clientWidth)
    },
    [fraction, setDockFraction],
  )

  if (!nodeId || !found) return null

  return (
    <aside className="viewer-dock" ref={asideRef} aria-label="Pinned viewer">
      <div
        className="viewer-dock__grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Dock width"
        aria-valuemin={Math.round(DOCK_MIN_FRACTION * 100)}
        aria-valuemax={Math.round(DOCK_MAX_FRACTION * 100)}
        aria-valuenow={Math.round(fraction * 100)}
        tabIndex={0}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onKeyDown={onGripKey}
      />
      <div className="viewer-dock__panel viewer-surface">
        <ViewerSurface
          nodeId={nodeId}
          actions={
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => pinNode(undefined)}
              title="Unpin — the card on the canvas draws this again"
              aria-label="Unpin viewer"
            >
              ✕
            </button>
          }
        />
      </div>
    </aside>
  )
}
