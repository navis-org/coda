/**
 * The scatter's pixel pass: marks written straight into an RGBA buffer.
 *
 * What a path of circles costs is Skia's raster, ~3.4 µs a mark measured, so a whole-dataset
 * embedding (fish2 is 129,325 neurons) panned at 2 frames a second. Writing pixels is
 * datashader's move (`pnpm probe:scatter-scale`; the threshold and its numbers are on
 * `CIRCLES_MAX`). It is used only above that threshold, so it has to look like the circle path it
 * stands in for, or the cloud changes as a zoom crosses it:
 *
 *  - **Edges are covered, not snapped.** Every stamp carries each pixel's coverage, from a 4×4
 *    supersample taken once per shape and size and cached — antialiasing that costs nothing per
 *    frame.
 *  - **Overlap is blended**, source-over at the node's `Opacity`, which is the composite
 *    `globalAlpha` gives the path. Last-write-wins was faster and threw `Opacity` away, and
 *    overplotting is the default state of a real scatter.
 *  - **Stacking is the buckets'**, from `visibleBuckets`, the order the path fills them in.
 *
 * **The buffer is opaque, and that is the performance.** It starts as the plot's own background
 * with the grid in it, so every blend is onto an opaque pixel: no division to un-premultiply, and
 * all four channels in two integer multiplies (red and blue share one, sixteen bits apart). The
 * first version blended straight alpha onto transparency and ran at 100 ms a frame where this
 * runs inside one — the overdraw is real, 129,325 marks of ~113 device pixels over a 3.5M-pixel
 * plot, so the per-pixel cost is all there is. Opaque also means one `putImageData` straight onto
 * the canvas, no scratch canvas and no composite.
 *
 * What it does not do is place a mark at a fraction of a pixel: a centre snaps to the nearest
 * device pixel, half a CSS pixel at most on a 2× screen.
 *
 * Headless — a buffer in, a buffer out — so jsdom tests can read the pixels it writes. The canvas
 * plumbing is `scatterDraw.ts`'s.
 */

import type { MarkerShape } from '../../nodes/lib/encodingParams'
import { ALL_SHAPES } from '../../nodes/lib/encodingParams'
import { markVertices } from './markGeometry'
import { parseHex } from '../../style/colors'
import type { Rect, ScatterSpec } from './scatterPlot'
import { markAlpha, pointInPolygon, visibleBuckets } from './scatterPlot'

/** The selection ring's gap from its mark and its width, in CSS pixels — every painter's. */
export const RING_GAP = 2.5
export const RING_WIDTH = 1.5

/**
 * A device-pixel buffer covering a box whose top-left is `originX`, `originY`, one `Uint32` a
 * pixel in `ImageData`'s byte order read little-endian: `0xAABBGGRR`. Every engine that runs this
 * app is little-endian.
 */
export interface PixelBuffer {
  pixels: Uint32Array
  width: number
  height: number
  originX: number
  originY: number
}

/** The device-pixel box covering a plot rect at a pixel ratio. */
export function rasterBox(
  plot: Rect,
  ratio: number,
): { originX: number; originY: number; width: number; height: number } {
  const originX = Math.floor(plot.x * ratio)
  const originY = Math.floor(plot.y * ratio)
  return {
    originX,
    originY,
    width: Math.max(1, Math.ceil((plot.x + plot.width) * ratio) - originX),
    height: Math.max(1, Math.ceil((plot.y + plot.height) * ratio) - originY),
  }
}

/** One mark's footprint around the pixel holding its centre. */
interface Stamp {
  dx: Int16Array
  dy: Int16Array
  coverage: Float32Array
  reach: number
  /** Coverage times the last opacity asked for, out of 256 — kept, the opacity rarely moving. */
  weights?: { alpha: number; values: Uint16Array }
}

const SUPERSAMPLE = 4

/**
 * Stamps by a numeric key — kind, then radius and width in quarter pixels — because a size
 * encoding changes the radius nearly every mark, and a string key per lookup was one short-lived
 * string per mark per frame.
 */
