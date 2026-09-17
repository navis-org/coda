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
import { mulberry32 } from './mock/generate'
import {
  decimateMesh,
  decimateParts,
  downsampleParts,
  downsamples,
  gridForFactor,
  reduceToTriangles,
  reductionFor,
} from './meshDecimate'
import { concatMeshes, type MeshArrays } from './meshParts'

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
function sphere(rings = 150, segments = 220, radius = 1000): MeshArrays {
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

/** A triangle with no extent: nothing to cluster, and a divide by zero if anything tries. */
const DEGENERATE: MeshArrays = {
  positions: new Float32Array([5, 5, 5, 5, 5, 5, 5, 5, 5]),
  indices: Uint32Array.from([0, 1, 2]),
}

/**
 * How many cells a mesh occupies, written the slow obvious way.
 *
 * A string key per vertex — what `decimateMesh`'s own comment rejects for allocating half a
 * million throwaway strings — which is exactly what makes it a usable oracle: it cannot collide,
 * so any disagreement is the packed key's.
 */
function clusterWithStringKeys(positions: Float32Array, grid: number): number {
  const { min, max } = bounds(positions)
  const cell = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) / grid
  const seen = new Set<string>()
  for (let i = 0; i < positions.length; i += 3) {
    const cx = Math.floor((positions[i]! - min[0]!) / cell)
    const cy = Math.floor((positions[i + 1]! - min[1]!) / cell)
    const cz = Math.floor((positions[i + 2]! - min[2]!) / cell)
    seen.add(`${cx},${cy},${cz}`)
  }
  return seen.size
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
    const result = decimateMesh(DEGENERATE.positions, DEGENERATE.indices)
    expect(result.positions).toBe(DEGENERATE.positions)
    expect(decimateMesh(new Float32Array(0), new Uint32Array(0)).positions).toHaveLength(0)
  })
})

/**
 * The same clustering over a mesh that arrives in pieces — see `decimateParts` for why skipping
 * the join is safe.
 *
 * That argument is what is tested: it is only worth anything if it changes no pixel, so the two
 * routes are compared **byte-identical**, not close.
 */
describe('decimateParts', () => {
  /**
   * The sphere cut into `n` fragments, the way a manifest hands one over.
   *
   * A fragment is its own little mesh in world coordinates, so the slice is contiguous and a
   * vertex's local index is just `global - from` — which also means `concatMeshes` of the parts
   * reproduces the sphere exactly, and every part is non-empty by construction.
   */
  function fragments(n: number): MeshArrays[] {
    const whole = sphere(60, 90)
    const vertices = whole.positions.length / 3
    const parts: MeshArrays[] = []
    for (let k = 0; k < n; k++) {
      const from = Math.floor((k * vertices) / n)
      const to = Math.floor(((k + 1) * vertices) / n)
      const inside = (i: number): boolean => i >= from && i < to
      const indices: number[] = []
      for (let t = 0; t + 2 < whole.indices.length; t += 3) {
        const a = whole.indices[t]!
        const b = whole.indices[t + 1]!
        const c = whole.indices[t + 2]!
        if (inside(a) && inside(b) && inside(c)) indices.push(a - from, b - from, c - from)
      }
      parts.push({
        positions: whole.positions.subarray(from * 3, to * 3),
        indices: Uint32Array.from(indices),
      })
    }
    return parts
  }

  it('is byte-identical to joining the parts and decimating that, at every grid', () => {
    // The grid decides how much merges, and how much merges is what the two walks could disagree
    // about — a coarse grid shares cells across fragment boundaries, a fine one barely does.
    const parts = fragments(17)
    const joined = concatMeshes(parts)
    for (const grid of [4, 16, 24, 64, 256]) {
      const viaJoin = decimateMesh(joined.positions, joined.indices, grid)
      const direct = decimateParts(parts, grid)
      expect(direct.positions.length).toBeGreaterThan(0)
      expect(Array.from(direct.positions)).toEqual(Array.from(viaJoin.positions))
      expect(Array.from(direct.indices)).toEqual(Array.from(viaJoin.indices))
    }
  })

  it('never allocates the joined mesh, which is the whole point', () => {
    /*
     * Counted rather than read off the code, because the failure mode is a future edit that
     * quietly joins first and still passes every test above.
     */
    const parts = fragments(9)
    const real = Float32Array
    let allocated = 0
    class Counting extends Float32Array {
      constructor(length: number) {
        super(length)
        allocated += length
      }
    }
    const total = parts.reduce((sum, part) => sum + part.positions.length, 0)
    try {
      globalThis.Float32Array = Counting as unknown as Float32ArrayConstructor
      decimateParts(parts, 24)
    } finally {
      globalThis.Float32Array = real
    }
    // The output only. A joined copy would add every input vertex on top of it.
    expect(allocated).toBeLessThan(total)
  })

  it('joins rather than refusing, for the cases with nothing to merge', () => {
    /*
     * `decimateMesh` hands its caller's arrays straight back in these cases; over parts the same
     * answer is the parts joined, so a caller never has to tell "reduced" from "as given" apart.
     */
    expect(decimateParts([]).positions).toHaveLength(0)
    const tri: MeshArrays = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
    }
    // A grid too coarse to be a grid, and a mesh with no extent — both divide by zero otherwise.
    expect(decimateParts([tri], 1).positions).toBe(tri.positions)
    expect(decimateParts([DEGENERATE]).positions).toBe(DEGENERATE.positions)

    // Two parts with nothing to merge come back joined, and the join is a real one.
    const joined = decimateParts([tri, tri], 1)
    expect(joined.positions).toHaveLength(tri.positions.length * 2)
    expect(Array.from(joined.indices)).toEqual([0, 1, 2, 3, 4, 5])
  })
})

