/**
 * The two sums behind the dashboard's gestures.
 *
 * Both have an off-by-one whose symptom is "the drag missed" rather than "the number is wrong",
 * which is why they are extracted at all: jsdom performs no layout, so neither is reachable from
 * a mounted test, and in a real browser a half-track error is indistinguishable from a slip of
 * the hand. `networkDrag.ts` records the same split.
 */

import { describe, expect, it } from 'vitest'

import { MIN_ROW_PX, dropIndex, rowHeight, spanFromDrag } from './gridGeometry'

describe('the span a resize drag reaches', () => {
  /*
   * A 4-column grid, 800px wide, 10px gaps: each unit is (800 - 30) / 4 = 192.5px, and the
   * thing that repeats is 202.5px — the unit *plus one gap*. A 1-span cell is 192.5px wide.
   */
  const UNIT = 192.5
  const GAP = 10

  it('stays where it is until the pointer passes the halfway point of the next track', () => {
    // Just under half a track: still one.
    expect(spanFromDrag(UNIT, 1, 90, GAP, 4)).toBe(1)
    // Just over: two.
    expect(spanFromDrag(UNIT, 1, 115, GAP, 4)).toBe(2)
    // A whole track further along, and it is exactly two rather than three.
    expect(spanFromDrag(UNIT, 1, UNIT + GAP, GAP, 4)).toBe(2)
  })

  /*
   * The `+ gap` in the rounding. Without it every span's halfway point sits a gap too far right,
   * so the grip has to be dragged past the *next* column's edge before the cell grows — which
   * reads as a sticky handle, not as arithmetic. Pinned at the widest span, where the error has
   * accumulated over three gaps and is largest.
   */
  it('measures the unit from a cell that already spans several tracks', () => {
    const threeWide = UNIT * 3 + GAP * 2 // 607.5
    expect(spanFromDrag(threeWide, 3, 0, GAP, 4)).toBe(3)
    expect(spanFromDrag(threeWide, 3, 110, GAP, 4)).toBe(4)
    expect(spanFromDrag(threeWide, 3, -110, GAP, 4)).toBe(2)
  })

  it('clamps at both ends rather than running past the grid', () => {
    expect(spanFromDrag(UNIT, 1, 5000, GAP, 4)).toBe(4)
    expect(spanFromDrag(UNIT, 1, -5000, GAP, 4)).toBe(1)
  })

  /*
   * A cell that has not been laid out yet measures zero. Dividing by that produces `Infinity`
   * and then `NaN`, which would reach the store as a span and clamp to 1 — silently collapsing
   * a cell somebody had made wide, at the one moment they are touching it.
   */
  it('keeps the span it has when the measurement is degenerate', () => {
    expect(spanFromDrag(0, 3, 50, GAP, 4)).toBe(3)
    expect(spanFromDrag(Number.NaN, 2, 50, GAP, 4)).toBe(2)
    // Still clamped, so a stale span past the current column count comes down.
    expect(spanFromDrag(0, 9, 0, GAP, 4)).toBe(4)
  })

  it('handles a gapless grid, where the unit and the repeat are the same number', () => {
    expect(spanFromDrag(200, 1, 120, 0, 4)).toBe(2)
    expect(spanFromDrag(200, 1, 80, 0, 4)).toBe(1)
  })
})

describe('the row track height', () => {
  /*
   * The property being asked for is *exactness*: `n` tracks and `n − 1` gaps must come to the
   * area, or the grid overflows its box and every dashboard gets a scrollbar it has not earned —
   * with the bottom row's resize corner behind the status bar. So the test is the reconstruction,
   * not a magic number.
   */
  it('divides the area so the tracks and their gaps come to exactly it', () => {
    for (const [area, gap, tracks] of [
      [783, 10, 6],
      [1000, 8, 6],
      [640, 0, 4],
    ] as const) {
      const row = rowHeight(area, gap, tracks)
      expect(row * tracks + gap * (tracks - 1)).toBeCloseTo(area, 6)
    }
  })

  /*
   * What "a third, a half, two thirds, the whole" actually has to mean, which is **that the
   * stops tile**: three thirds fill the screen, two halves fill the screen, two thirds and a
   * third fill the screen. Stated as the tiling rather than as `height / area ≈ 1/3`, because
   * the second is not quite true and the difference is the point — a cell of two tracks is two
   * sixths of the *track budget* plus one gap, so it is a little under a third of the area, and
   * the gaps it does not span are what make up the rest. A test asserting the loose fraction
   * would pass just as happily on a row height that left a 10px strip at the bottom of every
   * screen.
   */
  it('makes four stops that tile the area exactly', () => {
    const area = 783
    const gap = 10
    const row = rowHeight(area, gap, 6)
    const height = (span: number) => row * span + gap * (span - 1)
    const stacked = (...spans: number[]) =>
      spans.reduce((sum, s) => sum + height(s), 0) + gap * (spans.length - 1)

    expect(stacked(2, 2, 2)).toBeCloseTo(area, 6) // three thirds
    expect(stacked(3, 3)).toBeCloseTo(area, 6) // two halves
    expect(stacked(4, 2)).toBeCloseTo(area, 6) // two thirds and a third
    expect(stacked(6)).toBeCloseTo(area, 6) // the whole thing
    // And they really are the four sizes, in order, none of them equal to another.
    expect(new Set([2, 3, 4, 6].map(height)).size).toBe(4)
  })

  /*
   * A short window, and a container not yet measured. Below the floor the grid scrolls, which is
   * the honest answer — a sixth of 300px is not a view of anything.
   */
  it('floors on a short window and never answers with a degenerate number', () => {
    expect(rowHeight(200, 10, 6)).toBe(MIN_ROW_PX)
    expect(rowHeight(0, 10, 6)).toBe(MIN_ROW_PX)
    expect(rowHeight(Number.NaN, 10, 6)).toBe(MIN_ROW_PX)
    expect(rowHeight(800, 10, 0)).toBe(MIN_ROW_PX)
  })
})

describe('where a dragged cell lands', () => {
  const order = ['a', 'b', 'c', 'd']

  /*
   * The two conversions, and each is a bug on its own. Counting in the list *before* the lift
   * makes a one-place move a no-op; ignoring which half of the target was dropped in makes the
   * end of the list unreachable.
   */
  it('counts in the list after the dragged cell is lifted out', () => {
    // 'a' dropped on the left half of 'c': rest is [b, c, d], so before 'c' is 1.
    expect(dropIndex(order, 'a', 'c', false)).toBe(1)
    // …and on its right half, 2.
    expect(dropIndex(order, 'a', 'c', true)).toBe(2)
  })

  it('can reach the end of the list, which needs the right half of the last cell', () => {
    expect(dropIndex(order, 'a', 'd', true)).toBe(3)
    expect(dropIndex(order, 'a', 'd', false)).toBe(2)
  })

  it('moves a cell backwards without an adjustment of its own', () => {
    expect(dropIndex(order, 'd', 'a', false)).toBe(0)
    expect(dropIndex(order, 'd', 'b', true)).toBe(2)
  })

  /*
   * Dropped on itself. It has to resolve to where the cell already is, so `moveCell` returns the
   * graph unchanged by identity and `commit` records no undo step — otherwise picking a cell up
   * and putting it back costs a ⌘Z.
   */
  it('resolves a drop on the dragged cell to its own place', () => {
    expect(dropIndex(order, 'b', 'b', false)).toBe(1)
    expect(dropIndex(order, 'b', 'b', true)).toBe(1)
  })
})