const stamps = new Map<number, Stamp>()
const RING_KIND = ALL_SHAPES.length
const kindOf = new Map<MarkerShape, number>(ALL_SHAPES.map((shape, index) => [shape, index]))

/** In quarter pixels, so a size ramp makes a bounded number of stamps. */
function quarters(r: number): number {
  return Math.max(1, Math.round(r * 4))
}

function stampKey(kind: number, radius: number, width = 0): number {
  return (quarters(radius) * 1024 + (width > 0 ? quarters(width) : 0)) * 16 + kind
}

function buildStamp(inside: (x: number, y: number) => boolean, reach: number): Stamp {
  const dx: number[] = []
  const dy: number[] = []
  const coverage: number[] = []
  for (let y = -reach; y <= reach; y++) {
    for (let x = -reach; x <= reach; x++) {
      let hits = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          if (inside(x - 0.5 + (sx + 0.5) / SUPERSAMPLE, y - 0.5 + (sy + 0.5) / SUPERSAMPLE))
            hits++
        }
      }
      if (hits > 0) {
        dx.push(x)
        dy.push(y)
        coverage.push(hits / (SUPERSAMPLE * SUPERSAMPLE))
      }
    }
  }
  return {
    dx: Int16Array.from(dx),
    dy: Int16Array.from(dy),
    coverage: Float32Array.from(coverage),
    reach,
  }
}

/** The filled mark at a device-pixel radius. */
export function markStamp(shape: MarkerShape, radius: number): Stamp {
  const key = stampKey(kindOf.get(shape) ?? 0, radius)
  let stamp = stamps.get(key)
  if (stamp) return stamp
  const r = quarters(radius) / 4
  const reach = Math.ceil(r * 1.5) + 1
  if (shape === 'circle') {
    stamp = buildStamp((x, y) => x * x + y * y <= r * r, reach)
  } else {
    const polygon = markVertices(shape).flatMap(([vx, vy]) => [vx! * r, vy! * r])
    stamp = buildStamp((x, y) => polygon.length >= 6 && pointInPolygon(x, y, polygon), reach)
  }
  stamps.set(key, stamp)
  return stamp
}

/** A ring of `width` centred on `radius`, both in device pixels — the selection mark. */
function ringStamp(radius: number, width: number): Stamp {
  const key = stampKey(RING_KIND, radius, width)
  let stamp = stamps.get(key)
  if (stamp) return stamp
  const r = quarters(radius) / 4
  const w = quarters(width) / 4
  const inner = Math.max(0, r - w / 2)
  const outer = r + w / 2
  stamp = buildStamp(
    (x, y) => {
      const d = x * x + y * y
      return d >= inner * inner && d <= outer * outer
    },
    Math.ceil(outer) + 1,
  )
  stamps.set(key, stamp)
  return stamp
}

function weightsFor(stamp: Stamp, alpha: number): Uint16Array {
  if (stamp.weights?.alpha === alpha) return stamp.weights.values
  const values = Uint16Array.from(stamp.coverage, (c) => Math.round(c * alpha * 256))
  stamp.weights = { alpha, values }
  return values
}

/**
 * A mark colour as bytes, through `colors.ts`' one hex reader. Every colour the encodings hand
 * out is a literal `#rrggbb`, so anything that does not read is a bug upstream — drawn mid-grey
 * rather than as black or not at all, so it is visible. Shared with the GPU pass.
 */
export function markRgb(color: string): [number, number, number] {
  const rgb = parseHex(color)
  return rgb.every(Number.isFinite) ? rgb : [128, 128, 128]
}

/** An opaque pixel in the buffer's byte order. */
function packOpaque(color: string): number {
  const [r, g, b] = markRgb(color)
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0
}

/**
 * Source-over one stamp onto opaque pixels. With the destination opaque the result is opaque and
 * `out = (src·a + dst·(256 − a)) / 256` per channel, which red and blue compute together: each
 * product is under 2¹⁶, so neither field carries into the other.
 */
