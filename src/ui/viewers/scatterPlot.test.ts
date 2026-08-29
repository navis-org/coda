/**
 * Scatter plot geometry.
 *
 * The viewer draws to a canvas, which jsdom cannot render, so this file is where nearly all
 * of the scatter plot is actually checked — the same standing `networkLayout.test.ts` and
 * `networkDraw.test.ts` have for the network viewer. Anything moved out of here and into
 * `ScatterViewer.tsx` stops being covered by anything at all.
 */

import { describe, expect, it } from 'vitest'

import type { ColumnData } from '../../core/values'
import {
  DEFAULT_MAX_POINTS,
  axisTicks,
  buildHitIndex,
  buildScatter,
  cellNumber,
  equaliseAspect,
  extentOf,
  fitLine,
  forward,
  inverse,
  padDomain,
  pointInPolygon,
  rectPolygon,
  rowsInPolygon,
  sampleRows,
  usableRows,
} from './scatterPlot'

const PLOT = { x: 0, y: 0, width: 200, height: 100 }

/** Marks every point identically, so a test can be about geometry and nothing else. */
const FLAT = {
  colorAt: () => '#3987e5',
  radiusAt: () => 3,
  shapeAt: () => 'circle' as const,
}

function build(xs: ColumnData, ys: ColumnData, extra: Record<string, unknown> = {}) {
  return buildScatter({
    xValues: xs,
    yValues: ys,
    length: xs.length,
    xScale: 'linear',
    yScale: 'linear',
    plot: PLOT,
    style: FLAT,
    trendColor: '#000000',
    ...extra,
  })
}

describe('reading a cell', () => {
  it('refuses the values a plain Number() would silently plot on the origin', () => {
    // `Number(null)` and `Number('')` are both 0, which would draw a dense stripe of data
    // that does not exist. Same trap `numeric()` in encoding.ts exists for.
    expect(cellNumber(null)).toBeNaN()
    expect(cellNumber(undefined)).toBeNaN()
    expect(cellNumber('')).toBeNaN()
    expect(cellNumber('not a number')).toBeNaN()
    expect(cellNumber(0)).toBe(0)
    expect(cellNumber('12.5')).toBe(12.5)
  })
})

describe('usable rows', () => {
  it('drops a row missing either coordinate and counts what it dropped', () => {
    const { rows, skipped } = usableRows(
      [1, null, 3, 4],
      [1, 2, null, 4],
      4,
      'linear',
      'linear',
    )
    expect([...rows]).toEqual([0, 3])
    expect(skipped).toBe(2)
  })

  it('drops non-positive values under a log axis, on that axis only', () => {
    // A log toggle that silently discarded half the data would be the kind of quiet
    // subtraction the caption rules exist to prevent — hence the count coming back.
    const linear = usableRows([-1, 0, 5], [1, 1, 1], 3, 'linear', 'linear')
    expect(linear.rows.length).toBe(3)

    const logged = usableRows([-1, 0, 5], [1, 1, 1], 3, 'log', 'linear')
    expect([...logged.rows]).toEqual([2])
    expect(logged.skipped).toBe(2)

    // The y column is untouched by an x-axis log.
    const onlyY = usableRows([1, 1, 1], [-1, 0, 5], 3, 'linear', 'log')
    expect([...onlyY.rows]).toEqual([2])
  })
})

describe('the point budget', () => {
  it('leaves a set under the cap exactly as it is, same array', () => {
    const rows = Int32Array.from([0, 1, 2])
    expect(sampleRows(rows, 10)).toBe(rows)
  })

  it('strides rather than clipping, and is the same answer every time', () => {
    const rows = Int32Array.from({ length: 100 }, (_, i) => i)
    const first = sampleRows(rows, 10)
    expect(first.length).toBe(10)
    // A random sample would reshuffle on every re-render, so points would flicker in and out
    // during a pan and the picture would never be the same twice.
    expect([...sampleRows(rows, 10)]).toEqual([...first])
    // Strided across the whole set, not the first ten.
    expect(first[0]).toBe(0)
    expect(first[9]).toBe(90)
  })

  it('defaults to a cap that draws a whole connectome-scale embedding', () => {
    expect(DEFAULT_MAX_POINTS).toBeGreaterThanOrEqual(50_000)
  })
})

