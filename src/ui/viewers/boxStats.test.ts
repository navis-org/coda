/**
 * Five-number summaries, whiskers and violin curves.
 *
 * The interesting cases are the ones where a plausible implementation is wrong rather than
 * merely different: a whisker drawn at the fence instead of at the data, quantiles that drift
 * from numpy's, and a kernel estimate over a column with no spread.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import {
  ALL_LABEL,
  OUTLIER_DRAW_CAP,
  SWARM_DRAW_CAP,
  boxStats,
  buildDistributions,
  kdeCurve,
  quantileSorted,
  silvermanBandwidth,
  swarmOffsets,
} from './boxStats'

const SCHEMA = tableSchema(column('pre', 'f64'), column('type', 'str'))

function tableOf(rows: { pre: number | null; type?: string }[]) {
  return tableFromRows(
    SCHEMA,
    rows.map((r) => ({ pre: r.pre, type: r.type ?? 'a' })),
  )
}

describe('quantileSorted', () => {
  it('is the type-7 definition numpy and R default to', () => {
    // np.percentile([1,2,3,4], 25) is 1.75, not 2 — the difference matters at the small group
    // sizes a per-cell-type box plot is made of.
    expect(quantileSorted([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75)
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5)
    expect(quantileSorted([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25)
  })

  it('answers the single value for a group of one', () => {
    expect(quantileSorted([9], 0.25)).toBe(9)
  })
})

describe('boxStats', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]

  it('ends the whisker at the most extreme value inside the fence, not at the fence', () => {
    // Drawing the fence puts the whisker end at a number no row holds, and makes it stick out
    // past the data whenever the tail is short.
    const stats = boxStats(sorted, 'tukey')
    expect(stats.upper).toBe(9)
    expect(stats.lower).toBe(1)
    expect(stats.outliers).toEqual([100])
  })

  it('has no outliers under the full-range rule', () => {
    const stats = boxStats(sorted, 'minmax')
    expect(stats.lower).toBe(1)
    expect(stats.upper).toBe(100)
    expect(stats.outlierCount).toBe(0)
  })

  it('puts the percentile rule’s whiskers at the percentiles', () => {
    const stats = boxStats(sorted, 'p5p95')
    expect(stats.lower).toBeCloseTo(quantileSorted(sorted, 0.05))
    expect(stats.upper).toBeCloseTo(quantileSorted(sorted, 0.95))
  })

  it('thins the drawn outliers but reports how many there were', () => {
    // Forty thousand outlier dots is a filled rectangle, not a chart.
    const many = [
      ...Array.from({ length: 5000 }, (_, i) => 1 + (i % 10)),
      ...Array.from({ length: 500 }, () => 1e6),
    ].sort((a, b) => a - b)
    const stats = boxStats(many, 'tukey')
    expect(stats.outliers.length).toBeLessThanOrEqual(OUTLIER_DRAW_CAP)
    expect(stats.outlierCount).toBe(500)
  })

  it('survives an empty group without throwing', () => {
    expect(boxStats([], 'tukey').n).toBe(0)
  })
})

describe('kdeCurve', () => {
  it('answers zeros rather than dividing by a zero bandwidth', () => {
    const identical = [4, 4, 4]
    expect(silvermanBandwidth(identical)).toBe(0)
    expect(kdeCurve(identical, [3, 4, 5], 0)).toEqual([0, 0, 0])
  })

  /**
   * The two-pointer window against the definition it replaced.
   *
   * `kdeCurve` exploits both inputs being sorted to walk a window instead of testing every
   * value at every grid point. That is an algorithm change to arithmetic nothing else checks,
   * so the naive form is written out here and the two are required to agree exactly — a
   * pointer that resets one element late would still produce a plausible violin.
   */
  it('matches the definition it is an optimisation of, exactly', () => {
    const naive = (sorted: number[], grid: number[], h: number) => {
      const norm = 1 / (sorted.length * h * Math.sqrt(2 * Math.PI))
      return grid.map((x) => {
        let sum = 0
        for (const value of sorted) {
          const z = (x - value) / h
          if (z > -4 && z < 4) sum += Math.exp(-0.5 * z * z)
        }
        return sum * norm
      })
    }
    // Bimodal, heavy-tailed, with ties and a value outside every window — the shapes a real
    // group takes.
    const values = [
      ...Array.from({ length: 60 }, (_, i) => 1 + (i % 7) * 0.1),
      ...Array.from({ length: 40 }, (_, i) => 8 + i * 0.05),
      500,
    ].sort((a, b) => a - b)
    const grid = Array.from({ length: 64 }, (_, i) => (i / 63) * 520)
    for (const h of [0.05, 0.5, 4, 40]) {
      expect(kdeCurve(values, grid, h)).toEqual(naive(values, grid, h))
    }
  })

  it('peaks where the data is', () => {
    const values = [0, 0.1, -0.1, 0.05, -0.05]
    const grid = [-3, 0, 3]
    const curve = kdeCurve(values, grid, silvermanBandwidth(values))
    expect(curve[1]!).toBeGreaterThan(curve[0]!)
    expect(curve[1]!).toBeGreaterThan(curve[2]!)
  })
})

