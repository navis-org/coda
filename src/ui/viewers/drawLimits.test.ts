/**
 * What one draw call may ask for.
 *
 * Its own file beside `drawLimits.ts`, having started in `meshPicking.test.ts` — the limit has
 * nothing to do with raycasting, and filing it there is how the next geometry channel never finds
 * out the limit exists.
 */

import { describe, expect, it } from 'vitest'

import { MAX_INDICES_PER_DRAW, computeNormals, drawRanges } from './drawLimits'

/**
 * Splitting a mesh across draw calls, which is what makes a full-resolution neuron visible.
 *
 * Firefox refuses a draw asking for more than 30,000,000 index values —
 * `webgl.max-vert-ids-per-draw` — and simply does not draw it. An aedes neuron is 13.1 M
 * triangles, which is 39.4 M indices, so a scene of two drew nothing while every buffer was
 * uploaded successfully (measured at 627 MB on an M3 Max: never a memory problem). Neuroglancer
 * shows the same neurons because it draws each supervoxel fragment separately; Coda merges them,
 * so the split has to come back at the last moment.
 */
describe('drawRanges', () => {
  it('leaves an ordinary mesh as one draw', () => {
    // The common case pays nothing: one range, and `MeshItem` keeps its single geometry.
    expect(drawRanges(0)).toEqual([[0, 0]])
    expect(drawRanges(999)).toEqual([[0, 999]])
    expect(drawRanges(MAX_INDICES_PER_DRAW)).toEqual([[0, MAX_INDICES_PER_DRAW]])
  })

  it('splits the two real aedes neurons that would not draw', () => {
    for (const triangles of [13_143_221, 12_935_560]) {
      const ranges = drawRanges(triangles * 3)
      expect(ranges.length).toBe(2)
      for (const [, count] of ranges) expect(count).toBeLessThanOrEqual(MAX_INDICES_PER_DRAW)
    }
  })

  it('covers every index exactly once, and never lands inside a triangle', () => {
    for (const count of [MAX_INDICES_PER_DRAW + 3, 39_429_663, 120_000_003]) {
      const ranges = drawRanges(count)
      let at = 0
      for (const [start, length] of ranges) {
        expect(start).toBe(at)
        // A split inside a triangle would drop two corners and draw a third at random.
        expect(start % 3).toBe(0)
        at += length
      }
      expect(at).toBe(count)
    }
  })

  it('stays under the limit it exists for, with headroom', () => {
    // Named against Firefox's own number rather than left as a bare constant: the two are what
    // this file is about, and a cap raised past the refusal point is invisible until somebody
    // opens a large neuron in the one browser that enforces it.
    expect(MAX_INDICES_PER_DRAW).toBeLessThan(30_000_000)
    expect(MAX_INDICES_PER_DRAW % 3).toBe(0)
  })
})

describe('computeNormals', () => {
  /** One triangle in the xy plane, whose normal can only be ±z. */
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = Uint32Array.from([0, 1, 2])

  it('gives every corner the face normal, unit length', () => {
    const normals = computeNormals(positions, indices)
    expect(Array.from(normals)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1])
  })

  it('weights a shared vertex by face area, which is what three does', () => {
    /*
     * The reason the cross product is accumulated **unnormalised**: a large triangle and a sliver
     * meeting at a vertex must not count equally, or a decimated arbor shades as though its
     * slivers were half the surface. Two triangles of very different area sharing corner 0, tilted
     * opposite ways — the big one has to win.
     */
    const shared = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 1, 0, -10, -100])
    const faces = Uint32Array.from([0, 1, 2, 0, 3, 1])
    const normals = computeNormals(shared, faces)
    const big = computeNormals(shared, Uint32Array.from([0, 3, 1]))
    // Corner 0's normal leans towards the larger face's.
    expect(Math.sign(normals[2]!)).toBe(Math.sign(big[2]!))
  })

  it('leaves a degenerate vertex at zero rather than dividing by it', () => {
    // A vertex no triangle touches accumulates nothing; normalising it would be 0/0.
    const loose = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5])
    const normals = computeNormals(loose, Uint32Array.from([0, 1, 2]))
    expect(Array.from(normals.slice(9))).toEqual([0, 0, 0])
  })
})