describe('domains', () => {
  it('gives a single distinct value a window rather than zero span', () => {
    // Zero span divides by zero on projection and puts every point on one edge.
    const domain = padDomain({ min: 7, max: 7 })
    expect(domain.max).toBeGreaterThan(domain.min)
  })

  it('reads the extent in transformed space, so a log axis frames decades', () => {
    const extent = extentOf([1, 10, 1000], Int32Array.from([0, 1, 2]), 'log')
    expect(extent).toEqual({ min: 0, max: 3 })
  })

  it('equal aspect widens the tighter axis and never narrows either', () => {
    // Narrowing to match would push data outside the plot, and an aspect setting that hides
    // points is not an aspect setting.
    const view = { x: { min: 0, max: 200 }, y: { min: 0, max: 10 } }
    const equal = equaliseAspect(view, PLOT)
    // 200 units over 200px is 1/px; y must widen to 100 units over 100px.
    expect(equal.x.max - equal.x.min).toBeCloseTo(200)
    expect(equal.y.max - equal.y.min).toBeCloseTo(100)
    // Widened about the centre, so nothing that was visible has left.
    expect(equal.y.min).toBeLessThan(view.y.min)
    expect(equal.y.max).toBeGreaterThan(view.y.max)
  })
})

describe('ticks', () => {
  it('covers a domain that does not include zero', () => {
    // `niceTicks` in format.ts always starts at zero, because a bar chart's baseline does.
    // A scatter's window routinely excludes it, and always does after a zoom.
    const ticks = axisTicks({ min: 1000, max: 1040 }, 'linear', 4)
    expect(ticks.length).toBeGreaterThan(2)
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(1000)
    expect(Math.max(...ticks)).toBeLessThanOrEqual(1040)
  })

  it('puts log ticks on decades, labelled through the inverse', () => {
    const ticks = axisTicks({ min: 0, max: 4 }, 'log', 5)
    expect(ticks.map((t) => inverse('log', t))).toEqual([1, 10, 100, 1000, 10000])
  })

  it('subdivides a narrow log window into 1/2/5 rather than showing two labels', () => {
    const ticks = axisTicks({ min: 0, max: 1 }, 'log', 5)
    expect(ticks.map((t) => Math.round(inverse('log', t)))).toEqual([1, 2, 5, 10])
  })
})

describe('projection', () => {
  it('places a point where the scales say', () => {
    const spec = build([0, 100], [0, 50])
    // Both ends are padded, so the extremes are inside the plot rather than on its edge.
    expect(spec.px[0]).toBeGreaterThan(PLOT.x)
    expect(spec.px[1]).toBeLessThan(PLOT.x + PLOT.width)
    // y is flipped: the larger value sits higher, i.e. at a smaller pixel.
    expect(spec.py[1]!).toBeLessThan(spec.py[0]!)
  })

  it('frames over every usable row, not over the sample', () => {
    // An axis range that moved when Max points changed would make a drawing cap look like a
    // filter on the data.
    const xs = Array.from({ length: 100 }, (_, i) => i)
    const full = build(xs, xs)
    const capped = build(xs, xs, { maxPoints: 5 })
    expect(capped.drawn).toBe(5)
    expect(capped.usableRows.length).toBe(100)
    expect(capped.view.x).toEqual(full.view.x)
  })
})

