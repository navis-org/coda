/**
 * The session layout cache.
 *
 * A force layout at a few thousand nodes is earned — settled over seconds, skipped forward,
 * frozen where it looked right — and closing the viewer used to throw all of it away. What
 * matters here is that it comes back only when it still *describes* the graph: a stale layout
 * silently restored over changed data would be worse than recomputing.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { forgetLayouts, recallLayout, rememberLayout } from './layoutMemo'

afterEach(forgetLayouts)

const positions = (ids: string[]) => new Map(ids.map((id, i) => [id, { x: i, y: i }]))

const memo = (ids: string[], signature = 'sig') => ({
  nodeIds: ids,
  signature,
  positions: positions(ids),
})

describe('recallLayout', () => {
  it('returns nothing for a key never stored', () => {
    expect(recallLayout('a', ['x'], 'sig')).toBeUndefined()
  })

  it('returns the layout when the node set and the signature both still match', () => {
    rememberLayout('a', memo(['x', 'y']))
    expect(recallLayout('a', ['x', 'y'], 'sig')?.positions.get('y')).toEqual({ x: 1, y: 1 })
  })

  it('refuses a layout whose signature changed', () => {
    // Switching algorithm, orientation or seed — or pressing re-layout, which bumps a nonce
    // into the signature — must recompute rather than restore.
    rememberLayout('a', memo(['x', 'y']))
    expect(recallLayout('a', ['x', 'y'], 'other')).toBeUndefined()
  })

  it('refuses a layout whose node set changed', () => {
    rememberLayout('a', memo(['x', 'y']))
    expect(recallLayout('a', ['x', 'z'], 'sig')).toBeUndefined()
    expect(recallLayout('a', ['x'], 'sig')).toBeUndefined()
    expect(recallLayout('a', ['x', 'y', 'z'], 'sig')).toBeUndefined()
  })

  it('keeps layouts apart by key, so two network nodes do not share one', () => {
    rememberLayout('a', memo(['x']))
    rememberLayout('b', memo(['x']))
    expect(recallLayout('a', ['x'], 'sig')).toBeTruthy()
    expect(recallLayout('b', ['x'], 'sig')).toBeTruthy()
  })

  it('carries the camera back too, so the framing survives with the layout', () => {
    rememberLayout('a', { ...memo(['x']), camera: { x: 1, y: 2, ratio: 0.5, angle: 0 } })
    expect(recallLayout('a', ['x'], 'sig')?.camera?.ratio).toBe(0.5)
  })
})

describe('bounding the cache', () => {
  it('drops the least recently used once it is full', () => {
    for (let i = 0; i < 9; i++) rememberLayout(`k${i}`, memo(['x']))
    expect(recallLayout('k0', ['x'], 'sig')).toBeUndefined()
    expect(recallLayout('k8', ['x'], 'sig')).toBeTruthy()
  })

  it('counts a recall as a use, so the layout you keep returning to survives', () => {
    rememberLayout('keep', memo(['x']))
    for (let i = 0; i < 7; i++) rememberLayout(`k${i}`, memo(['x']))
    // Touch it, then push one more in: without the bump, `keep` would be the oldest.
    expect(recallLayout('keep', ['x'], 'sig')).toBeTruthy()
    rememberLayout('extra', memo(['x']))
    expect(recallLayout('keep', ['x'], 'sig')).toBeTruthy()
  })

  it('re-storing a key does not consume a second slot', () => {
    for (let i = 0; i < 20; i++) rememberLayout('same', memo(['x']))
    rememberLayout('other', memo(['x']))
    expect(recallLayout('same', ['x'], 'sig')).toBeTruthy()
    expect(recallLayout('other', ['x'], 'sig')).toBeTruthy()
  })
})
