/**
 * The whole-population reader.
 *
 * What can go wrong here goes wrong quietly, the way `traces.test.ts` describes: a stride off by
 * one shifts every value onto a neighbouring cell or timestep, and a row placed through the wrong
 * permutation is real activity under another cell's id. So assertions name cells — the fake store
 * holds `t * 1000 + column` at every cell and the level mean of that at every bin — and every
 * placement is asserted against the permutation the store was built with, which is reversed rather
 * than the identity so a reader ignoring it cannot pass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cellValue,
  defaultSorting,
  levelCellValue,
  serveTraceChunks,
} from '../../test/zapbenchStubs'
import { resetTransport } from '../precomputed/transport'
import {
  fetchRecording,
  levelWindow,
  planRecordingRead,
  readScale,
  recordingRows,
  resetLevelChecks,
} from './recording'
import { TRACE_COLUMNS, WHOLE_RECORDING, resetSortingCheck, resetTraceCache } from './traces'

const SORTING = defaultSorting()

beforeEach(() => {
  resetTraceCache()
  resetSortingCheck()
  resetLevelChecks()
  resetTransport()
})
afterEach(() => vi.unstubAllGlobals())

describe('the shape of a level', () => {
  it('has the rows the release publishes at each scale', () => {
    expect([1, 2, 4].map((scale) => recordingRows(scale as 1 | 2 | 4))).toEqual([
      71721, 35861, 17931,
    ])
  })

  it('keeps only the time bins wholly inside a window', () => {
    // The whole recording's last step at s1 and s2 is partial, and s2 weights it unevenly.
    expect(levelWindow(WHOLE_RECORDING, 2)).toEqual({ start: 0, end: 3939 })
    expect(levelWindow(WHOLE_RECORDING, 4)).toEqual({ start: 0, end: 1969 })
    // `gain` is [1, 648): the first s2 bin covering only steps inside it starts at step 4.
    expect(levelWindow({ start: 1, end: 648 }, 4)).toEqual({ start: 1, end: 162 })
  })

  it('reads an unreadable stored scale as the default rather than as full scale', () => {
    expect(readScale('2')).toBe(2)
    expect(readScale('3')).toBe(4)
    expect(readScale(undefined)).toBe(4)
  })
})

describe('what a whole-population read asks for', () => {
  it('reads row-major across each block, stopping at the last real cell', () => {
    const { reads, bytes } = planRecordingRead('plain', { start: 0, end: 2 }, TRACE_COLUMNS)
    expect(reads).toHaveLength(141)
    expect(reads[0]).toMatchObject({ from: 0, to: 2 * 512 * 4 - 1, cells: 512 })
    // 71,721 − 140 × 512 = 41 real cells in the last block.
    expect(reads[140]).toMatchObject({ from: 0, to: (512 + 41) * 4 - 1, cells: 41 })
    expect(bytes).toBe(140 * 2 * 512 * 4 + (512 + 41) * 4)
  })

  it('reads a transposed level from the first wanted step to the last', () => {
    const rows = recordingRows(4)
    const { reads } = planRecordingRead('sorted', { start: 1000, end: 1002 }, rows)
    expect(reads).toHaveLength(36)
    // Step 1000 is local step 488 of chunk row 1.
    expect(reads[0]).toMatchObject({
      chunkRow: 1,
      from: 488 * 4,
      to: (511 * 512 + 490) * 4 - 1,
    })
    expect(reads[35]).toMatchObject({ cells: 11, to: (10 * 512 + 490) * 4 - 1 })
  })
})

describe('reading every cell at full scale', () => {
  it('places each cell at its activity position and names it', async () => {
    serveTraceChunks({ sorted: true })
    const result = await fetchRecording({
      product: 'traces',
      scale: 1,
      window: { start: 100, end: 102 },
    })
    expect(result.order).toBe('activity')
    expect([result.rows, result.steps]).toEqual([TRACE_COLUMNS, 2])
    expect(result.stepStarts).toEqual([100, 101])
    for (const column of [0, 511, 512, TRACE_COLUMNS - 1]) {
      const row = SORTING.indexOf(column)
      expect(result.cells[row]).toBe(column + 1)
      expect(result.values[row * 2]).toBe(cellValue(100, column))
      expect(result.values[row * 2 + 1]).toBe(cellValue(101, column))
    }
  })

  it('reads the row-major copy, not the transposed one', async () => {
    const calls = serveTraceChunks({ sorted: true })
    await fetchRecording({ product: 'traces', scale: 1, window: { start: 100, end: 102 } })
    const chunks = calls.filter((call) => call.url.includes('/c/'))
    // Four probe cells check the permutation; every data read is row-major.
    expect(chunks.filter((call) => !call.url.includes('rastermap')).length).toBe(141 + 2)
  })

  it('falls back to cell order, labels intact, when the permutation cannot be checked', async () => {
    serveTraceChunks()
    const result = await fetchRecording({
      product: 'traces',
      scale: 1,
      window: { start: 7, end: 8 },
    })
    expect(result.order).toBe('cell')
    expect(result.cells[70000]).toBe(70001)
    expect(result.values[70000]).toBe(cellValue(7, 70000))
  })
})

describe('reading a downsampled level', () => {
  it('returns each bin’s mean and names every cell it averages', async () => {
    const calls = serveTraceChunks({ sorted: true })
    const result = await fetchRecording({
      product: 'traces',
      scale: 4,
      window: { start: 4000, end: 4008 },
    })
    expect([result.rows, result.steps]).toEqual([17931, 2])
    expect(result.stepStarts).toEqual([4000, 4004])
    for (const row of [0, 511, 512, 17930]) {
      expect(result.values[row * 2]).toBeCloseTo(levelCellValue(1000, row, 4), 0)
      expect(result.values[row * 2 + 1]).toBeCloseTo(levelCellValue(1001, row, 4), 0)
    }
    expect([...result.cells.subarray(0, 4)]).toEqual(SORTING.slice(0, 4).map((c) => c + 1))
    // The last row holds one real cell and three empty slots.
    expect([...result.cells.subarray(17930 * 4)]).toEqual([SORTING[71720]! + 1, 0, 0, 0])
    expect(calls.some((call) => call.url.includes('/s2/c/'))).toBe(true)
  })

  it('refuses when the permutation cannot be checked, since no row could be named', async () => {
    serveTraceChunks()
    await expect(
      fetchRecording({ product: 'traces', scale: 2, window: { start: 0, end: 4 } }),
    ).rejects.toThrow(/Set Scale to Full/)
  })

  it('refuses a level that no longer averages the one below it', async () => {
    serveTraceChunks({ sorted: true, skewLevels: true })
    await expect(
      fetchRecording({ product: 'traces', scale: 4, window: { start: 0, end: 8 } }),
    ).rejects.toThrow(/no longer averages/)
  })

  it('refuses a product with no downsampled copy', async () => {
    serveTraceChunks({ sorted: true })
    await expect(
      fetchRecording({
        product: 'stimulus_evoked_response',
        scale: 2,
        window: { start: 0, end: 4 },
      }),
    ).rejects.toThrow(/no downsampled copy/)
  })
})
