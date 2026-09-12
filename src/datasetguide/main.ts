/**
 * The Dataset Guide's script, which is a stylesheet and a theme read.
 *
 * Everything on the page is rendered at build time by `render.ts` and spliced into
 * `datasets.html` by `vite/datasetGuideData.ts` — see that module for why. So this file has
 * nothing to draw, and what is left is the one thing a static document cannot do from markup:
 * follow the theme the editor was last left in.
 *
 * Lifted from `overview/main.ts` rather than shared, for the reason its own header gives: six
 * lines around one string, and a `src/shared` for it would be a module three static entries
 * import purely so none of them has to repeat a `try`.
 *
 * Verify with `pnpm build` that `dist/datasets.html` references no `main-*` chunk.
 */

import './datasetguide.css'

const THEME_KEY = 'coda.theme.v1'

function applyStoredTheme(): void {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(THEME_KEY)
  } catch {
    /* no storage; the document's own declaration stands */
  }
  if (stored === 'system') delete document.documentElement.dataset.theme
  else if (stored === 'light' || stored === 'dark') {
    document.documentElement.dataset.theme = stored
  }
}

try {
  applyStoredTheme()
} catch {
  /* a static page is a fine failure */
}
