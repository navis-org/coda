/**
 * The pixel pass, read back as pixels.
 *
 * Headless on purpose: it takes a buffer and writes into it, so what it draws is checkable here
 * rather than only in a browser. Each property is a way the picture past `CIRCLES_MAX` could
 * differ from the circle path it stands in for — which is the failure that matters, since a zoom
 * crossing the threshold would then visibly change the cloud.
 */

import { describe, expect, it } from 'vitest'

import type { MarkerShape } from '../encoding'
import type { ScatterSpec } from './scatterPlot'
import { buildMarks, buildScatter } from './scatterPlot'
import type { PixelBuffer } from './scatterRaster'
import { markRgb, markStamp, rasterBox, rasterizeMarks } from './scatterRaster'

const PLOT = { x: 0, y: 0, width: 40, height: 40 }
const VIEW = { x: { min: 0, max: 40 }, y: { min: 0, max: 40 } }

/** Marks at value (x, y) land at pixel (x, 40 − y) under `VIEW` — y is flipped. */
function spec(
  points: [number, number][],
  colours: string[] = points.map(() => '#ff0000'),
  shape: MarkerShape = 'circle',
): ScatterSpec {
  const marks = buildMarks({
    xValues: points.map((p) => p[0]),
    yValues: points.map((p) => p[1]),
    length: points.length,
    xScale: 'linear',
    yScale: 'linear',
    style: { colorAt: (row) => colours[row]!, radiusAt: () => 4, shapeAt: () => shape },
  })
  return buildScatter({ marks, plot: PLOT, view: VIEW, trendColor: '#000000' })
}

/** Painted on black, read back as `[r, g, b, a]` bytes — `ImageData`'s order. */
function paint(
  s: ScatterSpec,
  opacity = 1,
  extra: Partial<Parameters<typeof rasterizeMarks>[1]> = {},
): PixelBuffer & { at: (x: number, y: number) => number[] } {
  const box = rasterBox(s.plot, 1)
  const buffer = { pixels: new Uint32Array(box.width * box.height), ...box }
  rasterizeMarks(buffer, {
    spec: s,
    ratio: 1,
    opacity,
    background: '#000000',
    ...extra,
  })
  const bytes = new Uint8Array(buffer.pixels.buffer)
  return {
    ...buffer,
    at: (x, y) => [...bytes.subarray((y * box.width + x) * 4, (y * box.width + x) * 4 + 4)],
  }
}

const BLACK = [0, 0, 0, 255]

describe('the pixel pass', () => {
  it('fills the mark and nothing far from it', () => {
    const out = paint(spec([[20, 20]]))
    expect(out.at(19, 19)).toEqual([255, 0, 0, 255])
    expect(out.at(2, 2)).toEqual(BLACK)
  })

  it('covers its edge rather than snapping it', () => {
    // Coverage is what stands in for the path's antialiasing; without it the cloud would
    // sharpen into jagged discs the moment a zoom crossed the threshold.
    const out = paint(spec([[20, 20]]))
    const reds = new Set<number>()
    for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) reds.add(out.at(x, y)[0]!)
    expect([...reds].some((r) => r > 0 && r < 255)).toBe(true)
  })

  it('blends overlap at the opacity, as globalAlpha does', () => {
    const out = paint(
      spec([
        [20, 20],
        [20, 20],
      ]),
      0.5,
    )
    // Two layers of 0.5 source-over onto black: 0.5 + 0.5 × 0.5 of full red.
    expect(Math.abs(out.at(19, 19)[0]! - 0.75 * 255)).toBeLessThanOrEqual(2)
    expect(out.at(19, 19)[3]).toBe(255)
  })

  it('stacks a later bucket over an earlier one', () => {
    const out = paint(
      spec(
        [
          [20, 20],
          [20, 20],
        ],
        ['#ff0000', '#0000ff'],
      ),
    )
    expect(out.at(19, 19)).toEqual([0, 0, 255, 255])
  })

  it('rings a selected mark without touching its middle', () => {
    const out = paint(spec([[20, 20]]), 1, { ring: { indices: [0], color: '#ffffff' } })
    expect(out.at(19, 19)).toEqual([255, 0, 0, 255])
    // radius 4 + gap 2.5: the ring passes ~6.5 px right of centre, clear of the mark, so it
    // lands on black and reads as the achromatic ink alone — brightest pixel along that row.
    const row = Array.from({ length: 6 }, (_, k) => out.at(24 + k, 19))
    const ring = row.reduce((best, px) => (px[1]! > best[1]! ? px : best))
    expect(ring[1]).toBeGreaterThan(200)
    expect(ring[0]).toBe(ring[1])
    expect(ring[2]).toBe(ring[1])
  })

  it('clips at the buffer edge rather than wrapping onto the next row', () => {
    const out = paint(spec([[0, 20]]))
    // A mark at the left edge must not bleed into the right-hand end of the row above.
    expect(out.at(out.width - 1, 18)).toEqual(BLACK)
  })

  it('carries the grid under the marks, the buffer replacing what the canvas drew', () => {
    // `putImageData` replaces pixels, so a grid left out of the buffer would vanish wherever
    // the pixel pass runs and reappear as a zoom crossed back below the threshold.
    const out = paint(spec([[30, 30]]), 1, { grid: { color: '#2c2c2a', xs: [5], ys: [] } })
    expect(out.at(5, 35)).toEqual([0x2c, 0x2c, 0x2a, 255])
    expect(out.at(6, 35)).toEqual(BLACK)
  })

  it('area-matches the shapes, as the path pass does', () => {
    // A square stamped at the circle's radius would be 27% larger, and shape would start
    // encoding magnitude by accident (`SQUARE = √π/2`).
    const area = (shape: MarkerShape) => markStamp(shape, 8).coverage.reduce((a, b) => a + b, 0)
    expect(area('square') / area('circle')).toBeCloseTo(1, 1)
  })
})

describe('colours', () => {
  it('reads a hex colour and greys out anything else, rather than drawing it black', () => {
    expect(markRgb('#3987e5')).toEqual([0x39, 0x87, 0xe5])
    expect(markRgb('red')).toEqual([128, 128, 128])
  })
})

describe('the GPU pass', () => {
  it('declines without WebGL2, so the CPU raster draws instead of nothing', async () => {
    // jsdom has no WebGL — which is also every browser where the context is refused or lost.
    // `drawPixels` treats `false` as "draw it yourself"; anything else would be a blank plot.
    const { drawMarksGl } = await import('./scatterGl')
    const s = spec([[20, 20]])
    const drew = drawMarksGl({} as CanvasRenderingContext2D, {
      spec: s,
      ratio: 1,
      box: rasterBox(s.plot, 1),
      opacity: 1,
    })
    expect(drew).toBe(false)
  })
})
