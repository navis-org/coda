/**
 * `memoPromise`: the two things a memo may keep, and the one thing it may never keep.
 *
 * The case that matters is the rejection. It is what CATMAID's listing got wrong once — a `??=`
 * that replayed a failed request for the life of the tab — and each variant is asked separately,
 * because the two evict on different paths (`catch` against `finally`) and a helper that got one
 * right would pass a test asking only about the other.
 */

import { describe, expect, it, vi } from 'vitest'

import type { SharedAsk } from './memoPromise'
import { ReplayedFailures, memoPromise, shareInFlight, untilAborted } from './memoPromise'

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

describe('untilAborted', () => {
  it('rejects at once on a signal already aborted, and still observes the work', async () => {
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    const work = deferred<number>()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await expect(untilAborted(work.promise, aborted.signal)).rejects.toThrow('cancelled')
      // The work fails after nobody is waiting for it any more: that is not an unhandled rejection.
      work.reject(new Error('server said no'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('ReplayedFailures', () => {
  it('replays a failure under the credential it was met with, and not under another', () => {
    const failures = new ReplayedFailures<string>()
    failures.record('k', new Error('401'), 'old-token')
    expect(() => failures.check('k', 'old-token')).toThrow('401')
    // Signing in is a reason to ask again at once.
    expect(() => failures.check('k', 'new-token')).not.toThrow()
  })

  it('never records a cancel, and forgets on request', () => {
    const failures = new ReplayedFailures<string>()
    const aborted = new AbortController()
    aborted.abort()
    failures.record('k', new Error('cancelled'), undefined, aborted.signal)
    expect(() => failures.check('k', undefined)).not.toThrow()
    failures.record('k', new Error('500'), undefined)
    failures.forget('k')
    expect(() => failures.check('k', undefined)).not.toThrow()
  })
})

/**
 * **Many keys asked once between however many callers want them**, and stopped only when every
 * one of them has stopped waiting — a single caller's Cancel must not fail another's answer.
 */
describe('shareInFlight', () => {
  /** An `ask` the test answers by hand, recording what it was asked and whether it was stopped. */
  const gatedAsk = () => {
    const asked: string[][] = []
    const stopped: boolean[] = []
    const answers: (() => void)[] = []
    const held = new Set<string>()
    const ask = (mine: string[], signal: AbortSignal) => {
      asked.push(mine)
      const at = stopped.push(false) - 1
      signal.addEventListener('abort', () => (stopped[at] = true))
      return new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason))
        answers.push(() => {
          for (const key of mine) held.add(key)
          resolve()
        })
      })
    }
    return { asked, stopped, answers, held, ask }
  }

  it('asks once for keys two callers want, and answers both', async () => {
    const g = gatedAsk()
    const asking = new Map<string, SharedAsk>()
    const a = shareInFlight(['1', '2'], (k) => g.held.has(k), asking, g.ask, undefined)
    const b = shareInFlight(['2', '3'], (k) => g.held.has(k), asking, g.ask, undefined)
    expect(g.asked).toEqual([['1', '2'], ['3']])
    g.answers.forEach((go) => go())
    await Promise.all([a, b])
    expect(asking.size).toBe(0)
  })

  it('keeps a request going while anyone still waits on it', async () => {
    const g = gatedAsk()
    const asking = new Map<string, SharedAsk>()
    const leaving = new AbortController()
    const a = shareInFlight(['1'], (k) => g.held.has(k), asking, g.ask, leaving.signal)
    const b = shareInFlight(['1'], (k) => g.held.has(k), asking, g.ask, undefined)
    leaving.abort()
    await expect(a).rejects.toThrow()
    expect(g.stopped).toEqual([false])
    g.answers[0]!()
    await b
    expect(g.held.has('1')).toBe(true)
  })

  /* A caller that left on another request's failure must not keep this one running for nobody. */
  it('gives up a caller’s place when one of its requests fails, not only when it cancels', async () => {
    const g = gatedAsk()
    const asking = new Map<string, SharedAsk>()
    const staying = new AbortController()
    // B owns '2'; A joins it and owns '1', which will fail.
    const b = shareInFlight(['2'], (k) => g.held.has(k), asking, g.ask, staying.signal)
    const failing = (mine: string[], signal: AbortSignal) =>
      mine.includes('1') ? Promise.reject(new Error('refused')) : g.ask(mine, signal)
    const a = shareInFlight(['1', '2'], (k) => g.held.has(k), asking, failing, undefined)
    await expect(a).rejects.toThrow('refused')
    staying.abort()
    await expect(b).rejects.toThrow()
    expect(g.stopped).toEqual([true])
  })

  it('stops a request nobody waits for any more, and the next caller asks afresh', async () => {
    const g = gatedAsk()
    const asking = new Map<string, SharedAsk>()
    const leaving = new AbortController()
    const a = shareInFlight(['1'], (k) => g.held.has(k), asking, g.ask, leaving.signal)
    leaving.abort()
    await expect(a).rejects.toThrow()
    expect(g.stopped).toEqual([true])
    expect(asking.size).toBe(0)
    const again = shareInFlight(['1'], (k) => g.held.has(k), asking, g.ask, undefined)
    expect(g.asked).toEqual([['1'], ['1']])
    g.answers[1]!()
    await again
  })
})
