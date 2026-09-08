/**
 * The socket vocabulary, and the one part of it a test can reach.
 *
 * `socketStyle` itself is a lookup and its contract is that colour never carries the type alone
 * (`colors.ts`: only three chromatic families clear the all-pairs colourblind gate, which is why
 * every socket is hue **plus** shape **plus** a visible label). What is asserted here is the
 * shape half staying distinct, and the one geometric rule that lives in CSS and cannot be
 * checked any other way — vitest applies no stylesheet and jsdom performs no layout, so the
 * declaration is the only thing a test here can hold. `tooltipPoint.test.ts` sets the precedent.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { T } from '../core/types'
import { socketStyle } from './socketStyle'

const CSS = readFileSync('src/ui/editor.css', 'utf8')

/** One CSS rule's body, comments stripped. */
function rule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThan(-1)
  return CSS.slice(start, CSS.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('socketStyle', () => {
  it('gives a matrix its own shape as well as its own hue', () => {
    expect(socketStyle(T.matrix())).toEqual({ family: 'matrix', shape: 'diamond' })
    expect(socketStyle(T.table()).shape).not.toBe('diamond')
  })
})

describe('the stylesheet half', () => {
  /*
   * The diamond is the one shape that has to restate React Flow's centring, and getting that
   * wrong is invisible to every other test in the tree.
   *
   * React Flow centres a left/right handle with `transform: translate(∓50%, -50%)`. `transform`
   * is a single property, so a rule setting `transform: rotate(45deg)` replaces that rather than
   * adding to it — which is what shipped, and it put every Matrix socket 3.97px below its own
   * row and 3.97px off the card edge, measured in Chrome against a circle in the row beside it.
   *
   * Two things are asserted, because the fix has two halves that fail differently. The **side
   * rules** must carry the translate *before* the rotate: the independent `rotate` property
   * composes ahead of `transform`, so it rotates the centring offset with the element and lands
   * dy −1.64 on the left against an unmoved +3.97 on the right. And the **base rule** must set
   * no `transform` at all, since either side rule would then be competing with a bare rotation
   * on equal specificity grounds the moment somebody reorders the file.
   */
  it('centres the diamond socket before rotating it, on both sides', () => {
    for (const side of ['left', 'right'] as const) {
      const body = rule(`.socket[data-shape='diamond'].react-flow__handle-${side}`)
      expect(body, side).toMatch(/transform:\s*translate\([^)]*\)\s+rotate\(45deg\)/)
    }
    expect(rule(".socket[data-shape='diamond']")).not.toMatch(/transform:/)
  })
})
