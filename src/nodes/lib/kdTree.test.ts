/**
 * The tree against brute force, which is the only check worth making of it.
 *
 * A k-d tree that prunes one branch too eagerly returns a real point at a plausible distance,
 * so nothing about the answer looks wrong — the failure is a number a few per cent too large in
 * a matrix of numbers nobody can check by eye. Every case here therefore compares against the
 * exhaustive scan rather than against a recorded expectation.
 */

import { describe, expect, it } from 'vitest'
import { cloud } from './__fixtures__/rng'
import { anyPairWithin, buildKdTree, closestPair } from './kdTree'

function bruteNearest(positions: Float32Array, x: number, y: number, z: number): number {
  let best = Infinity
  for (let i = 0; i < positions.length / 3; i++) {
    const d = Math.hypot(
      positions[i * 3]! - x,
      positions[i * 3 + 1]! - y,
      positions[i * 3 + 2]! - z,
    )
    if (d < best) best = d
  }
  return best
}

describe('buildKdTree', () => {
  it('matches brute force on every query, inside and outside the cloud', () => {
    const positions = cloud(2000)
    const tree = buildKdTree(positions)
    const probes = cloud(200, 30_000, 99)
    for (let i = 0; i < 200; i++) {
      const x = probes[i * 3]! - 10_000
      const y = probes[i * 3 + 1]! - 10_000
      const z = probes[i * 3 + 2]! - 10_000
      expect(tree.nearest(x, y, z)).toBeCloseTo(bruteNearest(positions, x, y, z), 4)
    }
  })

  it('answers a point of the set itself at zero', () => {
    const positions = cloud(500)
    const tree = buildKdTree(positions)
    for (let i = 0; i < 500; i += 37) {
      expect(
        tree.nearest(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!),
      ).toBe(0)
    }
  })

  it('reports Infinity rather than a number past maxDist', () => {
    const positions = cloud(1000)
    const tree = buildKdTree(positions)
    // Far outside the cloud, which spans 0..10,000 on every axis.
    expect(tree.nearest(1e6, 1e6, 1e6, 1000)).toBe(Infinity)
    expect(tree.nearest(1e6, 1e6, 1e6)).toBeCloseTo(bruteNearest(positions, 1e6, 1e6, 1e6), 3)
  })

  it('bounds the answer without changing it', () => {
    const positions = cloud(1500)
    const tree = buildKdTree(positions)
    const probes = cloud(100, 12_000, 7)
    for (let i = 0; i < 100; i++) {
      const x = probes[i * 3]!
      const y = probes[i * 3 + 1]!
      const z = probes[i * 3 + 2]!
      const exact = bruteNearest(positions, x, y, z)
      // Generous bound: the same number. Tight bound: Infinity, never a wrong number.
      expect(tree.nearest(x, y, z, exact * 2 + 1)).toBeCloseTo(exact, 4)
      expect(tree.nearest(x, y, z, exact * 0.5)).toBe(Infinity)
    }
  })

  it('agrees with nearest about what is within a distance', () => {
    const positions = cloud(800)
    const tree = buildKdTree(positions)
    const probes = cloud(150, 14_000, 3)
    for (let i = 0; i < 150; i++) {
      const x = probes[i * 3]!
      const y = probes[i * 3 + 1]!
      const z = probes[i * 3 + 2]!
      for (const dist of [100, 500, 2000]) {
        expect(tree.hasWithin(x, y, z, dist)).toBe(bruteNearest(positions, x, y, z) <= dist)
      }
    }
  })

  it('handles a degenerate set: one point, a line, and none at all', () => {
    const empty = buildKdTree(new Float32Array(0))
    expect(empty.count).toBe(0)
    expect(empty.nearest(0, 0, 0)).toBe(Infinity)
    expect(empty.hasWithin(0, 0, 0, 1e9)).toBe(false)

    const one = buildKdTree(Float32Array.from([3, 4, 0]))
    expect(one.nearest(0, 0, 0)).toBeCloseTo(5, 6)

    // Every point on one axis: two of the three spans are zero, so the split axis has to be picked
    // third or the tree never splits.
    const line = new Float32Array(300)
    for (let i = 0; i < 100; i++) line[i * 3 + 1] = i * 10
    const tree = buildKdTree(line)
    expect(tree.nearest(0, 455, 0)).toBeCloseTo(5, 6)
  })

  it('handles coincident points, which is what a split plane cannot separate', () => {
    // 400 points at the same place plus one elsewhere: quickselect's pivot equals every value
    // in the range, so a partition that cannot make progress loops forever or splits emptily.
    const positions = new Float32Array(401 * 3)
    positions[400 * 3] = 1000
    const tree = buildKdTree(positions)
    expect(tree.nearest(0, 0, 0)).toBe(0)
    expect(tree.nearest(1000, 0, 0)).toBe(0)
    expect(tree.nearest(500, 0, 0)).toBeCloseTo(500, 6)
  })
})

