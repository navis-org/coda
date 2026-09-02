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
import { heatmapPaletteStops, sequentialColor } from '../colors'
import { DIVERGING_PALETTE_OPTIONS, SEQUENTIAL_PALETTE_OPTIONS } from '../../nodes/lib/heatmapParams'
import {
  HEATMAP_CELLS_WARN,
  axisMarks,
  RAMP_STEPS,
  axisMap,
  buildHeatmapSpec,
  bucketOf,
  cellAt,
  cellRect,
  colorDomain,
  fullWindow,
  isFullWindow,
  labelTicks,
  matrixExtent,
  panWindow,
  pointToMatrix,
  rampColors,
  valueMarks,
  windowScale,
  zoomWindow,
} from './heatmapPlot'
import type { HeatmapWindow } from './heatmapPlot'

const BOX = { width: 400, height: 300 }

function names(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`)
}

function spec(
  rows: number,
  cols: number,
  values: Float64Array,
  over: Partial<{
    scale: 'sequential' | 'diverging'
    width: number
    height: number
    window: HeatmapWindow
  }> = {},
) {
  const matrix = makeMatrix(names('r', rows), names('c', cols), values)
  return buildHeatmapSpec({
    matrix,
    scale: over.scale ?? 'sequential',
    width: over.width ?? BOX.width,
    height: over.height ?? BOX.height,
    showLabels: true,
    ...(over.window ? { window: over.window } : {}),
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
    const { ticks, thinned } = labelTicks(names('r', 100), axisMap(100, 0, 200, 0, 100), 0, 200)
    expect(ticks.length).toBeLessThan(100)
    expect(thinned).toBe(100 - ticks.length)
    // Every k-th, so what is left is spread across the axis rather than clustered at one end.
    expect(ticks[0]!.index).toBe(0)
    const pitch = ticks[1]!.center - ticks[0]!.center
    expect(pitch).toBeGreaterThanOrEqual(11)
  })

  it('drops nothing while they all fit', () => {
    const { ticks, thinned } = labelTicks(names('r', 8), axisMap(8, 5, 160, 0, 8), 5, 160)
    expect(ticks).toHaveLength(8)
    expect(thinned).toBe(0)
  })

  it('un-thins as a zoom gives each line the pixels it needs', () => {
    // 100 lines in 200px is every ninth label; ten of them in the same 200px is every label.
    const zoomed = labelTicks(names('r', 100), axisMap(100, 0, 200, 40, 10), 0, 200)
    expect(zoomed.ticks.map((t) => t.index)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49])
    expect(zoomed.thinned).toBe(0)
  })

  it('names a line part way off the plot over the part that is on it', () => {
    // Four lines in 400px, the window starting 0.4 of a line in: line 40 has 60px on screen and
    // is named over those 60px, not at its own centre 10px above the plot.
    const { ticks, thinned } = labelTicks(names('r', 100), axisMap(100, 0, 400, 40.4, 4), 0, 400)
    expect(ticks[0]).toMatchObject({ index: 40, label: 'r40' })
    expect(ticks[0]!.center).toBeCloseTo(30, 6)
    expect(ticks.every((t) => t.center >= 0 && t.center <= 400)).toBe(true)
    expect(thinned).toBe(0)
  })

  it('names every k-th interior line, whatever the rounding of its edges', () => {
    // 95 lines over 700px: 7.37px each, every second one named. The interior lines' visible
    // extent is their own pitch computed two ways, and an exact comparison lost 29 of 47.
    const { ticks, thinned } = labelTicks(names('r', 401), axisMap(401, 0, 700, 150.3, 95), 0, 700)
    const gaps = ticks.slice(1).map((t, i) => t.index - ticks[i]!.index)
    expect(new Set(gaps)).toEqual(new Set([2]))
    // Lines 150 and 245 are slivers (0.7 and 0.3 of a line on screen); of the 94 between them
    // the even-indexed 47 are named and the other 47 are what the thinning dropped.
    expect(ticks).toHaveLength(47)
    expect(thinned).toBe(47)
  })

  it('keeps the same lines named across a pan', () => {
    const before = labelTicks(names('r', 401), axisMap(401, 0, 700, 150.3, 95), 0, 700)
    const after = labelTicks(names('r', 401), axisMap(401, 0, 700, 151.1, 95), 0, 700)
    const shared = before.ticks.filter((t) => after.ticks.some((u) => u.index === t.index))
    // Every line still on screen keeps its name; only the ones that scrolled off changed.
    expect(shared.length).toBeGreaterThanOrEqual(before.ticks.length - 1)
  })

  it('leaves a sliver unnamed and does not count it as thinned', () => {
    // 0.95 of a line in on a 20px pitch: line 40 has 1px on screen, less than a label's pitch,
    // so it is not named — and not reported as a dropped label either, which at ×15 on three
    // visible lines read as "labels thinned" over a plot showing every name it could.
    const { ticks, thinned } = labelTicks(names('r', 100), axisMap(100, 0, 200, 40.95, 10), 0, 200)
    expect(ticks[0]!.index).toBe(41)
    expect(thinned).toBe(0)
  })
})

describe('the window', () => {
  const full = { row0: 0, col0: 0, rows: 100, cols: 50 }

  it('zooms about the anchor and stays inside the matrix', () => {
    const half = zoomWindow(full, full, { row: 50, col: 25 }, 0.5)
    expect(half).toEqual({ row0: 25, col0: 12.5, rows: 50, cols: 25 })
    // Anchored in a corner, the window cannot leave the matrix — it slides instead.
    const corner = zoomWindow(full, full, { row: 0, col: 0 }, 0.5)
    expect(corner).toEqual({ row0: 0, col0: 0, rows: 50, cols: 25 })
    // Zooming out past the whole matrix is the whole matrix, which the viewer reads as "fit".
    const out = zoomWindow(half, full, { row: 50, col: 25 }, 4)
    expect(isFullWindow(out, full)).toBe(true)
    expect(windowScale(half, full)).toBe(2)
  })

  it('will not zoom below one line', () => {
    const tiny = zoomWindow(full, full, { row: 10, col: 10 }, 0.001)
    expect(tiny.rows).toBe(1)
    expect(tiny.cols).toBe(1)
  })

  it('pans, clamped', () => {
    const half = { row0: 25, col0: 12.5, rows: 50, cols: 25 }
    expect(panWindow(half, full, 10, -5)).toEqual({ row0: 35, col0: 7.5, rows: 50, cols: 25 })
    expect(panWindow(half, full, 1000, -1000)).toEqual({ row0: 50, col0: 0, rows: 50, cols: 25 })
  })

  it('is what the fold reads: zoomed in, a folded matrix shows its real cells', () => {
    const rows = 1_000
    const cols = 1_000
    const values = new Float64Array(rows * cols)
    values[500 * cols + 500] = 40
    values[501 * cols + 500] = 20
    const fitted = spec(rows, cols, values)
    expect(fitted.folded).toBe(true)

    // Twenty lines each way around the strong cell: every visible cell gets its own pixels.
    const window = { row0: 490.5, col0: 490.5, rows: 20, cols: 20 }
    const zoomed = spec(rows, cols, values, { window })
    expect(zoomed.folded).toBe(false)
    expect(zoomed.foldFactor).toBe(1)
    expect([zoomed.rowMap.first, zoomed.rowMap.visible]).toEqual([490, 21])
    expect(zoomed.buckets.length).toBe(21 * 21)
    // The grid starts half a line before the plot's edge — the painter clips.
    expect(zoomed.colMap.origin).toBeLessThan(zoomed.plot.x)
    expect(zoomed.plot.x - zoomed.colMap.origin).toBeCloseTo(zoomed.cellWidth / 2, 6)

    // The strong cell is where the hit test and the ring agree it is, by matrix index.
    const box = cellRect(zoomed, 500, 500)
    const hit = cellAt(zoomed, box.x + box.width / 2, box.y + box.height / 2)
    expect(hit).toEqual({ row: 500, col: 500, index: 500 * cols + 500 })
    // …and both neighbours are distinct cells now, where the fit folded them into one block.
    expect(cellAt(zoomed, box.x + box.width / 2, box.y + box.height * 1.5)?.row).toBe(501)
    // The colour domain is the whole matrix's, not the window's: a zoom changes no colour.
    expect(zoomed.domain).toEqual(fitted.domain)
    expect(Math.max(...zoomed.buckets)).toBe(RAMP_STEPS - 1)
  })

  it('folds only the visible block when still past 1:1', () => {
    const rows = 4_000
    const cols = 4_000
    const window = { row0: 1000, col0: 1000, rows: 2000, cols: 2000 }
    const zoomed = spec(rows, cols, new Float64Array(rows * cols), { window })
    expect(zoomed.folded).toBe(true)
    expect(zoomed.rowMap.visible).toBe(2000)
    expect(zoomed.foldFactor).toBeLessThan(spec(rows, cols, new Float64Array(rows * cols)).foldFactor)
    // The last visible line lands in the last grid cell, never past it.
    expect(cellRect(zoomed, 2999, 2999).x + zoomed.cellWidth).toBeLessThanOrEqual(
      zoomed.plot.x + zoomed.plot.width + 1e-6,
    )
  })

  it('maps a plot pixel back to a fractional matrix coordinate', () => {
    const s = spec(10, 10, new Float64Array(100))
    const centre = pointToMatrix(s, s.plot.x + s.plot.width / 2, s.plot.y + s.plot.height / 2)
    expect(centre).toEqual({ row: 5, col: 5 })
    expect(fullWindow(makeMatrix(['a'], ['b', 'c'], new Float64Array(2)))).toEqual({
      row0: 0,
      col0: 0,
      rows: 1,
      cols: 2,
    })
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
    // Each gutter's labels clip to their own gutter; a printed value clips to the plot.
    expect(rows.every((m) => m.zone === 'rows')).toBe(true)
    expect(cols.every((m) => m.zone === 'cols')).toBe(true)
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

describe('the published palettes', () => {
  /*
   * Transcribed by a script from the installed matplotlib and seaborn, so what a test can pin
   * is the transcription's *shape* and the two facts a reader would check against a paper: the
   * endpoints, and that the ramp is read low-to-high as published in both themes.
   */
  it('carries 64 stops for a continuous ramp and eleven anchors for a ColorBrewer set', () => {
    for (const { value } of SEQUENTIAL_PALETTE_OPTIONS) {
      if (value === 'coda') continue
      expect(heatmapPaletteStops(value), value).toHaveLength(64)
    }
    for (const { value } of DIVERGING_PALETTE_OPTIONS) {
      if (value === 'coda') continue
      expect(heatmapPaletteStops(value), value).toHaveLength(11)
    }
  })

  it('runs viridis from purple to yellow on both surfaces, unlike Coda’s own', () => {
    for (const mode of ['light', 'dark'] as const) {
      const ramp = rampColors('sequential', mode, RAMP_STEPS, 'viridis')
      expect(ramp[0]).toBe('#440154')
      expect(ramp[ramp.length - 1]).toBe('#fde725')
    }
    // Coda's flips with the theme; that is the whole reason it stays the default.
    expect(rampColors('sequential', 'light')[0]).not.toBe(rampColors('sequential', 'dark')[0])
  })

  it('puts RdBu’s red at the negative end, as published', () => {
    const ramp = rampColors('diverging', 'dark', RAMP_STEPS, 'RdBu')
    expect(ramp[0]).toBe('#67001f')
    expect(ramp[ramp.length - 1]).toBe('#053061')
    expect(ramp[Math.floor(RAMP_STEPS / 2)]).toBe('#f7f7f7')
  })

  it('falls back to Coda’s ramp for a name from the other scale’s list', () => {
    expect(rampColors('sequential', 'dark', 9, 'RdBu')).toEqual(rampColors('sequential', 'dark', 9))
    expect(rampColors('diverging', 'dark', 9, 'viridis')).toEqual(rampColors('diverging', 'dark', 9))
  })
})