/**
 * The packed cell key, which neither test above can see.
 *
 * Both compare `decimateParts` against `decimateMesh`, and those are the same code — so a key
 * that is injective and one that is not give both sides the same answer. A sphere cannot show it
 * either: its box is a cube, so every axis multiplier is equal and a wrong one is
 * indistinguishable from a right one.
 */
describe('the cell key', () => {
  it('collides on no box, including one that is nothing like a cube', () => {
    /*
     * The key packs three cell indices into one number with **per-axis** multipliers, and the two
     * tests above cannot see that: they compare `decimateParts` against `decimateMesh`, which is
     * the same code, so any key that is injective *or not* gives both sides the same answer. A
     * sphere cannot see it either — its box is a cube, so every multiplier is equal and a wrong
     * one is indistinguishable.
     *
     * So this is an independent oracle: the same clustering written the obvious slow way, with a
     * string key that cannot collide, over a deliberately oblong mesh. A multiplier that is too
     * small merges two cells that should stay apart, which shows up here as fewer vertices out.
     */
    const rnd = mulberry32(99)
    const count = 4000
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      // 40 : 4 : 1, so the three axes need three different cell counts.
      positions[i * 3] = rnd() * 40000
      positions[i * 3 + 1] = rnd() * 4000
      positions[i * 3 + 2] = rnd() * 1000
    }
    const indices = new Uint32Array((count - 2) * 3)
    for (let t = 0; t + 2 < count; t++) {
      indices[t * 3] = t
      indices[t * 3 + 1] = t + 1
      indices[t * 3 + 2] = t + 2
    }

    for (const grid of [8, 32, 128]) {
      const expected = clusterWithStringKeys(positions, grid)
      expect(decimateMesh(positions, indices, grid).positions.length / 3).toBe(expected)
    }
  })
})

/**
 * `Downsample` on the Meshes node: reduce a mesh to roughly `1 / factor` of its triangles.
 *
 * The property is that the factor asked for is near the factor delivered, on meshes of very
 * different shapes — which a grid computed from `0.68 · grid²` is not. That model is a *surface's*
 * law, and a neuron is a thin tree in a large box; measured on four real mosquito neurons the
 * exponent runs 1.6 to 2.0, so asking for half the triangles of the sparsest delivered a
 * twenty-seventh of them.
 */
