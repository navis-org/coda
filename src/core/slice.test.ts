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

import { describe, expect, it, vi } from 'vitest'

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

  /**
   * A body that is itself expensive, which is the case the fixed stride could not serve.
   *
   * `Distance between` computes one neuron **pair** per body — twenty thousand nearest-point searches,
   * tens of milliseconds on skeletons and hundreds on meshes. Read every 64th item, the clock is
   * consulted once per 64 *pairs*, so Cancel did nothing for up to twenty-five seconds; below 64
   * items it was never consulted at all and the walk could not be interrupted, which is what a
   * five-by-five comparison of meshes is.
   */
  const EXPENSIVE_MS = SLICE_MS * 1.5
  const expensive = () => {
    const until = performance.now() + EXPENSIVE_MS
    while (performance.now() < until) {
      /* burn */
    }
  }

  it.each([
    // A long walk: the abort must land within a body or two, not sixty-four.
    ['a long walk', 1_000, 2],
    // Fewer items than the old fixed stride, where the clock was never read at all — which is
    // what a five-by-five comparison of meshes is, and why it could not be stopped.
    ['a walk shorter than the old stride', 25, 24],
  ])('is interruptible in %s of expensive bodies', async (_name, total, atMost) => {
    let ran = 0
    const controller = new AbortController()
    await expect(
      sliced(total, { signal: controller.signal }, () => {
        ran++
        expensive()
        controller.abort()
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(ran).toBeLessThanOrEqual(atMost)
  })

  it('still reads the clock rarely when the bodies are cheap', async () => {
    // The optimisation the stride exists for: `performance.now()` is 52% of a do-nothing body.
    // Widening has to survive, or every cheap caller pays for this fix.
    let reads = 0
    const now = performance.now.bind(performance)
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      reads++
      return now()
    })
    await sliced(4096, {}, () => {})
    spy.mockRestore()
    // Climbing 1 → 64 costs a handful per slice; a read per item would be 4,096.
    expect(reads).toBeLessThan(200)
  })

  /**
   * An abort arriving from the **event loop**, which is where a real one comes from.
   *
   * Every other abort test here fires from inside the body, and that is a weaker claim than it
   * looks: it proves the signal is *read*, not that the loop ever gives the browser the turn in
   * which the click could be dispatched at all. A walk that yielded with `await Promise.resolve()`
   * passes those and hangs a tab, because a microtask runs before the browser gets to dispatch
   * anything — which is the failure `yieldToBrowser` exists for and the one a user reports as
   * "the Cancel button does nothing".
   */
  it('stops when the signal is set from a timer while the walk is running', async () => {
    const controller = new AbortController()
    let ran = 0
    // Fires after the walk has started and cannot be seen by the body itself.
    const timer = setTimeout(() => controller.abort(), 20)
    const started = performance.now()
    await expect(
      sliced(100_000, { signal: controller.signal }, () => {
        ran++
        slow()
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    clearTimeout(timer)
    // A body is SLICE_MS/32, so the whole walk would be about a minute and a half. Stopping
    // anywhere near the abort is the property; the generous bound is for a loaded CI box.
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(ran).toBeLessThan(100_000)
  })
})
