// @vitest-environment jsdom

/**
 * Where a chart tooltip is told to go.
 *
 * The arithmetic is three lines and the bug it fixes was invisible for the life of four
 * viewers, which is the ratio that earns a test. jsdom performs no layout, so the container is
 * stubbed with the numbers a real one reports — a card inside React Flow's `scale(z)` pane has
 * a bounding rect `z` times its `offsetWidth`, and that ratio is the whole correction.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { tooltipPlacement, tooltipPoint } from './tooltipPoint'

/** A container at `left`/`top` on screen, `width` CSS pixels wide, drawn at `scale`. */
function container(left: number, top: number, width: number, scale: number): HTMLElement {
  const element = document.createElement('div')
  Object.defineProperty(element, 'offsetWidth', { value: width, configurable: true })
  element.getBoundingClientRect = () =>
    ({
      left,
      top,
      width: width * scale,
      height: 100 * scale,
      right: 0,
      bottom: 0,
      x: left,
      y: top,
    }) as DOMRect
  return element
}

describe('tooltipPoint', () => {
  it('makes the pointer relative to the container', () => {
    // The overlay case: unscaled, but still offset from the viewport by the panel's position.
    expect(tooltipPoint({ clientX: 300, clientY: 220 }, container(100, 60, 500, 1))).toEqual({
      x: 200,
      y: 160,
    })
  })

  it('divides the distance by the zoom, which is the half that was missing', () => {
    /*
     * A card drawn at 0.5: a pointer 200 screen pixels into the container is 400 pixels into
     * its own coordinate system, because everything inside is drawn at half size. Placing the
     * tooltip at 200 would put it at the *midpoint* of where the cursor is.
     */
    expect(tooltipPoint({ clientX: 300, clientY: 160 }, container(100, 60, 500, 0.5))).toEqual({
      x: 400,
      y: 200,
    })
  })

  it('reproduces the measurement this was written from', () => {
    /*
     * The dendrogram card as measured in a browser: a bracket hovered at (1254, 417) put its
     * tooltip at (1787, 498) under `position: fixed`, i.e. 533 px to the right. The card's
     * container sat at (1000, 330) drawn at 0.627.
     */
    const point = tooltipPoint(
      { clientX: 1254, clientY: 417 },
      container(1000, 330, 550, 0.627),
    )
    expect(point.x).toBeCloseTo(405.1, 1)
    expect(point.y).toBeCloseTo(138.8, 1)
    // Which is inside the card rather than half a screen away from it.
    expect(point.x).toBeLessThan(550)
  })

  it('answers the pointer unchanged before anything is mounted', () => {
    // Nothing to be relative to, and no tooltip on screen either.
    expect(tooltipPoint({ clientX: 12, clientY: 34 }, null)).toEqual({ x: 12, y: 34 })
  })

  it('does not divide by zero for a container that has never been laid out', () => {
    const hidden = container(0, 0, 0, 1)
    expect(tooltipPoint({ clientX: 40, clientY: 50 }, hidden)).toEqual({ x: 40, y: 50 })
  })
})

describe('the stylesheet half', () => {
  /*
   * The helper is only correct paired with `position: absolute`. Put back to `fixed` — which
   * is what it was, and what reads as the obvious choice for something following a cursor —
   * these coordinates are then relative to the wrong box, and the tooltip is wrong on a card
   * and right in the overlay all over again. vitest applies no CSS, so the declaration is the
   * only thing a test here can hold.
   */
  it('positions the tooltip absolutely, never fixed', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync('src/ui/editor.css', 'utf8')
    const start = css.indexOf('.chart-tooltip {')
    expect(start).toBeGreaterThan(-1)
    const rule = css.slice(start, css.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rule).toMatch(/position:\s*absolute/)
    expect(rule).not.toMatch(/position:\s*fixed/)
  })
})

