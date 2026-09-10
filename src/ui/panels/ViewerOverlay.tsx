/**
 * Full-size viewer overlay.
 *
 * A modal panel over the canvas rather than a browser-fullscreen takeover, so the graph
 * stays one keypress away — but with a button that hands the panel to the Fullscreen API
 * when someone genuinely wants no chrome (a projector, a screenshot).
 *
 * What is *in* the panel is `ViewerSurface`, shared with the pinned dock: the header, the
 * presentational rail or the tabbed styling sidebar, and the node's own body. This file is the
 * modal frame around it — a `Modal`, the per-node width cap, fullscreen.
 *
 * The other surface answers a different moment. This one is for looking at a result; the dock
 * (`ViewerDock`) is for keeping one open while you work on the graph beside it. They are
 * mutually exclusive by construction — see `pinnedNodeId` in the store for why that is a
 * memory-footprint decision rather than a tidiness one.
 */

import { useCallback, useRef } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { exitFullscreen, toggleFullscreen, useIsFullscreen } from '../fullscreen'
import { expandedWidth } from './expandedWidth'
import { ViewerSurface, useViewerNode } from './ViewerSurface'
import { Modal } from '../Modal'

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
    <Modal
      className="overlay__panel viewer-panel viewer-surface"
      label={`${title} output`}
      onClose={close}
      panelRef={panelRef}
      style={width === 'full' || isFullscreen ? undefined : { maxWidth: width }}
      /* The browser consumes Escape itself while the *panel* is fullscreen, leaving fullscreen
         with the overlay still up — the behaviour people expect. A fullscreen *app* underneath
         is not that case: the overlay is an ordinary dialog on top of it. */
      ignoreEscape={() => document.fullscreenElement === panelRef.current}
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
    </Modal>
  )
}
