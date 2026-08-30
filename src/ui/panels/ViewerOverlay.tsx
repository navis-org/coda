/**
 * Full-size viewer overlay.
 *
 * A modal panel over the canvas rather than a browser-fullscreen takeover, so the graph
 * stays one keypress away — but with a button that hands the panel to the Fullscreen API
 * when someone genuinely wants no chrome (a projector, a screenshot).
 *
 * What is *in* the panel is `ViewerSurface`, shared with the pinned dock: the header, the
 * presentational rail or the tabbed styling sidebar, and the node's own body. This file is the
 * modal frame around it — the backdrop, Escape, the per-node width cap, fullscreen.
 *
 * The other surface answers a different moment. This one is for looking at a result; the dock
 * (`ViewerDock`) is for keeping one open while you work on the graph beside it. They are
 * mutually exclusive by construction — see `pinnedNodeId` in the store for why that is a
 * memory-footprint decision rather than a tidiness one.
 */

import { useCallback, useEffect, useRef } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { exitFullscreen, toggleFullscreen, useIsFullscreen } from '../fullscreen'
import { expandedWidth } from './expandedWidth'
import { ViewerSurface, useViewerNode } from './ViewerSurface'

export function ViewerOverlay() {
  const nodeId = useGraphStore((s) => s.expandedNodeId)
  const expandNode = useGraphStore((s) => s.expandNode)
  const setNotice = useGraphStore((s) => s.setNotice)
  // One lookup for all three things the frame needs: whether there is anything to draw, the
  // title the dialog is labelled with, and the type that decides the width cap.
  const found = useViewerNode(nodeId)

  const panelRef = useRef<HTMLDivElement>(null)
  const isFullscreen = useIsFullscreen(panelRef.current)

  const close = useCallback(() => {
    // Only *this panel's* fullscreen, never "whatever is fullscreen": the app itself can be
    // fullscreen underneath, and closing a viewer has no business dropping the whole window
    // out of it. The API keeps a stack, so leaving the panel lands back there.
    if (document.fullscreenElement === panelRef.current) exitFullscreen()
    expandNode(undefined)
  }, [expandNode])

  // Escape closes. The browser consumes Escape itself while the *panel* is fullscreen, which
  // exits fullscreen first and leaves the overlay up — that's the behaviour people expect.
  // A fullscreen *app* underneath is not that case: the overlay is an ordinary dialog on top
  // of it, and Escape closes it like any other.
  useEffect(() => {
    if (!nodeId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.fullscreenElement === panelRef.current) return
      /*
       * A popover on top of a dialog owns Escape first.
       *
       * This listener is on the *capture* phase, so it beats every popover's own dismissal —
       * which meant pressing Escape to shut the network viewer's context menu closed the whole
       * overlay from under it. Standing aside while one is open lets the key reach the menu's
       * own handler on the way back up; the next press finds no menu and closes this.
       *
       * By class rather than by a registry, because `.context-menu` is what all four of them
       * are, and a dialog knowing which popovers exist is the coupling being avoided.
       */
      if (document.querySelector('.context-menu')) return
      event.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [nodeId, close])

  if (!nodeId || !found) return null
  const title = found.node.title ?? found.def.label

  /*
   * A number CSS cannot know, so it goes on the element: the panel is one component drawing
   * every expandable node, and what it is drawing is the only thing that decides whether a
   * wider screen should make it wider. `.viewer-panel` uncaps it; this puts the cap back for
   * the surfaces that are worse for the room. Dropped entirely in fullscreen — a cap there
   * would letterbox the panel that was asked for precisely to lose the chrome.
   */
  const width = expandedWidth(found.node.type)

  const onToggleFullscreen = () => {
    const panel = panelRef.current
    if (!panel) return
    void toggleFullscreen(panel).then((now) => {
      if (!isFullscreen && !now) setNotice('This browser refused fullscreen for the viewer')
    })
  }

  return (
    <div className="overlay" role="presentation" onPointerDown={close}>
      <div
        ref={panelRef}
        className="overlay__panel viewer-panel viewer-surface"
        style={width === 'full' || isFullscreen ? undefined : { maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-label={`${title} output`}
        // Clicks inside must not reach the backdrop's close handler.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <ViewerSurface
          nodeId={nodeId}
          actions={
            <>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onToggleFullscreen}
                title={isFullscreen ? 'Leave fullscreen' : 'Fullscreen'}
                aria-label={isFullscreen ? 'Leave fullscreen' : 'Enter fullscreen'}
              >
                {isFullscreen ? '⛶ Exit' : '⛶ Fullscreen'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={close}
                title="Close (Esc)"
                aria-label="Close viewer"
              >
                ✕
              </button>
            </>
          }
        />
      </div>
    </div>
  )
}
