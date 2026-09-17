/**
 * The MCP page's script, which is a scroll reveal and nothing else.
 *
 * Plain TypeScript, no React and no store import — the rule every static entry
 * follows, and for the same reason: this is a separate vite entry, and reaching
 * into the editor would put the whole app bundle behind a document that draws
 * none of it. Verify with `pnpm build` that `dist/mcp.html` references no
 * `main-*` chunk.
 *
 * Lifted from `overview/main.ts` rather than shared, which is the standing
 * trade for these three dozen lines: a `src/shared` for them would be a module
 * every static entry imports purely so none has to repeat a `try`.
 */

import './mcppage.css'

const THEME_KEY = 'coda.theme.v1'

/**
 * Follow whatever theme the editor was last left in.
 *
 * Same origin as the app, so the key is readable. Wrapped because
 * `localStorage` throws outright in some privacy modes rather than answering
 * null. No stored preference leaves the document's own declaration alone —
 * `mcp.html` stamps `dark`, which is what the editor falls back to.
 */
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

function reveal(): void {
  const targets = document.querySelectorAll<HTMLElement>('.rise')
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduced || !('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-in'))
    return
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-in')
        io.unobserve(entry.target)
      }
    },
    // Slightly inside the viewport, so a block reveals as it is read rather
    // than the instant its first pixel clears the fold.
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
  )
  targets.forEach((el) => io.observe(el))
}

try {
  document.documentElement.classList.add('js')
  applyStoredTheme()
  reveal()
} catch {
  document.documentElement.classList.remove('js')
}