describe('the trend', () => {
  it('recovers a known line and its correlation', () => {
    const xs = Float64Array.from([0, 1, 2, 3])
    const ys = Float64Array.from([1, 3, 5, 7])
    const fit = fitLine(xs, ys)
    expect(fit?.slope).toBeCloseTo(2)
    expect(fit?.intercept).toBeCloseTo(1)
    expect(fit?.r).toBeCloseTo(1)
  })

  it('declines rather than drawing a claim it has not observed', () => {
    // One point is not a relationship, and a vertical cloud has no slope.
    expect(fitLine(Float64Array.from([1]), Float64Array.from([1]))).toBeUndefined()
    expect(fitLine(Float64Array.from([2, 2, 2]), Float64Array.from([1, 5, 9]))).toBeUndefined()
  })

  it('fits in the space the axes are drawn in, so a log-log fit is a power law', () => {
    // y = x^2 is a slope-2 straight line once both axes are logged, and nothing like one
    // before. Fitting in value space would report the curve's chord instead.
    const xs = [1, 10, 100, 1000]
    const ys = xs.map((x) => x * x)
    const spec = build(xs, ys, { xScale: 'log', yScale: 'log', trend: 'linear' })
    const [line] = spec.trends
    expect(line).toBeDefined()
    const slope = (line!.y1 - line!.y0) / (line!.x1 - line!.x0)
    expect(slope).toBeCloseTo(2)
    expect(line!.r).toBeCloseTo(1)
  })

  it('fits one line per colour group, keyed on the resolved colour', () => {
    // Keyed on the colour rather than the raw value, so each line corresponds exactly to a
    // legend entry — the eight-slot cap and the Other fold have already happened.
    const xs = [0, 1, 2, 0, 1, 2]
    const ys = [0, 1, 2, 10, 8, 6]
    const grouped = build(xs, ys, {
      trend: 'linear',
      trendPerGroup: true,
      style: { ...FLAT, colorAt: (row: number) => (row < 3 ? '#a' : '#b') },
    })
    expect(grouped.trends).toHaveLength(2)
    expect(grouped.trends.map((t) => t.color).sort()).toEqual(['#a', '#b'])

    const pooled = build(xs, ys, {
      trend: 'linear',
      trendPerGroup: false,
      style: { ...FLAT, colorAt: (row: number) => (row < 3 ? '#a' : '#b') },
    })
    expect(pooled.trends).toHaveLength(1)
  })
})

describe('the lasso', () => {
  it('is a plain crossing test, and a rectangle goes through the same one', () => {
    const square = rectPolygon(0, 0, 10, 10)
    expect(pointInPolygon(5, 5, square)).toBe(true)
    expect(pointInPolygon(15, 5, square)).toBe(false)
  })

  it('catches rows the point budget never drew', () => {
    // The load-bearing half. Above the cap a lasso still means the region it enclosed, so
    // `Selected` describes the area rather than the sample that survived the stride — the
    // caption is what stops the difference from being a surprise.
    const xs = Array.from({ length: 100 }, (_, i) => i)
    const spec = build(xs, xs, { maxPoints: 10 })
    expect(spec.drawn).toBe(10)

    const everything = rectPolygon(-1000, -1000, 1000, 1000)
    const hits = rowsInPolygon({
      xValues: xs,
      yValues: xs,
      rows: spec.usableRows,
      xScale: 'linear',
      yScale: 'linear',
      view: spec.view,
      plot: spec.plot,
      polygon: everything,
    })
    expect(hits).toHaveLength(100)
  })

  it('answers nothing for a polygon with no area', () => {
    expect(
      rowsInPolygon({
        xValues: [1],
        yValues: [1],
        rows: Int32Array.from([0]),
        xScale: 'linear',
        yScale: 'linear',
        view: { x: { min: 0, max: 2 }, y: { min: 0, max: 2 } },
        plot: PLOT,
        polygon: [0, 0, 1, 1],
      }),
    ).toEqual([])
  })
})

describe('hit testing', () => {
  it('finds the mark under the pointer and nothing beyond the reach', () => {
    const spec = build([0, 100], [0, 100])
    const index = buildHitIndex(spec)
    const found = index.nearest(spec.px[1]!, spec.py[1]!, 12)
    expect(found).toBe(1)
    expect(index.nearest(spec.px[1]! + 400, spec.py[1]!, 12)).toBe(-1)
  })
})


describe('scales', () => {
  it('round-trips through the transform', () => {
    expect(inverse('log', forward('log', 1000))).toBeCloseTo(1000)
    expect(forward('linear', -4)).toBe(-4)
    expect(forward('log', 0)).toBeNaN()
  })
})
