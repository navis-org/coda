import { describe, expect, it } from 'vitest'

import { quantileSorted } from './stats'

/*
 * Moved here with the function. It served `boxStats` first, which is why the tests lived
 * there; it now has three callers across two layers and `src/core` is the one both can see.
 */
describe('quantileSorted', () => {
  it('is the type-7 definition numpy and R default to', () => {
    // np.percentile([1,2,3,4], 25) is 1.75, not 2 — the difference matters at the small group
    // sizes a per-cell-type box plot is made of.
    expect(quantileSorted([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75)
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5)
    expect(quantileSorted([1, 2, 3, 4], 0.75)).toBeCloseTo(3.25)
  })

  it('answers the single value for a group of one', () => {
    expect(quantileSorted([9], 0.25)).toBe(9)
  })
})
