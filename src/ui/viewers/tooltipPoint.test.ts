// @vitest-environment jsdom

/**
 * Where a chart tooltip is told to go.
 *
 * The arithmetic is three lines and the bug it fixes was invisible for the life of four
 * viewers, which is the ratio that earns a test. jsdom performs no layout, so the container is
 * stubbed with the numbers a real one reports — a card inside React Flow's `scale(z)` pane has
 * a bounding rect `z` times its `offsetWidth`, and that ratio is the whole correction.
 */

import { describe, expect, it } from 'vitest'

import { tooltipPoint } from './tooltipPoint'

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