function blendStamp(
  buffer: PixelBuffer,
  stamp: Stamp,
  weights: Uint16Array,
  cx: number,
  cy: number,
  color: number,
): void {
  const { pixels, width, height } = buffer
  const { dx, dy, reach } = stamp
  const whole = cx - reach >= 0 && cy - reach >= 0 && cx + reach < width && cy + reach < height
  if (
    !whole &&
    (cx + reach < 0 || cy + reach < 0 || cx - reach >= width || cy - reach >= height)
  )
    return
  const srcRB = color & 0x00ff00ff
  const srcG = color & 0x0000ff00
  for (let k = 0; k < weights.length; k++) {
    const x = cx + dx[k]!
    const y = cy + dy[k]!
    if (!whole && (x < 0 || y < 0 || x >= width || y >= height)) continue
    const a = weights[k]!
    const keep = 256 - a
    const at = y * width + x
    const d = pixels[at]!
    const rb = (d & 0x00ff00ff) * keep + srcRB * a
    const g = (d & 0x0000ff00) * keep + srcG * a
    pixels[at] = 0xff000000 | ((rb >>> 8) & 0x00ff00ff) | ((g >>> 8) & 0x0000ff00)
  }
}

/**
 * Paint the plot: background, grid, the buckets, then the selection rings — the order the path
 * pass draws in. `grid` positions are CSS pixels, as `drawScatter` computes them; a line is one
 * CSS pixel wide, which is what its `+ 0.5` stroke covers. Ring indices are in range, which
 * `drawScatter` sees to.
 */
export function rasterizeMarks(
  buffer: PixelBuffer,
  options: {
    spec: ScatterSpec
    ratio: number
    opacity: number
    background: string
    grid?: { color: string; xs: number[]; ys: number[] }
    ring?: { indices: Iterable<number>; color: string }
  },
): void {
  const { spec, ratio } = options
  const { pixels, width, height, originX, originY } = buffer
  pixels.fill(packOpaque(options.background))
  // The device pixel holding a coordinate's centre.
  const column = (x: number) => Math.round(x * ratio - originX - 0.5)
  const row = (y: number) => Math.round(y * ratio - originY - 0.5)

  if (options.grid) {
    const ink = packOpaque(options.grid.color)
    const thick = Math.max(1, Math.round(ratio))
    for (const x of options.grid.xs) {
      const from = Math.round(x * ratio) - originX
      for (let col = Math.max(0, from); col < Math.min(width, from + thick); col++)
        for (let r = 0; r < height; r++) pixels[r * width + col] = ink
    }
    for (const y of options.grid.ys) {
      const from = Math.round(y * ratio) - originY
      for (let r = Math.max(0, from); r < Math.min(height, from + thick); r++)
        pixels.fill(ink, r * width, r * width + width)
    }
  }

  const alpha = markAlpha(options.opacity)
  for (const bucket of visibleBuckets(spec)) {
    const color = packOpaque(bucket.color)
    // Looked up again only when the radius moves to another quarter pixel, which under a size
    // encoding is far less often than it moves at all.
    let lastQuarters = -1
    let stamp: Stamp | undefined
    let weights: Uint16Array | undefined
    for (const i of bucket.indices) {
      const radius = spec.marks.radius[i]! * ratio
      if (quarters(radius) !== lastQuarters) {
        stamp = markStamp(bucket.shape, radius)
        weights = weightsFor(stamp, alpha)
        lastQuarters = quarters(radius)
      }
      blendStamp(buffer, stamp!, weights!, column(spec.px[i]!), row(spec.py[i]!), color)
    }
  }

  if (options.ring) {
    const color = packOpaque(options.ring.color)
    let lastQuarters = -1
    let stamp: Stamp | undefined
    let weights: Uint16Array | undefined
    for (const i of options.ring.indices) {
      const radius = (spec.marks.radius[i]! + RING_GAP) * ratio
      if (quarters(radius) !== lastQuarters) {
        stamp = ringStamp(radius, RING_WIDTH * ratio)
        weights = weightsFor(stamp, 1)
        lastQuarters = quarters(radius)
      }
      blendStamp(buffer, stamp!, weights!, column(spec.px[i]!), row(spec.py[i]!), color)
    }
  }
}