describe('downsampleParts', () => {
  it("reduces by the factor asked for, from each mesh's own triangle count", () => {
    /*
     * `Downsample`, not `Detail`. The seam says a source with one level ignores `triangleBudget`,
     * and graphene is that source — so the budget used to be honoured here by clustering
     * vertices, which made one control mean "pick a published level" on neuPrint and "recompute
     * the geometry" on FlyWire. The factor is the explicit half, and it is taken from **each
     * mesh's own** triangle count so every neuron in a set is reduced by the same ratio.
     */
    expect(gridForFactor(1_000_000, 4)).toBeLessThan(gridForFactor(1_000_000, 1))
    // Halving the triangles is a grid smaller by √2, the clustering being an area.
    expect(gridForFactor(1_000_000, 2) / gridForFactor(1_000_000, 8)).toBeCloseTo(2, 1)
    // Two neurons of different sizes, same factor: the ratio is what is preserved, not the count.
    expect(gridForFactor(1_000_000, 4)).toBeGreaterThan(gridForFactor(100_000, 4))
    // Never so coarse that the arbor goes — the floor is under every factor.
    expect(gridForFactor(1_000, 1_000_000)).toBe(gridForFactor(1, 1))
  })

  it('treats 0 and 1 as full resolution, and only >1 as a reduction', () => {
    // Four surfaces ask "is this on", which is exactly how it comes to be spelled `> 1` in three
    // of them and `>= 1` in the fourth.
    expect(downsamples(undefined)).toBe(false)
    expect(downsamples(0)).toBe(false)
    expect(downsamples(1)).toBe(false)
    expect(downsamples(2)).toBe(true)
  })

  /**
   * A dense surface, whose occupied cells really do grow as the square of the grid.
   *
   * Full resolution deliberately: `sphere(60, 90)` is *already* coarser than `MIN_DECIMATE_GRID`
   * can reduce — its vertices sit 70 apart where the floor's cells are 42 — so it saturates at
   * 1.24× whatever is asked, which says nothing about the fit. That saturation is real and a
   * caller meets it on an already-coarse mesh; it is just not what this test is about.
   */
  const dense = (): MeshArrays[] => [sphere()]

  /**
   * A thin tube wandering through a box many times its own thickness — the shape the area model
   * gets wrong, and a mild stand-in for an arbor: on a real neuron the model is out by more.
   */
  function sparse(): MeshArrays[] {
    const rnd = mulberry32(7)
    const steps = 4000
    const ring = 8
    const positions = new Float32Array(steps * ring * 3)
    const indices: number[] = []
    let x = 0,
      y = 0,
      z = 0
    for (let t = 0; t < steps; t++) {
      x += (rnd() - 0.5) * 400
      y += (rnd() - 0.5) * 400
      z += (rnd() - 0.5) * 400
      for (let r = 0; r < ring; r++) {
        const a = (r / ring) * Math.PI * 2
        const at = (t * ring + r) * 3
        positions[at] = x + Math.cos(a) * 30
        positions[at + 1] = y + Math.sin(a) * 30
        positions[at + 2] = z
        if (t + 1 < steps) {
          const here = t * ring + r
          const next = t * ring + ((r + 1) % ring)
          indices.push(here, next, here + ring, next, next + ring, here + ring)
        }
      }
    }
    return [{ positions, indices: Uint32Array.from(indices) }]
  }

  const triangles = (parts: readonly MeshArrays[]): number =>
    parts.reduce((n, p) => n + p.indices.length / 3, 0)

  it('lands near the factor asked for, on a surface and on a tube alike', () => {
    for (const build of [dense, sparse]) {
      const parts = build()
      const before = triangles(parts)
      for (const factor of [2, 4]) {
        const achieved = before / (downsampleParts(parts, factor).indices.length / 3)
        /*
         * A factor of two either way, and honestly so: the grid is fitted from two probes of a
         * power law that is only approximately one, so this is "the right order of reduction"
         * rather than a guarantee. What it rules out is the failure it was written for — the
         * unfitted model returned a *twenty-seventh* of a real neuron for a requested half. Measured on
         * four of those, spanning
         * 111k to 23.8M triangles, the fit lands at 1.7–2.0× for ÷2 and 3.2–3.4× for ÷4: a little
         * under, which is the safe direction, since erring the other way deletes geometry nobody
         * asked to lose.
         */
        expect(achieved).toBeGreaterThan(factor / 2)
        expect(achieved).toBeLessThan(factor * 2)
      }
    }
  })

  it('is closer than the unfitted model on the shape the model is wrong about', () => {
    /*
     * The comparative claim, which is the one that survives a change of fixture. A thin tube is
     * where `0.68 · grid²` fails — it is a surface's law — and the synthetic one here is milder
     * than a real neuron — see `countCells` for the figure there.
     */
    const parts = sparse()
    const before = triangles(parts)
    for (const factor of [2, 16]) {
      const modelled =
        before / (decimateParts(parts, gridForFactor(before, factor)).indices.length / 3)
      const fitted = before / (downsampleParts(parts, factor).indices.length / 3)
      expect(Math.abs(fitted - factor)).toBeLessThan(Math.abs(modelled - factor))
    }
  })

  it('hands back the join, by identity where it can, for a factor that asks for nothing', () => {
    // 0 and 1 are the default and the identity. A caller never has to branch, so neither may
    // quietly become a reduction.
    const parts = dense()
    for (const factor of [undefined, 0, 1]) {
      const out = downsampleParts(parts, factor as number)
      expect(out.positions).toBe(parts[0]!.positions)
    }
  })
})

