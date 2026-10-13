/**
 * The page half of a worker job against a fake `Worker` — Node has none, so every other test takes
 * the `here` route and none of these exits ran anywhere. What is pinned is that each way a worker
 * can end settles the promise: an answer, an error, an answer that cannot be read, a cancel — and a
 * cancel that came before the job did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buffersIn, runWorkerJob, serveJob } from './workerJob'

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false
  posted: unknown[] = []
  postMessage(job: unknown) {
    this.posted.push(job)
  }
  terminate() {
    this.terminated = true
  }
}

let spawned: FakeWorker[] = []
const spawn = () => {
  const worker = new FakeWorker()
  spawned.push(worker)
  return worker as unknown as Worker
}
const options = { label: 'test worker', here: async () => 'here' }

beforeEach(() => {
  spawned = []
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => vi.unstubAllGlobals())

describe('a worker job', () => {
  it('settles with the worker’s answer, and lets the worker go', async () => {
    const result = runWorkerJob(spawn, 'job', options)
    spawned[0]!.onmessage!({ data: { type: 'done', result: 42 } })
    await expect(result).resolves.toBe(42)
    expect(spawned[0]!.terminated).toBe(true)
  })

  it('is never started for a signal cancelled before it', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runWorkerJob(spawn, 'job', { ...options, signal: controller.signal }),
    ).rejects.toThrow(/Aborted/)
    expect(spawned).toHaveLength(0)
  })

  it('stops the worker on a cancel during it', async () => {
    const controller = new AbortController()
    const result = runWorkerJob(spawn, 'job', { ...options, signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toThrow(/Aborted/)
    expect(spawned[0]!.terminated).toBe(true)
  })

  it('fails, rather than waiting forever, on an answer that cannot be read', async () => {
    const result = runWorkerJob(spawn, 'job', options)
    spawned[0]!.onmessageerror!()
    await expect(result).rejects.toThrow(/could not be read/)
    expect(spawned[0]!.terminated).toBe(true)
  })

  it('fails with the worker’s own error', async () => {
    const result = runWorkerJob(spawn, 'job', options)
    spawned[0]!.onerror!({ message: 'boom' })
    await expect(result).rejects.toThrow('boom')
    expect(spawned[0]!.terminated).toBe(true)
  })

  it('says to reload where the worker could not be loaded, which a browser gives no words for', async () => {
    const result = runWorkerJob(spawn, 'job', options)
    spawned[0]!.onerror!({ message: '' })
    await expect(result).rejects.toThrow(/test worker could not be loaded.*Reload the page/)
  })

  it('says the worker stopped, not to reload, when it dies silently after it started', async () => {
    // Its code loaded and ran; what ends a running worker without a word is nearly always memory.
    const result = runWorkerJob(spawn, 'job', options)
    spawned[0]!.onmessage!({ data: { type: 'started' } })
    spawned[0]!.onerror!({ message: '' })
    await expect(result).rejects.toThrow(
      /test worker stopped while it was running.*out of memory/,
    )
  })

  it('announces itself on receiving a job, before the handler runs', async () => {
    const posted: unknown[] = []
    vi.stubGlobal('self', { postMessage: (message: unknown) => posted.push(message) })
    let started: unknown
    serveJob(async () => {
      started = posted[0]
      return 1
    })
    await (
      globalThis.self as unknown as { onmessage: (e: { data: unknown }) => Promise<void> }
    ).onmessage({ data: 'job' })
    expect(started).toEqual({ type: 'started' })
    expect(posted.at(-1)).toEqual({ type: 'done', result: 1 })
  })

  it('fails with the handler’s own message when the job threw inside the worker', async () => {
    const result = runWorkerJob(spawn, 'job', options)
    spawned[0]!.onmessage!({ data: { type: 'error', message: 'no such column' } })
    await expect(result).rejects.toThrow('no such column')
    expect(spawned[0]!.terminated).toBe(true)
  })

  it('relays progress while it runs, and keeps the worker until it answers', async () => {
    const heard: [number, string | undefined][] = []
    const result = runWorkerJob(spawn, 'job', {
      ...options,
      onProgress: (fraction, note) => heard.push([fraction, note]),
    })
    spawned[0]!.onmessage!({ data: { type: 'progress', fraction: 0.5, note: 'half' } })
    expect(heard).toEqual([[0.5, 'half']])
    expect(spawned[0]!.terminated).toBe(false)
    spawned[0]!.onmessage!({ data: { type: 'done', result: 1 } })
    await expect(result).resolves.toBe(1)
  })
})

describe('buffersIn', () => {
  it('finds every typed array’s buffer however deep, each once', () => {
    const shared = new Float64Array(4)
    const result = {
      t: shared,
      views: [new Int32Array(2), shared.subarray(1)],
      nested: { deep: { u: new Uint8Array(3) } },
      text: 'x',
      none: undefined,
    }
    const found = buffersIn(result)
    expect(found).toHaveLength(3)
    expect(found).toContain(shared.buffer)
    expect(found).toContain(result.nested.deep.u.buffer)
  })
})