describe('tooltipPlacement', () => {
  const box = { containerWidth: 400, containerHeight: 300 }
  const card = { width: 120, height: 60 }

  it('sits below and right of the pointer where there is room', () => {
    expect(tooltipPlacement({ x: 50, y: 40, ...card, ...box })).toEqual({ x: 62, y: 52 })
  })

  it('flips to the left of the pointer at the right edge', () => {
    // The mark this describes is at the pointer, so sliding along the edge would cover it —
    // the card goes to the other side instead.
    const placed = tooltipPlacement({ x: 380, y: 40, ...card, ...box })
    expect(placed.x).toBe(380 - 12 - 120)
    expect(placed.x + card.width).toBeLessThan(box.containerWidth)
  })

  it('flips above the pointer at the bottom edge', () => {
    const placed = tooltipPlacement({ x: 50, y: 290, ...card, ...box })
    expect(placed.y).toBe(290 - 12 - 60)
    expect(placed.y + card.height).toBeLessThan(box.containerHeight)
  })

  it('flips both at once in the far corner, which is where this was reported', () => {
    const placed = tooltipPlacement({ x: 395, y: 295, ...card, ...box })
    expect(placed.x + card.width).toBeLessThanOrEqual(box.containerWidth)
    expect(placed.y + card.height).toBeLessThanOrEqual(box.containerHeight)
  })

  it('clamps into the surface where neither side fits', () => {
    // A container narrower than the card — a compact preview. Flipping left would put it off
    // the *left* edge, which is the same bug mirrored.
    const placed = tooltipPlacement({
      x: 90,
      y: 10,
      width: 120,
      height: 60,
      containerWidth: 100,
      containerHeight: 300,
    })
    expect(placed.x).toBeGreaterThanOrEqual(0)
  })

  it('answers the naive position when nothing has been measured', () => {
    // Every size in jsdom, and the first frame anywhere. Pretending to fit an unmeasured card
    // would move it for no reason; the layout effect corrects before paint.
    expect(tooltipPlacement({ x: 5, y: 7, width: 0, height: 0, ...box })).toEqual({
      x: 17,
      y: 19,
    })
    expect(
      tooltipPlacement({ ...card, x: 5, y: 7, containerWidth: 0, containerHeight: 0 }),
    ).toEqual({ x: 17, y: 19 })
  })
})

/**
 * The rule the hover card needs the *other* viewers to keep.
 *
 * A `<title>` that is a direct child of `<svg>` is a native browser tooltip over the whole
 * drawing, so it opens on top of the `chart-tooltip` that says what the pointer is actually on.
 * Every viewer here carries `aria-label` instead — the same accessible name, no tooltip — and
 * `serializeSvg` turns that back into a `<title>` for the exported file.
 *
 * Read off the **source** rather than by mounting nine charts, which is `help.test.ts`' approach
 * to a rule that lives in how a file is written: what has to hold is that nobody types the thing
 * again, and a tenth viewer would otherwise regress this silently — the symptom is a tooltip
 * covering another tooltip, which no assertion about rendered output would think to look for.
 *
 * The window is textual and deliberately generous. A per-mark `<title>` is a different thing and
 * is wanted — `DendrogramViewer` puts one on a renamed leaf and `Tiles` on a pie slice — and both
 * sit far from their `<svg>` tag, where this does not reach.
 */
describe('a chart names itself with aria-label, never a root <title>', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const files = readdirSync(here)
    .filter((name) => name.endsWith('Viewer.tsx'))
    .map((name) => [name, readFileSync(join(here, name), 'utf-8')])

  it('finds the viewers to check, so a rename cannot empty this sweep', () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
  })

  // `it.each` spreads each row into the parameters, so the source travels with the name rather
  // than being looked back up out of the list it was just mapped off.
  it.each(files)('%s opens no <title> on its svg root', (_name, source) => {
    for (let at = source.indexOf('<svg'); at >= 0; at = source.indexOf('<svg', at + 1)) {
      expect(source.slice(at, at + 400)).not.toContain('<title>')
    }
  })

  it.each(files)('%s gives its svg root an accessible name', (_name, source) => {
    // Only the roots that claim to be an image: `PersistentCanvas` and the WebGL viewers mount a
    // `<canvas>`, and a decorative `<svg>` in a legend is not something to name.
    for (
      let at = source.indexOf('role="img"');
      at >= 0;
      at = source.indexOf('role="img"', at + 1)
    ) {
      expect(source.slice(Math.max(0, at - 400), at + 400)).toContain('aria-label')
    }
  })
})
