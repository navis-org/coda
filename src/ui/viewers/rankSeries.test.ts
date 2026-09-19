/**
 * The ranking and its share.
 *
 * The cases here are the ones where a plausible implementation is quietly wrong: a signed
 * column drawn with a "share" that climbs past 1 and comes back down, a flag column that is
 * excluded from the numerator and left in the denominator (or the reverse), ties that resolve
 * by whichever order a sort happened to leave, and a log axis dropping rows without saying so.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { isFlagCell, rankSeries, sampleRanks, shareAt, shareReaches } from './rankSeries'

const SCHEMA = tableSchema(
  column('influence', 'f64'),
  column('isSeed', 'bool'),
  column('type', 'str'),
)

function tableOf(values: (number | null)[], seeds: boolean[] = []) {
  return tableFromRows(
    SCHEMA,
    values.map((influence, i) => ({
      influence,
      isSeed: seeds[i] ?? false,
      type: `t${i}`,
    })),
  )
}

describe('rankSeries', () => {
  it('ranks largest first and numbers from one', () => {
    const series = rankSeries(tableOf([1, 5, 3]), {
      valueColumn: 'influence',
      valueScale: 'linear',
    })
    expect(series.points.map((p) => p.value)).toEqual([5, 3, 1])
    expect(series.points.map((p) => p.rank)).toEqual([1, 2, 3])
    // The row travels with the point: every encoding and the tooltip resolve against it.
    expect(series.points.map((p) => p.row)).toEqual([1, 2, 0])
  })

  it('ranks smallest first when asked, which is right for a cost', () => {
    const series = rankSeries(tableOf([1, 5, 3]), {
      valueColumn: 'influence',
      valueScale: 'linear',
      descending: false,
    })
    expect(series.points.map((p) => p.value)).toEqual([1, 3, 5])
  })

  it('breaks ties on the row, so two runs of one query rank the same', () => {
    const series = rankSeries(tableOf([2, 2, 2]), {
      valueColumn: 'influence',
      valueScale: 'linear',
    })
    expect(series.points.map((p) => p.row)).toEqual([0, 1, 2])
  })

  it('accumulates a share of the values, never of the rows', () => {
    // 90 of 100 in one row: the share after rank 1 is 0.9, where a CDF over *rows* would be 0.25.
    const series = rankSeries(tableOf([90, 5, 3, 2]), {
      valueColumn: 'influence',
      valueScale: 'linear',
    })
    expect(series.total).toBe(100)
    expect(Array.from(series.share)).toEqual([0.9, 0.95, 0.98, 1])
    expect(shareReaches(series, 0.5)).toBe(1)
  })

  it('refuses the share over a signed column rather than drawing a curve past 1', () => {
    const series = rankSeries(tableOf([10, 5, -8]), {
      valueColumn: 'influence',
      valueScale: 'linear',
    })
    // Ranked descending the running sum is 10, 15, 7 against a total of 7 — so an unguarded
    // implementation draws 1.43 then comes back down, which reads exactly like a Lorenz curve.
    expect(series.shareRefusal).toMatch(/negative/)
    expect(series.share).toHaveLength(0)
    // The points are still there: only the share is withheld.
    expect(series.points).toHaveLength(3)
  })

  it('refuses the share when everything is zero rather than dividing by it', () => {
    const series = rankSeries(tableOf([0, 0]), {
      valueColumn: 'influence',
      valueScale: 'linear',
    })
    expect(series.shareRefusal).toMatch(/zero/)
    expect(Number.isNaN(shareAt(series, 1))).toBe(false)
  })

  describe('the flag column', () => {
    it('keeps a flagged row out of both halves of the share', () => {
      // The seed carries 100 and the influencers 6 between them. Left in, the curve reaches 94%
      // at rank 1 and says nothing about the rest.
      const series = rankSeries(tableOf([100, 3, 2, 1], [true, false, false, false]), {
        valueColumn: 'influence',
        flagColumn: 'isSeed',
        valueScale: 'linear',
      })
      expect(series.total).toBe(6)
      expect(series.flagged).toBe(1)
      // Flat across the flagged rank, then the influencers' own thirds.
      expect(Array.from(series.share)).toEqual([0, 0.5, 5 / 6, 1])
    })

    it('still ranks and plots the flagged row', () => {
      const series = rankSeries(tableOf([100, 3], [true, false]), {
        valueColumn: 'influence',
        flagColumn: 'isSeed',
        valueScale: 'linear',
      })
      expect(series.points[0]).toMatchObject({ rank: 1, value: 100, flagged: true })
    })

    it('says the flag is why the share is withheld, not that the column is empty', () => {
      // The shape an Influence walk seeded with every neuron in a small connectome produces: a
      // full column of scores and nothing left to take a share of. Answered in the other
      // refusal's words it names a column that is not zero anywhere.
      const series = rankSeries(tableOf([5, 3, 1], [true, true, true]), {
        valueColumn: 'influence',
        flagColumn: 'isSeed',
        valueScale: 'linear',
      })
      expect(series.flagged).toBe(3)
      expect(series.shareRefusal).toMatch(/flagged/)
      // And the ranking above it is untouched, which is the rule every refusal here follows.
      expect(series.points.map((p) => p.value)).toEqual([5, 3, 1])
    })

    it('flags nothing when no column is picked', () => {
      const series = rankSeries(tableOf([100, 3], [true, false]), {
        valueColumn: 'influence',
        valueScale: 'linear',
      })
      expect(series.flagged).toBe(0)
      expect(series.total).toBe(103)
    })
  })

  describe('what is dropped, and why', () => {
    it('counts a missing value apart from a non-positive one', () => {
      const series = rankSeries(tableOf([5, null, 0, -2]), {
        valueColumn: 'influence',
        valueScale: 'log',
      })
      expect(series.missing).toBe(1)
      expect(series.nonPositive).toBe(2)
      expect(series.points).toHaveLength(1)
    })

    it('keeps a zero on a linear axis, where it has a position', () => {
      const series = rankSeries(tableOf([5, 0]), {
        valueColumn: 'influence',
        valueScale: 'linear',
      })
      expect(series.nonPositive).toBe(0)
      expect(series.points).toHaveLength(2)
    })

    it('answers empty for an unresolved column rather than throwing', () => {
      const series = rankSeries(tableOf([1, 2]), {
        valueColumn: undefined,
        valueScale: 'linear',
      })
      expect(series.points).toHaveLength(0)
    })
  })
})

describe('isFlagCell', () => {
  it('reads a bool and an integer flag, which is what the picker admits', () => {
    expect(isFlagCell(true)).toBe(true)
    expect(isFlagCell(1)).toBe(true)
    expect(isFlagCell(0)).toBe(false)
    expect(isFlagCell(false)).toBe(false)
  })

  it('takes no string as a flag, so the two exporters cannot disagree with it', () => {
    // `Flag column` is restricted to bool/i64/f64 for exactly this: pandas reads every non-empty
    // string as true and R answers `NA`, so a text column meant three different pictures.
    expect(isFlagCell('true')).toBe(false)
    expect(isFlagCell('yes')).toBe(false)
    expect(isFlagCell(null)).toBe(false)
    expect(isFlagCell(undefined)).toBe(false)
    expect(isFlagCell(NaN)).toBe(false)
  })
})

describe('sampleRanks', () => {
  it('draws everything below the budget', () => {
    expect(sampleRanks(5, 100, 50)).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps the head dense, where the reader is', () => {
    const ranks = sampleRanks(100_000, 400, 120)
    expect(ranks.slice(0, 120)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1))
  })

  it('stays inside the budget and strictly increases', () => {
    const ranks = sampleRanks(165_122, 400, 120)
    expect(ranks.length).toBeLessThanOrEqual(401)
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!).toBeGreaterThan(ranks[i - 1]!)
    }
  })

  it('reaches the last rank, so the curve ends where the data does', () => {
    const ranks = sampleRanks(165_122, 400, 120)
    expect(ranks[ranks.length - 1]).toBe(165_122)
  })

  it('spaces the tail logarithmically rather than uniformly', () => {
    // A uniform sample puts every point it takes into the last decade. The test of the log
    // spacing is that the gaps grow: the step at the start of the tail is smaller than at its end.
    const ranks = sampleRanks(100_000, 200, 50)
    const early = ranks[60]! - ranks[59]!
    const late = ranks[ranks.length - 2]! - ranks[ranks.length - 3]!
    expect(late).toBeGreaterThan(early)
  })
})
