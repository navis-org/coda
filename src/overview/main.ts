/**
 * The overview page's script, which is a scroll reveal and nothing else.
 *
 * Plain TypeScript, no React and no store import — the same rule the tutorial
 * and the node guide follow, and for the same reason: this is a separate vite
 * entry, and reaching into the editor would put the whole app bundle behind a
 * document that draws none of it. Verify with `pnpm build` that
 * `dist/overview.html` references no `main-*` chunk.
 *
 * Everything that animates in is hidden by CSS only under a `js` class on the
 * root, which this file claims and gives back if anything below throws. A
 * static page is a fine failure; a blank one is not — which is exactly what the
 * tutorial page shipped with once, under a jsdom that has no `matchMedia`.
 */

import './overview.css'

const THEME_KEY = 'coda.theme.v1'

/**
 * Follow whatever theme the editor was last left in.
 *
 * Same origin as the app, so the key is readable. Wrapped because
 * `localStorage` throws outright in some privacy modes rather than answering
 * null. No stored preference leaves the document's own declaration alone —
 * `overview.html` stamps `dark`, which is what the editor falls back to.
 *
 * Lifted from `tutorial/main.ts` rather than shared: it is six lines around one
 * string, and a `src/shared` for it would be a module both static entries
 * import purely so neither has to repeat a `try`.
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