describe('buildDistributions', () => {
  it('gives an ungrouped table one box, labelled', () => {
    const { groups } = buildDistributions(tableOf([{ pre: 1 }, { pre: 2 }]), 'pre', undefined)
    expect(groups.map((g) => g.label)).toEqual([ALL_LABEL])
  })

  it('drops the tail past the cap rather than pooling it, and says how many there were', () => {
    // Pooling fifty cell types into one box makes a distribution that describes nothing.
    const rows = Array.from({ length: 40 }, (_, i) => ({ pre: i + 1, type: `t${i % 10}` }))
    const { groups, groupCount } = buildDistributions(tableOf(rows), 'pre', 'type', {
      maxGroups: 3,
    })
    expect(groups).toHaveLength(3)
    expect(groupCount).toBe(10)
    expect(groups.map((g) => g.label)).not.toContain('Other')
  })

  it('keeps the largest groups, whatever it then sorts them by', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => ({ pre: 1, type: 'big' })),
      { pre: 100, type: 'tiny' },
    ]
    const { groups } = buildDistributions(tableOf(rows), 'pre', 'type', { maxGroups: 1 })
    expect(groups.map((g) => g.label)).toEqual(['big'])
  })

  it('leaves quartiles alone under a log axis — a quantile survives a monotone transform', () => {
    const rows = [1, 10, 100, 1000, 10000].map((pre) => ({ pre }))
    const linear = buildDistributions(tableOf(rows), 'pre', undefined, { log: false })
    const logged = buildDistributions(tableOf(rows), 'pre', undefined, { log: true })
    expect(logged.groups[0]!.stats.median).toBe(linear.groups[0]!.stats.median)
    expect(logged.groups[0]!.stats.q1).toBe(linear.groups[0]!.stats.q1)
  })

  it('drops non-positive values under a log axis and counts them', () => {
    const rows = [{ pre: 0 }, { pre: -1 }, { pre: 10 }, { pre: null }]
    const { groups, dropped } = buildDistributions(tableOf(rows), 'pre', undefined, { log: true })
    expect(dropped).toBe(3)
    expect(groups[0]!.stats.n).toBe(1)
  })

  it('draws no curve unless a violin was asked for', () => {
    const rows = [1, 2, 3, 4, 5].map((pre) => ({ pre }))
    expect(buildDistributions(tableOf(rows), 'pre', undefined).groups[0]!.curve).toEqual([])
    expect(
      buildDistributions(tableOf(rows), 'pre', undefined, { violin: true }).groups[0]!.curve
        .length,
    ).toBeGreaterThan(1)
  })

  it('normalises every violin against one peak, so widths compare between groups', () => {
    const rows = [
      ...Array.from({ length: 200 }, () => ({ pre: 5, type: 'sharp' })),
      ...Array.from({ length: 200 }, (_, i) => ({ pre: i / 20, type: 'flat' })),
    ]
    const { groups } = buildDistributions(tableOf(rows), 'pre', 'type', { violin: true })
    const widest = groups.map((g) => Math.max(...g.curve.map((p) => p.w)))
    // One group reaches 1 and the other does not: rescaling each to its own maximum would make
    // a flat distribution and a sharp one the same shape.
    expect(Math.max(...widest)).toBeCloseTo(1)
    expect(Math.min(...widest)).toBeLessThan(0.9)
  })

  it('answers empty for a column that is not there', () => {
    expect(buildDistributions(tableOf([{ pre: 1 }]), 'nope', undefined).groups).toEqual([])
  })
})

describe('swarmOffsets', () => {
  const positions = (n: number, step: number) => Array.from({ length: n }, (_, i) => i * step)

  it('leaves marks on the centre line when they already clear each other', () => {
    // A swarm that needs no swarming is a strip chart, and should look like one.
    expect(swarmOffsets(positions(5, 20), 3)).toEqual([0, 0, 0, 0, 0])
  })

  it('never lets two marks overlap', () => {
    // The one property the whole function is for. A tight clump is the case that exercises it.
    const values = [...positions(60, 0.4), ...positions(40, 3)].sort((a, b) => a - b)
    const radius = 3
    const offsets = swarmOffsets(values, radius)
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        const dx = values[i]! - values[j]!
        const dy = offsets[i]! - offsets[j]!
        if (Math.abs(dx) >= 2 * radius) continue
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(2 * radius - 1e-6)
      }
    }
  })

  it('interlocks rather than stacking, so a clump reads as a distribution', () => {
    // Identical values are the degenerate case: a fixed ±r ladder would put them in one column
    // at r, 2r, 3r…, which draws as a bar. Neighbours must sit at ±2r from each other and the
    // pile must therefore stay centred.
    const identical = Array.from({ length: 7 }, () => 100)
    const offsets = swarmOffsets(identical, 4)
    expect(offsets[0]).toBe(0)
    expect(Math.min(...offsets)).toBeLessThan(0)
    expect(Math.max(...offsets)).toBeGreaterThan(0)
  })

  it('keeps the swarm as narrow as it can', () => {
    // Nearest-the-centre-line, not first-that-fits: a greedy one-sided search doubles the width.
    const offsets = swarmOffsets(positions(30, 1), 3)
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThan(30)
  })

  it('answers zeros for a zero radius rather than dividing by it', () => {
    expect(swarmOffsets([1, 2, 3], 0)).toEqual([0, 0, 0])
  })

  it('carries no swarm unless one was asked for', () => {
    const rows = [1, 2, 3, 4, 5].map((pre) => ({ pre }))
    expect(buildDistributions(tableOf(rows), 'pre', undefined).groups[0]!.swarm).toEqual([])
    const swarmed = buildDistributions(tableOf(rows), 'pre', undefined, { swarm: true })
    expect(swarmed.groups[0]!.swarm).toEqual([1, 2, 3, 4, 5])
  })

  it('thins a swarm past the draw cap, in value order', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ pre: 5000 - i }))
    const { groups } = buildDistributions(tableOf(rows), 'pre', undefined, { swarm: true })
    expect(groups[0]!.swarm.length).toBe(SWARM_DRAW_CAP)
    expect(groups[0]!.swarm).toEqual([...groups[0]!.swarm].sort((a, b) => a - b))
  })
})
