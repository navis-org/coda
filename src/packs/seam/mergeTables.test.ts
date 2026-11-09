/**
 * Invariant 3 for the merge-window task: each schema half held to its value half.
 *
 * `affinityTables.test.ts`' argument again — `makeTable` catches a declared column nothing
 * provided, and these catch the other direction, where a column is written under a name the
 * schema spells differently and simply never reaches a picker.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import { column, columnNames, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import type { NeuronWindows } from './mergeTables'
import {
  drawnPointsSchema,
  drawnPointsTable,
  fragmentName,
  neuronSummarySchema,
  neuronSummaryTable,
  summariseWindows,
  windowTable,
  windowTableSchema,
} from './mergeTables'

const neurons = tableFromRows(
  tableSchema(column(ID_COLUMN_NAME, 'str'), column('type', 'str')),
  [
    { [ID_COLUMN_NAME]: 'a', type: 'LC4' },
    { [ID_COLUMN_NAME]: 'b', type: 'LPLC2' },
  ],
  'neurons',
)

describe('the window table', () => {
  const rows = [
    {
      neuronId: 'a',
      cell: 0,
      centreNm: [1, 2, 3] as const,
      score: 0.9,
      logit: 2.2,
      points: 10,
      balance: 0.3,
    },
    {
      neuronId: 'a',
      cell: 4,
      centreNm: [4, 5, 6] as const,
      score: 0.1,
      logit: -2.2,
      points: 8,
      balance: 0,
    },
  ]

  it('agrees with its schema half, column for column', () => {
    const got = windowTable(rows)
    expect(got.schema).toEqual(windowTableSchema())
    expect(Object.keys(got.data).sort()).toEqual(got.schema.columns.map((c) => c.name).sort())
  })

  it('keeps one row per window, with the centre split into three columns', () => {
    const got = windowTable(rows)
    expect(got.length).toBe(2)
    expect(got.data.cell).toEqual([0, 4])
    expect(got.data.score).toEqual([0.9, 0.1])
    expect([got.data.x, got.data.y, got.data.z]).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ])
  })

  /** The logit is kept beside the probability because a calibration is fitted to the logit. */
  it('carries the logit as well as the probability', () => {
    expect(windowTable(rows).data.logit).toEqual([2.2, -2.2])
  })

  /**
   * `balance` is the second signal and it is independent of the score: the per-point head is
   * untrained on clean windows, so a cell can score low and still cut. It is published for every
   * cell, whatever the score, which is what lets the card compare the two.
   */
  it('publishes the bipartition’s balance and its denominator for every cell', () => {
    const got = windowTable(rows)
    expect(got.data.balance).toEqual([0.3, 0])
    expect(got.data.points).toEqual([10, 8])
  })
})

describe('the per-neuron summary', () => {
  const summary = (cells: number, max: number): NeuronWindows => ({
    cells,
    maxScore: max,
    meanScore: max / 2,
  })

  it('agrees with its schema half, and keeps the neurons’ own columns', () => {
    const got = neuronSummaryTable(neurons, [summary(3, 0.9), summary(1, 0.2)])
    expect(got.schema).toEqual(neuronSummarySchema(neurons.schema))
    expect(columnNames(got.schema)).toContain('type')
    expect(got.kind).toBe('neurons')
    expect(got.data.maxScore).toEqual([0.9, 0.2])
  })

  /** A skipped neuron is null, never zero: nobody asked the model about it. */
  it('reads a skipped neuron as null, not as zero windows', () => {
    const got = neuronSummaryTable(neurons, [summary(3, 0.9), undefined])
    expect(got.data.cells).toEqual([3, null])
    expect(got.data.maxScore).toEqual([0.9, null])
  })

  /** `new Array(n)` leaves holes and `map` preserves them; `Array.from` reads every index. */
  it('fills a skipped neuron’s cells even when the array it was handed is sparse', () => {
    const sparse: (NeuronWindows | undefined)[] = new Array(2)
    sparse[0] = summary(3, 0.9)
    const got = neuronSummaryTable(neurons, sparse)
    expect(1 in got.data.cells!).toBe(true)
    expect(got.data.cells).toEqual([3, null])
  })

  it('writes over a column of its own name rather than beside it', () => {
    const stale = tableFromRows(
      tableSchema(column(ID_COLUMN_NAME, 'str'), column('cells', 'str')),
      [{ [ID_COLUMN_NAME]: 'a', cells: 'stale' }],
    )
    const got = neuronSummaryTable(stale, [summary(7, 0.5)])
    expect(columnNames(got.schema)).toEqual(['neuronId', 'cells', 'maxScore', 'meanScore'])
    expect(got.data.cells).toEqual([7])
  })
})

describe('summariseWindows', () => {
  it('is null rather than zero for a neuron with no windows', () => {
    expect(summariseWindows([])).toEqual({ cells: 0, maxScore: null, meanScore: null })
  })

  it('takes the max and the mean of what it was given', () => {
    expect(summariseWindows([0.2, 0.8, 0.5])).toEqual({
      cells: 3,
      maxScore: 0.8,
      meanScore: 0.5,
    })
  })
})

describe('the drawn points', () => {
  const windows = [
    { neuronId: 'a', cell: 0, score: 0.9, fragments: ['0a', '0b'] },
    { neuronId: 'b', cell: 2, score: 0.3, fragments: ['2a'] },
  ]

  it('agrees with its schema half, column for column', () => {
    const got = drawnPointsTable(windows)
    expect(got.schema).toEqual(drawnPointsSchema())
    expect(Object.keys(got.data).sort()).toEqual(got.schema.columns.map((c) => c.name).sort())
  })

  /** Every point of a cell shares its score; the fragment is what varies within one. */
  it('repeats the cell’s score per point and keeps each point’s fragment', () => {
    const got = drawnPointsTable(windows)
    expect(got.length).toBe(3)
    expect(got.data.neuronId).toEqual(['a', 'a', 'b'])
    expect(got.data.cell).toEqual([0, 0, 2])
    expect(got.data.score).toEqual([0.9, 0.9, 0.3])
    expect(got.data.fragment).toEqual(['0a', '0b', '2a'])
  })
})

describe('fragmentName', () => {
  /**
   * The name carries the cell because the label only means something *inside* one: the model's
   * per-point head is trained with a permutation-invariant loss, so which piece it calls 0 is
   * arbitrary per window. `3a` and `4a` are not the same fragment and the name says so.
   */
  it('names a cell’s two pieces', () => {
    expect(fragmentName(3, 0)).toBe('3a')
    expect(fragmentName(3, 1)).toBe('3b')
  })

  it('never collides between cells', () => {
    const names = new Set([fragmentName(3, 1), fragmentName(4, 0), fragmentName(4, 1)])
    expect(names.size).toBe(3)
  })
})
