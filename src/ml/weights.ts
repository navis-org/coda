/**
 * Fetching a model's weights, checking them, and keeping them.
 *
 * A point affinity encoder is 385 MB. That is not a file you download twice, and it is not one
 * you trust without checking: a truncated or proxy-mangled body produces a session that loads and
 * answers wrongly, which is worse than one that fails.
 *
 * Three properties, each learned from something in this repo that already keeps them:
 *
 *  - **Verified before use.** Every body is hashed and compared with the manifest's `sha256`
 *    before it is cached or handed back. `scripts/probe-affinity.py` does the same thing on the
 *    other side of the seam, and it caught a one-byte corruption that otherwise surfaced as an
 *    opaque ONNX Runtime load failure.
 *  - **Never fatal.** A cache that cannot be opened, written or read must look exactly like a
 *    cache miss — `src/data/cache.ts` states that rule and this follows it. Private-mode Firefox
 *    and a browser with storage switched off are not errors, they are slow next sessions.
 *  - **Its own database.** `src/data/idb.ts` keeps six, deliberately, because sharing one means
 *    racing on a version bump. This is the seventh, and it holds blobs rather than structured
 *    values, so a quota failure here must not evict the dataset cache.
 */

import { attempt, database, readKey } from '../data/idb'
import type { LoadedManifest, ModelPart } from './manifest'
import { fileUrl } from './manifest'

const WEIGHTS = database({ name: 'coda-models', version: 1, stores: ['weights'] })

/** How far a download has got. `total` is the manifest's figure, so it is known before the body. */
export interface WeightProgress {
  readonly id: string
  readonly variant: string
  readonly part: ModelPart
  readonly received: number
  readonly total: number
  /** True once the bytes came from the cache rather than the network. */
  readonly cached: boolean
}

export interface WeightOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: WeightProgress) => void
  /** Skip the cache entirely. For a probe measuring a cold fetch. */
  readonly skipCache?: boolean
}

export class WeightError extends Error {}

/** The cache key. The hash is in it, so a reconverted model can never collide with the old one. */
function keyFor(id: string, variant: string, part: ModelPart, sha256: string): string {
  return `${id}/${variant}/${part}/${sha256}`
}

/**
 * sha256 of a buffer, as lower-case hex.
 *
 * `crypto.subtle` is unavailable on an insecure origin, which is also where WebGPU is unavailable,
 * so a caller that got this far has it. Absent, we refuse rather than skipping the check: an
 * unverified 385 MB download is the thing this module exists to prevent.
 */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new WeightError('No SubtleCrypto, so the weights cannot be verified')
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function fromCache(key: string): Promise<ArrayBuffer | undefined> {
  return readKey<ArrayBuffer, undefined>(WEIGHTS, 'weights', key, undefined)
}

async function toCache(key: string, bytes: ArrayBuffer): Promise<void> {
  // `attempt`, not `commit`: this is a write nobody asked for. Failing to *remember* 385 MB is
  // not failing to fetch it, and a quota refusal here is the common case, not an exceptional one.
  await attempt(
    WEIGHTS,
    'weights',
    'readwrite',
    (tx) => tx.objectStore('weights').put(bytes, key),
    undefined,
  )
}

/**
 * Stream a body, reporting progress against the manifest's declared size.
 *
 * `Content-Length` is deliberately not trusted for the total — it is absent under
 * `Transfer-Encoding: chunked` and wrong behind a recompressing proxy, and the manifest already
 * states the size authoritatively.
 */
async function download(
  url: string,
  total: number,
  report: (received: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new WeightError(`${url} answered ${response.status}`)
  if (!response.body) return response.arrayBuffer()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    report(received)
  }
  // One copy at the end rather than a growing buffer: the parts are known only as they arrive,
  // and `Blob` would add a second copy on the way out.
  const joined = new Uint8Array(received)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.byteLength
  }
  if (received !== total) {
    throw new WeightError(`${url} gave ${received} bytes, the manifest says ${total}`)
  }
  return joined.buffer
}

/**
 * One part's weights: from the cache if they are there and still match, else over the network.
 *
 * The hash is checked on both paths. A cached body that no longer matches is treated as a miss
 * and refetched rather than reported — the only way it happens is a corrupted store, and the
 * caller can do nothing useful with that news.
 */
export async function loadWeights(
  loaded: LoadedManifest,
  variant: string,
  part: ModelPart,
  options: WeightOptions = {},
): Promise<ArrayBuffer> {
  const { manifest } = loaded
  const entry = manifest.files.find((f) => f.variant === variant && f.part === part)
  if (!entry) throw new WeightError(`${manifest.id} has no ${variant}/${part}`)

  const key = keyFor(manifest.id, variant, part, entry.sha256)
  const announce = (received: number, cached: boolean) =>
    options.onProgress?.({
      id: manifest.id,
      variant,
      part,
      received,
      total: entry.bytes,
      cached,
    })

  if (!options.skipCache) {
    const held = await fromCache(key)
    if (held && (await sha256Hex(held)) === entry.sha256) {
      announce(held.byteLength, true)
      return held
    }
  }

  const url = fileUrl(loaded, variant, part)
  const bytes = await download(
    url,
    entry.bytes,
    (received) => announce(received, false),
    options.signal,
  )
  const got = await sha256Hex(bytes)
  if (got !== entry.sha256) {
    throw new WeightError(
      `${url} does not match the manifest: sha256 ${got.slice(0, 12)} against ` +
        `${entry.sha256.slice(0, 12)}`,
    )
  }
  if (!options.skipCache) await toCache(key, bytes)
  return bytes
}

/** Forget every cached model. For the storage panel, and for a probe measuring a cold fetch. */
export async function clearWeights(): Promise<void> {
  await attempt(
    WEIGHTS,
    'weights',
    'readwrite',
    (tx) => tx.objectStore('weights').clear(),
    undefined,
  )
}

/** Test seam, matching the other six stores: drop the memoised connection. */
export function resetWeightStore(): void {
  WEIGHTS.reset()
}
