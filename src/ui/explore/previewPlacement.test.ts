/**
 * Where the hover preview lands.
 *
 * jsdom reports one rect for every element, so this is the only layer at which the placement can
 * be checked at all. Each case is a window width the app is actually used at, and the property
 * every one of them is about is `covers` — whether the preview reaches onto the row it is a
 * picture of.
 */

import { describe, expect, it } from 'vitest'

import { previewPlacement } from './previewPlacement'

/** A 76px tile, `x` from the left edge, part way down a list. */
const tile = (x: number) => ({ left: x, top: 200, width: 76, height: 76 })

const SIZE = 176

describe('previewPlacement', () => {
  it('opens left, so it never covers the row it is a picture of', () => {
    // 1920 window, 1500px panel centred: the tile sits ~250px in and the gutter is wide.
    const at = previewPlacement(tile(250), SIZE, { width: 1920, height: 1080 })
    expect(at.left).toBe(250 - 10 - SIZE)
    expect(at.covers).toBe(false)
  })

  it('clamps to the margin rather than flipping right when the gutter is narrow', () => {
    /*
     * 1440 window: the panel takes all but 28px of padding, so there is no room to the left.
     *
     * The version with a right-hand fallback put this at 171 — measured in a browser, over the
     * hovered row's name and the two rows either side. Clamping lands it on the tile and the
     * checkbox instead, which is 23px of overlap against 176.
     */
    const at = previewPlacement(tile(85), SIZE, { width: 1440, height: 900 })
    expect(at.left).toBe(8)
    expect(at.left + SIZE).toBeLessThan(85 + 10 + SIZE)
  })

  it('reports reaching onto the row, which is the only thing the rule is trading', () => {
    // Clamped to 8, so it ends at 184 against a tile ending at 161.
    expect(previewPlacement(tile(85), SIZE, { width: 1440, height: 900 }).covers).toBe(true)
    // Far enough in that the whole preview fits in the gutter.
    expect(previewPlacement(tile(250), SIZE, { width: 1920, height: 1080 }).covers).toBe(false)
  })

  it('stays on screen when the viewport is narrower than tile plus preview', () => {
    const at = previewPlacement(tile(60), SIZE, { width: 380, height: 700 })
    expect(at.left).toBeGreaterThanOrEqual(8)
    expect(at.left + SIZE).toBeLessThanOrEqual(380 - 8)
  })

  it('centres on the tile', () => {
    const at = previewPlacement(tile(250), SIZE, { width: 1920, height: 1080 })
    expect(at.top).toBe(200 + 38 - 88)
  })

  it('keeps a whole preview for the first and last rows of a scrolled list', () => {
    const top = previewPlacement({ left: 250, top: 4, width: 76, height: 76 }, SIZE, {
      width: 1920,
      height: 1080,
    })
    expect(top.top).toBe(8)

    const bottom = previewPlacement({ left: 250, top: 1040, width: 76, height: 76 }, SIZE, {
      width: 1920,
      height: 1080,
    })
    expect(bottom.top).toBe(1080 - SIZE - 8)
  })
})
