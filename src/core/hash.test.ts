/**
 * Hashing for cache keys: a typed array is digested over its bytes, so a held current of 100,000
 * steps per sweep — which Simulate Model's movie basis hashes on the page — costs a pass over its
 * bytes rather than a sorted key per element.
 */

import { describe, expect, it } from 'vitest'

import { hashValue, stableStringify } from './hash'

describe('stableStringify', () => {
  it('digests a typed array by its bytes, its type part of what is hashed', () => {
    const a = Float64Array.of(1, 2, 3)
    expect(stableStringify(a)).toMatch(/^\[@Float64Array:24:/)
    expect(hashValue({ v: a })).toBe(hashValue({ v: Float64Array.of(1, 2, 3) }))
    expect(hashValue({ v: a })).not.toBe(hashValue({ v: Float64Array.of(1, 2, 4) }))
    // The same numbers at another width are other content.
    expect(hashValue(Float32Array.of(1, 2, 3))).not.toBe(hashValue(a))
    // A large one is no longer one sorted key per element.
    expect(stableStringify(new Float64Array(200_000)).length).toBeLessThan(80)
  })
})
