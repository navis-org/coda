import { useEffect } from 'react'

import { useGraphStore } from './store/graphStore'
import { applyTheme } from './store/persistence'
import { AssistantPanel } from './ui/panels/AssistantPanel'
import { Editor } from './ui/Editor'
import { HelpOverlay } from './ui/help/HelpOverlay'
import { FeedbackDialog } from './ui/panels/FeedbackDialog'
import { FeedbackNudge } from './ui/panels/FeedbackNudge'
import { Inspector } from './ui/panels/Inspector'
import { ShareDialog } from './ui/panels/ShareDialog'
import { PrivacyDialog } from './ui/panels/PrivacyDialog'
import { ShortcutsDialog } from './ui/panels/ShortcutsDialog'
import { SharedLinkGate } from './ui/panels/SharedLinkGate'
import { StartPage } from './ui/panels/StartPage'
import { ZooGate } from './ui/panels/ZooGate'
import { StatusBar } from './ui/panels/StatusBar'
import { Toolbar } from './ui/panels/Toolbar'
import { ViewerDock } from './ui/panels/ViewerDock'
import { ViewerOverlay } from './ui/panels/ViewerOverlay'

export function App() {
  const requestPalette = useGraphStore((s) => s.requestPalette)
  const requestNodeBrowser = useGraphStore((s) => s.requestNodeBrowser)
  const theme = useGraphStore((s) => s.theme)
  /*
   * The dock's column is declared on `.app`, so `.app` is what has to know about it. Both reads
   * are primitives — invariant 7 — and `data-dock` is what switches the second column from
   * `auto` (which a closed dock collapses to zero) to the stored share of the window.
   */
  const docked = useGraphStore((s) => s.pinnedNodeId !== undefined)
  const dockFraction = useGraphStore((s) => s.dockFraction)

  // Reflect the stored preference onto the document so the viewers sample the right mode
  // when they read `currentMode()`.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  return (
    <div
      className="app"
      data-dock={docked ? 'open' : undefined}
      style={{ '--dock-width': `${dockFraction * 100}%` } as React.CSSProperties}
    >
      <Toolbar onOpenPalette={requestPalette} onOpenBrowser={requestNodeBrowser} />
      <Editor />
      {/* Between the canvas and the inspector, and before it in the DOM so tab order runs
          left to right across the shell. */}
      <ViewerDock />
      <Inspector />
      <AssistantPanel />
      <StatusBar />
      <ViewerOverlay />
      {/*
       * Above the viewer overlay, because it is opened *from* one: an expanded chart has a `?`
       * of its own, and a help document that rendered underneath the thing it was opened from
       * would read as the button doing nothing.
       */}
      <HelpOverlay />
      <ShareDialog />
      {/*
       * Beside the share dialog rather than below the viewer overlay: an expanded chart is one
       * of the places somebody presses Escape and wonders what else the keyboard does.
       */}
      <ShortcutsDialog />
      <PrivacyDialog />
      {/* Same idiom, opened from the `?` menu, the palette, the start page and the nudge below. */}
      <FeedbackDialog />
      {/* Last, and on top: it can be reopened over an expanded viewer. */}
      <StartPage />
      {/*
       * Under the start page rather than over it: `openZoo` closes the start page on the way in,
       * so the two are never both up, and the ordering only decides which wins if that ever
       * stops being true — where the welcome modal is the safer thing to be looking at.
       */}
      <ZooGate />
      {/*
       * Above even the start page: a link somebody followed is the most specific intent on the
       * screen, and the store already withholds the welcome modal when there is one.
       */}
      <SharedLinkGate />
      {/*
       * A standing card, not a dialog — it withholds itself while the start page is up, so it
       * never competes with the one modal that already asks for attention on load.
       */}
      <FeedbackNudge />
    </div>
  )
}
