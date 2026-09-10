/**
 * `memoPromise`: the two things a memo may keep, and the one thing it may never keep.
 *
 * The case that matters is the rejection. It is what CATMAID's listing got wrong once — a `??=`
 * that replayed a failed request for the life of the tab — and each variant is asked separately,
 * because the two evict on different paths (`catch` against `finally`) and a helper that got one
 * right would pass a test asking only about the other.
 */

import { describe, expect, it, vi } from 'vitest'

import { memoPromise } from './memoPromise'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('memoPromise', () => {
  it("keep: 'resolved' shares one request and keeps it after it lands", async () => {
    const held = new Map<string, Promise<number>>()
    const run = vi.fn(() => Promise.resolve(7))
    const first = memoPromise(held, 'k', run, { keep: 'resolved' })
    expect(memoPromise(held, 'k', run, { keep: 'resolved' })).toBe(first)
    expect(await first).toBe(7)
    expect(memoPromise(held, 'k', run, { keep: 'resolved' })).toBe(first)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("keep: 'inflight' shares one request while pending and asks again once it lands", async () => {
    const held = new Map<string, Promise<number>>()
    const gate = deferred<number>()
    const run = vi.fn(() => gate.promise)
    const first = memoPromise(held, 'k', run, { keep: 'inflight' })
    expect(memoPromise(held, 'k', run, { keep: 'inflight' })).toBe(first)
    gate.resolve(1)
    await first
    expect(held.has('k')).toBe(false)
    void memoPromise(held, 'k', () => Promise.resolve(2), { keep: 'inflight' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each(['resolved', 'inflight'] as const)(
    "never keeps a rejection (keep: '%s')",
    async (keep) => {
      const held = new Map<string, Promise<number>>()
      const failing = memoPromise(held, 'k', () => Promise.reject(new Error('flaky')), { keep })
      await expect(failing).rejects.toThrow('flaky')
      expect(held.has('k')).toBe(false)
      expect(await memoPromise(held, 'k', () => Promise.resolve(3), { keep })).toBe(3)
    },
  )

  it.each(['resolved', 'inflight'] as const)(
    "a late settlement does not evict a newer entry (keep: '%s')",
    async (keep) => {
      // A changed server clears the map and starts again; the old request settling afterwards
      // must not take the new one with it.
      const held = new Map<string, Promise<number>>()
      const old = deferred<number>()
      const stale = memoPromise(held, 'k', () => old.promise, { keep })
      held.clear()
      const fresh = memoPromise(held, 'k', () => new Promise<number>(() => {}), { keep })
      old.reject(new Error('gone'))
      await expect(stale).rejects.toThrow('gone')
      expect(held.get('k')).toBe(fresh)
    },
  )
})
