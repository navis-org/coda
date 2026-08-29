/**
 * The two back-ends that draw a mark, checked against each other.
 *
 * `markVertices` is consumed by the canvas and the SVG export; `SHAPE_SDF` is consumed by the
 * WebGL node program, which **no test can import** — `sigma/rendering` touches WebGL globals at
 * module scope. So the shader's geometry is generated here, in a module with no sigma in it,
 * and what is pinned is that the generated GLSL agrees with the polygons.
 *
 * The check is run against a hand-written JS twin of the SDF. That is a second implementation,
 * which is normally the thing to avoid — but the alternative is no check at all on a pair that
 * has to agree to the digit, and the failure it catches is invisible: a network and a scatter
 * drawing one category at different weights, or the one asymmetric mark drawn upside-down.
 */

import { describe, expect, it } from 'vitest'

import { ALL_SHAPES } from '../encoding'
import type { MarkerShape } from '../encoding'
import {
  ARM,
  DASH,
  DIAMOND,
  MARK_EXTENT,
  REACH,
  SQUARE,
  SHAPE_SDF,
  TRIANGLE,
  markVertices,
} from './markGeometry'

/** Is a point inside the polygon `markVertices` describes? Even-odd ray cast. */
function insidePolygon(shape: MarkerShape, x: number, y: number): boolean {
  const vertices = markVertices(shape)
  let inside = false
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const [xi, yi] = vertices[i] as [number, number]
    const [xj, yj] = vertices[j] as [number, number]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * The shader's `sdShape`, transcribed to JS from the same constants the GLSL is built from.
 *
 * Deliberately written against the *constants*, not against the emitted string: a transcription
 * of the string would pass by construction and prove nothing about the numbers.
 */
function sdShape(shape: MarkerShape, rawX: number, rawY: number): number {
  // The flip the shader applies on entry: sigma's graph y runs up, `markVertices` runs down.
  const px = rawX
  const py = -rawY
  const box = (hx: number, hy: number) => {
    const dx = Math.abs(px) - hx
    const dy = Math.abs(py) - hy
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0)
  }
  switch (shape) {
    case 'circle':
      return Math.hypot(px, py) - 1
    case 'square':
      return box(SQUARE, SQUARE)
    case 'triangle':
      return Math.max(
        py - TRIANGLE / 2,
        Math.cos(Math.PI / 6) * Math.abs(px) - 0.5 * py - TRIANGLE / 2,
      )
    case 'diamond':
      return (Math.abs(px) + Math.abs(py) - DIAMOND) * Math.SQRT1_2
    case 'cross':
    case 'plus': {
      const c = Math.SQRT1_2
      const qx = shape === 'cross' ? px * c + py * c : px
      const qy = shape === 'cross' ? -px * c + py * c : py
      const arm = (hx: number, hy: number) => {
        const dx = Math.abs(qx) - hx
        const dy = Math.abs(qy) - hy
        return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0)
      }
      return Math.min(arm(REACH, ARM), arm(ARM, REACH))
    }
    default:
      return box(REACH, DASH)
  }
}

describe('the shader and the polygons describe the same marks', () => {
  /** A grid over the drawable field, in graph coordinates (y up). */
  const samples: Array<[number, number]> = []
  for (let i = -20; i <= 20; i++) {
    for (let j = -20; j <= 20; j++) samples.push([(i / 20) * 1.4, (j / 20) * 1.4])
  }

  it.each(ALL_SHAPES.filter((shape) => shape !== 'circle'))(
    'agrees about what is inside a %s',
    (shape) => {
      /*
       * Sampled rather than proved. Points within a hair of an edge are skipped: the SDF is a
       * slight over-estimate past a corner by design, and the polygon test is exact, so the two
       * legitimately disagree inside that band.
       */
      let checked = 0
      for (const [x, y] of samples) {
        const distance = sdShape(shape, x, y)
        if (Math.abs(distance) < 0.05) continue
        checked++
        // `markVertices` is screen-space (y down); the samples are graph-space (y up).
        expect(insidePolygon(shape, x, -y)).toBe(distance < 0)
      }
      expect(checked).toBeGreaterThan(1000)
    },
  )

  it('draws the triangle point-up on both, which only the flip achieves', () => {
    /*
     * The one mark that is not symmetric about y, and so the only one that can be silently
     * upside-down. `markVertices` puts the apex at negative y because it is screen-space; the
     * shader runs in graph space where y is up, so without the flip on entry the canvas would
     * draw ▼ while the legend and the SVG export drew ▲ — from the same numbers.
     */
    const apexUp = markVertices('triangle')[0] as [number, number]
    expect(apexUp[1]).toBeLessThan(0)
    // In graph space the apex is at +y, and just inside it must be inside the mark.
    expect(sdShape('triangle', 0, TRIANGLE * 0.9)).toBeLessThan(0)
    // ...while the same distance below the centre is outside, because the base is at half.
    expect(sdShape('triangle', 0, -TRIANGLE * 0.9)).toBeGreaterThan(0)
  })

  it('keeps every mark inside the quad the shader rasterises', () => {
    // `MARK_EXTENT` sizes that quad. A mark reaching past it has its corners clipped, which
    // reads as a rendering artefact rather than as a bug.
    for (const shape of ALL_SHAPES) {
      for (const [x, y] of markVertices(shape)) {
        expect(Math.hypot(x!, y!)).toBeLessThanOrEqual(MARK_EXTENT + 1e-9)
      }
    }
  })

  it('generates the GLSL from the constants rather than from literals', () => {
    // If someone re-types a number into the shader string, this is what notices.
    expect(SHAPE_SDF).toContain(SQUARE.toFixed(6))
    expect(SHAPE_SDF).toContain(DIAMOND.toFixed(6))
    expect(SHAPE_SDF).toContain(REACH.toFixed(6))
    expect(SHAPE_SDF).toContain(ARM.toFixed(6))
    expect(SHAPE_SDF).toContain(DASH.toFixed(6))
  })
})
