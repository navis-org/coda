import { useEffect } from 'react'

import { useGraphStore } from './store/graphStore'
import { applyTheme } from './store/persistence'
import { AssistantPanel } from './ui/panels/AssistantPanel'
import { Editor } from './ui/Editor'
import { Inspector } from './ui/panels/Inspector'
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
      {/* Last, and on top: it can be reopened over an expanded viewer. */}
      <StartPage />
    </div>
  )
}
