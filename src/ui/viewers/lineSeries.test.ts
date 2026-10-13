import { describe, expect, it } from 'vitest'
import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import {
  buildLines,
  decimate,
  indicesIn,
  panWindow,
  valuesAt,
  xExtent,
  yExtentOf,
  zoomWindow,
} from './lineSeries'

/** A wide traces table, Simulate's shape: time, then one column per record site. */
const WIDE = makeTable(
  tableSchema(
    column('t', 'f64'),
    column('soma', 'f64'),
    column('tip', 'f64'),
    column('note', 'str'),
  ),
  {
    t: [0, 1, 2, 3],
    soma: [-60, -55, -58, -60],
    tip: [-60, -40, -50, null],
    note: ['a', 'b', 'c', 'd'],
  },
)

/** A long one: a series column, rows out of X order. */
const LONG = makeTable(
  tableSchema(column('t', 'f64'), column('v', 'f64'), column('site', 'str')),
  { t: [2, 0, 1, 0, 1], v: [3, 1, 2, 10, 20], site: ['a', 'a', 'a', 'b', 'b'] },
)

const linear = { order: 'x', xScale: 'linear', yScale: 'linear' } as const

describe('which lines', () => {
  it('draws one line per Y on a wide table, skipping and counting empty cells', () => {
    const { lines, missing } = buildLines(WIDE, { ...linear, x: 't', ys: ['soma', 'tip'] })
    expect(lines.map((l) => l.label)).toEqual(['soma', 'tip'])
    expect(Array.from(lines[1]!.y)).toEqual([-60, -40, -50])
    expect(missing).toBe(1)
  })

  it('draws one line per series value on a long table, joined in X order', () => {
    const { lines } = buildLines(LONG, { ...linear, x: 't', ys: ['v'], series: 'site' })
    expect(lines.map((l) => l.label)).toEqual(['a', 'b'])
    expect(Array.from(lines[0]!.x)).toEqual([0, 1, 2])
    expect(Array.from(lines[0]!.y)).toEqual([1, 2, 3])
    expect(lines[0]!.sorted).toBe(true)
  })

  it('names every Y for every series when both are set', () => {
    const table = makeTable(
      tableSchema(
        column('t', 'f64'),
        column('v', 'f64'),
        column('w', 'f64'),
        column('s', 'str'),
      ),
      { t: [0, 1], v: [1, 2], w: [3, 4], s: ['a', 'a'] },
    )
    const { lines } = buildLines(table, { ...linear, x: 't', ys: ['v', 'w'], series: 's' })
    expect(lines.map((l) => l.label)).toEqual(['a · v', 'a · w'])
  })

  it('keeps row order when asked, for a path that doubles back', () => {
    const { lines } = buildLines(LONG, {
      ...linear,
      order: 'rows',
      x: 't',
      ys: ['v'],
      series: 'site',
    })
    expect(Array.from(lines[0]!.x)).toEqual([2, 0, 1])
    expect(lines[0]!.sorted).toBe(false)
  })

  it('counts what a log axis has no room for', () => {
    const { nonPositive, lines } = buildLines(WIDE, {
      ...linear,
      yScale: 'log',
      x: 't',
      ys: ['soma'],
    })
    expect(nonPositive).toBe(4)
    expect(lines[0]!.x.length).toBe(0)
  })
})

describe('decimation', () => {
  /** A flat trace of `n` samples with one spike a single sample wide. */
  function spiky(n: number, at: number) {
    const x = Float64Array.from({ length: n }, (_, i) => i)
    const y = Float64Array.from({ length: n }, (_, i) => (i === at ? 40 : -60))
    return { label: 'v', x, y, sorted: true }
  }

  it('keeps a one-sample spike that a stride would step over', () => {
    const line = spiky(20_000, 12_345)
    const kept = decimate(line, { min: 0, max: 19_999 }, 500)
    expect(kept.length).toBeLessThanOrEqual(500 * 4 + 2)
    expect(kept).toContain(12_345)
    // In X order, each once.
    expect(kept).toEqual([...new Set(kept)].sort((a, b) => a - b))
  })

  it('leaves a line sparser than its pixels, or an unsorted one, whole', () => {
    expect(decimate(spiky(100, 3), { min: 0, max: 99 }, 500)).toHaveLength(100)
    const loop = { ...spiky(5000, 1), sorted: false }
    expect(decimate(loop, { min: 0, max: 4999 }, 10)).toHaveLength(5000)
  })

  it('draws only the window, and one sample either side so the line reaches the edge', () => {
    const line = spiky(100, 50)
    expect(indicesIn(line, { min: 10.5, max: 20.5 })).toEqual([10, 22])
  })
})

describe('the crosshair and the window', () => {
  const { lines } = buildLines(LONG, { ...linear, x: 't', ys: ['v'], series: 'site' })
  const full = xExtent(lines)!

  it('reads each line at its sample nearest X', () => {
    expect(valuesAt(lines, 0.9, full)).toEqual([
      { x: 1, y: 2 },
      { x: 1, y: 20 },
    ])
    // b has nothing past 1: nearest is 1, still in the window.
    expect(valuesAt(lines, 2, full)[1]).toEqual({ x: 1, y: 20 })
  })

  it('refits Y to what the decimated window holds', () => {
    const extent = (window: { min: number; max: number }) =>
      lines.reduce<{ min: number; max: number } | undefined>(
        (into, line) => yExtentOf(line, decimate(line, window, 100), into),
        undefined,
      )
    expect(extent(full)).toEqual({ min: 1, max: 20 })
    // From 1.5: each line's sample before the window comes with it, so the line reaches the edge.
    expect(extent({ min: 1.5, max: 2 })).toEqual({ min: 2, max: 20 })
  })

  it('zooms about a point within the data, and is the whole extent again when zoomed out', () => {
    const zoomed = zoomWindow(full, full, 0.5, 1)!
    expect(zoomed).toEqual({ min: 0.5, max: 1.5 })
    expect(zoomWindow(zoomed, full, 4, 1)).toBeUndefined()
    expect(panWindow(zoomed, full, 5)).toEqual({ min: 1, max: 2 })
  })
})
