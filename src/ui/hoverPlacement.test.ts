/**
 * The shared hover-panel arithmetic, from the side its two callers do not share.
 *
 * `previewPlacement.test.ts` holds the left-preferring arm — Explore's thumbnail — and its
 * measurement. What is here is the right-preferring one an output port's preview asks for, plus
 * the properties both arms are supposed to share, which is the half a per-caller copy of this
 * arithmetic used to be free to get wrong on one side only.
 */

import { describe, expect, it } from 'vitest'

import { hoverPlacement } from './hoverPlacement'

const SOCKET = { left: 400, top: 300, width: 11, height: 11 }
const SCREEN = { width: 1440, height: 900 }
const BOX = { width: 340, height: 200 }

function place(anchor = SOCKET, viewport = SCREEN) {
  return hoverPlacement({
    anchor,
    ...BOX,
    viewport,
    prefer: 'right',
    gap: 12,
    margin: 8,
  })
}

describe('hoverPlacement, preferring right', () => {
  it('opens clear of the anchor, so the card an output belongs to stays visible', () => {
    const at = place()
    expect(at.left).toBe(400 + 11 + 12)
    expect(at.covers).toBe(false)
  })

  it('centres on the anchor', () => {
    // The socket's centre is 305.5; a 200-tall box hangs half above and half below it.
    expect(place().top).toBe(305.5 - 100)
  })

  it('clamps rather than flipping when the preferred side runs out', () => {
    /*
     * The measurement `hoverPlacement`'s note records: a flip puts the whole box over the card
     * whose output this is, where the clamp slides it partly over and leaves the card's left
     * half — its title, its state, its params — readable.
     */
    const at = place({ left: 1300, top: 300, width: 11, height: 11 })
    expect(at.left).toBe(SCREEN.width - BOX.width - 8)
    // And it says so, which is what the flag is for.
    expect(at.covers).toBe(true)
  })

  it('keeps the top edge when the window is shorter than the panel', () => {
    const at = place(SOCKET, { width: 1440, height: 120 })
    expect(at.top).toBe(8)
  })

  it('never leaves the window on either axis', () => {
    for (const left of [0, 200, 700, 1439]) {
      for (const top of [0, 5, 450, 899]) {
        const at = place({ left, top, width: 11, height: 11 })
        expect(at.left).toBeGreaterThanOrEqual(8)
        expect(at.left + BOX.width).toBeLessThanOrEqual(SCREEN.width - 8)
        expect(at.top).toBeGreaterThanOrEqual(8)
        expect(at.top + BOX.height).toBeLessThanOrEqual(SCREEN.height - 8)
      }
    }
  })

  it('answers the two sides oppositely on one anchor', () => {
    const right = place()
    const left = hoverPlacement({
      anchor: SOCKET,
      ...BOX,
      viewport: SCREEN,
      prefer: 'left',
      gap: 12,
      margin: 8,
    })
    expect(left.left).toBeLessThan(SOCKET.left)
    expect(right.left).toBeGreaterThan(SOCKET.left)
    expect(left.top).toBe(right.top)
  })
})
