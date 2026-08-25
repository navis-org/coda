/**
 * The heatmap's fold: what survives when there are more cells than pixels.
 *
 * Headless, and this is where the viewer's real coverage lives — jsdom has no canvas, so the
 * cells themselves are not observable in the suite. What *is* observable, and is what the
 * whole change rests on, is the grid the cells are folded onto and the rule that decides which
 * cell each block is drawn as.
 */

import { describe, expect, it } from 'vitest'

import { makeMatrix } from '../../core/values'
import { sequentialColor } from '../colors'
import {
  HEATMAP_CELLS_WARN,
  axisMarks,
  RAMP_STEPS,
  buildHeatmapSpec,
  bucketOf,
  cellAt,
  colorDomain,
  labelTicks,
  matrixExtent,
  rampColors,
  valueMarks,
} from './heatmapPlot'

const BOX = { width: 400, height: 300 }

function names(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`)
}

function spec(
  rows: number,
  cols: number,
  values: Float64Array,
  over: Partial<{ scale: 'sequential' | 'diverging'; width: number; height: number }> = {},
) {
  const matrix = makeMatrix(names('r', rows), names('c', cols), values)
  return buildHeatmapSpec({
    matrix,
    scale: over.scale ?? 'sequential',
    width: over.width ?? BOX.width,
    height: over.height ?? BOX.height,
    showLabels: true,
  })
}

describe('the drawn grid', () => {
  it('is the matrix itself while every cell still has a pixel', () => {
    const s = spec(
      4,
      5,
      Float64Array.from({ length: 20 }, (_, i) => i),
    )
    expect([s.gridRows, s.gridCols]).toEqual([4, 5])
    expect(s.folded).toBe(false)
    expect(s.foldFactor).toBe(1)
    // No index map: on an unfolded grid it would be the identity, and allocating four bytes a
    // cell to say so is the allocation the fold exists to avoid.
    expect(s.source).toBeUndefined()
    expect(s.buckets.length).toBe(20)
  })

  it('is bounded by the plot however large the matrix is', () => {
    // The property the ceiling rests on: drawing cost follows the card, not the data.
    for (const [rows, cols] of [
      [1_000, 1_000],
      [2_000, 40],
      [40, 4_000],
    ]) {
      const s = spec(rows!, cols!, new Float64Array(rows! * cols!))
      expect(s.gridRows).toBeLessThanOrEqual(Math.floor(s.plot.height))
      expect(s.gridCols).toBeLessThanOrEqual(Math.floor(s.plot.width))
      expect(s.gridRows * s.gridCols).toBeLessThanOrEqual(BOX.width * BOX.height)
      expect(s.buckets.length).toBe(s.gridRows * s.gridCols)
    }
  })

  it('folds and says by how much', () => {
    const s = spec(1_000, 1_000, new Float64Array(1_000_000))
    expect(s.folded).toBe(true)
    expect(s.foldFactor).toBeGreaterThan(1)
  })
})

describe('what a folded block is drawn as', () => {
  /** One strong cell among zeros, on a matrix far larger than the box. */
  function sparse(rows: number, cols: number, row: number, col: number, value: number) {
    const values = new Float64Array(rows * cols)
    values[row * cols + col] = value
    return values
  }

  it('keeps the strongest cell, so a sparse matrix keeps its structure', () => {
    const rows = 1_000
    const cols = 1_000
    const s = spec(rows, cols, sparse(rows, cols, 500, 500, 40))
    expect(s.folded).toBe(true)

    // The one connection reaches the top of the ramp. A mean over its block would put it at a
    // fraction of a percent — off the picture entirely, which is the only thing in it.
    expect(Math.max(...s.buckets)).toBe(RAMP_STEPS - 1)
    expect([...s.buckets].filter((b) => b === RAMP_STEPS - 1)).toHaveLength(1)
    // …and the block remembers which cell it is showing.
    const winner = s.source![s.buckets.indexOf(RAMP_STEPS - 1)]
    expect(winner).toBe(500 * cols + 500)
  })

  it('measures strength from the scale, not from zero', () => {
    // Under a sequential ramp the low end is what "nothing here" looks like, so the *largest*
    // value wins its block — not the largest magnitude, which would let a strong negative draw
    // a block in the palest colour the ramp has.
    const rows = 600
    const cols = 600
    const values = new Float64Array(rows * cols)
    values[0] = -10
    values[1] = 3
    const s = spec(rows, cols, values)
    expect(s.folded).toBe(true)
    expect(s.source![0]).toBe(1)
  })

  it('keeps both tails under a diverging scale', () => {
    const rows = 600
    const cols = 600
    const values = new Float64Array(rows * cols)
    values[0] = 9
    values[1] = -10
    const s = spec(rows, cols, values, { scale: 'diverging' })
    // Zero is the neutral point there, so the furthest from it wins whichever way it goes.
    expect(s.source![0]).toBe(1)
    expect(s.buckets[0]).toBe(0)
  })

  it('does not read a cell nobody recorded as the bottom of the scale', () => {
    const values = Float64Array.from([1, Number.NaN, 3, 4])
    expect(matrixExtent(values)).toEqual({ min: 1, max: 4 })
    const s = spec(2, 2, values)
    // -1 is "nothing landed here": the surface shows through rather than a confident zero.
    expect(s.buckets[1]).toBe(-1)
    expect(s.buckets[0]).toBeGreaterThanOrEqual(0)
  })
})

describe('the hit test', () => {
  it('names a cell of the matrix, not of the grid', () => {
    const rows = 1_000
    const cols = 1_000
    const values = new Float64Array(rows * cols)
    values[123 * cols + 456] = 77
    const s = spec(rows, cols, values)

    const gx = Math.floor((456 * s.gridCols) / cols)
    const gy = Math.floor((123 * s.gridRows) / rows)
    const hit = cellAt(
      s,
      s.plot.x + (gx + 0.5) * s.cellWidth,
      s.plot.y + (gy + 0.5) * s.cellHeight,
    )

    // The strongest cell in the block, by its own row and column — a number somebody can go and
    // look at, where an average of the block would be a number nobody can point at.
    expect(hit).toEqual({ row: 123, col: 456, index: 123 * cols + 456 })
  })

  it('answers nothing outside the plot', () => {
    const s = spec(
      4,
      4,
      Float64Array.from({ length: 16 }, (_, i) => i),
    )
    expect(cellAt(s, 0, 0)).toBeNull()
    expect(cellAt(s, s.plot.x + s.plot.width + 1, s.plot.y + 1)).toBeNull()
  })
})

describe('axis labels', () => {
  it('thins to a legible pitch and reports what it dropped', () => {
    const { ticks, thinned } = labelTicks(names('r', 100), 200, 2, 0)
    expect(ticks.length).toBeLessThan(100)
    expect(thinned).toBe(100 - ticks.length)
    // Every k-th, so what is left is spread across the axis rather than clustered at one end.
    expect(ticks[0]!.index).toBe(0)
    const pitch = ticks[1]!.center - ticks[0]!.center
    expect(pitch).toBeGreaterThanOrEqual(11)
  })

  it('drops nothing while they all fit', () => {
    const { ticks, thinned } = labelTicks(names('r', 8), 160, 20, 5)
    expect(ticks).toHaveLength(8)
    expect(thinned).toBe(0)
  })
})

describe('the ramp lookup', () => {
  /*
   * `ScatterViewer` declines to quantise a sequential ramp, on the grounds that it would put a
   * colour on screen the encoding never returned. This pins the measurement that says a heatmap
   * can: the ramps are piecewise-linear in RGB and the output is 8 bits a channel, so sampling
   * them into `RAMP_STEPS` buckets lands within a rounding step of exact. Shrink `RAMP_STEPS`
   * far enough and this fails, which is the point of having it.
   */
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

  it('is within a rounding step of resolving the colour exactly', () => {
    for (const mode of ['light', 'dark'] as const) {
      const ramp = rampColors('sequential', mode)
      const domain = colorDomain({ min: 0, max: 1 }, 'sequential')
      let worst = 0
      for (let i = 0; i <= 2_000; i++) {
        const value = i / 2_000
        const got = channels(ramp[bucketOf(value, domain)]!)
        const exact = channels(sequentialColor(value, mode))
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(got[c]! - exact[c]!))
      }
      expect(worst).toBeLessThanOrEqual(2)
    }
  })

  it("is one function with the caption's colour bar, sampled coarsely", () => {
    // Two samplings of one ramp is exactly how a colour bar comes to describe a scale the cells
    // are not drawn in.
    const full = rampColors('sequential', 'dark')
    const bar = rampColors('sequential', 'dark', 9)
    expect(bar[0]).toBe(full[0])
    expect(bar[8]).toBe(full[full.length - 1])
  })
})

describe('the caption threshold', () => {
  it('sits far above what the old per-cell drawing could reach', () => {
    // 20,000 was a fact about SVG rather than about matrices: it refused an NBLAST score matrix
    // at a 500-neuron all-by-all, which is 250,000 cells. That number is now not even remarked
    // on — and remarking is all this one does, since the refusal is `CRASH_FLOOR_CELLS`.
    expect(HEATMAP_CELLS_WARN).toBeGreaterThanOrEqual(500 * 500)
  })
})

describe('the chrome placements', () => {
  it('gives a rotated column label the alphabetic baseline, and a row label the central one', () => {
    /*
     * `dominant-baseline: central` centres text across its *reading* direction, so on a column
     * label turned -90° it shifts sideways by half a cap height and the whole band drifts off
     * the columns it names. Caught by a pixel diff against the previous build — jsdom performs
     * no layout, so nothing else here could see a two-pixel move.
     */
    const s = spec(3, 3, Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))
    const marks = axisMarks(s, '#52514e')
    const rows = marks.filter((m) => m.key.startsWith('r-'))
    const cols = marks.filter((m) => m.key.startsWith('c-'))

    expect(rows.length).toBeGreaterThan(0)
    expect(cols.length).toBeGreaterThan(0)
    expect(rows.every((m) => m.baseline === 'central')).toBe(true)
    expect(cols.every((m) => m.baseline === undefined)).toBe(true)
    expect(cols.every((m) => m.transform?.startsWith('rotate(-90'))).toBe(true)
  })

  it("resolves a printed value's ink once, so the card and the file cannot disagree", () => {
    // The overlay and the exporter used to fall back differently for a bucket of -1: ramp-bottom
    // ink on screen, black in the file.
    const s = spec(2, 2, Float64Array.from([1, 2, 3, 4]), { width: 900, height: 700 })
    const ramp = rampColors('sequential', 'dark')
    const marks = valueMarks({ ...s, labelsFit: true }, Float64Array.from([1, 2, 3, 4]), ramp)
    expect(marks).toHaveLength(4)
    expect(marks.every((m) => /^#[0-9a-f]{6}$/i.test(m.fill))).toBe(true)
  })
})
