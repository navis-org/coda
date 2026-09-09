/**
 * The geometry half of "Reading a card": the boxes round the parts and the leader lines to them.
 *
 * The section itself is static markup — `anatomy.ts`, spliced into `nodes.html` at build time —
 * and it reads perfectly well without this file: a list of numbered parts with every note
 * visible. What this adds is the arrangement, and only the arrangement.
 *
 * ## Measured, not authored
 *
 * The *labels* are hand-placed, because where a label goes is a composition. The *boxes* are
 * measured from the elements they name, because a rectangle typed out beside a label is a
 * rectangle that drifts the first time a font falls back, a card grows a row, or somebody edits
 * a number in the card's markup — and it drifts silently, pointing an inch below the button it
 * names. So every box and every leader endpoint comes from `getBoundingClientRect`, re-taken on
 * a resize and once more when the web fonts land.
 *
 * ## It asks the layout whether it is on, rather than repeating the breakpoint
 *
 * `nodeguide.css` folds the stage back into a flow list below its own breakpoint. Restating that
 * number here as a `matchMedia` string is two declarations of one threshold, and the version
 * that goes wrong is the silent one: the labels are positioned by CSS and the lines by this
 * file, so a disagreement leaves a figure with labels floating and nothing pointing at anything.
 * Reading `display` off the leader canvas asks the stylesheet directly and cannot disagree with
 * it.
 */

/** How much air a box leaves round the part it names. */
const PAD = 3

/** The dot a `point` callout draws instead of a rectangle, as a box. */
const DOT = 13

/** Where a leader stops short of the label it leaves and the box it arrives at. */
const GAP = 4

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

/**
 * The target's box in stage coordinates.
 *
 * A path gets a dot on its own midpoint rather than a rectangle round its bounding box: the wire
 * is a diagonal, and a box round a diagonal is a box round mostly nothing. `getPointAtLength` is
 * what puts the dot *on* the curve — the bbox centre is beside it.
 */
function targetBox(el: Element, stage: DOMRect, dot: boolean): Box {
  if (dot && el instanceof SVGPathElement) {
    const at = el.getPointAtLength(el.getTotalLength() / 2)
    const own = el.ownerSVGElement?.getBoundingClientRect()
    /* The wire's `viewBox` is the stage's own size and it is stretched over the stage, so user
       units are stage px; the offset is only there in case that ever stops being true. */
    const dx = own ? own.left - stage.left : 0
    const dy = own ? own.top - stage.top : 0
    return { x: at.x + dx - DOT / 2, y: at.y + dy - DOT / 2, w: DOT, h: DOT }
  }
  const r = el.getBoundingClientRect()
  return {
    x: r.left - stage.left - PAD,
    y: r.top - stage.top - PAD,
    w: r.width + PAD * 2,
    h: r.height + PAD * 2,
  }
}

