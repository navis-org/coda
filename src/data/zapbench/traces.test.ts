/**
 * The ZapBench trace reader.
 *
 * Two things here are worth more than the rest. The **byte arithmetic** is the whole of the
 * feature — the array is uncompressed, so a strip is located by multiplication and a mistake
 * shifts every value to a different timestep while still producing a perfectly plausible
 * trace — and the **id base**, where the two readings differ by one everywhere and choosing
 * wrongly returns the neighbouring cell.
 *
 * The fake store below is the real layout rather than a convenient one: 512 × 512 chunks keyed
 * `c/<row>/<col>`, `value(t, f) = t * 1000 + f`, and it honours `Range` the way GCS does. That
 * encoding is what lets an assertion say *which* cell arrived rather than only that something
 * did, which is the only way a transposed or off-by-one read fails a test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CHUNK, cellValue, defaultSorting, serveTraceChunks } from '../../test/zapbenchStubs'
import type { TraceStoreCall } from '../../test/zapbenchStubs'
import { planPlainRead } from './readPlan'
import { resetTransport } from '../precomputed/transport'
import {
  TRACE_COLUMNS,
  TRACE_TIMESTEPS,
  WHOLE_RECORDING,
  WHOLE_RECORDING_ID,
  ZAPBENCH_CONDITIONS,
  conditionWindow,
  fetchTraces,
  resetSortingCheck,
  resetTraceCache,
  traceColumnOf,
} from './traces'

const ROW_BYTES = CHUNK * 4

beforeEach(() => {
  resetTraceCache()
  resetSortingCheck()
  resetTransport()
})

/** The call under test, written out fifteen times before this. */
function read(columns: number[], window: { start: number; end: number }, extra = {}) {
  return fetchTraces({ product: 'traces', columns, window, ...extra })
}

/** Chunk requests only — the one-off `sorting.json` probe is not an access-pattern fact. */
function chunkCalls(calls: TraceStoreCall[], from = 0) {
  return calls.slice(from).filter((call) => call.url.includes('/c/'))
}
afterEach(() => vi.unstubAllGlobals())

describe('the released array', () => {
  it('describes the shape the release actually publishes', () => {
    expect([TRACE_TIMESTEPS, TRACE_COLUMNS]).toEqual([7879, 71721])
    expect(WHOLE_RECORDING).toEqual({ start: 0, end: 7879 })
  })

  /*
   * `get_condition_bounds` adds the padding to the lower bound and subtracts it from the upper,
   * returning `(inclusive_min, exclusive_max)`. Pinned against the two edges and one middle,
   * because an off-by-one here silently mixes one stimulus block's last frames into the next.
   */
  it('trims each condition one timestep at each end, as zapbench does', () => {
    expect(ZAPBENCH_CONDITIONS).toHaveLength(9)
    expect(ZAPBENCH_CONDITIONS[0]).toEqual({ name: 'gain', window: { start: 1, end: 648 } })
    expect(ZAPBENCH_CONDITIONS[2]).toEqual({
      name: 'flash',
      window: { start: 2423, end: 3077 },
    })
    expect(ZAPBENCH_CONDITIONS[8]).toEqual({ name: 'dark', window: { start: 7280, end: 7878 } })
  })

  it('names a window for the whole recording and for nothing it does not have', () => {
    expect(conditionWindow(WHOLE_RECORDING_ID)).toEqual(WHOLE_RECORDING)
    expect(conditionWindow('flash')).toEqual({ start: 2423, end: 3077 })
    // Not a fallback to the whole recording: that answers a different question at 12x the cost.
    expect(conditionWindow('looming')).toBeUndefined()
  })
})

describe('the id base', () => {
  /*
   * The measurement this rests on: `label[i] === i + 1` for all 71,721 rows of
   * `segmentation/dataframe.json`. So a label and a column differ by exactly one, and both
   * readings are in range for every id but the two at the ends — which is what made the *range*
   * unable to settle it and the geometry fit necessary. `pnpm probe:zapbench` holds that half;
   * what is pinned here is the subtraction the fit chose.
   */
  it('reads a label one lower than itself', () => {
    expect(traceColumnOf(1)).toBe(0)
    expect(traceColumnOf(5)).toBe(4)
    expect(traceColumnOf(TRACE_COLUMNS)).toBe(TRACE_COLUMNS - 1)
  })

  it('places no id outside the columns the release has', () => {
    // 0 is background in the segmentation, so it is not a label; one past the last is not one
    // either. Both would otherwise land on a real neighbouring cell's trace.
    expect(traceColumnOf(0)).toBeUndefined()
    expect(traceColumnOf(-1)).toBeUndefined()
    expect(traceColumnOf(TRACE_COLUMNS + 1)).toBeUndefined()
    // Not an id that was rounded — a column that is not this one.
    expect(traceColumnOf(12.5)).toBeUndefined()
  })
})

