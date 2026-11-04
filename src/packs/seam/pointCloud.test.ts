import { describe, expect, it } from 'vitest'

import { DEFAULT_SEED, MIN_SKELETON_NODES, pointCloud, skipReason } from './pointCloud'

const scale = 659.88367
/** A skeleton of `nodes` points spread over ~100 µm, in nanometres. */
const skeleton = (nodes: number) => ({
  positions: Float32Array.from({ length: nodes * 3 }, (_, i) => (i % 7) * 15_000),
})

describe('DEFAULT_SEED', () => {
  /**
   * Prose cannot hold this one. Changing the seed leaves every cached provenance key valid while
   * the answer underneath it changes — the one way a fixed seed goes wrong — so the claim in its
   * comment is pinned by a test whose failure message is that claim.
   */
  it('is 1; changing it silently changes every reader’s answer', () => {
    expect(DEFAULT_SEED).toBe(1)
  })
})

describe('pointCloud', () => {
  it('draws exactly the asked-for number of points, centred and scaled', () => {
    const got = pointCloud(skeleton(200), {
      globalScale: scale,
      points: 64,
      seed: DEFAULT_SEED,
    })
    expect(got.positions).toHaveLength(64 * 3)
    expect(got.sourceIndex).toHaveLength(64)
    // Centred on the centroid: the mean of each axis is ~0.
    for (let axis = 0; axis < 3; axis++) {
      let total = 0
      for (let i = 0; i < 64; i++) total += got.positions[i * 3 + axis]!
      expect(total / 64).toBeCloseTo(0, 5)
    }
  })

  /** The same graph must give the same answer; invariant 4 rests on it. */
  it('is deterministic for one seed and differs for another', () => {
    const a = pointCloud(skeleton(200), { globalScale: scale, points: 32, seed: 1 })
    const b = pointCloud(skeleton(200), { globalScale: scale, points: 32, seed: 1 })
    const c = pointCloud(skeleton(200), { globalScale: scale, points: 32, seed: 2 })
    expect([...a.sourceIndex]).toEqual([...b.sourceIndex])
    expect([...a.sourceIndex]).not.toEqual([...c.sourceIndex])
  })

  /** Sorted, as upstream sorts, so a cloud built here is comparable row for row with one there. */
  it('returns its draws sorted', () => {
    const got = pointCloud(skeleton(500), { globalScale: scale, points: 128, seed: 3 })
    expect([...got.sourceIndex]).toEqual([...got.sourceIndex].sort((x, y) => x - y))
  })

  /** With replacement: 128 points out of 20 nodes is normal, not an error. */
  it('draws with replacement', () => {
    const got = pointCloud(skeleton(20), { globalScale: scale, points: 128, seed: 4 })
    expect(new Set(got.sourceIndex).size).toBeLessThan(128)
    expect(Math.max(...got.sourceIndex)).toBeLessThan(20)
  })
})

describe('skipReason', () => {
  it('passes a skeleton in nanometres with enough nodes', () => {
    expect(skipReason(skeleton(200), { units: 'nm' }, 'Skeletons')).toBeUndefined()
    expect(skipReason(skeleton(200), {}, 'Skeletons')).toBeUndefined()
  })

  it('skips coordinates that are not nanometres, naming the remedy', () => {
    const reason = skipReason(skeleton(200), { units: 'voxels' }, 'Skeletons')
    expect(reason).toMatch(/in voxels/)
    expect(reason).toMatch(/Skeletons node/)
  })

  it('skips a skeleton with too little shape to reason about', () => {
    const reason = skipReason(skeleton(MIN_SKELETON_NODES - 1), { units: 'nm' }, 'Skeletons')
    expect(reason).toMatch(new RegExp(`below ${MIN_SKELETON_NODES}`))
  })
})
