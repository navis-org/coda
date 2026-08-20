/**
 * The tutorial page's scroll engine.
 *
 * Plain TypeScript, no React and no store import, deliberately: this is a second
 * vite entry, and reaching into the editor would put the whole app bundle behind
 * a document that draws none of it. The page's node cards are CSS, not React
 * Flow — but their tokens come from the app's own `theme.css`, so the two cannot
 * drift on what a Dataset socket looks like.
 *
 * Everything that animates in is hidden by CSS only under a `js` class on the
 * root, which this file claims. So a browser that never runs it — or one missing
 * something below — gets a static page rather than a blank one.
 */

import './tutorial.css'

interface Frame {
  x: number
  y: number
  w: number
  h: number
}

/** Which link exists, and from which chapter. Named by socket: a node has several. */
interface Wire {
  from: string
  to: string
  at: number
  fam: 'dataset' | 'table' | 'matrix'
}

const THEME_KEY = 'coda.theme.v1'

/**
 * Follow whatever theme the editor was last left in.
 *
 * Same origin as the app, so the key is readable. Wrapped because
 * `localStorage` throws outright in some privacy modes rather than answering
 * null.
 *
 * **No stored preference leaves the document's own declaration alone**, rather
 * than forcing a default. `tutorial.html` stamps `dark`, which is exactly what
 * `loadTheme()` falls back to, so a first-time visitor sees the editor's
 * default either way — and a copy of this page published somewhere that stamps
 * its own theme keeps it instead of being overridden.
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

const WIRES: readonly Wire[] = [
  { from: 's-ds-out', to: 's-find-in', at: 1, fam: 'dataset' },
  { from: 's-ds-out', to: 's-conn-in-ds', at: 1, fam: 'dataset' },
  { from: 's-find-out', to: 's-conn-in-n', at: 1, fam: 'table' },
  { from: 's-conn-out', to: 's-filt-in', at: 3, fam: 'table' },
  { from: 's-filt-out', to: 's-grp-in', at: 3, fam: 'table' },
  { from: 's-grp-out', to: 's-chart-in', at: 4, fam: 'table' },
]

/**
 * The box each chapter is composed on, in world units — the camera fits this
 * rather than taking a zoom level, so the framing survives every viewport size.
 * The last one is the deliberate wide shot: the cards are texture there, and the
 * point is the shape of the whole chain.
 */
const FRAMES: readonly Frame[] = [
  { x: 30, y: 126, w: 530, h: 162 },
  // Framed on the two cards the sockets are being explained on; the Dataset
  // card runs off the left edge, which is what a canvas looks like anyway.
  { x: 118, y: 122, w: 532, h: 180 },
  // Chapter 3 holds the frame: the detail panel sits over the top of it.
  { x: 118, y: 122, w: 532, h: 180 },
  { x: 440, y: 124, w: 628, h: 180 },
  { x: 880, y: 102, w: 416, h: 202 },
  { x: 8, y: 98, w: 1288, h: 210 },
]

/**
 * A phone-width stage is about a third of a desktop one, and fitting the frames
 * above into it puts the card text under legibility. So these hold fewer cards
 * each: the callouts stand down (the prose already names the four parts) and
 * chapter 4 frames only the two nodes it is about.
 */
const FRAMES_NARROW: readonly Frame[] = [
  { x: 214, y: 126, w: 200, h: 162 },
  { x: 210, y: 124, w: 440, h: 176 },
  { x: 210, y: 124, w: 440, h: 176 },
  { x: 682, y: 130, w: 386, h: 176 },
  { x: 880, y: 102, w: 416, h: 202 },
  { x: 8, y: 98, w: 1288, h: 210 },
]

/* Wired but not yet run in chapter 2; chapter 3 is the Run that settles them. */
const STATES: readonly Record<string, string>[] = [
  { find: 'blocked' },
  { ds: 'ok', find: 'stale', conn: 'stale' },
  { ds: 'ok', find: 'ok', conn: 'ok' },
  { ds: 'ok', find: 'ok', conn: 'ok', filt: 'ok', grp: 'ok' },
  { ds: 'ok', find: 'ok', conn: 'ok', filt: 'ok', grp: 'ok', chart: 'ok' },
  { ds: 'ok', find: 'ok', conn: 'ok', filt: 'ok', grp: 'ok', chart: 'ok' },
]

const FIND_FOOT = ['— · no Dataset connected', '— · not run yet', '1,704 rows · 0.6 s'] as const
const RUN_PILL = ['▶ Run 1', '▶ Run 2', 'Up to date'] as const
/** The `conn` card carries a result only once chapter 3 has run the graph. */
const CONN_FOOT = ['— · not run yet', '— · not run yet', '18,206 rows · 2.4 s'] as const

const FAM_COLOR: Record<Wire['fam'], string> = {
  dataset: 'var(--t-dataset)',
  table: 'var(--t-table)',
  matrix: 'var(--t-matrix)',
}

/** Height of the mock toolbar the world sits under. */
const BAR = 34
const NARROW = 980
const SVG_NS = 'http://www.w3.org/2000/svg'

function at<T>(list: readonly T[], index: number): T {
  return list[Math.max(0, Math.min(index, list.length - 1))] as T
}