describe('what a request costs', () => {
  /*
   * The rule the whole node is shaped by: neurons are on the row-major copy's contiguous axis, so
   * 512 adjacent ones cost what one costs and the neuron count barely enters into it. Asked of
   * the plan, which is the only cost model now — a second one beside it priced a different set of
   * columns and filled the other half of the same sentence.
   */
  it('counts 512-neuron blocks, not neurons', () => {
    const blocks = (columns: number[]) => planPlainRead(columns, WHOLE_RECORDING).blocks
    expect(blocks([0])).toBe(1)
    expect(blocks([0, 1, 511])).toBe(1)
    expect(blocks([511, 512])).toBe(2)
    expect(blocks([0, 512, 1024])).toBe(3)
  })

  it('prices a read as blocks x timesteps x a row of 512 values', () => {
    expect(planPlainRead([0, 5], { start: 0, end: 100 }).bytes).toBe(1 * 100 * ROW_BYTES)
    expect(planPlainRead([0, 512], { start: 0, end: 100 }).bytes).toBe(2 * 100 * ROW_BYTES)
    // One block over the whole recording is the 16 MiB the module header measures.
    expect(planPlainRead([7], WHOLE_RECORDING).bytes).toBe(7879 * ROW_BYTES)
  })
})

describe('reading traces', () => {
  it('returns the cell the array holds, for each requested neuron', async () => {
    serveTraceChunks()
    const result = await fetchTraces({
      product: 'traces',
      columns: [3, 700],
      window: { start: 0, end: 4 },
    })
    expect(Array.from(result.values)).toEqual([
      cellValue(0, 3),
      cellValue(1, 3),
      cellValue(2, 3),
      cellValue(3, 3),
      cellValue(0, 700),
      cellValue(1, 700),
      cellValue(2, 700),
      cellValue(3, 700),
    ])
  })

  /*
   * The one that catches a transposed read. A window starting mid-chunk offsets the strip, and
   * reading `t` where `f` belongs produces numbers of the same magnitude — so the assertion has
   * to name the cell, which `cellValue` is for.
   */
  it('reads a window that starts inside a chunk and crosses into the next', async () => {
    serveTraceChunks()
    const result = await fetchTraces({
      product: 'traces',
      columns: [9],
      window: { start: 510, end: 514 },
    })
    expect(Array.from(result.values)).toEqual([
      cellValue(510, 9),
      cellValue(511, 9),
      cellValue(512, 9),
      cellValue(513, 9),
    ])
  })

  it('asks for one range per chunk row, covering only the window', async () => {
    const calls = serveTraceChunks()
    await fetchTraces({
      product: 'traces',
      columns: [9],
      window: { start: 510, end: 514 },
    })
    const chunks = chunkCalls(calls)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.url).toContain('/traces/c/0/0')
    // Rows 510-511 of chunk row 0, then rows 0-1 of chunk row 1. Both are row spans, and a
    // row is all 512 of that chunk's neurons whether they were asked for or not.
    expect(chunks[0]!.range).toBe(`bytes=${510 * ROW_BYTES}-${512 * ROW_BYTES - 1}`)
    expect(chunks[1]!.url).toContain('/traces/c/1/0')
    expect(chunks[1]!.range).toBe(`bytes=0-${2 * ROW_BYTES - 1}`)
  })

  it('reads one block once, however many of its neurons are wanted', async () => {
    const calls = serveTraceChunks()
    const result = await fetchTraces({
      product: 'traces',
      columns: [0, 1, 2, 511],
      window: { start: 0, end: 2 },
    })
    expect(chunkCalls(calls)).toHaveLength(1)
    expect(result.values[6]).toBe(cellValue(0, 511))
    expect(result.bytesRead).toBe(2 * ROW_BYTES)
  })

  it('reads the product it was asked for', async () => {
    const calls = serveTraceChunks()
    await fetchTraces({
      product: 'stimulus_evoked_response',
      columns: [0],
      window: { start: 0, end: 1 },
    })
    expect(calls[0]!.url).toContain('/stimulus_evoked_response/c/0/0')
  })

  /*
   * A duplicated id is ordinary: a neuron table is data and nothing promises the column is
   * unique. Both rows have to be filled, which a single row index per column would not do.
   */
  it('fills every row of a repeated id', async () => {
    serveTraceChunks()
    const result = await fetchTraces({
      product: 'traces',
      columns: [4, 9, 4],
      window: { start: 0, end: 2 },
    })
    expect(Array.from(result.values)).toEqual([
      cellValue(0, 4),
      cellValue(1, 4),
      cellValue(0, 9),
      cellValue(1, 9),
      cellValue(0, 4),
      cellValue(1, 4),
    ])
  })
})

