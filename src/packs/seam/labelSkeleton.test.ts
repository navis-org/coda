import { describe, expect, it } from 'vitest'

import { labelSkeleton } from './labelSkeleton'

/** Six nodes in a line along x, 10 apart. */
const line = new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0, 50, 0, 0])

describe('labelSkeleton', () => {
  /** Points are drawn with replacement, so one node can arrive with two different labels. */
  it('takes the majority of a node’s own draws', () => {
    const labels = labelSkeleton(
      line,
      Int32Array.from([2, 2, 2, 5]),
      Int32Array.from([1, 1, 2, 2]),
    )
    expect(labels[2]).toBe(1)
  })

  /** Ties go to the lower label, so the answer cannot depend on the order draws arrived in. */
  it('breaks a tie on the lower label', () => {
    const one = labelSkeleton(line, Int32Array.from([3, 3]), Int32Array.from([2, 1]))
    const other = labelSkeleton(line, Int32Array.from([3, 3]), Int32Array.from([1, 2]))
    expect(one[3]).toBe(1)
    expect(other[3]).toBe(1)
  })

  it('gives a drawn node its own label and an undrawn one its nearest drawn node’s', () => {
    const labels = labelSkeleton(line, Int32Array.from([0, 5]), Int32Array.from([1, 2]))
    // 1 and 2 are nearer node 0; 3 and 4 are nearer node 5.
    expect([...labels]).toEqual([1, 1, 1, 2, 2, 2])
  })

  /**
   * Background does not spread. "The model saw nothing it was confident about here" is a finding,
   * not a gap to fill with the nearest real cluster.
   */
  it('lets background propagate rather than promoting to a real cluster', () => {
    const labels = labelSkeleton(line, Int32Array.from([0, 5]), Int32Array.from([0, 1]))
    expect(labels[1]).toBe(0)
    expect(labels[4]).toBe(1)
  })

  it('labels every node', () => {
    const labels = labelSkeleton(line, Int32Array.from([2]), Int32Array.from([7]))
    expect([...labels]).toEqual([7, 7, 7, 7, 7, 7])
  })
})
