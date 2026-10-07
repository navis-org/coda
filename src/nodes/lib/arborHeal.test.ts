import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { EMPTY_BOUNDS, makeTable } from '../../core/values'
import { ySkeleton } from './__fixtures__/ySkeleton'
import { healSkeleton, healedNow } from './arborHeal'

describe('healSkeleton', () => {
  it('answers a whole skeleton as it is, without the Python runtime', async () => {
    const skeleton = ySkeleton()
    const value = {
      kind: 'skeletons' as const,
      items: [skeleton],
      attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['1'] }),
      bounds: EMPTY_BOUNDS,
    }
    const healed = await healSkeleton(value, skeleton)
    expect(healed.skeleton).toBe(skeleton)
    expect(healed.pieces).toBe(1)
    expect(healed.bridges).toBeUndefined()
    // The same answer, by identity, for the card asking during render.
    expect(healedNow(skeleton)).toBe(healed)
  })

  it('says how many pieces a forest is in, without healing it', () => {
    const skeleton = { ...ySkeleton(), parents: Int32Array.from([-1, 0, 1, -1, 2, 4]) }
    expect(healedNow(skeleton)).toEqual({ pieces: 2 })
  })
})
