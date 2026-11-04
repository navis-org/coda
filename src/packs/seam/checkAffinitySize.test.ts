/**
 * The two rails, on the two tiers. What matters is which tier each is on, and that the wait is
 * priced over the **set** — a per-neuron estimate warns about the wrong thing.
 */

import { describe, expect, it } from 'vitest'

import { CRASH_FLOOR_BYTES, WAIT_WARN_SECONDS } from '../../core/limits'
import { affinityBytes, affinitySeconds, checkAffinitySize } from './checkAffinitySize'

const warner = () => {
  const warnings: string[] = []
  return { warnings, warn: (message: string) => warnings.push(message) }
}

describe('checkAffinitySize', () => {
  /**
   * `MESH_WARN_SECONDS`' recorded lesson. One neuron at the default is about twelve seconds and
   * unremarkable; forty of them is past five minutes and the warning has to fire on the set.
   */
  it('warns about a set whose total wait is long, not about one neuron', () => {
    expect(affinitySeconds(1024, 1)).toBeLessThan(WAIT_WARN_SECONDS)
    const one = warner()
    checkAffinitySize(one, 1024, 1)
    expect(one.warnings).toEqual([])

    const many = warner()
    checkAffinitySize(many, 1024, 40)
    expect(many.warnings).toHaveLength(1)
    expect(many.warnings[0]).toContain('40 neurons')
    expect(many.warnings[0]).toContain('`Points`')
  })

  /** Quadratic in the points, which is the fact the lever's sentence rests on. */
  it('prices the decode as the square of the point count', () => {
    const one = affinitySeconds(1024, 1)
    const two = affinitySeconds(2048, 1)
    expect(two).toBeGreaterThan(3.5 * one)
  })

  /**
   * Two n² Float32Arrays, the matrix and the clustering's working copy. Counting one would put
   * the refusal at twice the point count it belongs at.
   */
  it('counts both matrices against the crash floor', () => {
    expect(affinityBytes(1000)).toBe(8_000_000)
    const fits = Math.floor(Math.sqrt(CRASH_FLOOR_BYTES / 8))
    expect(() => checkAffinitySize(warner(), fits, 1)).not.toThrow()
    expect(() => checkAffinitySize(warner(), fits * 2, 1)).toThrow(/Refused/)
  })

  /** Per neuron, because the matrices are built and dropped one neuron at a time. */
  it('does not multiply the allocation by the neurons', () => {
    expect(() => checkAffinitySize(warner(), 1024, 10_000)).not.toThrow()
  })
})
