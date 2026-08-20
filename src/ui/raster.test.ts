/**
 * Triangles to masks, and masks to outlines.
 *
 * The test that earns this file is the concave one. A region outline can be produced by sweeping
 * angles around a centroid and taking the furthest surface at each — it is far less code, it
 * looks right on a ball, and it is wrong: it can only describe a star-shaped region, so every
 * notch is quietly filled in and the shape is drawn larger than it is. Neuropils are not
 * star-shaped, so that failure is the normal case rather than an edge case. What is asserted here
 * is that a point sitting in a shape's notch is *outside* the outline it produces.
 */

import { describe, expect, it } from 'vitest'

import { fillTriangle, simplifyClosed, traceOutlines } from './raster'
import type { XY } from './raster'

function mask(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height)
}

/** Paint an axis-aligned rectangle as two triangles, the way a real caller would. */
function rect(
  m: Uint8Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  fillTriangle(m, w, h, [x0, y0], [x1, y0], [x1, y1])
  fillTriangle(m, w, h, [x0, y0], [x1, y1], [x0, y1])
}

/** Ray casting. Used to ask whether a traced outline actually excludes a hollow. */
function inside(ring: readonly XY[], point: XY): boolean {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > point[1] !== yj > point[1]) {
      const cross = ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
      if (point[0] < cross) hit = !hit
    }
  }
  return hit
}

describe('fillTriangle', () => {
  it('fills the interior and nothing outside it', () => {
    const w = 10
    const h = 10
    const m = mask(w, h)
    fillTriangle(m, w, h, [1, 1], [8, 1], [1, 8])
    // Well inside the lower-left triangle.
    expect(m[2 * w + 2]).toBe(255)
    // The opposite corner is across the hypotenuse.
    expect(m[7 * w + 7]).toBe(0)
  })

  it('clips to the mask rather than writing out of bounds', () => {
    const w = 6
    const h = 6
    const m = mask(w, h)
    // Deliberately far outside on every side; a missing bounds check throws or corrupts.
    expect(() => fillTriangle(m, w, h, [-50, -50], [80, -20], [10, 90])).not.toThrow()
    expect(m.length).toBe(w * h)
  })

  it('keeps the brightest value where faces overlap', () => {
    const w = 8
    const h = 8
    const m = mask(w, h)
    fillTriangle(m, w, h, [0, 0], [7, 0], [7, 7], 200)
    fillTriangle(m, w, h, [0, 0], [7, 0], [7, 7], 90)
    expect(m[1 * w + 5]).toBe(200)
  })

  it('marks something for a face seen exactly edge-on', () => {
    const w = 8
    const h = 8
    const m = mask(w, h)
    // Zero area after projection. Dropping these loses whole bands of a curved surface.
    fillTriangle(m, w, h, [2, 2], [5, 2], [7, 2])
    expect(m.some((v) => v > 0)).toBe(true)
  })
})

describe('traceOutlines', () => {
  it('walks the boundary of a solid rectangle once', () => {
    const w = 20
    const h = 20
    const m = mask(w, h)
    rect(m, w, h, 4, 4, 15, 15)

    const rings = traceOutlines(m, w, h)
    expect(rings).toHaveLength(1)
    expect(inside(rings[0]!, [9, 9])).toBe(true)
    expect(inside(rings[0]!, [1, 1])).toBe(false)
  })

  it('follows a concavity into the notch', () => {
    /*
     * A C: two arms and a spine, with a hollow between the arms that opens to the right. The
     * hollow is the whole point — a swept outline reports it as filled.
     */
    const w = 40
    const h = 40
    const m = mask(w, h)
    rect(m, w, h, 6, 6, 32, 13) // top arm
    rect(m, w, h, 6, 6, 13, 33) // spine
    rect(m, w, h, 6, 26, 32, 33) // bottom arm

    const rings = traceOutlines(m, w, h)
    expect(rings).toHaveLength(1)
    const ring = rings[0]!

    // Solid parts are inside.
    expect(inside(ring, [9, 20])).toBe(true) // spine
    expect(inside(ring, [25, 9])).toBe(true) // top arm
    expect(inside(ring, [25, 30])).toBe(true) // bottom arm
    // The hollow is not. This is the assertion the module exists for.
    expect(inside(ring, [25, 20])).toBe(false)
  })

  it('gives every disconnected blob its own ring', () => {
    // A region can genuinely project to two pieces — a U seen edge-on, or anything the explode
    // has pulled off a neighbour. One ring would join them with a line through empty space.
    const w = 40
    const h = 20
    const m = mask(w, h)
    rect(m, w, h, 3, 5, 12, 15)
    rect(m, w, h, 26, 5, 36, 15)

    const rings = traceOutlines(m, w, h)
    expect(rings).toHaveLength(2)
    expect(inside(rings[0]!, [7, 10]) || inside(rings[1]!, [7, 10])).toBe(true)
    expect(inside(rings[0]!, [31, 10]) || inside(rings[1]!, [31, 10])).toBe(true)
    // Nothing in the gap belongs to either.
    expect(inside(rings[0]!, [19, 10])).toBe(false)
    expect(inside(rings[1]!, [19, 10])).toBe(false)
  })

  it('drops specks below the area floor but keeps the region', () => {
    const w = 30
    const h = 30
    const m = mask(w, h)
    rect(m, w, h, 4, 4, 20, 20)
    m[28 * w + 28] = 255 // one stray pixel: a mesh corner seen edge-on

    expect(traceOutlines(m, w, h, 6)).toHaveLength(1)
  })

  it('answers nothing for an empty mask', () => {
    expect(traceOutlines(mask(12, 12), 12, 12)).toEqual([])
  })
})

describe('simplifyClosed', () => {
  it('collapses a staircase without moving the corners', () => {
    const m = mask(40, 40)
    rect(m, 40, 40, 5, 5, 34, 34)
    const ring = traceOutlines(m, 40, 40)[0]!
    const simple = simplifyClosed(ring, 0.75)

    expect(simple.length).toBeLessThan(ring.length / 4)
    // A rectangle needs four points; tracing walks the pixel centres so allow the corners a
    // little slack rather than pinning an exact count.
    expect(simple.length).toBeGreaterThanOrEqual(4)
    expect(inside(simple, [20, 20])).toBe(true)
    expect(inside(simple, [2, 2])).toBe(false)
  })

  it('does not depend on where the trace happened to start', () => {
    const ring: XY[] = []
    for (let a = 0; a < 60; a++) {
      const t = (a / 60) * Math.PI * 2
      ring.push([50 + Math.cos(t) * 20, 50 + Math.sin(t) * 20])
    }
    const rotated = ring.slice(17).concat(ring.slice(0, 17))
    expect(simplifyClosed(rotated, 1).length).toBe(simplifyClosed(ring, 1).length)
  })

  it('leaves a shape too small to simplify alone', () => {
    const tiny: XY[] = [
      [0, 0],
      [1, 0],
      [0, 1],
    ]
    expect(simplifyClosed(tiny, 0.5)).toEqual(tiny)
  })
})
