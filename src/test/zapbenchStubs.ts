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
  /**
   * Serve pyramid levels that no longer average the level below them, 1% off at every cell — the
   * re-release `verifiedLevel` exists for, where every row would still look like activity. Relative,
   * because this store's values run to millions and a fixed offset hides inside any tolerance.
   */
  skewLevels?: boolean
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

/** The pyramid level a URL addresses, as its averaging factor. The row-major copy is 1. */
function levelScale(href: string): number {
  const level = /traces_rastermap_sorted\/s(\d)\//.exec(href)
  return level ? 2 ** Number(level[1]) : 1
}

/** Mean of `valueAt` over each bin of `scale` along an axis of `length`, the last bin partial. */
function binMeans(
  length: number,
  scale: number,
  valueAt: (index: number) => number,
): Float64Array {
  const out = new Float64Array(Math.ceil(length / scale))
  for (let bin = 0; bin < out.length; bin++) {
    let sum = 0
    const end = Math.min((bin + 1) * scale, length)
    for (let index = bin * scale; index < end; index++) sum += valueAt(index)
    out[bin] = sum / (end - bin * scale)
  }
  return out
}

/**
 * What the fake store holds at `(t, row)` of a level of the sorted copy: the mean of the
 * full-resolution cells under it, clipped to the release.
 *
 * A plain mean over whatever real cells a bin covers, where the release builds `s2` from `s1` and
 * so weights a partial *time* bin differently (see `recording.ts`). The reader never reads one.
 */
export function levelCellValue(
  t: number,
  row: number,
  scale: number,
  sorting: readonly number[] = defaultSorting(),
): number {
  const lastStep = Math.min((t + 1) * scale, TRACE_TIMESTEPS)
  let steps = 0
  for (let step = t * scale; step < lastStep; step++) steps += step
  const lastCell = Math.min((row + 1) * scale, TRACE_COLUMNS)
  let cells = 0
  for (let position = row * scale; position < lastCell; position++) cells += sorting[position]!
  return cellValue(steps / (lastStep - t * scale), cells / (lastCell - row * scale))
}

export function serveTraceChunks(options: TraceStoreOptions = {}): TraceStoreCall[] {
  const calls: TraceStoreCall[] = []
  // sorted position -> original column, so the fake can fill a transposed chunk.
  const sorting = options.sorting ?? defaultSorting()
  /*
   * `cellValue` is linear, so a level's mean over a block is the mean timestep × 1000 plus the
   * mean column — one table per axis per level, built once rather than per cell per request.
   */
  const axes = new Map<string, { time: Float64Array; cell: Float64Array }>()
  const axesFor = (scale: number, sorted: boolean) => {
    const key = `${scale}:${sorted}`
    const held = axes.get(key)
    if (held) return held
    const built = {
      time: binMeans(TRACE_TIMESTEPS, scale, (step) => step),
      cell: binMeans(TRACE_COLUMNS, scale, (position) =>
        sorted ? sorting[position]! : position,
      ),
    }
    axes.set(key, built)
    return built
  }
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
    const scale = levelScale(href)
    const { time, cell } = axesFor(scale, isSorted)
    /*
     * Only the requested values are built, since a whole-population read asks for hundreds of
     * chunks and the unrequested ones cost as much to fill as the rest. The value at an index is
     * the same either way, so this changes the cost of the fake and nothing it answers.
     */
    const parsed = range ? /bytes=(\d+)-(\d+)/.exec(range) : null
    const first = parsed ? Number(parsed[1]) / 4 : 0
    const last = parsed ? (Number(parsed[2]) + 1) / 4 : CHUNK_T * CHUNK_F
    const chunk = new Float32Array(last - first)
    for (let index = first; index < last; index++) {
      /*
       * The sorted copy holds the same values under a permuted column, stored transposed
       * (`order: [1, 0]`) so a neuron's timesteps are contiguous. Building the fake that way
       * round — rather than transposing a plain chunk — is what makes it able to disagree with
       * the reader if the reader's offsets are wrong.
       */
      const localT = isSorted ? index % CHUNK : Math.floor(index / CHUNK)
      const localA = isSorted ? Math.floor(index / CHUNK) : index % CHUNK
      const t = chunkRow * CHUNK + localT
      const axis = chunkCol * CHUNK + localA
      chunk[index - first] =
        t < time.length && axis < cell.length
          ? (time[t]! * 1000 + cell[axis]!) * (options.skewLevels && scale > 1 ? 1.01 : 1)
          : 0
    }
    const body = new Uint8Array(chunk.buffer)
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
