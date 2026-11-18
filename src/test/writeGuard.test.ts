/**
 * The guard `setup.ts` puts under every test file: no test reaches a chunkedgraph edit endpoint
 * or the verdict log.
 * Which URLs are edits is `isChunkedgraphEdit`, tested beside it (`sandboxWrites.test.ts`).
 */

import { describe, expect, it } from 'vitest'

import { VERDICT_SERVER } from '../data/verdictServer'
import { takeWriteAttempts } from './writeGuard'

describe('the write guard', () => {
  /**
   * The installed `fetch` itself, with no stub: refused, and recorded so the test would fail. The
   * host is `.invalid`, which never resolves, so a guard that has gone missing fails this test
   * without a request reaching any server — the first version of it sent one to the sandbox.
   */
  it('refuses an unstubbed edit request and records it', async () => {
    const url = 'https://chunkedgraph.invalid/segmentation/api/v1/table/mar2021_test/merge'
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow(/server Coda writes to/)
    await expect(fetch(new Request(url, { method: 'POST' }))).rejects.toThrow(
      /server Coda writes to/,
    )
    // A Request-like object from another realm or class, which `instanceof Request` would miss.
    const foreign = { url, method: 'POST' } as unknown as Request
    await expect(fetch(foreign)).rejects.toThrow(/server Coda writes to/)
    // Taken here, so the guard's own check after this test finds nothing — it would fail it otherwise.
    expect(takeWriteAttempts()).toEqual([url, url, url])
  })

  /** Every request, not only a post: even a GET is refused, since a challenge asks for work too. */
  it('refuses any request to the verdict log and records it', async () => {
    const url = `${VERDICT_SERVER}/datastacks`
    await expect(fetch(url)).rejects.toThrow(/server Coda writes to/)
    expect(takeWriteAttempts()).toEqual([url])
  })
})
