/**
 * The sliced loop, which is the only thing standing between a long node and a frozen tab.
 *
 * Pinned here rather than in whichever node happens to call it, because that asymmetry is what
 * the file exists to end: the loop was re-derived three ways, and only one of the three had a
 * test — so the two that reported progress nobody paints, or never yielded at all, were nobody's
 * failing assertion.
 *
 * What is worth pinning is what a plausible loop gets wrong: it must **await** (a microtask does
 * not let the browser paint, and does not let the click that cancels be dispatched), it must
 * report the items *done*, it must not slice a run that does not need it, and an abort must
 * **reject** rather than resolve short.
 */

import { describe, expect, it } from 'vitest'

import { SLICE_MS, sliced } from './slice'

/**
 * A body costing about half a millisecond, so 64 of them clear a slice.
 *
 * Sized against `CLOCK_MASK` rather than against `SLICE_MS`: the clock is only read every 64th
 * item, so a slice is at least 64 bodies long whatever they cost. A body that took a whole slice
 * on its own — the obvious way to write this — makes every test here 64 slices deep and the
 * suite runs for thirty seconds.
 */
const BODY_MS = SLICE_MS / 32
const slow = () => {
  const until = performance.now() + BODY_MS
  while (performance.now() < until) {
    /* burn */
  }
}

/** Enough bodies for several slices at 64 items each. */
const ITEMS = 256

describe('sliced', () => {
  it('runs the body once per item, in order', async () => {
    const seen: number[] = []
    await sliced(5, {}, (i) => seen.push(i))
    expect(seen).toEqual([0, 1, 2, 3, 4])
  })

  /*
   * The whole point. A loop that never awaits holds the event loop, so its progress is never
   * painted and the abort it checks for can never be set — which is a frozen tab with a dead bar
   * and a Cancel button that does nothing.
   */
  it('hands the browser a turn part way through a long walk', async () => {
    const seen: number[] = []
    let settled = false
    const run = sliced(ITEMS, { progress: (f) => seen.push(f) }, slow).then(() => {
      settled = true
    })
    // A turn of the event loop: if the walk were synchronous it would already be finished.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    await run
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[0]).toBeGreaterThan(0)
  })

  /* Items *done*, not started: reported the other way every run opens at a flat zero. */
  it('reports the fraction done, and always ends at 1', async () => {
    const seen: number[] = []
    await sliced(ITEMS, { progress: (f) => seen.push(f) }, slow)
    expect(seen[seen.length - 1]).toBe(1)
    expect(seen.every((f) => f > 0 && f <= 1)).toBe(true)
  })

  /* A walk that fits in one slice pays nothing — the ordinary case for every cheap node. */
  it('does not break up a walk that finishes inside one slice', async () => {
    const seen: number[] = []
    await sliced(1000, { progress: (f) => seen.push(f) }, () => {})
    expect(seen).toEqual([1])
  })

  it('reports nothing for an empty walk but still closes at 1', async () => {
    const seen: number[] = []
    await sliced(0, { progress: (f) => seen.push(f) }, () => {
      throw new Error('should not run')
    })
    expect(seen).toEqual([1])
  })

  /*
   * Rejects rather than resolving short, and with an `AbortError` — the scheduler tells a
   * cancellation from a failure by the name, so a plain Error would be reported as a broken node.
   */
  it('rejects with an AbortError when the signal is already set', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sliced(4, { signal: controller.signal }, () => {})).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('stops at the next boundary when the signal is set mid-walk', async () => {
    const controller = new AbortController()
    let ran = 0
    await expect(
      sliced(ITEMS, { signal: controller.signal }, () => {
        ran++
        controller.abort()
        slow()
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // Stopped at the first boundary; the whole walk would have been ITEMS.
    expect(ran).toBeLessThan(ITEMS)
  })
})
