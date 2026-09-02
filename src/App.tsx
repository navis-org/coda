import { useEffect } from 'react'

import { useGraphStore } from './store/graphStore'
import { applyTheme } from './store/persistence'
import { AssistantPanel } from './ui/panels/AssistantPanel'
import { useAppShortcuts } from './ui/appShortcuts'
import { DashboardView } from './ui/dashboard/DashboardView'
import { Editor } from './ui/Editor'
import { HelpOverlay } from './ui/help/HelpOverlay'
import { FeedbackDialog } from './ui/panels/FeedbackDialog'
import { FeedbackNudge } from './ui/panels/FeedbackNudge'
import { Inspector } from './ui/panels/Inspector'
import { ShareDialog } from './ui/panels/ShareDialog'
import { PrivacyDialog } from './ui/panels/PrivacyDialog'
import { ShortcutsDialog } from './ui/panels/ShortcutsDialog'
import { SharedLinkGate } from './ui/panels/SharedLinkGate'
import { GuidesDialog } from './ui/panels/GuidesDialog'
import { WizardDialog } from './ui/panels/WizardDialog'
import { StartPage } from './ui/panels/StartPage'
import { ZooGate } from './ui/panels/ZooGate'
import { StatusBar } from './ui/panels/StatusBar'
import { Toolbar } from './ui/panels/Toolbar'
import { ViewerDock } from './ui/panels/ViewerDock'
import { ViewerOverlay } from './ui/panels/ViewerOverlay'

export function App() {
  const theme = useGraphStore((s) => s.theme)
  /*
   * The dock's column is declared on `.app`, so `.app` is what has to know about it. Both reads
   * are primitives — invariant 7 — and `data-dock` is what switches the second column from
   * `auto` (which a closed dock collapses to zero) to the stored share of the window.
   */
  const docked = useGraphStore((s) => s.pinnedNodeId !== undefined)
  const dockFraction = useGraphStore((s) => s.dockFraction)
  /*
   * Which view occupies the canvas column. One or the other, never both — see `DashboardView`
   * for why that is about WebGL contexts rather than about screen space. React Flow unmounts
   * with `Editor`, taking every card's live preview with it.
   */
  const dashboardOpen = useGraphStore((s) => s.dashboardOpen)

  /*
   * Fullscreen, the inspector, the assistant and the dashboard toggle. Mounted here rather than
   * in `Editor` because none of them is about the canvas — and `Editor` is not mounted at all
   * while the dashboard is up, which is how `F` came to do nothing there.
   */
  useAppShortcuts()

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
      <Toolbar />
      {dashboardOpen ? <DashboardView /> : <Editor />}
      {/*
       * Between the canvas and the inspector, and before it in the DOM so tab order runs left to
       * right across the shell.
       *
       * Gone entirely while the dashboard is up, and structurally rather than by a check inside
       * the cell. The dock exists to keep one viewer live *beside the graph you are working on*,
       * and there is no graph beside it here — but the real reason is the exclusion: the dock is
       * its own grid column, so it survives the view swap, and pinning after the grid opened
       * would put one node live in a cell and in the dock at once. That is exactly the two
       * contexts the store refuses for the overlay. `openDashboard` already dropped the pin on
       * the way in; this is what stops it coming back.
       */}
      {!dashboardOpen && <ViewerDock />}
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
       * The first visit's first screen, in front of the welcome page it hands over to. Never
       * both — `useLaunchStage` gives the two one answer between them — so the order here only
       * decides which wins if that ever stops being true, and being asked to take the Basics is
       * the more useful thing to be looking at on the visit where it can happen.
       */}
      <GuidesDialog />
      {/*
       * Above the start page, which is one of the three surfaces that open it — `openWizard`
       * closes that page on the way in, so the two are never both up, and the ordering only
       * decides which wins if that ever stops being true.
       */}
      <WizardDialog />
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
