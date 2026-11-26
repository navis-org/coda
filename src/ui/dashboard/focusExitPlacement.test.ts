import { describe, expect, it } from 'vitest'

import { PILL_CLEARANCE, placePill } from './focusExitPlacement'

const bounds = { left: 0, right: 1000 }
const W = 100

describe('placePill', () => {
  it('centres the pill when nothing is in the way', () => {
    expect(placePill(W, bounds, [])).toBe(450)
    expect(
      placePill(W, bounds, [
        { left: 10, right: 30 },
        { left: 900, right: 990 },
      ]),
    ).toBe(450)
  })

  it('moves to the nearer side of a control under the centre', () => {
    // Most of the control is right of centre, so the left side is the shorter move.
    const left = placePill(W, bounds, [{ left: 480, right: 560 }])
    expect(left).toBe(480 - PILL_CLEARANCE - W)
    const right = placePill(W, bounds, [{ left: 440, right: 520 }])
    expect(right).toBe(520 + PILL_CLEARANCE)
  })

  it('steps past a row of controls rather than landing between two too close together', () => {
    // A cell's ⤢ and ✕ at the end of the left cell, the next cell's grip just past the border.
    const controls = [
      { left: 440, right: 460 },
      { left: 462, right: 482 },
      { left: 506, right: 520 },
    ]
    const x = placePill(W, bounds, controls)
    for (const c of controls) {
      expect(x + W <= c.left - PILL_CLEARANCE || x >= c.right + PILL_CLEARANCE).toBe(true)
    }
    // Right of the grip (74px from centre) beats left of the ⤢ (114px).
    expect(x).toBe(520 + PILL_CLEARANCE)
  })

  it('stays inside the bounds', () => {
    const x = placePill(W, { left: 0, right: 220 }, [{ left: 40, right: 180 }])
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x + W).toBeLessThanOrEqual(220)
    // Neither side has room, so it falls back to the centre.
    expect(x).toBe(60)
  })

  it('avoids a title too, but gives way on a title before a control', () => {
    const grip = { left: 500, right: 514 }
    const title = { left: 518, right: 600 }
    // Room either side: clear of both, on the nearer side.
    expect(placePill(W, bounds, [grip], [title])).toBe(500 - PILL_CLEARANCE - W)
    // A strip too narrow to clear the title: it may sit on the title, never on the grip.
    const narrow = { left: 380, right: 640 }
    const x = placePill(W, narrow, [grip], [{ left: 400, right: 498 }, title])
    expect(x).toBe(514 + PILL_CLEARANCE)
  })
})
