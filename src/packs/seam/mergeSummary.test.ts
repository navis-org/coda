/**
 * The card's readout, which is the only place the cutoff is applied now that `evaluate` ignores
 * it. These tests are the agreement between the table `mergeTables.ts` writes and the numbers
 * the card reads back out of it — a column renamed on one side and not the other would otherwise
 * show as a card that quietly says nothing.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import { makeTable } from '../../core/values'
import { windowTable, windowTableSchema } from './mergeTables'
import { SCORE_BINS, cutoffForFraction, summariseMerges } from './mergeSummary'

/** Built through `windowTable`, so the test breaks if the two halves stop agreeing. */
function cells(rows: { id?: string; score: number; balance?: number }[]) {
  return windowTable(
    rows.map((row, i) => ({
      neuronId: row.id ?? 'a',
      cell: i,
      centreNm: [0, 0, 0] as const,
      score: row.score,
      logit: 0,
      points: 100,
      balance: row.balance ?? 0,
    })),
  )
}

describe('summariseMerges', () => {
  it('says nothing at all before a run, and nothing for an empty table', () => {
    expect(summariseMerges(undefined, undefined)).toBeUndefined()
    expect(summariseMerges(windowTable([]), undefined)).toBeUndefined()
  })

  it('counts the cells, the neurons and the three order statistics', () => {
    const got = summariseMerges(
      cells([
        { id: 'a', score: 0.1 },
        { id: 'a', score: 0.9 },
        { id: 'b', score: 0.5 },
      ]),
      undefined,
    )!
    expect(got.neurons).toBe(2)
    expect(got.cells).toBe(3)
    expect([got.minScore, got.medianScore, got.maxScore]).toEqual([0.1, 0.5, 0.9])
  })

  /**
   * Fragments are cells plus the cells the per-point head actually cut, so a neuron the model
   * thinks is whole has exactly as many fragments as cells. That equality is the card's headline
   * reading and the reason both numbers are shown rather than one.
   */
  it('counts a fragment per cell, and a second one per cell that was cut', () => {
    const whole = summariseMerges(cells([{ score: 0.2 }, { score: 0.3 }]), undefined)!
    expect([whole.cells, whole.fragments, whole.cut]).toEqual([2, 2, 0])

    const cut = summariseMerges(
      cells([{ score: 0.2, balance: 0.4 }, { score: 0.3 }]),
      undefined,
    )!
    expect([cut.cells, cut.fragments, cut.cut]).toEqual([2, 3, 1])
  })

  it('bins the scores, keeping a score of exactly 1 in the last bin', () => {
    const got = summariseMerges(
      cells([{ score: 0 }, { score: 1 }, { score: 0.99 }]),
      undefined,
    )!
    expect(got.bins.length).toBe(SCORE_BINS)
    expect(got.bins[0]).toBe(1)
    expect(got.bins[SCORE_BINS - 1]).toBe(2)
    expect(got.tallest).toBe(2)
  })

  it('counts what is at or above the cutoff, and nothing without one', () => {
    const rows = cells([{ score: 0.2 }, { score: 0.8 }, { score: 0.9 }])
    expect(summariseMerges(rows, undefined)!.above).toBeUndefined()
    // At or above, so the cell sitting exactly on the line is kept — the same reading
    // `Filter Table` on `score >= 0.8` would give.
    expect(summariseMerges(rows, 0.8)!.above).toBe(2)
  })

  /**
   * A null score is a cell nothing can be said about. Folding it in as a zero would report it as
   * a cell the model called clean, which is a claim nobody made.
   */
  it('leaves a null score out of every count rather than reading it as zero', () => {
    const table = makeTable(
      windowTableSchema(),
      {
        [ID_COLUMN_NAME]: ['a', 'a'],
        cell: [0, 1],
        score: [null, 0.5],
        logit: [null, 0],
        points: [0, 10],
        balance: [null, 0],
        x: [0, 0],
        y: [0, 0],
        z: [0, 0],
      },
      'table',
    )
    const got = summariseMerges(table, undefined)!
    expect(got.cells).toBe(1)
    expect(got.minScore).toBe(0.5)
  })
})

describe('cutoffForFraction', () => {
  /** The bar's left edge: a reader clicking a bar means "this bar and everything right of it". */
  it('puts the cutoff on the clicked bar’s left edge', () => {
    expect(cutoffForFraction(0.42)).toBeCloseTo(0.4)
    expect(cutoffForFraction(0.4)).toBeCloseTo(0.4)
  })

  it('clamps a click outside the plot to a real bar', () => {
    expect(cutoffForFraction(-2)).toBe(0)
    expect(cutoffForFraction(5)).toBeCloseTo((SCORE_BINS - 1) / SCORE_BINS)
  })
})
