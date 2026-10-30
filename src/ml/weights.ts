/**
 * Fetching a model's weights, checking them, and keeping them.
 *
 * A point affinity encoder is 385 MB. That is not a file you download twice, and it is not one
 * you trust without checking: a truncated or proxy-mangled body produces a session that loads and
 * answers wrongly, which is worse than one that fails.
 *
 * Four properties, each learnt from something in this repo that already keeps it:
 *
 *  - **Verified before it is kept.** Every downloaded body is hashed and compared with the
 *    manifest's `sha256` before it is cached or handed back. The Python probe on the other side
 *    of this seam does the same, and it caught a one-byte corruption that otherwise surfaced as
 *    an opaque ONNX Runtime load failure. Note the *cache* is not re-hashed — see `fromCache`.
 *  - **Never fatal.** A cache that cannot be opened, written or read looks exactly like a miss,
 *    which is `src/data/cache.ts`' rule. Private-mode Firefox and storage switched off are not
 *    errors, they are slow next sessions.
 *  - **Its own database.** `src/data/idb.ts` keeps several, deliberately, because sharing one
 *    means racing on a version bump. This one holds blobs rather than structured values, so a
 *    quota failure here must not evict the dataset cache.
 *  - **One download per key.** Two cells asking for the same model at once are one fetch
 *    (`memoPromise`), not two 385 MB ones.
 */

import { attempt, database, readKey, usage } from '../data/idb'
import type { StoredUsage } from '../data/idb'
import { memoPromise, untilAborted } from '../data/memoPromise'
import { unreachable } from '../data/fetchText'
import type { LoadedManifest } from './manifest'
import { fileUrl, modelFile } from './manifest'

const WEIGHTS = database({ name: 'coda-models', version: 1, stores: ['weights'] })

/** How far a download has got. `total` is the manifest's figure, so it is known before the body. */
export interface WeightProgress {
  readonly id: string
  readonly variant: string
  readonly part: string
  readonly received: number
  readonly total: number
  /** True once the bytes came from the cache rather than the network. */
  readonly cached: boolean
}

export interface WeightOptions {
  readonly signal?: AbortSignal
  /**
   * Bytes received, not a fraction.
   *
   * Deliberately unlike `ctx.progress(fraction, note)`, which every compute path reports through:
   * a download whose total is known is better said in bytes, and the node that owns the UI turns
   * this into a fraction and a `formatBytes` note. Said here so the difference reads as a
   * decision rather than an oversight.
   */
  readonly onProgress?: (progress: WeightProgress) => void
}

export class WeightError extends Error {}

const inflight = new Map<string, Promise<{ bytes: ArrayBuffer; cached: boolean }>>()

/** sha256 of a buffer, as lower-case hex. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new WeightError('No SubtleCrypto, so the weights cannot be verified')
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const write = (body: (tx: IDBTransaction) => void) =>
  // `attempt`, not `commit`: these are writes nobody asked for. Failing to *remember* 385 MB is
  // not failing to fetch it, and a quota refusal is the common case rather than an exceptional one.
  attempt(WEIGHTS, 'weights', 'readwrite', body, undefined)

/**
 * A cached body, trusted without re-hashing it.
 *
 * **The key contains the hash**, so a hit is a body that was verified when it was written. Hashing
 * 385 MB again costs 0.2 s on a machine with SHA extensions and over a second without, every time
 * a model is opened, to detect a corrupted store the caller can do nothing about. The length is
 * checked instead, which catches the truncation that is the realistic store failure, and ONNX
 * Runtime refuses a mangled graph anyway.
 */
async function fromCache(key: string, bytes: number): Promise<ArrayBuffer | undefined> {
  const held = await readKey<ArrayBuffer, undefined>(WEIGHTS, 'weights', key, undefined)
  return held?.byteLength === bytes ? held : undefined
}

/**
 * Stream a body into one buffer of the size the manifest declares.
 *
 * Allocated up front rather than accumulated and joined: the size is known, and the two-pass
 * version peaked at twice the body — 770 MB for this encoder — with a 385 MB memcpy on top.
 * `Content-Length` is deliberately not used for it; it is absent under chunked encoding and wrong
 * behind a recompressing proxy, while the manifest states the size authoritatively.
 */
