/**
 * The guard `setup.ts` puts under every test file: no test reaches a chunkedgraph edit endpoint.
 * Which URLs are edits is `isChunkedgraphEdit`, tested beside it (`sandboxWrites.test.ts`).
 */

import { describe, expect, it } from 'vitest'

import { takeWriteAttempts } from './writeGuard'

describe('the write guard', () => {
  /**
   * The installed `fetch` itself, with no stub: refused, and recorded so the test would fail. The
   * host is `.invalid`, which never resolves, so a guard that has gone missing fails this test
   * without a request reaching any server — the first version of it sent one to the sandbox.
   */
  it('refuses an unstubbed edit request and records it', async () => {
    const url = 'https://chunkedgraph.invalid/segmentation/api/v1/table/mar2021_test/merge'
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow(/edit endpoint/)
    await expect(fetch(new Request(url, { method: 'POST' }))).rejects.toThrow(/edit endpoint/)
    // A Request-like object from another realm or class, which `instanceof Request` would miss.
    const foreign = { url, method: 'POST' } as unknown as Request
    await expect(fetch(foreign)).rejects.toThrow(/edit endpoint/)
    // Taken here, so the guard's own check after this test finds nothing — it would fail it otherwise.
    expect(takeWriteAttempts()).toEqual([url, url, url])
  })
})
