import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkerReply } from './types'

/**
 * A stand-in for the Python worker: it records what it is sent and lets a test answer as the
 * real one does. The engine is otherwise only exercised through a browser, since every bridge's
 * test mocks `callPython`.
 */
class FakeWorker {
  static made: FakeWorker[] = []
  readonly sent: unknown[] = []
  terminated = false
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>()
  constructor() {
    FakeWorker.made.push(this)
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  postMessage(message: unknown) {
    this.sent.push(message)
  }
  terminate() {
    this.terminated = true
  }
  reply(data: WorkerReply) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data })
  }
  /** The id of the last call sent, as the engine numbered it. */
  lastCallId(): number {
    const calls = this.sent.filter((one) => (one as { call?: unknown }).call)
    return (calls.at(-1) as { id: number }).id
  }
}

beforeEach(() => {
  FakeWorker.made = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('document', { baseURI: 'http://localhost/' })
  vi.resetModules()
})
afterEach(() => vi.unstubAllGlobals())

const load = () => import('./engine')
const call = (module: string) => ({ module, fn: 'f', args: [] })

/**
 * **A lane belongs to a module, not to a call.** The cutter holds a labelled box in its worker's
 * heap, so every call to it must land on the same worker — and one that did not would still
 * answer, from a fresh copy of the module with no box open.
 */
describe('which worker a module runs on', () => {
  it('runs the assessor cutter on its own worker, and everything else on the main one', async () => {
    const { laneOf } = await load()
    expect(laneOf('assessorPatches')).toBe('assessor')
    expect(laneOf('cutoutSummary')).toBe('main')
    expect(laneOf('nblast')).toBe('main')
  })

  it('makes one worker per lane, and a Cancel on one leaves the other', async () => {
    const { callPython } = await load()
    const control = new AbortController()
    const search = callPython(call('cutoutSummary'), { signal: control.signal })
    void callPython(call('assessorPatches'))
    expect(FakeWorker.made).toHaveLength(2)
    control.abort()
    await expect(search).rejects.toThrow('Aborted')
    expect(FakeWorker.made.map((one) => one.terminated)).toEqual([true, false])
  })
})

/**
 * **A partial result is handed over and the call stays open** until `done`. Settling on the
 * partial would answer the caller with half a result; dropping the pending entry would lose the
 * final one.
 */
describe('a partial result', () => {
  it('reaches `onPartial` without settling the call, and the final answer still arrives', async () => {
    const { callPython } = await load()
    const partials: unknown[] = []
    let settled = false
    const answer = callPython(call('cutoutSummary'), { onPartial: (one) => partials.push(one) })
    void answer.then(() => (settled = true))
    const worker = FakeWorker.made[0]!
    const id = worker.lastCallId()
    worker.reply({ id, kind: 'partial', result: { candRoot: BigUint64Array.of(7n) } })
    await Promise.resolve()
    expect(partials).toEqual([{ candRoot: BigUint64Array.of(7n) }])
    expect(settled).toBe(false)
    worker.reply({ id, kind: 'done', result: { rows: 1 } })
    await expect(answer).resolves.toEqual({ rows: 1 })
  })

  it('is dropped once the call has ended', async () => {
    const { callPython } = await load()
    const onPartial = vi.fn()
    const answer = callPython(call('cutoutSummary'), { onPartial })
    const worker = FakeWorker.made[0]!
    const id = worker.lastCallId()
    worker.reply({ id, kind: 'done', result: {} })
    await answer
    worker.reply({ id, kind: 'partial', result: {} })
    expect(onPartial).not.toHaveBeenCalled()
  })
})
