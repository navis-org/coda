/**
 * The verify-and-cache path, against a real IndexedDB (`fake-indexeddb`) for the reason
 * `datasetCache.test.ts` gives: the in-memory fallback would pass every one of these without
 * exercising a store.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadedManifest, ModelManifest } from './manifest'
import { MANIFEST_SCHEMA } from './manifest'
import { clearWeights, loadWeights, resetWeightStore } from './weights'

const BODY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function loaded(over: Record<string, unknown> = {}): Promise<LoadedManifest> {
  const manifest = {
    id: 'affinity-flywire',
    manifestSchema: MANIFEST_SCHEMA,
    randomWeights: false,
    files: [
      {
        variant: 'mixed',
        part: 'encoder',
        file: 'mixed/encoder.onnx',
        url: null,
        bytes: BODY.byteLength,
        sha256: await sha256Of(BODY),
        quantisation: { kind: 'nbits', bits: 8 },
        ...over,
      },
    ],
  } as unknown as ModelManifest
  return { manifest, url: 'https://models.invalid/affinity/manifest.json' }
}

/** A body delivered as a stream, so the progress path is the one under test. */
function respondWith(bytes: Uint8Array, status = 200) {
  return vi.fn(async (_url: string) =>
    status === 200
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, 4))
              controller.enqueue(bytes.slice(4))
              controller.close()
            },
          }),
          { status },
        )
      : new Response('no', { status }),
  )
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetWeightStore()
})
afterEach(() => vi.unstubAllGlobals())

describe('loadWeights', () => {
  it('fetches, verifies and reports progress against the manifest size', async () => {
    const fetched = respondWith(BODY)
    vi.stubGlobal('fetch', fetched)
    const seen: number[] = []
    const got = await loadWeights(await loaded(), 'mixed', 'encoder', {
      onProgress: (p) => seen.push(p.received),
    })
    expect(new Uint8Array(got.bytes)).toEqual(BODY)
    expect(seen).toEqual([4, 8])
    expect(fetched.mock.calls[0]?.[0]).toBe(
      'https://models.invalid/affinity/mixed/encoder.onnx',
    )
  })

  /**
   * The one that matters. A truncated or proxy-mangled body produces a session that loads and
   * answers wrongly, which is worse than one that fails -- and the probe on the other side of
   * this seam caught exactly that from a one-byte difference.
   */
  it('refuses a body whose hash does not match', async () => {
    vi.stubGlobal('fetch', respondWith(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])))
    await expect(loadWeights(await loaded(), 'mixed', 'encoder', {})).rejects.toThrow(
      /does not match the manifest/,
    )
  })

  it('refuses a body of the wrong length before hashing it', async () => {
    vi.stubGlobal('fetch', respondWith(new Uint8Array([1, 2, 3, 4])))
    await expect(loadWeights(await loaded(), 'mixed', 'encoder', {})).rejects.toThrow(
      /gave 4 bytes, the manifest says 8/,
    )
  })

  it('serves the second call from the cache without fetching', async () => {
    const fetched = respondWith(BODY)
    vi.stubGlobal('fetch', fetched)
    const at = await loaded()
    ;(await loadWeights(at, 'mixed', 'encoder', {})).remember()
    const second: boolean[] = []
    const got = await loadWeights(at, 'mixed', 'encoder', {
      onProgress: (p) => second.push(p.cached),
    })
    expect(new Uint8Array(got.bytes)).toEqual(BODY)
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(second).toEqual([true])
  })

  /** The key carries the hash, so a reconverted model cannot be served from the old one's entry. */
  it('does not serve a differently-hashed entry from the cache', async () => {
    vi.stubGlobal('fetch', respondWith(BODY))
    ;(await loadWeights(await loaded(), 'mixed', 'encoder', {})).remember()
    const other = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1])
    const fetched = respondWith(other)
    vi.stubGlobal('fetch', fetched)
    const at = await loaded({ sha256: await sha256Of(other) })
    expect(new Uint8Array((await loadWeights(at, 'mixed', 'encoder', {})).bytes)).toEqual(other)
    expect(fetched).toHaveBeenCalledTimes(1)
  })

  it('reports a refusal by the server', async () => {
    vi.stubGlobal('fetch', respondWith(BODY, 404))
    await expect(loadWeights(await loaded(), 'mixed', 'encoder', {})).rejects.toThrow(/404/)
  })

  /**
   * Two dashboard cells opening one model must be one 385 MB download, not two.
   */
  it('shares one download between concurrent callers', async () => {
    const fetched = respondWith(BODY)
    vi.stubGlobal('fetch', fetched)
    const at = await loaded()
    const [a, b] = await Promise.all([
      loadWeights(at, 'mixed', 'encoder', {}),
      loadWeights(at, 'mixed', 'encoder', {}),
    ])
    expect(new Uint8Array(a.bytes)).toEqual(BODY)
    expect(new Uint8Array(b.bytes)).toEqual(BODY)
    expect(fetched).toHaveBeenCalledTimes(1)
  })

  /**
   * The cache hit must not re-hash: the key contains the sha256, so a hit was verified when it
   * was written, and hashing 385 MB again costs a second on every open to learn nothing the
   * caller can act on. Checked by making the hash itself unavailable.
   */
  it('serves a cache hit without hashing it again', async () => {
    vi.stubGlobal('fetch', respondWith(BODY))
    const at = await loaded()
    ;(await loadWeights(at, 'mixed', 'encoder', {})).remember()

    const digest = vi.fn(() => Promise.reject(new Error('should not hash a cache hit')))
    vi.stubGlobal('crypto', {
      ...globalThis.crypto,
      subtle: { ...globalThis.crypto.subtle, digest },
    })
    expect(new Uint8Array((await loadWeights(at, 'mixed', 'encoder', {})).bytes)).toEqual(BODY)
    expect(digest).not.toHaveBeenCalled()
  })

  /**
   * One caller's Cancel must not abort the download another is sharing. The shared work carries
   * nobody's signal; each caller stops waiting on its own (`untilAborted`).
   */
  it('lets one caller give up without aborting the shared download', async () => {
    const fetched = respondWith(BODY)
    vi.stubGlobal('fetch', fetched)
    const at = await loaded()
    const giving = new AbortController()
    const abandoned = loadWeights(at, 'mixed', 'encoder', { signal: giving.signal })
    const waiting = loadWeights(at, 'mixed', 'encoder', {})
    giving.abort()
    await expect(abandoned).rejects.toThrow()
    expect(new Uint8Array((await waiting).bytes)).toEqual(BODY)
    expect(fetched).toHaveBeenCalledTimes(1)
  })

  it('refetches after the cache is cleared', async () => {
    const fetched = respondWith(BODY)
    vi.stubGlobal('fetch', fetched)
    const at = await loaded()
    ;(await loadWeights(at, 'mixed', 'encoder', {})).remember()
    await clearWeights()
    ;(await loadWeights(at, 'mixed', 'encoder', {})).remember()
    expect(fetched).toHaveBeenCalledTimes(2)
  })
})