/** Two points: where the leader leaves the label, and where it meets the box. */
function leader(label: Box, box: Box): [number, number, number, number] {
  const lcx = label.x + label.w / 2
  const lcy = label.y + label.h / 2
  const bcx = box.x + box.w / 2
  const bcy = box.y + box.h / 2

  // The side of the label that faces the part, which is the side the line leaves from.
  const horizontal = Math.abs(bcx - lcx) > Math.abs(bcy - lcy)
  const ax = horizontal ? (bcx > lcx ? label.x + label.w : label.x) : lcx
  const ay = horizontal ? lcy : bcy > lcy ? label.y + label.h : label.y

  // The nearest point on the box, which for a label off one corner is that corner.
  const bx = clamp(ax, box.x, box.x + box.w)
  const by = clamp(ay, box.y, box.y + box.h)

  // Pull both ends in so the line touches neither the text nor the rule round the part.
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  return [ax + ux * GAP, ay + uy * GAP, bx - ux * GAP, by - uy * GAP]
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Draw the figure, and keep it drawn.
 *
 * Returns without touching anything when the section is not on the page, which is every entry
 * but this one — `main.ts` calls this unconditionally.
 */
export function mountAnatomy(): void {
  const stage = document.querySelector<HTMLElement>('.anat__stage')
  const leads = stage?.querySelector<SVGSVGElement>('.anat__leads')
  if (!stage || !leads) return

  /*
   * The stage layout is claimed here rather than in the stylesheet's own right, because it is
   * only correct once this file is running: the labels are positioned by CSS and the lines that
   * make sense of them by `draw()` below. A script that throws before this point leaves the
   * list, which is a fine figure; a stylesheet that had assumed otherwise would leave labels
   * scattered round two cards with nothing pointing at anything.
   */
  document.documentElement.classList.add('js')

  const items = [...stage.querySelectorAll<HTMLElement>('.anat__item')]

  /* One line per callout, minted once and moved thereafter: the hover handlers below hold a
     reference to each, so rebuilding the set on every resize would leave them pointing at lines
     that are no longer in the document. */
  const lines = new Map<string, SVGLineElement>()
  for (const item of items) {
    const line = document.createElementNS(SVG_NS, 'line')
    lines.set(item.dataset.for ?? '', line)
    leads.append(line)

    /*
     * Hovering the label lights the line and the part itself. In CSS this would need a selector
     * per callout — the line is not a descendant of the label, and there is no sibling relation
     * to reach it by — so it is two class toggles here and the appearance stays in the
     * stylesheet. The note itself is `:hover` / `:focus-within`, and deliberately not this: a
     * panel that only opens under a pointer is one a keyboard cannot read.
     */
    const target = (): Element | null =>
      stage.querySelector(`[data-anat="${item.dataset.for ?? ''}"]`)
    const hot = (on: boolean) => {
      line.classList.toggle('is-hot', on)
      target()?.classList.toggle('is-hot', on)
    }
    item.addEventListener('pointerenter', () => hot(true))
    item.addEventListener('pointerleave', () => hot(false))
    item.addEventListener('focusin', () => hot(true))
    item.addEventListener('focusout', () => hot(false))
  }

  /**
   * The wire, from socket to socket.
   *
   * React Flow's own shape: a cubic whose control points leave each end horizontally, so the
   * curve arrives at a socket the way every wire on the canvas does. The curvature is a fraction
   * of the horizontal gap with a floor, or two cards nearly touching get a wire with a kink in
   * it where the canvas would draw a gentle S.
   */
  function drawWire(bounds: DOMRect): void {
    const path = stage?.querySelector<SVGPathElement>('.anat__wire path')
    const from = stage?.querySelector('[data-wire="from"]')
    const to = stage?.querySelector('[data-wire="to"]')
    if (!path || !from || !to) return
    const centre = (el: Element): [number, number] => {
      const r = el.getBoundingClientRect()
      return [r.left - bounds.left + r.width / 2, r.top - bounds.top + r.height / 2]
    }
    const [x1, y1] = centre(from)
    const [x2, y2] = centre(to)
    const bend = Math.max(30, Math.abs(x2 - x1) * 0.5)
    path.setAttribute(
      'd',
      `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
    )
  }

  function draw(): void {
    if (!stage || !leads) return
    // The stylesheet decides whether there is a figure at all — see the header.
    if (getComputedStyle(leads).display === 'none') return
    const bounds = stage.getBoundingClientRect()
    /* Before the callouts, because one of them points at the wire's midpoint and
       `getPointAtLength` on a path with no `d` yet answers about nothing. */
    drawWire(bounds)

    for (const item of items) {
      const id = item.dataset.for ?? ''
      const el = stage.querySelector(`[data-anat="${id}"]`)
      const line = lines.get(id)
      const boxEl = item.querySelector<HTMLElement>('.anat__box')
      const labelEl = item.querySelector<HTMLElement>('.anat__label')
      if (!el || !line || !boxEl || !labelEl) continue

      const box = targetBox(el, bounds, item.dataset.mark === 'point')
      /*
       * The box is written in the *item's* coordinates and the leader in the stage's, because
       * that is where each one lives: the box is a child of the item so that hovering the label
       * can light it with a selector rather than a third class toggle, and the item is
       * positioned, so it is the box's containing block. Everything is measured against the
       * stage first and this is the one subtraction that puts it back.
       */
      const own = item.getBoundingClientRect()
      boxEl.style.setProperty('--bx', `${box.x - (own.left - bounds.left)}px`)
      boxEl.style.setProperty('--by', `${box.y - (own.top - bounds.top)}px`)
      boxEl.style.setProperty('--bw', `${box.w}px`)
      boxEl.style.setProperty('--bh', `${box.h}px`)

      const r = labelEl.getBoundingClientRect()
      const label = {
        x: r.left - bounds.left,
        y: r.top - bounds.top,
        w: r.width,
        h: r.height,
      }
      const [x1, y1, x2, y2] = leader(label, box)
      line.setAttribute('x1', x1.toFixed(1))
      line.setAttribute('y1', y1.toFixed(1))
      line.setAttribute('x2', x2.toFixed(1))
      line.setAttribute('y2', y2.toFixed(1))
    }
  }

  let queued = 0
  const schedule = (): void => {
    cancelAnimationFrame(queued)
    queued = requestAnimationFrame(draw)
  }

  schedule()
  window.addEventListener('resize', schedule)
  /* A fallback font is a different label width, and the figure is measured from label widths.
     Guarded because `document.fonts` is absent under jsdom, which is where the suite reads
     this file. */
  void document.fonts?.ready.then(schedule)
}
