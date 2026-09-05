/**
 * Binning.
 *
 * The cases here are the ones where a plausible implementation is quietly wrong: the largest
 * value falling outside every bar, a column whose middle half is one number making the
 * automatic rule divide by zero, a log axis silently dropping rows, and density scaling by a
 * uniform width when the widths are not uniform.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import {
  MAX_AUTO_BINS,
  buildHistogram,
  chooseBinCount,
  columnStats,
  normalizeLabel,
} from './histogramBins'

const SCHEMA = tableSchema(column('pre', 'f64'), column('type', 'str'))

function tableOf(values: (number | null)[], types: string[] = []) {
  return tableFromRows(
    SCHEMA,
    values.map((pre, i) => ({ pre, type: types[i] ?? 'a' })),
  )
}

describe('chooseBinCount', () => {
  it('falls back to Sturges when the interquartile range is zero', () => {
    // Freedman–Diaconis divides by the IQR, so `pre` on a table that is mostly zero would ask
    // for an infinite number of bins.
    const mostlyZero = [...Array(100).fill(0), 1, 2, 3]
    expect(Number.isFinite(chooseBinCount(mostlyZero))).toBe(true)
    expect(chooseBinCount(mostlyZero)).toBeGreaterThan(1)
  })

  it('caps, so a heavy-tailed integer column is still a picture', () => {
    const heavy = Array.from({ length: 4000 }, (_, i) => (i < 3990 ? i % 4 : i * 50))
    expect(chooseBinCount([...heavy].sort((a, b) => a - b))).toBeLessThanOrEqual(MAX_AUTO_BINS)
  })

  it('answers 1 for a column with one distinct value', () => {
    expect(chooseBinCount([7, 7, 7])).toBe(1)
  })
})

describe('buildHistogram', () => {
  it('puts the largest value inside the last bar rather than past every one of them', () => {
    const { bars, used } = buildHistogram(tableOf([0, 1, 2, 3, 4, 10]), 'pre', undefined, {
      binMode: 'fixed',
      bins: 5,
    })
    expect(used).toBe(6)
    expect(bars.reduce((sum, bar) => sum + bar.count, 0)).toBe(6)
    expect(bars[bars.length - 1]!.closed).toBe(true)
    expect(bars[bars.length - 1]!.hi).toBe(10)
  })

  it('marks only the top bar closed, so no value is counted twice', () => {
    const { bars } = buildHistogram(tableOf([0, 5, 10]), 'pre', undefined, {
      binMode: 'fixed',
      bins: 4,
    })
    expect(bars.filter((bar) => bar.closed).length).toBe(1)
  })

  it('gives a single-valued column one bar rather than an empty picture', () => {
    const { bars } = buildHistogram(tableOf([7, 7, 7]), 'pre', undefined, {})
    expect(bars).toHaveLength(1)
    expect(bars[0]!.count).toBe(3)
  })

  it('drops what it cannot read and says how many', () => {
    const { used, dropped } = buildHistogram(tableOf([1, null, 2, null]), 'pre', undefined, {})
    expect(used).toBe(2)
    expect(dropped).toBe(2)
  })

  it('drops values at or below zero under a log axis, and counts them', () => {
    // Nothing about flipping a switch suggests rows would leave the picture, which is why the
    // caption reports it.
    const { used, dropped, lo } = buildHistogram(
      tableOf([0, -3, 1, 10, 100]),
      'pre',
      undefined,
      {
        log: true,
      },
    )
    expect(used).toBe(3)
    expect(dropped).toBe(2)
    expect(lo).toBeCloseTo(1)
  })

  it('reports edges in value space even when it binned in log space', () => {
    const { bars } = buildHistogram(tableOf([1, 10, 100, 1000]), 'pre', undefined, {
      log: true,
      binMode: 'fixed',
      bins: 3,
    })
    // Three decades over three bars: the edges are the decades themselves, not their logs.
    expect(bars.map((bar) => Math.round(bar.lo))).toEqual([1, 10, 100])
    expect(Math.round(bars[2]!.hi)).toBe(1000)
  })

  it('scales density by each bar’s own width, which is what log bins need', () => {
    const { bars } = buildHistogram(tableOf([1, 10, 100, 1000]), 'pre', undefined, {
      log: true,
      binMode: 'fixed',
      bins: 3,
      normalize: 'density',
    })
    // Each bar holds one of four rows; a uniform divisor would make all three heights equal,
    // and the widths here differ by a factor of ten per step.
    const heights = bars.map((bar) => bar.total)
    expect(heights[0]!).toBeGreaterThan(heights[1]!)
    expect(heights[1]!).toBeGreaterThan(heights[2]!)
  })

  it('percent is of every binned row, so the bars total 100', () => {
    const { bars } = buildHistogram(tableOf([1, 2, 3, 4]), 'pre', undefined, {
      binMode: 'fixed',
      bins: 4,
      normalize: 'percent',
    })
    expect(bars.reduce((sum, bar) => sum + bar.total, 0)).toBeCloseTo(100)
  })

  it('cumulates per series, so the top bar holds every row', () => {
    const { bars } = buildHistogram(tableOf([1, 2, 3, 4]), 'pre', undefined, {
      binMode: 'fixed',
      bins: 4,
      cumulative: true,
    })
    expect(bars.map((bar) => bar.count)).toEqual([1, 2, 3, 4])
  })

  it('keeps the raw count beside the plotted height', () => {
    // A tooltip reporting "0.004" for a bar holding 41 neurons answers a question nobody asked.
    const { bars } = buildHistogram(tableOf([1, 1, 1, 2]), 'pre', undefined, {
      binMode: 'fixed',
      bins: 2,
      normalize: 'percent',
    })
    expect(bars[0]!.count).toBe(3)
    expect(bars[0]!.total).toBeCloseTo(75)
  })

  it('folds a ninth series into one achromatic bucket rather than reusing a hue', () => {
    const types = Array.from({ length: 12 }, (_, i) => `t${i}`)
    const { series } = buildHistogram(
      tableOf(
        types.map((_, i) => i + 1),
        types,
      ),
      'pre',
      'type',
      {},
    )
    expect(series).toHaveLength(9)
    expect(series[8]).toBe('Other')
  })

  it('answers empty for a column that is not there', () => {
    expect(buildHistogram(tableOf([1, 2]), 'nope', undefined, {}).bars).toEqual([])
  })
})

describe('normalizeLabel', () => {
  it('never says cumulative density, which is not a quantity', () => {
    expect(normalizeLabel('density', true)).toBe('density')
    expect(normalizeLabel('count', true)).toBe('cumulative rows')
  })
})

describe('columnStats', () => {
  it('reports the four numbers a histogram is read with', () => {
    const stats = columnStats(tableOf([1, 2, 3, 4]), 'pre')
    expect(stats).toEqual({ count: 4, min: 1, median: 2.5, mean: 2.5, max: 4 })
  })

  it('skips the nulls rather than counting them as zero', () => {
    // A mean of 2 and a mean of 1 are the two answers here, and only one of them is about the
    // rows that have a value.
    expect(columnStats(tableOf([1, null, 3]), 'pre')).toMatchObject({ count: 2, mean: 2 })
  })

  it('answers nothing for a column that is absent or holds no numbers', () => {
    expect(columnStats(tableOf([1, 2]), 'nosuch')).toBeUndefined()
    expect(columnStats(tableOf([null, null]), 'pre')).toBeUndefined()
  })

  it('takes its median from the same place a Describe node does', () => {
    // Nine quantile definitions, and two of them differ on an even-length run. `boxStats` is
    // the one this and `describeOps` share; a second copy here is how they come to disagree.
    expect(columnStats(tableOf([1, 2, 3, 4, 5, 6]), 'pre')?.median).toBe(3.5)
  })
})
