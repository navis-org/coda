/**
 * The changelog's script: what a static document cannot do from markup.
 *
 * Everything readable is rendered at build time (`render.ts`). This adds four things, each of
 * which degrades to a complete page when it fails:
 *
 * - **The marker.** As an entry scrolls past a reading line, the marker walks from that entry's
 *   date to the next older one, and the axis fills behind it. Interpolating across the *section*
 *   rather than following individual items is deliberate: items inside an update are ordered by
 *   importance, not date, so a marker following them would jump back and forth.
 * - **Ticks for what is on screen light up**, which is what ties a tick to its line of text.
 * - **The filter**, which hides items and dims their ticks.
 * - **"New since your last visit"**, read from the same key the editor writes (`seen.ts`), and
 *   then this visit is recorded — opening the page is what clears the dot on the editor's `?`.
 *
 * Imports nothing from the app but `seen.ts` (no imports) and the stylesheet. Verify with
 * `pnpm build` that `dist/changelog.html` references no `main-*` chunk.
 */

import './changelog.css'
import { dayOf, ms, shortDate } from './dates'
import { loadChangelogSeen, saveChangelogSeen } from './seen'

const THEME_KEY = 'coda.theme.v1'
/** Where on the screen the entry being read is taken to be, as a fraction of the height. */
const READING_LINE = 0.3
/** Below this many pixels per day the day marks merge into a bar and are dropped. */
const DENSE_PX_PER_DAY = 4
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

const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches

function markNew(sections: readonly HTMLElement[], axis: HTMLElement): void {
  const seen = loadChangelogSeen()
  const newest = sections[0]?.dataset.date
  if (seen !== undefined) {
    for (const s of sections) {
      if ((s.dataset.date ?? '') <= seen) continue
      s.querySelector<HTMLElement>('.release__new')?.removeAttribute('hidden')
      axis
        .querySelector<HTMLElement>(`.axis__entry[data-for="${s.id}"] .axis__new`)
        ?.removeAttribute('hidden')
    }
  }
  if (newest) saveChangelogSeen(newest)
}