async function download(
  url: string,
  total: number,
  report: (received: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  let response: Response
  try {
    response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    // A cancellation must stay a cancellation, or giving up reads as the host being unreachable.
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw unreachable(url, 'A model is served from wherever its manifest is.')
  }
  if (!response.ok) throw new WeightError(`${url} answered ${response.status}`)
  if (!response.body) {
    const whole = await response.arrayBuffer()
    if (whole.byteLength !== total) {
      throw new WeightError(`${url} gave ${whole.byteLength} bytes, the manifest says ${total}`)
    }
    return whole
  }

  const reader = response.body.getReader()
  const joined = new Uint8Array(total)
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (received + value.byteLength > total) {
      throw new WeightError(`${url} is longer than the manifest's ${total} bytes`)
    }
    joined.set(value, received)
    received += value.byteLength
    report(received)
  }
  if (received !== total) {
    throw new WeightError(`${url} gave ${received} bytes, the manifest says ${total}`)
  }
  return joined.buffer
}

/** Weights, and the thunk that puts them in the cache. See `loadWeights`. */
export interface LoadedWeights {
  readonly bytes: ArrayBuffer
  /**
   * Cache these bytes. **Call it after the session is built, not before.**
   *
   * The structured clone is another 385 MB, and `InferenceSession.create` is already copying the
   * same 385 MB into the wasm heap — firing the write alongside it put the peak at roughly three
   * times the encoder on the one path whose own likeliest failure is memory. Nothing waits on
   * the write either way, so deferring it costs no latency.
   *
   * A no-op when the bytes came from the cache.
   */
  remember(): void
}

/**
 * One part's weights: from the cache if they are there, else over the network.
 *
 * Concurrent calls for one key share a download, so two dashboard cells opening the same model
 * are one fetch — and, through `untilAborted`, **the shared work carries nobody's signal**: the
 * first caller's Cancel must not abort the download the second is waiting on. Each caller stops
 * waiting on its own.
 */
export function loadWeights(
  loaded: LoadedManifest,
  variant: string,
  part: string,
  options: WeightOptions = {},
): Promise<LoadedWeights> {
  const { manifest } = loaded
  const entry = modelFile(loaded, variant, part)
  // The hash is in the key, so a reconverted model can never be served from the old one's entry.
  const key = `${manifest.id}/${variant}/${part}/${entry.sha256}`

  const announce = (received: number, cached: boolean) =>
    options.onProgress?.({
      id: manifest.id,
      variant,
      part,
      received,
      total: entry.bytes,
      cached,
    })

  const shared = memoPromise(
    inflight,
    key,
    async () => {
      const held = await fromCache(key, entry.bytes)
      if (held) {
        announce(held.byteLength, true)
        return { bytes: held, cached: true }
      }
      const url = fileUrl(loaded, variant, part)
      // No signal: this is the *shared* work. A caller gives up by `untilAborted` below.
      const bytes = await download(url, entry.bytes, (received) => announce(received, false))
      const got = await sha256Hex(bytes)
      if (got !== entry.sha256) {
        throw new WeightError(
          `${url} does not match the manifest: sha256 ${got.slice(0, 12)} against ` +
            `${entry.sha256.slice(0, 12)}`,
        )
      }
      return { bytes, cached: false }
    },
    // Only while in flight: a resolved entry would pin 385 MB in memory for the tab's life.
    { keep: 'inflight' },
  )

  return untilAborted(shared, options.signal).then(({ bytes, cached }) => ({
    bytes,
    // `attempt` swallows its own failures, so there is nothing here to catch. Two callers
    // sharing one download both get a thunk; the second `put` writes identical bytes under one
    // key, which is harmless.
    remember: () => {
      if (!cached) void write((tx) => tx.objectStore('weights').put(bytes, key))
    },
  }))
}

/** Forget every cached model. For the Storage tab, and for a probe measuring a cold fetch. */
export async function clearWeights(): Promise<void> {
  await write((tx) => tx.objectStore('weights').clear())
}

/**
 * What the weight cache holds, for the Memory dialog's Storage tab.
 *
 * No `SizedBy`: that is for a store of small meta records standing in for payload stores the walk
 * *skips* (`uploads.ts`), and here the measured store **is** the payload. `usage` already charges
 * `storedBytes(cursor.value)`, which prices an `ArrayBuffer` at its `byteLength`, so declaring one
 * as well reported a 385 MB cache as 770 MB.
 *
 * Not yet a row in `ui/storageReadout.ts`' `SHELVES`; it joins when a node opens a model.
 */
export function weightsUsage(): Promise<StoredUsage | undefined> {
  return usage(WEIGHTS, 'weights')
}

/** Test seam, matching the other stores: drop the memoised connection. */
export function resetWeightStore(): void {
  WEIGHTS.reset()
  inflight.clear()
}
