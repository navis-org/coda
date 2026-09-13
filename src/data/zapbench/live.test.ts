/**
 * The ZapBench reader against the real bucket.
 *
 * Skipped unless `ZAPBENCH_LIVE` is set, the gate `data/dvid/live.test.ts` uses. Everything in
 * `traces.test.ts` runs against a fake store built to the layout this file *claims* the release
 * has — which is exactly the assumption a fake store cannot check. Three things only the bucket
 * can answer:
 *
 * - the URL and key encoding are right (`c/<row>/<col>`, path-style GCS);
 * - the array still has the shape and the missing compressor the reader's arithmetic needs;
 * - a 206 comes back for a range, rather than a 200 with the whole megabyte.
 *
 * The values are checked against a second, independent read — one four-byte range computed
 * inline here — rather than against recorded numbers, so this stays a check on the *reader*
 * rather than on whether Google has re-released the volume.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { resetTransport } from '../precomputed/transport'
import {
  SORTED_LEVEL,
  SORTED_TRACES,
  TRACE_COLUMNS,
  TRACE_PRODUCTS,
  TRACE_TIMESTEPS,
  ZAPBENCH_RELEASE,
  fetchTraces,
  resetSortingCheck,
  resetTraceCache,
  traceColumnOf,
  verifiedSorting,
} from './traces'

const live = process.env.ZAPBENCH_LIVE ? describe : describe.skip

const BASE = 'https://storage.googleapis.com/zapbench-release/volumes/20240930/traces'
const CHUNK = 512

/** One value, by arithmetic written out here rather than imported — the independent read. */
async function directRead(t: number, f: number): Promise<number> {
  const offset = ((t % CHUNK) * CHUNK + (f % CHUNK)) * 4
  const url = `${BASE}/c/${Math.floor(t / CHUNK)}/${Math.floor(f / CHUNK)}`
  const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + 3}` } })
  expect(response.status).toBe(206)
  return new DataView(await response.arrayBuffer()).getFloat32(0, true)
}

beforeEach(() => {
  resetTraceCache()
  resetSortingCheck()
  resetTransport()
})

live('the released traces array', () => {
  /*
   * Looped over the products rather than asserted for `traces` alone. The single code path below
   * rests on the two arrays having byte-identical geometry, and that claim was prose — so a
   * second product re-released with a compressor or a different chunking would have been read
   * through arithmetic written for the first, which returns noise shaped like a trace rather
   * than failing.
   */
  it.each(TRACE_PRODUCTS.map((product) => product.value))(
    'still has the shape and the missing compressor the reader assumes: %s',
    async (product) => {
      const response = await fetch(
        `https://storage.googleapis.com/zapbench-release/volumes/20240930/${product}/zarr.json`,
      )
      expect(response.ok).toBe(true)
      const meta = (await response.json()) as {
        shape: number[]
        data_type: string
        chunk_grid: { configuration: { chunk_shape: number[] } }
        codecs: Array<{ name: string }>
      }
      expect(meta.shape).toEqual([TRACE_TIMESTEPS, TRACE_COLUMNS])
      expect(meta.data_type).toBe('float32')
      expect(meta.chunk_grid.configuration.chunk_shape).toEqual([CHUNK, CHUNK])
      /*
       * The load-bearing one. Every byte offset in the reader is arithmetic, which is only true
       * while `bytes` is the whole codec chain — a compressor added here would not fail, it
       * would return noise shaped like a trace.
       */
      expect(meta.codecs.map((codec) => codec.name)).toEqual(['bytes'])
    },
    60_000,
  )

  it('names the bucket the reader reads', () => {
    expect(ZAPBENCH_RELEASE).toBe('gs://zapbench-release/volumes/20240930')
  })

  /*
   * Real fish2 matches, from `pnpm probe:zapbench`. 5 and 10 share a 512-neuron block, so this
   * also covers the case where one read serves two neurons; 71,720 is the array's last column
   * and lands in the final chunk column, which is padded past the real extent.
   */
  it('reads what the array holds, for neurons sharing a block and for the last column', async () => {
    const ids = [5, 10, TRACE_COLUMNS]
    const columns = ids.map((id) => traceColumnOf(id)!)
    const window = { start: 2423, end: 2427 }
    const result = await fetchTraces({ product: 'traces', columns, window })
    const steps = window.end - window.start
    expect(result.values).toHaveLength(ids.length * steps)

    for (const [row, column] of columns.entries()) {
      for (const step of [0, steps - 1]) {
        const expected = await directRead(window.start + step, column)
        expect(result.values[row * steps + step]).toBe(expected)
      }
    }
    // Not a padded region read by accident: a real trace is not flat zero.
    expect(result.values.some((value) => value !== 0)).toBe(true)
  }, 120_000)

  it('reads a window crossing a chunk-row boundary', async () => {
    const window = { start: 510, end: 515 }
    const result = await fetchTraces({ product: 'traces', columns: [4], window })
    for (const [step, t] of [510, 511, 512, 513, 514].entries()) {
      expect(result.values[step]).toBe(await directRead(t, 4))
    }
  }, 120_000)

  it('reads the second product the node offers', async () => {
    const result = await fetchTraces({
      product: 'stimulus_evoked_response',
      columns: [4],
      window: { start: 100, end: 102 },
    })
    expect(result.values).toHaveLength(2)
    expect(result.bytesRead).toBeGreaterThan(0)
  }, 120_000)
})

