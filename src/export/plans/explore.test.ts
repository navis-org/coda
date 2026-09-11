/**
 * The Explore export's decisions about Hits and Selected, asked of the plan directly.
 *
 * The fixture's Explore node searches with a limit and ticks nothing, so the goldens hold one
 * combination of three: an empty box, a search with no cap and a ticked selection are pinned here.
 */

import { describe, expect, it } from 'vitest'

import type { ParamValues } from '../../core/node'
import { explorePlan } from './explore'
import { fakeNeutralContext } from './testContext'

const explore = (params: ParamValues) =>
  explorePlan(fakeNeutralContext({ type: 'neuron.explore', params }))

describe('explorePlan', () => {
  it('keeps every row in Hits when the box is empty', () => {
    expect(explore({ query: '   ', limit: 50 }).hits).toEqual({
      note: 'The search box is empty, so Hits is the whole table.',
    })
  })

  it('caps a search only at a positive limit', () => {
    expect(explore({ query: ' LC4 ', limit: 50 }).hits).toEqual({ query: 'LC4', cap: 50 })
    expect(explore({ query: 'LC4', limit: 0 }).hits).toEqual({ query: 'LC4' })
  })

  it('fills Selected from the ticked ids, and says so when nothing is ticked', () => {
    expect(explore({ selection: ['101', ''] }).selected).toEqual({ ids: ['101'] })
    expect(explore({}).selected).toEqual({
      note: 'Nothing is ticked on the canvas, so Selected is empty.',
    })
  })
})
