/**
 * The arithmetic behind dragging nodes in the network viewer.
 *
 * Sigma needs WebGL and jsdom has none, so the component's drag wiring cannot be exercised
 * at all here — which is exactly why the part that decides *what moves* and *where it lands*
 * was pulled out into `networkDrag.ts`. These are the questions a mistake would answer
 * silently: a selection quietly collapsing onto the cursor, a second drag compounding the
 * first, a click being eaten because the hand shook.
 */

import { describe, expect, it } from 'vitest'

import { DRAG_SLOP, beginDrag, beyondSlop, dragPositions } from './networkDrag'
import type { Positioned } from './networkLayout'

const PLACES: Record<string, Positioned> = {
  a: { x: 0, y: 0 },
  b: { x: 10, y: 20 },
  c: { x: -5, y: 5 },
}

const positionOf = (id: string): Positioned | undefined => PLACES[id]

/** A grab whose pointer sits somewhere other than the node's centre, which is the point. */
function grab(node: string, selection: string[] = [], at = { x: 3, y: 4 }) {
  return beginDrag(node, new Set(selection), positionOf, { graph: at, viewport: at })
}

describe('beginDrag', () => {
  it('picks up only the grabbed node when it is not selected', () => {
    const state = grab('a', ['b', 'c'])
    expect([...(state?.start.keys() ?? [])]).toEqual(['a'])
  })

  it('picks up the whole selection when the grabbed node is part of it', () => {
    const state = grab('a', ['a', 'b'])
    expect([...(state?.start.keys() ?? [])].sort()).toEqual(['a', 'b'])
  })

  it('drops selected ids the graph no longer has', () => {
    // A selection outlives its nodes — an upstream filter, a re-run — and those ids are
    // simply not picked up rather than being an error.
    const state = grab('a', ['a', 'gone'])
    expect([...(state?.start.keys() ?? [])]).toEqual(['a'])
  })

  it('declines a node with no position', () => {
    expect(grab('nowhere')).toBeNull()
  })

  it('starts un-moved', () => {
    expect(grab('a')?.moved).toBe(false)
  })
})

describe('dragPositions', () => {
  it('carries the grab offset rather than snapping the node onto the pointer', () => {
    // Pressed at (3,4) on a node sitting at (0,0), then moved to (13,4): the node travels
    // the same 10 the pointer did and keeps the 3,4 it was held by. Snapping instead would
    // teleport it under the cursor the instant the button went down.
    const state = grab('a')!
    expect(dragPositions(state, { x: 13, y: 4 }).get('a')).toEqual({ x: 10, y: 0 })
  })

  it('keeps a multi-node drag rigid', () => {
    const state = grab('a', ['a', 'b'])!
    const moved = dragPositions(state, { x: 3, y: 104 })
    expect(moved.get('a')).toEqual({ x: 0, y: 100 })
    expect(moved.get('b')).toEqual({ x: 10, y: 120 })
  })

  it('is absolute, not cumulative', () => {
    // Each move is one delta over the positions recorded at the grab. Applying it against
    // the *last* position instead would double every step and run the node off the canvas.
    const state = grab('a')!
    dragPositions(state, { x: 103, y: 4 })
    expect(dragPositions(state, { x: 13, y: 4 }).get('a')).toEqual({ x: 10, y: 0 })
  })
})

describe('beyondSlop', () => {
  it('holds a press still enough to be a click', () => {
    const state = grab('a')!
    expect(beyondSlop(state, { x: 3 + DRAG_SLOP, y: 4 })).toBe(false)
  })

  it('reports a press that travelled', () => {
    const state = grab('a')!
    expect(beyondSlop(state, { x: 3 + DRAG_SLOP + 1, y: 4 })).toBe(true)
  })

  it('measures both axes together', () => {
    const state = grab('a')!
    // 3px each way is 4.24px of travel — past the slop, though neither axis is on its own.
    expect(beyondSlop(state, { x: 6, y: 7 })).toBe(true)
  })
})
