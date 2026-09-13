/**
 * A fake ZapBench trace store, built to the released array's real geometry.
 *
 * Here rather than in either test file for `precomputedStubs.ts`' reason — that file exists
 * because its stubs "were written out in three files before they lived here", and this one had
 * reached two with the drift already started: the node's copy had dropped the request log and
 * re-declared the shape constants instead of importing them, so a change to the layout would
 * have been made in one place and not the other.
 *
 * `serveBytes` in `precomputedStubs.ts` cannot serve this: it ignores `Range` entirely, and a
 * ranged read is the whole mechanism under test.
 *
 * Two properties are deliberate. The store honours `Range` **the way GCS does** — 206 with
 * exactly the requested bytes — because the reader's refusal for a store that answers 200 with
 * the whole object is a real branch. And every cell carries a value derived from its own
 * coordinates, so an assertion can name *which* cell arrived rather than only that something
 * did; a transposed or off-by-one read produces numbers of the same magnitude, so a test
 * comparing against a recorded constant would pass through it.
 */

import { vi } from 'vitest'

import { CHUNK_F, CHUNK_T } from '../data/zapbench/readPlan'
import { TRACE_COLUMNS, TRACE_TIMESTEPS } from '../data/zapbench/traces'

/**
 * The chunk shape the release publishes. Imported rather than restated — the fake has to build a
 * chunk, but a fake built to a different shape than the reader addresses tests nothing.
 */
export const CHUNK = CHUNK_T

/** What the fake store holds at `(t, f)` — distinct per cell, so a misread is identifiable. */
export function cellValue(t: number, f: number): number {
  return t * 1000 + f
}

export interface TraceStoreCall {
  url: string
  range: string | undefined
}

/**
 * Stub `fetch` with the fake store, returning the log of requests it received.
 *
 * The log is what lets a test assert the *access pattern* — one range per chunk row, covering
 * only the window, one read per block however many of its neurons were wanted — which is the
 * half of this reader that costs money.
 */
export interface TraceStoreOptions {
  /**
   * Also serve `traces_rastermap_sorted` — `sorting.json` and the transposed `s0` chunks.
   *
   * Off by default, so a test asking about the row-major layout gets it: with the sorted copy
   * available the reader prefers it for most shapes, which is right in production and would
   * quietly move every access-pattern assertion here onto a different array.
   */
  sorted?: boolean
  /**
   * The permutation to serve, as `sorting.json` holds it — sorted position → original column.
   * Defaults to a non-trivial one, because an identity permutation cannot tell a reader that
   * applies it from one that ignores it.
   */
  sorting?: number[]
}

/**
 * The default permutation: reverse order.
 *
 * Deliberately not the identity. Under identity, a reader that forgot to permute at all would
 * pass every test — which is the single most likely mistake, since the sorted copy's columns
 * look exactly like the plain copy's.
 */
export function defaultSorting(): number[] {
  return Array.from({ length: TRACE_COLUMNS }, (_, position) => TRACE_COLUMNS - 1 - position)
}

export function serveTraceChunks(options: TraceStoreOptions = {}): TraceStoreCall[] {
  const calls: TraceStoreCall[] = []
  const sorting = options.sorting ?? defaultSorting()
  // sorted position -> original column, so the fake can fill a transposed chunk.
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const href = String(url)
    const range = new Headers(init?.headers).get('Range') ?? undefined
    calls.push({ url: href, range })

    /*
     * Refuse anything that is not an HTTP(S) URL. The reader addresses the bucket in `gs://`
     * form and converts at the edge; a stub matching on the path alone accepted the unconverted
     * URI and hid a real bug — the sorted route silently never engaged, and every value was
     * still correct because the fallback is a slower way to the same answer.
     */
    if (!/^https?:\/\//.test(href)) {
      throw new Error(`zapbench stub got a non-HTTP url: ${href}`)
    }

    if (href.endsWith('sorting.json')) {
      if (!options.sorted) {
        return Promise.resolve({ ok: false, status: 404, url: href } as Response)
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        url: href,
        text: () => Promise.resolve(JSON.stringify(sorting)),
      } as unknown as Response)
    }

    const match = /\/c\/(\d+)\/(\d+)$/.exec(href)
    if (!match) {
      return Promise.resolve({ ok: false, status: 404, url: href } as Response)
    }
    const isSorted = href.includes('traces_rastermap_sorted')
    if (isSorted && !options.sorted) {
      return Promise.resolve({ ok: false, status: 404, url: href } as Response)
    }
    const chunkRow = Number(match[1])
    const chunkCol = Number(match[2])
    const chunk = new Float32Array(CHUNK_T * CHUNK_F)
    for (let localT = 0; localT < CHUNK; localT++) {
      for (let localA = 0; localA < CHUNK; localA++) {
        const t = chunkRow * CHUNK + localT
        const axis = chunkCol * CHUNK + localA
        /*
         * The sorted copy holds the same values under a permuted column, stored transposed
         * (`order: [1, 0]`) so a neuron's timesteps are contiguous. Building the fake that way
         * round — rather than transposing a plain chunk — is what makes it able to disagree with
         * the reader if the reader's offsets are wrong.
         */
        const f = isSorted ? sorting[axis]! : axis
        const value = t < TRACE_TIMESTEPS && axis < TRACE_COLUMNS ? cellValue(t, f) : 0
        chunk[isSorted ? localA * CHUNK + localT : localT * CHUNK + localA] = value
      }
    }
    const whole = new Uint8Array(chunk.buffer)
    const parsed = range ? /bytes=(\d+)-(\d+)/.exec(range) : null
    const body = parsed ? whole.slice(Number(parsed[1]), Number(parsed[2]) + 1) : whole.slice()
    return Promise.resolve({
      ok: true,
      status: parsed ? 206 : 200,
      url: href,
      arrayBuffer: () =>
        Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
    } as unknown as Response)
  })
  return calls
}
