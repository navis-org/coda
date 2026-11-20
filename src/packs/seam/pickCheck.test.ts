/**
 * The check a hand pick passes (`pickCheck.ts`), against stand-in services: nothing here reaches
 * a server. What it decides — which root the pick is on, its contact and gap, and the sentence
 * for a pick Submit could not anchor — is all in the answer.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Triple } from '../../data/precomputed/volume'
import type { AnchorPair, AnchorVolume, Anchors } from './mergeAnchors'
import { UNKNOWN_GAP_REACH_NM, anchorReachNm } from './mergeAnchors'
import type { PickRequest, PickServices } from './pickCheck'
import { checkPick } from './pickCheck'

const SEED = '720575940621522189'
const NOW = '720575940699999999'
const PIECE = '720575940630442210'
const PICKED = '720575940640000001'

const request = (extra: Partial<PickRequest> = {}): PickRequest => ({
  datastack: 'fanc_sandbox',
  segment: PICKED,
  positionNm: [1000, 2000, 3000],
  seed: SEED,
  neuronRoot: NOW,
  pieces: [PIECE],
  ...extra,
})

const end = (at: Triple) => ({ supervoxel: '1', positionNm: at })

function services(anchors: Anchors, l2?: () => Promise<Map<string, number>>) {
  const asked: AnchorPair[] = []
  const live: PickServices = {
    openVolume: async () => ({ graphene: { server: 's', table: 't' } }) as AnchorVolume,
    anchor: async (_volume, pair) => {
      asked.push(pair)
      return anchors
    },
    l2: l2 ?? (async () => new Map([[PICKED, 17]])),
  }
  return { live, asked }
}

const OPTIONS = { deployment: 'https://cave.example' }

describe('checking a hand pick', () => {
  it('finds the contact between the two nearest voxels, and the root it touches now', async () => {
    const { live, asked } = services({
      ok: true,
      neuron: end([1000, 2000, 2700]),
      candidate: end([1000, 2400, 3000]),
      chunks: 0,
      onRoot: NOW,
    })
    const checked = await checkPick(request(), OPTIONS, live)
    expect(checked).toEqual({
      ok: true,
      root: SEED,
      contactNm: [1000, 2200, 2850],
      gapUm: 0.5,
      l2Chunks: 17,
    })
    // Looked for on the neuron and its unmerged pieces alike, at the place pointed to.
    expect(asked[0]).toMatchObject({
      neuronRoot: NOW,
      alsoNeuron: [PIECE],
      candidateRoot: PICKED,
      contactNm: [1000, 2000, 3000],
    })
  })

  it('is on the piece it touches, where that is a piece of the neuron', async () => {
    const { live } = services({
      ok: true,
      neuron: end([0, 0, 0]),
      candidate: end([0, 0, 100]),
      chunks: 0,
      onRoot: PIECE,
    })
    expect(await checkPick(request(), OPTIONS, live)).toMatchObject({ ok: true, root: PIECE })
  })

  it("leaves Submit's own reach around the contact room for both pieces", () => {
    // Each piece within the reach of the place pointed to: at most twice it apart.
    const widest = (2 * UNKNOWN_GAP_REACH_NM) / 1000
    const reach = anchorReachNm(widest)
    expect(reach).toBeDefined()
    expect(reach!).toBeGreaterThanOrEqual(UNKNOWN_GAP_REACH_NM)
  })

  it('refuses the neuron itself, and a piece already extended on it, before reading', async () => {
    const { live, asked } = services({ ok: false, reason: 'neuron-absent', message: '' })
    for (const segment of [SEED, NOW]) {
      expect(await checkPick(request({ segment }), OPTIONS, live)).toEqual({
        ok: false,
        message: 'That is the neuron itself.',
      })
    }
    expect(await checkPick(request({ segment: PIECE }), OPTIONS, live)).toMatchObject({
      ok: false,
    })
    expect(asked).toHaveLength(0)
  })

  it('says where to point when the neuron is not near the place', async () => {
    const { live } = services({ ok: false, reason: 'neuron-absent', message: 'raw' })
    const checked = await checkPick(request(), OPTIONS, live)
    expect(checked.ok).toBe(false)
    expect(!checked.ok && checked.message).toMatch(
      /No part of the neuron, or of a piece accepted on it, lies within 1\.5 µm .*close to where it meets/,
    )
  })

  it('refuses an end on a root that is neither the neuron nor its piece', async () => {
    const { live } = services({
      ok: true,
      neuron: end([0, 0, 0]),
      candidate: end([0, 0, 0]),
      chunks: 0,
      onRoot: '720575940611111111',
    })
    expect((await checkPick(request(), OPTIONS, live)).ok).toBe(false)
  })

  /** Pieces a stopped Submit joined short of the neuron are one segment: which to continue? */
  it('reads joined pieces at their root, and refuses a pick on them until they are submitted', async () => {
    const GROUP = '720575940650000001'
    const joined = new Map([[PIECE, GROUP]])
    const { live, asked } = services({
      ok: true,
      neuron: end([0, 0, 0]),
      candidate: end([0, 0, 100]),
      chunks: 0,
      onRoot: GROUP,
    })
    const checked = await checkPick(request({ joined }), OPTIONS, live)
    expect(asked[0]!.alsoNeuron).toEqual([GROUP])
    expect(!checked.ok && checked.message).toMatch(/joined short of the neuron\. Submit them/)
    // Pointing at the group itself is pointing at an accepted piece.
    const itself = await checkPick(request({ joined, segment: GROUP }), OPTIONS, live)
    expect(!itself.ok && itself.message).toBe('That piece is already accepted on this neuron.')
  })

  it('is not refused for want of a size', async () => {
    const { live } = services(
      { ok: true, neuron: end([0, 0, 0]), candidate: end([0, 0, 0]), chunks: 0, onRoot: NOW },
      () => Promise.reject(new Error('leaves_many is down')),
    )
    expect(await checkPick(request(), OPTIONS, live)).toMatchObject({
      ok: true,
      l2Chunks: undefined,
    })
  })

  it('says a failed read in a sentence, and lets a cancel through', async () => {
    const { live } = services({ ok: false, reason: 'neuron-absent', message: '' })
    const failing = { ...live, openVolume: vi.fn(() => Promise.reject(new Error('503'))) }
    expect(await checkPick(request(), OPTIONS, failing)).toEqual({
      ok: false,
      message: 'The pick could not be checked: 503',
    })
    const cancelled = {
      ...live,
      openVolume: () => Promise.reject(new DOMException('stop', 'AbortError')),
    }
    await expect(checkPick(request(), OPTIONS, cancelled)).rejects.toThrow('stop')
  })
})