/**
 * The transposed copy, which is the route the reader actually prefers.
 *
 * Everything above checks `traces`. This is the array a real session reads, and the two things
 * only the bucket can answer about it are whether the permutation still describes it and whether
 * the transpose is still the transpose — neither of which fails loudly if it changes.
 */
live('the transposed copy', () => {
  it('carries a transpose codec and the shape the reader assumes', async () => {
    const response = await fetch(
      `https://storage.googleapis.com/zapbench-release/volumes/20240930/` +
        `traces_rastermap_sorted/${SORTED_LEVEL}/zarr.json`,
    )
    expect(response.ok).toBe(true)
    const meta = (await response.json()) as {
      shape: number[]
      codecs: Array<{ name: string; configuration?: { order?: number[] } }>
    }
    expect(meta.shape).toEqual([TRACE_TIMESTEPS, TRACE_COLUMNS])
    /*
     * `transpose` then `bytes`, and **no compressor** — the same load-bearing absence as the
     * row-major copy. The order matters as much as the presence: `[1, 0]` is what puts a
     * neuron's timesteps together, and `[0, 1]` would silently be the row-major layout read
     * through transposed arithmetic.
     */
    expect(meta.codecs.map((codec) => codec.name)).toEqual(['transpose', 'bytes'])
    expect(meta.codecs[0]?.configuration?.order).toEqual([1, 0])
  }, 60_000)

  it('names the sorted copy the reader addresses', () => {
    expect(SORTED_TRACES).toBe(`${ZAPBENCH_RELEASE}/traces_rastermap_sorted`)
  })

  it('still has a permutation that describes the array', async () => {
    const inverse = await verifiedSorting({})
    // Undefined means the run-time check refused it — which is a working fallback, but on the
    // real bucket today it means the release changed and this feature has silently stopped.
    expect(inverse).toBeDefined()
    expect(inverse).toHaveLength(TRACE_COLUMNS)
  }, 120_000)

  /*
   * The property the whole route rests on: the two arrays are the same numbers. Read through the
   * reader itself, both ways, and compared — so a wrong permutation or a wrong transpose offset
   * shows up as a disagreement rather than as plausible values from the wrong neuron.
   */
  it('agrees with the row-major copy, neuron for neuron', async () => {
    const ids = [5, 10, TRACE_COLUMNS]
    const columns = ids.map((id) => traceColumnOf(id)!)
    const window = { start: 2423, end: 2443 }

    const viaSorted = await fetchTraces({ product: 'traces', columns, window })
    resetTraceCache()
    for (const [row, column] of columns.entries()) {
      for (const step of [0, 19]) {
        expect(viaSorted.values[row * 20 + step]).toBe(
          await directRead(window.start + step, column),
        )
      }
    }
    expect(viaSorted.values.some((value) => value !== 0)).toBe(true)
  }, 120_000)
})
