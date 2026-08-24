import { useEffect } from 'react'

import { useGraphStore } from './store/graphStore'
import { applyTheme } from './store/persistence'
import { AssistantPanel } from './ui/panels/AssistantPanel'
import { Editor } from './ui/Editor'
import { HelpOverlay } from './ui/help/HelpOverlay'
import { Inspector } from './ui/panels/Inspector'
import { ShareDialog } from './ui/panels/ShareDialog'
import { SharedLinkGate } from './ui/panels/SharedLinkGate'
import { StartPage } from './ui/panels/StartPage'
import { StatusBar } from './ui/panels/StatusBar'
import { Toolbar } from './ui/panels/Toolbar'
import { ViewerOverlay } from './ui/panels/ViewerOverlay'

export function App() {
  const requestPalette = useGraphStore((s) => s.requestPalette)
  const requestNodeBrowser = useGraphStore((s) => s.requestNodeBrowser)
  const theme = useGraphStore((s) => s.theme)

  // Reflect the stored preference onto the document so the viewers sample the right mode
  // when they read `currentMode()`.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  return (
    <div className="app">
      <Toolbar onOpenPalette={requestPalette} onOpenBrowser={requestNodeBrowser} />
      <Editor />
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
      {/* Last, and on top: it can be reopened over an expanded viewer. */}
      <StartPage />
      {/*
       * Above even the start page: a link somebody followed is the most specific intent on the
       * screen, and the store already withholds the welcome modal when there is one.
       */}
      <SharedLinkGate />
    </div>
  )
}
