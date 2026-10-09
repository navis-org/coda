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
import type { MarksOptions, Viewport } from './scatterPlot'
import {
  axisTicks,
  buildHitIndex,
  buildMarks,
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
  usableRows,
} from './scatterPlot'

const PLOT = { x: 0, y: 0, width: 200, height: 100 }

/** Marks every point identically, so a test can be about geometry and nothing else. */
const FLAT = {
  colorAt: () => '#3987e5',
  radiusAt: () => 3,
  shapeAt: () => 'circle' as const,
}

/** Marks and one frame of them; `view` and `aspect` go to the frame, the rest to the marks. */
function build(
  xs: ColumnData,
  ys: ColumnData,
  extra: Partial<MarksOptions> & { view?: Viewport; aspect?: 'fit' | 'equal' } = {},
) {
  const { view, aspect, ...rest } = extra
  const marks = buildMarks({
    xValues: xs,
    yValues: ys,
    length: xs.length,
    xScale: 'linear',
    yScale: 'linear',
    style: FLAT,
    ...rest,
  })
  return buildScatter({
    marks,
    plot: PLOT,
    trendColor: '#000000',
    ...(view ? { view } : {}),
    ...(aspect ? { aspect } : {}),
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

describe('culling', () => {
  it('draws every usable row — there is no sample any more', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i)
    const spec = build(xs, xs)
    expect(spec.marks.rows).toHaveLength(100)
    expect(spec.px).toHaveLength(100)
  })

  it('counts as visible only the marks that reach the plot, radius included', () => {
    // A zoom into one cluster has to cost what that cluster costs, and `CIRCLES_MAX` is
    // counted against this — so a whole-dataset embedding zoomed in hands back real circles.
    const xs = [0, 1, 2, 10, 20]
    const view = { x: { min: -0.5, max: 2.5 }, y: { min: -0.5, max: 2.5 } }
    const spec = build(xs, xs, { view })
    expect([...spec.visible]).toEqual([0, 1, 2])
    // A mark whose centre is just outside but whose disc pokes in is still drawn.
    const edge = build([0, 2.51], [1, 1], { view, style: { ...FLAT, radiusAt: () => 6 } })
    expect([...edge.visible]).toEqual([0, 1])
  })

  it('indexes only visible marks for the hover', () => {
    // Off-screen marks used to clamp into the border cells, and a hover along the edge then
    // walked a zoomed-out remainder of the whole cloud. They cannot be under the pointer.
    const xs = [0, 1, 50]
    const view = { x: { min: -1, max: 2 }, y: { min: -1, max: 2 } }
    const spec = build(xs, xs, { view })
    const index = buildHitIndex(spec)
    const edgeX = PLOT.x + PLOT.width - 1
    expect(index.nearest(edgeX, PLOT.y + 1, 12)).toBe(-1)
  })
})

describe('batching', () => {
  it('buckets by colour and shape in order of first appearance', () => {
    // The order is the stacking order, and every painter shares it — the circle path and the
    // pixel pass included, or the cloud restacks as a zoom crosses `CIRCLES_MAX`.
    const colours = ['#bbbbbb', '#aaaaaa', '#bbbbbb', '#aaaaaa']
    const shapes = ['circle', 'circle', 'square', 'circle'] as const
    const spec = build([0, 1, 2, 3], [0, 1, 2, 3], {
      style: {
        colorAt: (row: number) => colours[row]!,
        radiusAt: () => 3,
        shapeAt: (row: number) => shapes[row]!,
      },
    })
    const { buckets, bucketOf } = spec.marks
    expect([...bucketOf]).toEqual([0, 1, 2, 1])
    expect(buckets.map((b) => [b.color, b.shape, b.indices])).toEqual([
      ['#bbbbbb', 'circle', [0]],
      ['#aaaaaa', 'circle', [1, 3]],
      ['#bbbbbb', 'square', [2]],
    ])
  })
})

describe('domains', () => {
  it('gives a single distinct value a window rather than zero span', () => {
    // Zero span divides by zero on projection and puts every point on one edge.
    const domain = padDomain({ min: 7, max: 7 })
    expect(domain.max).toBeGreaterThan(domain.min)
  })

  it('reads the extent in transformed space, so a log axis frames decades', () => {
    const marks = build([1, 10, 1000], [1, 1, 1], { xScale: 'log' }).marks
    expect(marks.extent?.x).toEqual({ min: 0, max: 3 })
    expect(extentOf(Float64Array.from([2, -1, 5]))).toEqual({ min: -1, max: 5 })
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

  it('catches every mark inside it, on screen or not, and names their source rows', () => {
    // Tested at the frame's projection rather than against what was painted, so the answer
    // cannot depend on whether the marks were traced as paths or written as pixels — and a
    // zoom does not shrink what a lasso round the whole plane catches.
    const xs = [null, ...Array.from({ length: 100 }, (_, i) => i)]
    const spec = build(xs, xs, { view: { x: { min: 0, max: 10 }, y: { min: 0, max: 10 } } })
    const hits = rowsInPolygon(spec, rectPolygon(-1e6, -1e6, 1e6, 1e6))
    expect(hits).toHaveLength(100)
    // Source rows, not mark positions: row 0 had no coordinate and is not a mark.
    expect(hits[0]).toBe(1)
  })

  it('answers nothing for a polygon with no area', () => {
    expect(rowsInPolygon(build([1], [1]), [0, 0, 1, 1])).toEqual([])
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
