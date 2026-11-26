import { describe, expect, it } from 'vitest'

import { clusterAffinities, clusterConfidence, summarise } from './affinityOps'

/** The two fields the clustering reads. */
const cut = (threshold: number, minClusterSize: number) => ({ threshold, minClusterSize })

/** Two blocks: points within a block have affinity `inside`, across blocks `across`. */
function blocks(
  sizes: number[],
  inside: number,
  across: number,
): { a: Float32Array; n: number } {
  const owner: number[] = []
  sizes.forEach((size, block) => {
    for (let i = 0; i < size; i++) owner.push(block)
  })
  const n = owner.length
  const a = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++)
      a[i * n + j] = i === j ? 1 : owner[i] === owner[j] ? inside : across
  }
  return { a, n }
}

describe('clusterAffinities', () => {
  it('separates two well-formed blocks', () => {
    const { a, n } = blocks([20, 20], 0.95, 0.05)
    const got = clusterAffinities(a, n, cut(0.8, 5))
    expect(got.clusters).toBe(2)
    expect(got.background).toBe(0)
    // Same block, same label; different blocks, different.
    expect(got.labels[0]).toBe(got.labels[19])
    expect(got.labels[0]).not.toBe(got.labels[20])
  })

  /**
   * The trap. `t` is a distance on `1 - affinity`, so 0.8 links anything whose mean affinity
   * exceeds 0.2 — including blocks that look well separated at 0.25. Reading it as an affinity
   * cut would split these, which is the silent over-fragmentation the docs warn about.
   */
  it('treats the threshold as a distance, not an affinity', () => {
    const { a, n } = blocks([20, 20], 0.95, 0.25)
    expect(clusterAffinities(a, n, cut(0.8, 5)).clusters).toBe(1)
    // Cut tighter than the across-block distance (0.75) and they separate again.
    expect(clusterAffinities(a, n, cut(0.7, 5)).clusters).toBe(2)
  })

  it('folds a cluster under the minimum into background', () => {
    const { a, n } = blocks([30, 3], 0.95, 0.02)
    const got = clusterAffinities(a, n, cut(0.8, 10))
    expect(got.clusters).toBe(1)
    expect(got.background).toBe(3)
    expect([...got.labels].filter((l) => l === 0)).toHaveLength(3)
  })

  /** Largest first, so "cluster 1" means the same kind of thing from one neuron to the next. */
  it('numbers clusters largest first', () => {
    const { a, n } = blocks([8, 25], 0.95, 0.02)
    const got = clusterAffinities(a, n, cut(0.8, 5))
    expect(got.labels[0]).toBe(2)
    expect(got.labels[n - 1]).toBe(1)
  })

  /**
   * The model is not symmetric, so a pair's distance is the mean of both directions. Two points
   * only, so nothing can link them by a third party: believing either triangle alone would put
   * them at distance 0 or 1 and change the answer at both cuts below.
   */
  it('takes a pair’s distance from the mean of both directions', () => {
    const a = new Float32Array([1, 0, 1, 1])
    // Mean affinity 0.5 -> distance 0.5. Above a 0.45 cut, so they stay apart...
    expect(clusterAffinities(a, 2, cut(0.45, 1)).clusters).toBe(2)
    // ...and below a 0.55 cut, so they join.
    expect(clusterAffinities(a, 2, cut(0.55, 1)).clusters).toBe(1)
  })

  /**
   * Largest-first numbering is this pack's promise and not the reference's, so the parity probe
   * cannot see it: it compares partitions, where numbering is deliberately invisible.
   */
  it('numbers clusters largest first, with background 0', () => {
    const { a, n } = blocks([5, 26, 12], 0.95, 0.02)
    const got = clusterAffinities(a, n, cut(0.8, 8))
    expect(got.clusters).toBe(2)
    expect(got.labels[5]).toBe(1)
    expect(got.labels[31]).toBe(2)
    expect(got.labels[0]).toBe(0)
    expect(got.background).toBe(5)
  })

  it('gives every point a label when nothing is below the cut', () => {
    const { a, n } = blocks([6], 0.95, 0.95)
    const got = clusterAffinities(a, n, cut(0.01, 1))
    expect(got.clusters).toBe(n)
  })
})

describe('clusterConfidence', () => {
  it('reports the mean affinity to the rest of a point’s own cluster', () => {
    const { a, n } = blocks([10, 10], 0.9, 0.1)
    const { labels } = clusterAffinities(a, n, cut(0.8, 5))
    const confidence = clusterConfidence(a, n, labels)
    expect(confidence[0]).toBeCloseTo(0.9, 5)
  })

  /** Background is not a cluster, so there is nothing to be confident about. */
  it('leaves background points null', () => {
    const { a, n } = blocks([30, 3], 0.95, 0.02)
    const { labels } = clusterAffinities(a, n, cut(0.8, 10))
    const confidence = clusterConfidence(a, n, labels)
    const background = [...labels].findIndex((l) => l === 0)
    expect(confidence[background]).toBeNull()
  })
})

describe('summarise', () => {
  const clustering = (clusters: number, background: number) => ({
    labels: new Int32Array(),
    clusters,
    background,
  })

  it('reports the mean and the weakest placed point', () => {
    const got = summarise(clustering(2, 1), [0.9, 0.5, null, 0.7, 0.8])
    expect(got.clusters).toBe(2)
    expect(got.backgroundShare).toBeCloseTo(0.2, 6)
    expect(got.confidence).toBeCloseTo(0.725, 6)
    expect(got.lowestConfidence).toBeCloseTo(0.5, 6)
  })

  it('has no confidence when nothing was placed', () => {
    const got = summarise(clustering(0, 4), [null, null, null, null])
    expect(got.confidence).toBeNull()
    expect(got.lowestConfidence).toBeNull()
    expect(got.backgroundShare).toBe(1)
  })
})
