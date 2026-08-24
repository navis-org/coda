/**
 * The camera that outlives its component.
 *
 * Small enough to look self-evident, and it is the load-bearing half of "the view stops
 * resetting under you": the card and the overlay are two instances of one node, so a camera
 * kept in a ref is a camera thrown away every time somebody expands a card. What the map has
 * to get right is that a *stored* camera exists — because its presence is also what tells the
 * rig that this scene has already been framed once and must not be framed again.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { forgetCamera, recallCamera, rememberCamera, resetCameraMemos } from './cameraMemo'

const camera = (x: number) => ({
  position: [x, 0, 0] as [number, number, number],
  up: [0, -1, 0] as [number, number, number],
  quaternion: [0, 0, 0, 1] as [number, number, number, number],
})

beforeEach(resetCameraMemos)

describe('cameraMemo', () => {
  it('hands a camera from one mount of a viewer to the next', () => {
    rememberCamera('v', camera(7))
    expect(recallCamera('v')?.position).toEqual([7, 0, 0])
  })

  it('keeps viewers apart, since two 3D cards are two scenes', () => {
    rememberCamera('a', camera(1))
    rememberCamera('b', camera(2))
    expect(recallCamera('a')?.position[0]).toBe(1)
    expect(recallCamera('b')?.position[0]).toBe(2)
  })

  it('has nothing to say about a viewer that has never been framed', () => {
    // The absence is the signal, not an error: it is what makes the rig frame the scene the
    // first time it has an extent, and only then.
    expect(recallCamera('never')).toBeUndefined()
  })

  it('forgets on request, which is what Reset view does before re-framing', () => {
    rememberCamera('v', camera(7))
    forgetCamera('v')
    expect(recallCamera('v')).toBeUndefined()
  })

  it('evicts the least recently *written*, not the oldest created', () => {
    // Re-inserting moves an entry to the end, so the scene somebody keeps coming back to is
    // the one that survives — the same rule `layoutMemo` follows.
    for (let i = 0; i < 8; i++) rememberCamera(`v${i}`, camera(i))
    rememberCamera('v0', camera(99))
    rememberCamera('extra', camera(1))

    expect(recallCamera('v0')?.position[0]).toBe(99)
    expect(recallCamera('v1')).toBeUndefined()
    expect(recallCamera('extra')).toBeDefined()
  })
})
