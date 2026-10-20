/**
 * A pack guide's script: a stylesheet, a theme read — the dataset guide's, for the reason its header
 * gives: everything on the page is rendered at build time (`render.ts`), and following the theme the
 * editor was last left in is one thing markup cannot do; a figure opened full-screen on a click and
 * the contents following the reader are the others. A figure is a link to its file (`guide__zoom`), so without this a click still opens it.
 *
 * Verify with `pnpm build` that `dist/biophysics.html` references no `main-*` chunk.
 */

import './packguide.css'

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

/**
 * A figure's link opens the image full-screen in a `<dialog>` instead of leaving the page: Escape,
 * a click anywhere or the browser's back gesture closes it. A modifier click keeps the link's own
 * behaviour, a new tab being what it asks for.
 */
function zoomFigures(): void {
  const dialog = document.createElement('dialog')
  dialog.className = 'guide__lightbox'
  const image = document.createElement('img')
  dialog.append(image)
  dialog.addEventListener('click', () => dialog.close())
  document.body.append(dialog)
  document.addEventListener('click', (event) => {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a.guide__zoom')
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    event.preventDefault()
    image.src = link.href
    image.alt = link.querySelector('img')?.alt ?? ''
    dialog.showModal()
  })
}

try {
  zoomFigures()
} catch {
  /* the links still open the images */
}

/**
 * The contents entry for what is being read: the last heading above a line a quarter of the way
 * down the window — a subsection's where it has one, else its section's — marked `aria-current`,
 * and its section's item `data-reading`, which keeps that section's subsections unfolded. Before
 * the first heading, none. Read off positions on scroll, a frame at a time, rather than with an
 * IntersectionObserver, whose answer is about what crosses an edge and goes quiet inside a section
 * taller than the window.
 */
function followContents(): void {
  const entries = [
    ...document.querySelectorAll<HTMLAnchorElement>('.guide__contents a'),
  ].flatMap((link) => {
    const heading = document.getElementById(decodeURIComponent(link.hash.slice(1)))
    // A subsection's link lives in its section's nested list; a section's is its item's own.
    const section = link.closest('.guide__subsections')?.parentElement ?? link.parentElement
    return heading && section ? [{ link, heading, section }] : []
  })
  if (entries.length === 0) return
  let current: (typeof entries)[number] | undefined
  let queued = false
  const update = () => {
    queued = false
    const line = window.innerHeight / 4
    let reading: (typeof entries)[number] | undefined
    for (const e of entries) if (e.heading.getBoundingClientRect().top <= line) reading = e
    // At the very bottom, the last heading is the one being read even if it never reaches the line.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      reading = entries[entries.length - 1]
    }
    if (reading === current) return
    current?.link.removeAttribute('aria-current')
    current?.section.removeAttribute('data-reading')
    reading?.link.setAttribute('aria-current', 'true')
    reading?.section.setAttribute('data-reading', '')
    current = reading
  }
  const queue = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(update)
  }
  window.addEventListener('scroll', queue, { passive: true })
  window.addEventListener('resize', queue)
  update()
}

try {
  followContents()
} catch {
  /* the contents still link to every section */
}
