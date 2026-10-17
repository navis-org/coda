/**
 * The fit's worker pool against a stand-in `Worker` speaking its protocol — jsdom has none, so
 * without one the pool's dispatch, ordering, failure and cancel paths never run anywhere.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FitSetup } from './fit'
import { prepareFit, residualsAt } from './fit'
import type { FitMembrane } from './passive'
import { startMembrane } from './passive'
import type { FitReply, FitRequest } from './fitPool'
import { fitPool } from './fitPool'
import { build } from './testFixtures'

/** Answers on a later task, in whatever order `delay` says, as a worker would. */
class FakeWorker {
  static made: FakeWorker[] = []
  static delay = (_m: FitMembrane) => 0
  static failOn: ((m: FitMembrane) => boolean) | undefined
  onmessage: ((e: MessageEvent<FitReply>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false
  setups = 0
  private setup: FitSetup | undefined
  constructor() {
    FakeWorker.made.push(this)
  }
  postMessage(request: FitRequest) {
    if (request.type === 'setup') {
      this.setups++
      this.setup = structuredClone(request.setup)
      return
    }
    setTimeout(() => {
      if (this.terminated) return
      const reply: FitReply = FakeWorker.failOn?.(request.membrane)
        ? { type: 'error', message: 'boom' }
        : {
            type: 'residuals',
            residuals: residualsAt(this.setup!, request.membrane),
          }
      this.onmessage?.({ data: reply } as MessageEvent<FitReply>)
    }, FakeWorker.delay(request.membrane))
  }
  terminate() {
    this.terminated = true
  }
}

function setup() {
  const t = Float64Array.from({ length: 200 }, (_, i) => i * 0.1)
  const sweep = {
    sweep: 1,
    t,
    v: new Float64Array(t.length).fill(-60),
    command: t.map((x) => (x >= 5 && x < 15 ? 0.02 : 0)),
  }
  const value = build()
  return { value, setup: prepareFit(value, [sweep], { skipAfterSteps: 0, dt: 0.1 }) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeWorker.made = []
  FakeWorker.delay = () => 0
  FakeWorker.failOn = undefined
})

describe('fitPool', () => {
  it('answers a batch in order across its workers, each handed the setup once', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const { value, setup: s } = setup()
    const start = startMembrane(value)
    const membranes = [1, 2, 3, 4].map((k) => ({ ...start, rm: start.rm * k }))
    // The first answers last, so a pool filing replies by arrival would misorder them.
    FakeWorker.delay = (m) => (m.rm === start.rm ? 20 : 0)
    const pool = fitPool(() => new FakeWorker() as unknown as Worker, s, 3)
    const got = await pool.evaluate(membranes)
    expect(got).toEqual(membranes.map((m) => residualsAt(s, m)))
    expect(FakeWorker.made).toHaveLength(3)
    expect(FakeWorker.made.every((w) => w.setups === 1)).toBe(true)
    // A batch of one starts no more workers and re-sends no setup.
    await pool.evaluate([start])
    expect(FakeWorker.made).toHaveLength(3)
    expect(FakeWorker.made.every((w) => w.setups === 1)).toBe(true)
    pool.close()
    expect(FakeWorker.made.every((w) => w.terminated)).toBe(true)
  })

  it('rejects the batch on a worker’s error, and everything after it', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const { value, setup: s } = setup()
    const start = startMembrane(value)
    FakeWorker.failOn = (m) => m.rm !== start.rm
    const pool = fitPool(() => new FakeWorker() as unknown as Worker, s, 2)
    await expect(pool.evaluate([start, { ...start, rm: 1 }])).rejects.toThrow('boom')
    await expect(pool.evaluate([start])).rejects.toThrow('boom')
    expect(FakeWorker.made.every((w) => w.terminated)).toBe(true)
  })

  it('ends every worker on cancel, rejecting what was waiting', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const { value, setup: s } = setup()
    FakeWorker.delay = () => 50
    const abort = new AbortController()
    const pool = fitPool(() => new FakeWorker() as unknown as Worker, s, 2, abort.signal)
    const waiting = pool.evaluate([startMembrane(value)])
    abort.abort()
    await expect(waiting).rejects.toThrow(/Aborted/)
    expect(FakeWorker.made.every((w) => w.terminated)).toBe(true)
  })

  it('evaluates on this thread where there is no Worker', async () => {
    const { value, setup: s } = setup()
    const pool = fitPool(
      () => {
        throw new Error('no worker should be made')
      },
      s,
      4,
    )
    const m = startMembrane(value)
    expect(await pool.evaluate([m])).toEqual([residualsAt(s, m)])
  })
})