function main(): void {
  const root = document.documentElement
  applyStoredTheme()
  root.classList.add('js')

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // --- reveals -------------------------------------------------------------
  const risers = Array.from(document.querySelectorAll<HTMLElement>('.rise'))
  if (reduced) {
    risers.forEach((el) => el.classList.add('is-in'))
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('is-in')
          io.unobserve(entry.target)
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
    )
    risers.forEach((el) => io.observe(el))
  }

  // --- the pinned canvas ---------------------------------------------------
  const stage = document.querySelector<HTMLElement>('#stage')
  const world = document.querySelector<HTMLElement>('#world')
  const wiresSvg = document.querySelector<SVGSVGElement>('#wires')
  if (!stage || !world || !wiresSvg) return

  const runPill = document.querySelector<HTMLElement>('#stagerun')
  const findFoot = world.querySelector<HTMLElement>('[data-foot="find"]')
  const connFoot = world.querySelector<HTMLElement>('[data-foot="conn"]')
  const beats = Array.from(document.querySelectorAll<HTMLElement>('.beat'))
  const nodes = Array.from(world.querySelectorAll<HTMLElement>('.node'))

  /**
   * Where a socket sits in world units.
   *
   * Walked through `offsetParent` rather than measured with a bounding rect,
   * because the world carries a `scale()` — a measured rect would be in screen
   * pixels and would change with the camera.
   */
  function worldPos(el: HTMLElement): { x: number; y: number } {
    let x = 0
    let y = 0
    let node: HTMLElement | null = el
    while (node && node !== world) {
      x += node.offsetLeft
      y += node.offsetTop
      node = node.offsetParent as HTMLElement | null
    }
    return { x: x + el.offsetWidth / 2, y: y + el.offsetHeight / 2 }
  }

  const paths = WIRES.map((wire) => {
    const path = document.createElementNS(SVG_NS, 'path')
    // Through `style`, not `setAttribute`: a presentation attribute does not
    // resolve `var()`, so the wires would come out black.
    path.style.stroke = FAM_COLOR[wire.fam]
    wiresSvg.appendChild(path)
    return path
  })

  function layoutWires(): void {
    WIRES.forEach((wire, i) => {
      const a = document.querySelector<HTMLElement>(`#${wire.from}`)
      const b = document.querySelector<HTMLElement>(`#${wire.to}`)
      const path = paths[i]
      if (!a || !b || !path) return
      const s = worldPos(a)
      const t = worldPos(b)
      const bow = Math.max(46, Math.abs(t.x - s.x) * 0.45)
      path.setAttribute(
        'd',
        `M ${s.x} ${s.y} C ${s.x + bow} ${s.y}, ${t.x - bow} ${t.y}, ${t.x} ${t.y}`,
      )
      path.style.setProperty('--len', String(path.getTotalLength()))
    })
  }

  function camera(beat: number): void {
    const narrow = window.innerWidth <= NARROW
    const frame = at(narrow ? FRAMES_NARROW : FRAMES, beat)
    const vw = stage!.clientWidth
    const vh = Math.max(120, stage!.clientHeight - BAR)
    const pad = narrow ? 20 : 40
    const k = Math.min(1.35, (vw - pad) / frame.w, (vh - pad) / frame.h)
    const cx = frame.x + frame.w / 2
    const cy = frame.y + frame.h / 2
    world!.style.setProperty('--k', String(k))
    world!.style.setProperty('--tx', `${vw / 2 - k * cx}px`)
    world!.style.setProperty('--ty', `${vh / 2 - k * cy}px`)
  }

  function applyStates(beat: number): void {
    const map = at(STATES, beat)
    nodes.forEach((node) => {
      node.dataset.state = map[node.dataset.key ?? ''] ?? 'blocked'
    })
  }

  let flashToken = 0
  let current = -1

  function setBeat(beat: number): void {
    if (beat === current) return
    const previous = current
    current = beat
    stage!.dataset.beat = String(beat)

    nodes.forEach((n) => n.classList.toggle('is-on', Number(n.dataset.from) <= beat))
    paths.forEach((p, i) => p.classList.toggle('is-on', at(WIRES, i).at <= beat))

    const clamped = Math.min(beat, 2)
    if (findFoot) findFoot.textContent = at(FIND_FOOT, clamped)
    if (connFoot) connFoot.textContent = at(CONN_FOOT, clamped)
    if (runPill) runPill.textContent = at(RUN_PILL, clamped)
    stage!.dataset.pending = beat < 2 ? 'true' : 'false'

    camera(beat)

    // Arriving at chapter 3 *is* the Run, so let the two queries actually run
    // for a moment rather than appearing already finished.
    const token = ++flashToken
    if (!reduced && beat === 2 && previous < 2) {
      const settled = at(STATES, 2)
      nodes.forEach((node) => {
        const key = node.dataset.key ?? ''
        node.dataset.state =
          key === 'find' || key === 'conn' ? 'running' : (settled[key] ?? 'blocked')
      })
      window.setTimeout(() => {
        if (token === flashToken) applyStates(current)
      }, 1400)
    } else {
      applyStates(beat)
    }
  }

  // The active chapter is whichever straddles the reading line.
  let ticking = false
  function onScroll(): void {
    if (ticking) return
    ticking = true
    window.requestAnimationFrame(() => {
      ticking = false
      // On a narrow screen the canvas holds the top of the viewport, so the
      // chapter being read sits below the midpoint.
      const narrow = window.innerWidth <= NARROW
      const mid = window.innerHeight * (narrow ? 0.68 : 0.5)
      let best = 0
      let bestDistance = Infinity
      beats.forEach((el, i) => {
        const rect = el.getBoundingClientRect()
        const distance = Math.abs(rect.top + rect.height / 2 - mid)
        if (distance < bestDistance) {
          bestDistance = distance
          best = i
        }
      })
      setBeat(best)
    })
  }

  layoutWires()
  setBeat(0)
  // Fonts change the socket positions, so re-measure once they have settled.
  void document.fonts?.ready.then(layoutWires)
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', () => {
    layoutWires()
    camera(Math.max(0, current))
  })
  onScroll()
}

try {
  main()
} catch (error) {
  document.documentElement.classList.remove('js')
  console.error('Coda tutorial: falling back to the static page.', error)
}