function timeline(axis: HTMLElement, sections: readonly HTMLElement[]): () => void {
  const start = ms(axis.dataset.start ?? '')
  const end = ms(axis.dataset.end ?? '')
  const tOf = (date: string) => (end - ms(date)) / (end - start)
  const entries = new Map(
    [...axis.querySelectorAll<HTMLElement>('.axis__entry')].map((a) => [
      a.dataset.for ?? '',
      a,
    ]),
  )
  const ticks = new Map(
    [...axis.querySelectorAll<HTMLElement>('.axis__tick')].map((a) => [a.dataset.for ?? '', a]),
  )
  const here = axis.querySelector<HTMLElement>('.axis__here')
  const hereLabel = here?.querySelector('b')
  // Only these two read the marker's position, so only they get it: set on the axis, it would
  // restyle every tick and day mark on each scroll frame.
  const moving = [axis.querySelector<HTMLElement>('.axis__fill'), here]

  // Ticks for what is on screen.
  const io = new IntersectionObserver(
    (seen) => {
      for (const e of seen)
        ticks.get(e.target.id)?.classList.toggle('is-inview', e.isIntersecting)
    },
    { rootMargin: '-10% 0px -10% 0px' },
  )
  for (const id of ticks.keys()) {
    const el = document.getElementById(id)
    if (el) io.observe(el)
  }

  // A tick or a dot scrolls to its change and flashes it; the href alone would jump.
  axis.addEventListener('click', (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[data-for]')
    const target = link && document.getElementById(link.dataset.for ?? '')
    if (!target) return
    event.preventDefault()
    const behavior: ScrollBehavior = reducedMotion() ? 'auto' : 'smooth'
    const isEntry = link.classList.contains('axis__entry')
    target.scrollIntoView({ block: isEntry ? 'start' : 'center', behavior })
    history.replaceState(null, '', `#${target.id}`)
    if (!isEntry) {
      target.classList.remove('flash')
      void target.offsetWidth
      target.classList.add('flash')
    }
  })

  /*
   * Labels that would overlap are hidden, the current entry's first. Positions depend only on
   * the axis's size, so the boxes are measured on resize and the choice redone when the current
   * entry changes. The shown sections' document offsets are measured at the same moments, so a
   * scroll frame reads `scrollY` and nothing else from layout.
   */
  let boxes = new Map<string, { top: number; bottom: number }>()
  let shown: { el: HTMLElement; top: number; height: number }[] = []
  const measure = () => {
    shown = sections
      .filter((s) => !s.hidden)
      .map((el) => {
        const r = el.getBoundingClientRect()
        return { el, top: r.top + scrollY, height: r.height }
      })
    const rects = new Map<string, { top: number; bottom: number }>()
    for (const [id, a] of entries) {
      const r = a.querySelector('.axis__lbl')?.getBoundingClientRect()
      if (r) rects.set(id, { top: r.top, bottom: r.bottom })
    }
    boxes = rects
    const days = Number(axis.dataset.days) || 1
    const long = Math.max(axis.clientHeight, axis.clientWidth)
    axis.classList.toggle('is-dense', long / days < DENSE_PX_PER_DAY)
  }
  let crowdedFor: string | undefined | null = null
  const thin = (current: string | undefined) => {
    if (current === crowdedFor) return
    crowdedFor = current
    const order = [...entries.keys()].sort((a, b) =>
      a === current ? -1 : b === current ? 1 : a < b ? 1 : -1,
    )
    const kept: { top: number; bottom: number }[] = []
    for (const id of order) {
      const box = boxes.get(id)
      const clash = box && kept.some((k) => box.top < k.bottom + 4 && box.bottom > k.top - 4)
      entries.get(id)?.classList.toggle('is-crowded', !!clash)
      if (box && !clash) kept.push(box)
    }
  }

  const place = () => {
    const line = scrollY + innerHeight * READING_LINE
    let i = -1
    shown.forEach((s, k) => {
      if (s.top <= line) i = k
    })
    let t: number
    let current: HTMLElement | undefined
    if (i < 0) t = shown[0] ? tOf(shown[0].el.dataset.date ?? '') : 0
    else {
      const at = shown[i]!
      current = at.el
      const p = Math.min(1, Math.max(0, (line - at.top) / at.height))
      const from = tOf(current.dataset.date ?? '')
      const next = shown[i + 1]
      const to = next ? tOf(next.el.dataset.date ?? '') : 1
      t = from + (to - from) * p
    }
    for (const el of moving) el?.style.setProperty('--t', t.toFixed(4))
    // Dates sit at noon, so the instant is inside its day with no rounding to push it over.
    const label = shortDate(dayOf(end - t * (end - start)))
    if (hereLabel && hereLabel.textContent !== label) hereLabel.textContent = label
    for (const s of sections) {
      const dot = entries.get(s.id)
      dot?.classList.toggle('is-current', s === current)
      dot?.classList.toggle(
        'is-past',
        current !== undefined && (s.dataset.date ?? '') > (current.dataset.date ?? ''),
      )
    }
    thin(current?.id)
  }

  let queued = false
  let stale = false
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      if (stale) {
        stale = false
        measure()
        crowdedFor = null
      }
      place()
    })
  }
  const remeasure = () => {
    stale = true
    schedule()
  }
  addEventListener('scroll', schedule, { passive: true })
  addEventListener('resize', remeasure)
  // Web fonts and anything without a declared size can move the sections after first paint.
  addEventListener('load', remeasure)
  measure()
  place()

  return () => {
    for (const [id, tick] of ticks) {
      tick.classList.toggle('is-off', !!document.getElementById(id)?.closest('[hidden]'))
    }
    remeasure()
  }
}

function filters(sections: readonly HTMLElement[], sync: () => void): void {
  const chips = [...document.querySelectorAll<HTMLButtonElement>('.chip')]
  const changes = sections.map((sec) => ({
    sec,
    items: [...sec.querySelectorAll<HTMLElement>('[data-k]:not(.tag)')],
    extras: [...sec.querySelectorAll<HTMLElement>('.fixes, .release__label')],
  }))
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      const f = chip.dataset.f
      for (const c of chips) c.setAttribute('aria-pressed', String(c === chip))
      for (const { sec, items, extras } of changes) {
        for (const el of items) el.hidden = f !== 'all' && el.dataset.k !== f
        for (const el of extras) el.hidden = f !== 'all'
        sec.hidden = items.every((el) => el.hidden)
      }
      sync()
    })
  }
}

try {
  applyStoredTheme()
} catch {
  /* a static page is a fine failure */
}

try {
  const axis = document.querySelector<HTMLElement>('.axis')
  const sections = [...document.querySelectorAll<HTMLElement>('.release')]
  if (axis && sections.length) {
    markNew(sections, axis)
    filters(sections, timeline(axis, sections))
  }
} catch {
  /* the document is whole without any of this */
}
