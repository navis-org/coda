import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@xyflow/react/dist/style.css'
import './ui/theme.css'
import './ui/editor.css'

// Registers every built-in node type. The store also imports this for the same reason,
// so ordering here is belt-and-braces rather than load-bearing.
import './nodes'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
