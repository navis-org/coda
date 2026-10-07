/**
 * The neuroglancer segment hash.
 *
 * The value of this encoding is entirely in it being *the same* hash neuroglancer uses — a
 * colour scheme that merely looks like it would be worth nothing, because the whole point is
 * that a neuron keeps the colour it already has in whatever viewer somebody came from. So the
 * tests are unusually literal: the fixed colours below are the pins that catch a "harmless"
 * refactor of the bit twiddling, which is the failure mode this file actually has. Nothing
 * here would throw; it would quietly produce different, perfectly plausible colours.
 *
 * The pinned values were cross-checked against an independent transcription of
 * `segment_color.ts` + `gpu_hash/hash_function.ts` written in Python from the same sources,
 * which agrees on every one of them. That establishes the arithmetic is not a typo. It does
 * not, and cannot from here, establish that neuroglancer's *current* implementation still
 * matches — if these ever disagree with a live viewer, the sources are the thing to re-read.
 */

import { describe, expect, it } from 'vitest'

import { hashCombine, segmentColor } from './segmentColor'

describe('hashCombine', () => {
  it('is the Murmur round, including the trailing constant', () => {
    // Hand-computable: a zero value mixes to zero, so the whole round collapses to the final
    // `state * 5 + 0xe6546b64` — which makes this the one case a reader can check by eye.
    expect(hashCombine(0, 0)).toBe(0xe6546b64)
    expect(hashCombine(0, 1)).toBe(651101558)
    expect(hashCombine(1, 1)).toBe(651060598)
  })

  it('stays an unsigned 32-bit number, which every step depends on', () => {
    // A single missing `>>> 0` leaves a negative int32 that mixes differently on the next
    // round — a different colour, not an error.
    const pairs: Array<[number, number]> = [
      [0, 0xffffffff],
      [0xffffffff, 0],
      [0xdeadbeef, 0xcafebabe],
    ]
    for (const [state, value] of pairs) {
      const out = hashCombine(state, value)
      expect(Number.isInteger(out)).toBe(true)
      expect(out).toBeGreaterThanOrEqual(0)
      expect(out).toBeLessThanOrEqual(0xffffffff)
    }
  })
})

describe('segmentColor', () => {
  it('gives these ids exactly these colours', () => {
    expect(segmentColor('1')).toBe('#5e80ff')
    expect(segmentColor('2')).toBe('#ff3578')
    expect(segmentColor('3')).toBe('#9bff0c')
    expect(segmentColor('0')).toBe('#42ff46')
  })

  it('reads an 18-digit root id as an id rather than as a float', () => {
    /*
     * The invariant-8 case, in the one place it would be invisible. `Number()` on this id
     * loses the low digits, so a hash taken after it is the hash of a *neighbouring* segment —
     * and the colour that comes out is a perfectly good colour. The two ids below differ only
     * in their last digit and are indistinguishable as float64.
     */
    expect(Number('720575940621039145')).toBe(Number('720575940621039144'))
    expect(segmentColor('720575940621039145')).toBe('#ffe63b')
    expect(segmentColor('720575940621039145')).not.toBe(segmentColor('720575940621039144'))
  })

  it('handles both halves of a uint64, at the ends of the range', () => {
    expect(segmentColor('5813105172')).toBe('#626aff')
    expect(segmentColor('18446744073709551615')).toBe('#d3ff03')
  })

  it('honours a colour seed, since a neuroglancer link may carry one', () => {
    // Seed 0 is `SegmentColorHash.getDefault()`, and `toJSON` omits it — so a link with no
    // `segmentColorSeed` is a link on seed 0, which is what the default here has to be.
    expect(segmentColor('1', 1119377680)).toBe('#2659ff')
    expect(segmentColor('1', 0)).toBe(segmentColor('1'))
  })

  it('colours a name too, which neuroglancer has no answer for', () => {
    // Not a claim of agreement — there is nothing to agree with. It is what makes the mode
    // usable when somebody points it at a `type` column instead of an id one.
    expect(segmentColor('LC4')).toMatch(/^#[0-9a-f]{6}$/)
    expect(segmentColor('LC4')).not.toBe(segmentColor('LC6'))
    expect(segmentColor('LC4')).toBe(segmentColor('LC4'))
  })

  it('spreads a thousand ids over a thousand colours', () => {
    // The property the whole mode exists for: no cap, no folding, no reuse at the scale a
    // morphology scene actually reaches. The categorical palette manages nine.
    const seen = new Set<string>()
    for (let id = 1; id <= 1000; id++) seen.add(segmentColor(String(id)))
    expect(seen.size).toBe(1000)
  })

  it('is fully bright, every time, which is why the background control matters', () => {
    // Value is pinned at 1 in neuroglancer's own `compute`, so at least one channel is `ff`.
    for (const id of ['1', '17', '4242', '720575940621039145']) {
      expect(segmentColor(id), id).toMatch(/ff/)
    }
  })
})