describe('closestPair', () => {
  /** The same answer the per-point loop gives, which is what it replaces. */
  const viaPoints = (a: Float32Array, b: Float32Array): number => {
    const tree = buildKdTree(b)
    let best = Infinity
    for (let i = 0; i < a.length / 3; i++) {
      const d = tree.nearest(a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!)
      if (d < best) best = d
    }
    return best
  }

  it('agrees with asking every point of one set for its nearest in the other', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const a = cloud(700, 10_000, seed)
      const b = cloud(900, 10_000, seed + 100)
      expect(closestPair(buildKdTree(a), buildKdTree(b))).toBeCloseTo(viaPoints(a, b), 4)
    }
  })

  it('agrees when the two sets are far apart, which is the case it exists for', () => {
    const a = cloud(1500, 10_000, 7)
    const b = cloud(1500, 10_000, 9)
    // Push b a long way off on one axis; the two roots are then rejected immediately.
    for (let i = 0; i < 1500; i++) b[i * 3] = b[i * 3]! + 500_000
    expect(closestPair(buildKdTree(a), buildKdTree(b))).toBeCloseTo(viaPoints(a, b), 3)
  })

  it('is symmetric, which is what lets the reverse direction be skipped', () => {
    for (const seed of [11, 12, 13]) {
      const a = cloud(400, 8_000, seed)
      const b = cloud(600, 8_000, seed + 50)
      const ab = closestPair(buildKdTree(a), buildKdTree(b))
      const ba = closestPair(buildKdTree(b), buildKdTree(a))
      expect(ab).toBeCloseTo(ba, 9)
    }
  })

  it('answers zero for sets that share a point, and for a set against itself', () => {
    const a = cloud(300, 5_000, 21)
    expect(closestPair(buildKdTree(a), buildKdTree(a))).toBe(0)
    const b = cloud(300, 5_000, 22)
    b.set(a.subarray(0, 3), 0)
    expect(closestPair(buildKdTree(a), buildKdTree(b))).toBe(0)
  })

  it('answers Infinity when either side is empty', () => {
    const a = cloud(100, 1_000, 31)
    expect(closestPair(buildKdTree(a), buildKdTree(new Float32Array(0)))).toBe(Infinity)
    expect(closestPair(buildKdTree(new Float32Array(0)), buildKdTree(a))).toBe(Infinity)
  })

  it('handles one point against many, and deeply unbalanced sizes', () => {
    const many = cloud(5000, 20_000, 41)
    const one = Float32Array.from([1000, 2000, 3000])
    expect(closestPair(buildKdTree(one), buildKdTree(many))).toBeCloseTo(
      viaPoints(one, many),
      4,
    )
    expect(closestPair(buildKdTree(many), buildKdTree(one))).toBeCloseTo(
      viaPoints(one, many),
      4,
    )
  })

  it('survives a descent deeper than the initial stack', () => {
    // Two long collinear runs: the boxes overlap along the line, so the descent pairs many nodes
    // before it can prune — which is what grows the stack past its 256 entries.
    const n = 20_000
    const a = new Float32Array(n * 3)
    const b = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      a[i * 3] = i
      b[i * 3] = i + 0.25
    }
    expect(closestPair(buildKdTree(a), buildKdTree(b))).toBeCloseTo(0.25, 5)
  })
})

describe('anyPairWithin', () => {
  /*
   * `closestPair`'s question as a yes or a no, so the check is against `closestPair` itself
   * rather than against recorded expectations: the two must agree at every distance, or the
   * `within` pre-rejection drops pairs that really do come close and the cells read a flat zero.
   * An early exit that leaves a branch unvisited is exactly that failure and nothing about the
   * matrix would look wrong.
   */
  const treeA = buildKdTree(cloud(400, 10_000, 3))
  const treeB = buildKdTree(cloud(400, 10_000, 9))
  const far = buildKdTree(cloud(400, 10_000, 11).map((v) => v + 80_000) as Float32Array)

  it('agrees with the closest approach at every distance, either side of it', () => {
    for (const [a, b] of [
      [treeA, treeB],
      [treeA, far],
      [far, treeB],
    ] as const) {
      const closest = closestPair(a, b)
      for (const dist of [0, closest / 2, closest * 0.999, closest * 1.001, closest * 2, 1e9]) {
        expect(anyPairWithin(a, b, dist)).toBe(closest <= dist)
      }
    }
  })

  it('counts a pair exactly at the distance as within it, as hasWithin does', () => {
    const a = buildKdTree(Float32Array.from([0, 0, 0]))
    const b = buildKdTree(Float32Array.from([100, 0, 0]))
    expect(anyPairWithin(a, b, 100)).toBe(true)
    expect(anyPairWithin(a, b, 99.999)).toBe(false)
  })

  it('answers false when either side is empty, never true by vacuum', () => {
    const empty = buildKdTree(new Float32Array(0))
    expect(anyPairWithin(empty, treeA, 1e9)).toBe(false)
    expect(anyPairWithin(treeA, empty, 1e9)).toBe(false)
  })

  it('is symmetric, and answers zero distance for a set against itself', () => {
    expect(anyPairWithin(treeA, treeB, 5_000)).toBe(anyPairWithin(treeB, treeA, 5_000))
    expect(anyPairWithin(treeA, treeA, 0)).toBe(true)
  })

  it('survives a descent deeper than the initial stack, as closestPair does', () => {
    // Two large co-located sets: every box pair overlaps, so the stack grows past its 256 triples.
    const big = buildKdTree(cloud(20_000, 1_000, 21))
    const alsoBig = buildKdTree(cloud(20_000, 1_000, 22))
    expect(anyPairWithin(big, alsoBig, 0.001)).toBe(closestPair(big, alsoBig) <= 0.001)
    expect(anyPairWithin(big, alsoBig, 1_000)).toBe(true)
  })
})