describe('the session cache', () => {
  it('re-reads nothing on an identical request', async () => {
    const calls = serveTraceChunks()
    const request = {
      product: 'traces',
      columns: [1, 2],
      window: { start: 0, end: 3 },
    } as const
    const first = await fetchTraces({ ...request })
    const before = calls.length
    const again = await fetchTraces({ ...request })
    expect(calls).toHaveLength(before)
    expect(again.bytesRead).toBe(0)
    expect(Array.from(again.values)).toEqual(Array.from(first.values))
  })

  /*
   * The unit the cache is keyed on, and the reason it is the neuron rather than the chunk:
   * growing a selection by one neuron in a *different* block must read that block and nothing
   * else.
   */
  it('reads only the block a newly added neuron lives in', async () => {
    const calls = serveTraceChunks()
    await fetchTraces({ product: 'traces', columns: [1], window: { start: 0, end: 3 } })
    const before = calls.length
    const grown = await fetchTraces({
      product: 'traces',
      columns: [1, 600],
      window: { start: 0, end: 3 },
    })
    expect(chunkCalls(calls, before).every((call) => call.url.includes('/c/0/1'))).toBe(true)
    expect(grown.values[0]).toBe(cellValue(0, 1))
    expect(grown.values[3]).toBe(cellValue(0, 600))
  })

  it('does not answer one window from another', async () => {
    const calls = serveTraceChunks()
    await fetchTraces({ product: 'traces', columns: [1], window: { start: 0, end: 3 } })
    const before = calls.length
    await fetchTraces({ product: 'traces', columns: [1], window: { start: 3, end: 6 } })
    expect(calls.length).toBeGreaterThan(before)
  })

  it('re-reads when asked to refresh, and holds what it read', async () => {
    const calls = serveTraceChunks()
    await fetchTraces({ product: 'traces', columns: [1], window: { start: 0, end: 3 } })
    const before = calls.length
    await fetchTraces({
      product: 'traces',
      columns: [1],
      window: { start: 0, end: 3 },
      refresh: true,
    })
    expect(calls.length).toBeGreaterThan(before)
  })
})

describe('refusing rather than filling a gap', () => {
  /*
   * A strip that does not arrive would otherwise be read as the array's fill value, which is a
   * run of real-looking zeroes in the middle of a trace. `mapWithConcurrency` reports a failed
   * item as `undefined`, so the reader has to notice.
   */
  it('throws when a chunk cannot be read', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: false, status: 500, url: 'x' } as Response),
    )
    await expect(
      fetchTraces({ product: 'traces', columns: [0], window: { start: 0, end: 2 } }),
    ).rejects.toThrow()
  })

  /*
   * A store that ignores `Range` answers 200 with the whole megabyte. Taken as the strip, every
   * value would come from the wrong timestep — plausible numbers, wrong everywhere.
   */
  it('throws when a store ignores the range and sends the whole chunk', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: String(url),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(CHUNK * CHUNK * 4)),
      } as unknown as Response),
    )
    await expect(
      fetchTraces({ product: 'traces', columns: [0], window: { start: 0, end: 2 } }),
    ).rejects.toThrow(/Range/)
  })

  it('throws on an empty window rather than returning an empty matrix', async () => {
    serveTraceChunks()
    await expect(
      fetchTraces({ product: 'traces', columns: [0], window: { start: 5, end: 5 } }),
    ).rejects.toThrow(/empty/)
  })
})

/**
 * Settle the one-off permutation check, so an access-pattern assertion sees only data reads.
 *
 * `verifiedSorting` reads one cell from *each* array to confirm the permutation still describes
 * the release, which is four requests touching both layouts — exactly the thing a test asking
 * "which array did this read" must not count. Settled once here, then the trace cache is cleared
 * so the measured call still fetches.
 */
async function settleSortingCheck(): Promise<void> {
  await fetchTraces({ product: 'traces', columns: [0], window: { start: 0, end: 1 } })
  resetTraceCache()
}

