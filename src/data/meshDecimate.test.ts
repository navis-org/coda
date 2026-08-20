/**
 * Making a mesh smaller before it is stored.
 *
 * What matters is not the reduction ratio — that is a knob — but that the shape survives it.
 * A decimator that shrinks a mesh and moves its surface is worse than none: the ROIs widget
 * traces outlines from these, so a silhouette that drifted would put a region's border in the
 * wrong place with nothing to compare it against.
 */

import { describe, expect, it } from 'vitest'

import { generateRoiMesh } from './mock/morphology'
import { decimateMesh } from './meshDecimate'

/** Axis-aligned bounds, for comparing a shape against its reduction. */
function bounds(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const v = positions[i + axis]!
      if (v < min[axis]!) min[axis] = v
      if (v > max[axis]!) max[axis] = v
    }
  }
  return { min, max }
}

/** A dense sphere, standing in for a full-resolution neuropil. */
function sphere(
  rings = 150,
  segments = 220,
  radius = 1000,
): {
  positions: Float32Array
  indices: Uint32Array
} {
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= rings; i++) {
    const theta = (i / rings) * Math.PI
    for (let j = 0; j <= segments; j++) {
      const phi = (j / segments) * Math.PI * 2
      positions.push(
        Math.sin(theta) * Math.cos(phi) * radius,
        Math.cos(theta) * radius,
        Math.sin(theta) * Math.sin(phi) * radius,
      )
    }
  }
  const stride = segments + 1
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * stride + j
      const b = a + stride
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  return { positions: new Float32Array(positions), indices: Uint32Array.from(indices) }
}

describe('decimateMesh', () => {
  it('reduces a full-resolution surface by an order of magnitude', () => {
    const big = sphere()
    const small = decimateMesh(big.positions, big.indices)
    // As dense as hemibrain's LO(R), which is what this is sized against.
    expect(big.positions.length / 3).toBeGreaterThan(30000)
    expect(small.positions.length / 3).toBeLessThan(big.positions.length / 3 / 8)
    expect(small.indices.length).toBeGreaterThan(0)
  })

  it('keeps the silhouette, which is the only thing the outline tracer reads', () => {
    const big = sphere()
    const small = decimateMesh(big.positions, big.indices)
    const before = bounds(big.positions)
    const after = bounds(small.positions)
    // Clustering pulls the extreme vertices inward by at most a cell, and a cell is a
    // thirty-second of the longest axis. Anything beyond that is the shape having moved.
    const cell = 2000 / 32
    for (let axis = 0; axis < 3; axis++) {
      expect(Math.abs(after.min[axis]! - before.min[axis]!)).toBeLessThan(cell * 1.5)
      expect(Math.abs(after.max[axis]! - before.max[axis]!)).toBeLessThan(cell * 1.5)
    }
  })

  it('emits no degenerate triangles', () => {
    // Two corners landing in one cell leaves a zero-area face: invisible to every raster and a
    // nuisance to anything that later asks it for a normal.
    const big = sphere()
    const small = decimateMesh(big.positions, big.indices)
    for (let t = 0; t < small.indices.length; t += 3) {
      const a = small.indices[t]!
      const b = small.indices[t + 1]!
      const c = small.indices[t + 2]!
      expect(a === b || b === c || a === c).toBe(false)
    }
  })

  it('leaves every index in range', () => {
    const big = sphere()
    const small = decimateMesh(big.positions, big.indices)
    const vertices = small.positions.length / 3
    for (const index of small.indices) expect(index).toBeLessThan(vertices)
  })

  it('is deterministic, so a cached mesh is reproducible', () => {
    const big = sphere(20, 30)
    const a = decimateMesh(big.positions, big.indices)
    const b = decimateMesh(big.positions, big.indices)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices))
  })

  it('returns a mesh with nothing to merge untouched', () => {
    // No copy, so a source that already publishes coarse meshes is not degraded by passing
    // through this.
    const tetra = new Float32Array([0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0, 100])
    const faces = Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3])
    const same = decimateMesh(tetra, faces, 64)
    expect(same.positions).toBe(tetra)
    expect(same.indices).toBe(faces)
  })

  it("welds a UV sphere's seam even at a fine grid, and that is a gain", () => {
    /*
     * A sphere built ring by ring repeats its seam column and collapses every pole ring to one
     * point, so a mesh that is "already coarse" still carries exact duplicates. Merging them is
     * welding rather than decimation — the surface is unchanged and the vertex list is shorter,
     * which is why this path does not try to detect "nothing to do" by grid size alone.
     */
    const roi = generateRoiMesh('CA(R)')
    const welded = decimateMesh(roi.positions, roi.indices, 512)
    expect(welded.positions.length).toBeLessThan(roi.positions.length)

    const before = bounds(roi.positions)
    const after = bounds(welded.positions)
    for (let axis = 0; axis < 3; axis++) {
      expect(after.min[axis]).toBeCloseTo(before.min[axis]!, 3)
      expect(after.max[axis]).toBeCloseTo(before.max[axis]!, 3)
    }
  })

  it('does reduce a mock region at a coarse enough grid', () => {
    const roi = generateRoiMesh('CA(R)')
    const small = decimateMesh(roi.positions, roi.indices, 8)
    expect(small.positions.length).toBeLessThan(roi.positions.length)
    expect(small.indices.length).toBeGreaterThan(0)
  })

  it('refuses to divide by zero on a degenerate mesh', () => {
    const flat = new Float32Array([5, 5, 5, 5, 5, 5, 5, 5, 5])
    const result = decimateMesh(flat, Uint32Array.from([0, 1, 2]))
    expect(result.positions).toBe(flat)
    expect(decimateMesh(new Float32Array(0), new Uint32Array(0)).positions).toHaveLength(0)
  })
})