/**
 * `Downsample`'s automatic setting: keep as much as a scene can draw, and nothing less.
 *
 * It is a *triangle target* rather than a factor because no factor is right for two datasets at
 * once — one aedes neuron is 13.1 M triangles where one FlyWire neuron is 1.3 M, so the factor
 * that makes the first drawable erases the second. That is not hypothetical: the control shipped
 * for one round with 0 meaning "off", and the two aedes neurons in an ordinary workflow came to
 * 472 MB of typed arrays and drew nothing at all.
 */
describe('reduceToTriangles', () => {
  it('hands a mesh that already fits straight back, untouched', () => {
    // The property that makes automatic free on a small mesh, and on a pyramid whose level was
    // already chosen against the same budget — otherwise every scene would pay a fit it did not
    // need, and every caption would claim a reduction nobody made.
    const parts = [sphere(60, 90)]
    const triangles = parts[0]!.indices.length / 3
    const out = reduceToTriangles(parts, triangles * 2)
    expect(out.positions).toBe(parts[0]!.positions)
    expect(out.indices).toBe(parts[0]!.indices)
  })

  it('brings a mesh that does not fit down near the target', () => {
    const parts = [sphere()]
    const before = parts[0]!.indices.length / 3
    const out = reduceToTriangles(parts, before / 8)
    const after = out.indices.length / 3
    expect(after).toBeLessThan(before)
    // The same tolerance the factor gets, and for the same reason: the grid is fitted, so this
    // is "the right order of reduction" rather than a guarantee — measured at 3.8× for a target
    // of an eighth on this fixture, which errs towards keeping geometry.
    expect(before / after).toBeGreaterThan(8 / 2.5)
    expect(before / after).toBeLessThan(8 * 2)
  })

  it('splits the ceiling between the neurons in the set', () => {
    // A scene's budget is the *scene's*, so twenty neurons each get a twentieth of it — which is
    // what stops a set being reduced by whichever neuron in it is largest.
    expect(reductionFor('auto', 1, 1_500_000)).toEqual({ targetTriangles: 1_500_000 })
    expect(reductionFor('auto', 20, 1_500_000)).toEqual({ targetTriangles: 75_000 })
  })

  it('reads 1 and absent as full resolution, and a number above 1 as a ratio', () => {
    expect(reductionFor(undefined, 2, 1_500_000)).toBeUndefined()
    expect(reductionFor(1, 2, 1_500_000)).toBeUndefined()
    expect(reductionFor(4, 2, 1_500_000)).toEqual({ factor: 4 })
  })
})
