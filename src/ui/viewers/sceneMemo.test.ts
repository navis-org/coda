/**
 * The neuroglancer state that outlives its iframe.
 *
 * `cameraMemo`'s test one seam further out, and the same load-bearing point: the card and the
 * overlay are two instances of one node, so a state kept in a ref is a state thrown away every
 * time somebody expands a card. What the map has to get right beyond storing is the *gate* —
 * a stored state is only safe to restore into a scene describing the same place through the
 * same deployment, and the caller is the one that has to be able to ask.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { forgetScene, recallScene, rememberScene, resetSceneMemos } from './sceneMemo'

const memo = (position: number) => ({
  base: 'https://neuroglancer-demo.appspot.com',
  identity: '{"layout":"3d"}',
  scene: { position: [position, 0, 0], layers: [] },
})

beforeEach(resetSceneMemos)

describe('sceneMemo', () => {
  it('hands a state from one mount of an embed to the next', () => {
    rememberScene('v', memo(7))
    expect(recallScene('v')?.scene).toEqual({ position: [7, 0, 0], layers: [] })
  })

  it('keeps one per viewer', () => {
    rememberScene('a', memo(1))
    rememberScene('b', memo(2))
    expect((recallScene('a')?.scene as { position: number[] }).position[0]).toBe(1)
    expect((recallScene('b')?.scene as { position: number[] }).position[0]).toBe(2)
  })

  it('has nothing for a viewer that has never been read', () => {
    expect(recallScene('never')).toBeUndefined()
  })

  it('keeps the base and the identity the state was read under', () => {
    // The whole of what makes a restore safe. Without them a state would be replayed into
    // whatever scene the node happens to be emitting now — another dataset, another viewer.
    rememberScene('v', memo(7))
    expect(recallScene('v')?.base).toBe('https://neuroglancer-demo.appspot.com')
    expect(recallScene('v')?.identity).toBe('{"layout":"3d"}')
  })

  it('forgets on request, so the next mount opens the published scene', () => {
    rememberScene('v', memo(7))
    forgetScene('v')
    expect(recallScene('v')).toBeUndefined()
  })

  it('drops the oldest rather than growing without bound', () => {
    // A leak guard: an entry is a whole scene, tens of kB for the larger published states.
    for (let i = 0; i < 4; i++) rememberScene(`v${i}`, memo(i))
    rememberScene('v0', memo(99))
    rememberScene('extra', memo(1))

    // `v0` was rewritten, so it is no longer the oldest — `v1` is.
    expect((recallScene('v0')?.scene as { position: number[] }).position[0]).toBe(99)
    expect(recallScene('v1')).toBeUndefined()
    expect(recallScene('extra')).toBeDefined()
  })
})