describe('the transposed copy', () => {
  /*
   * The whole reason this route exists, and the assertion that matters most: the same values,
   * read from a different array through a permutation. The stub's default permutation is
   * *reversed*, never the identity — under identity a reader that forgot to permute would pass
   * this and every other test here, and forgetting is the likeliest mistake, the sorted copy's
   * columns looking exactly like the plain copy's.
   */
  it('returns the same values as the row-major copy', async () => {
    serveTraceChunks({ sorted: true })
    const window = { start: 0, end: 600 }
    const result = await read([4, 900], window)
    const steps = 600
    expect(result.values[0]).toBe(cellValue(0, 4))
    expect(result.values[599]).toBe(cellValue(599, 4))
    expect(result.values[steps]).toBe(cellValue(0, 900))
    expect(result.values[steps + 599]).toBe(cellValue(599, 900))
  })

  it('is the route taken for a few neurons over a wide window, and reads far less', async () => {
    const calls = serveTraceChunks({ sorted: true })
    await settleSortingCheck()
    const before = calls.length
    const window = { start: 0, end: 1024 }
    const result = await read([4], window)
    const chunks = chunkCalls(calls, before)
    expect(chunks.every((call) => call.url.includes('traces_rastermap_sorted'))).toBe(true)
    // Two chunk rows, one neuron each: 1,024 values rather than 1,024 x 512.
    expect(result.bytesRead).toBe(1024 * 4)
  })

  /*
   * The other half of `readPlan`'s argument, end to end: row-major is the right shape for many
   * neurons over a narrow window, and the reader has to actually go there.
   */
  it('is not taken for a whole block over a narrow window', async () => {
    const calls = serveTraceChunks({ sorted: true })
    await settleSortingCheck()
    const before = calls.length
    const columns = Array.from({ length: 512 }, (_, i) => i)
    await fetchTraces({ product: 'traces', columns, window: { start: 0, end: 4 } })
    const chunks = chunkCalls(calls, before)
    expect(chunks.every((call) => !call.url.includes('rastermap'))).toBe(true)
  })

  /*
   * The sorted copy is a derived product that could be re-sorted without notice, and a stale
   * permutation returns a real neuron's real trace under another neuron's name. So the reader
   * spot-checks one cell both ways and falls back rather than trusting it.
   */
  it('falls back to row-major when the permutation disagrees with the array', async () => {
    // A permutation the sorted chunks were not built with: every probe cell will mismatch.
    const wrong = defaultSorting()
    ;[wrong[0], wrong[1]] = [wrong[1]!, wrong[0]!]
    const calls = serveTraceChunks({ sorted: true, sorting: wrong })
    const result = await fetchTraces({
      product: 'traces',
      columns: [4],
      window: { start: 0, end: 8 },
    })
    const chunks = chunkCalls(calls)
    // The probe did look at the sorted copy — that is what caught the disagreement…
    expect(chunks.some((call) => call.url.includes('traces_rastermap_sorted'))).toBe(true)
    // …but the values came from the row-major copy, and are right.
    expect(Array.from(result.values.slice(0, 3))).toEqual([
      cellValue(0, 4),
      cellValue(1, 4),
      cellValue(2, 4),
    ])
  })

  /*
   * The guard on the memcpy fast path. On the transposed route a neuron's window is contiguous
   * at both ends, so one `set` replaces the step loop — but only while a single output row wants
   * it. Asked for twice, `set` would fill the first row and leave the second as zeros, and a
   * repeated id is ordinary: a neuron table is data and nothing promises its id column is
   * unique. Mutation testing found this uncovered; the plain-route case above cannot reach it.
   */
  it('fills every row of a repeated id on the transposed route', async () => {
    const calls = serveTraceChunks({ sorted: true })
    await settleSortingCheck()
    const before = calls.length
    const result = await read([4, 9, 4], { start: 0, end: 1024 })
    expect(chunkCalls(calls, before).every((call) => call.url.includes('rastermap'))).toBe(true)
    const steps = 1024
    expect(result.values[0]).toBe(cellValue(0, 4))
    expect(result.values[steps]).toBe(cellValue(0, 9))
    expect(result.values[2 * steps]).toBe(cellValue(0, 4))
    expect(result.values[2 * steps + 1023]).toBe(cellValue(1023, 4))
  })

  it('uses the row-major copy for a product that has no sorted copy', async () => {
    const calls = serveTraceChunks({ sorted: true })
    await settleSortingCheck()
    const before = calls.length
    await fetchTraces({
      product: 'stimulus_evoked_response',
      columns: [4],
      window: { start: 0, end: 8 },
    })
    const chunks = chunkCalls(calls, before)
    expect(chunks.every((call) => call.url.includes('/stimulus_evoked_response/'))).toBe(true)
  })
})
