/**
 * Hand picks (`handPicks.ts`): where a pick is listed, how its row reads, and how it is stored.
 *
 * Placed from the tips each time the queue is built, never by a stored tip number, so a re-run
 * that renumbers the tips cannot move a pick onto another tip.
 */

import { describe, expect, it } from 'vitest'

import type { Triple } from '../../data/precomputed/volume'
import type { HandPick } from './handPicks'
import { PICK_TIP_UM, decodePicks, encodePicks, listedAt, withPicks } from './handPicks'
import type { Candidate, QueueTip } from './reviewQueue'
import { DEFAULT_FILTERS, arrangeRows, currentOfQueue, tipKey } from './reviewQueue'

const NEURON = '720575940621522189'
const PIECE = '720575940630442210'

const candidate = (id: string, rank: number, extra: Partial<Candidate> = {}): Candidate => ({
  candidateId: id,
  rank,
  geoRank: undefined,
  volumeUm3: undefined,
  l2Chunks: undefined,
  minDistUm: undefined,
  contactNm: [0, 0, 0],
  pCand: undefined,
  conf: 0.5,
  shown: rank === 1,
  ...extra,
})

const tip = (endUid: number, at: Triple, extra: Partial<QueueTip> = {}): QueueTip => ({
  endUid,
  neuronId: NEURON,
  seed: NEURON,
  junction: false,
  search: 'done',
  kind: 'tip',
  tipNm: at,
  r: 0.5,
  q: 0.4,
  pTip: undefined,
  shown: true,
  cleared: true,
  source: undefined,
  candidates: [candidate(`9${endUid}1`, 1), candidate(`9${endUid}2`, 2)],
  ...extra,
})

const pick = (extra: Partial<HandPick> = {}): HandPick => ({
  n: 1,
  seed: NEURON,
  root: NEURON,
  candidateId: '777',
  contactNm: [0, 0, 0],
  gapUm: 0.2,
  l2Chunks: 12,
  ...extra,
})

/** A micrometre along x, in nm. */
const um = (x: number): Triple => [x * 1000, 0, 0]

describe('where a hand pick is listed', () => {
  it(`joins its root's nearest tip within ${PICK_TIP_UM} µm, after that tip's own candidates`, () => {
    const queue = [tip(1, um(0)), tip(2, um(1.5)), tip(3, um(1.8), { neuronId: PIECE })]
    const out = withPicks(queue, [pick({ contactNm: um(1.2) })])
    expect(out).toHaveLength(3)
    expect(out[1]!.candidates.map((one) => one.candidateId)).toEqual(['921', '922', '777'])
    const added = out[1]!.candidates[2]!
    expect(added).toMatchObject({ rank: 3, hand: true, minDistUm: 0.2, l2Chunks: 12 })
    // The tips it did not join are the same objects.
    expect(out[0]).toBe(queue[0])
  })

  it(`is a tip of its own, numbered -n, past ${PICK_TIP_UM} µm or on a junction`, () => {
    const queue = [tip(1, um(0)), tip(2, um(5.1)), tip(3, um(3), { junction: true })]
    const out = withPicks(queue, [pick({ n: 4, contactNm: um(2.5) })])
    const own = out[3]!
    expect(own).toMatchObject({ endUid: -4, neuronId: NEURON, seed: NEURON, tipNm: um(2.5) })
    expect(own.candidates).toHaveLength(1)
    expect(own.q).toBeUndefined()
    // A second pick near the first joins the first's own tip.
    const both = withPicks(queue, [
      pick({ n: 4, contactNm: um(2.5) }),
      pick({ n: 5, candidateId: '778', contactNm: um(2.9) }),
    ])
    expect(both).toHaveLength(4)
    expect(both[3]!.candidates.map((one) => one.candidateId)).toEqual(['777', '778'])
  })

  it("is listed on a piece's tip by the root it touches, on its own neuron's", () => {
    const OTHER = '720575940600000003'
    const queue = [
      tip(1, um(0)),
      // The same piece, in another neuron's tree, listed first.
      tip(1, um(0), { neuronId: PIECE, seed: OTHER }),
      tip(1, um(0), { neuronId: PIECE }),
    ]
    const out = withPicks(queue, [pick({ root: PIECE })])
    expect(out[0]!.candidates).toHaveLength(2)
    expect(out[1]!.candidates).toHaveLength(2)
    expect(out[2]!.candidates.at(-1)?.candidateId).toBe('777')
  })

  it('is left out where the queue does not hold its neuron, or its tip lists it already', () => {
    const queue = [tip(1, um(0))]
    expect(withPicks(queue, [pick({ seed: '1', root: '1' })])).toEqual(queue)
    expect(withPicks(queue, [pick({ candidateId: '912' })])[0]!.candidates).toHaveLength(2)
    expect(withPicks(queue, [])).toBe(queue)
  })

  it('finds a piece already listed where it is nearest the neuron', () => {
    const queue = [
      tip(1, um(0), { candidates: [candidate('5', 1, { minDistUm: 0.9 })] }),
      tip(2, um(9), { candidates: [candidate('4', 1), candidate('5', 2, { minDistUm: 0.3 })] }),
    ]
    expect(listedAt(queue, '5')).toMatchObject({ tip: { endUid: 2 }, candidate: { rank: 2 } })
    expect(listedAt(queue, '6')).toBeUndefined()
  })
})

describe('a hand pick in the list', () => {
  const queue = withPicks(
    [tip(1, um(0), { q: 0.9 }), tip(2, um(9), { q: 0.1 }), tip(3, um(20), { q: 0.05 })],
    [pick({ contactNm: um(9.5) }), pick({ n: 2, candidateId: '778', contactNm: um(50) })],
  )

  it('leads its tip’s row, with no number of SEAM’s, first, whatever the filters', () => {
    const rows = arrangeRows(queue, { ...DEFAULT_FILTERS, minConfidence: 0.5 })
    expect(rows.map((row) => row.tip.endUid)).toEqual([-2, 2, 1])
    expect(rows[1]).toMatchObject({ score: undefined, shown: false })
    expect(rows[1]!.candidate?.candidateId).toBe('777')
  })

  it('is a row of its own per candidate, first, whatever the filters', () => {
    const rows = arrangeRows(queue, {
      ...DEFAULT_FILTERS,
      mode: 'candidate',
      minConfidence: 0.9,
    })
    expect(rows.map((row) => row.candidate?.candidateId)).toEqual(['778', '777'])
  })

  it('is where the cursor can stand, on its own tip too', () => {
    expect(currentOfQueue(queue, tipKey(NEURON, -2), 1)?.candidate.candidateId).toBe('778')
    expect(currentOfQueue(queue, tipKey(NEURON, 2), 3)?.candidate.candidateId).toBe('777')
  })
})

describe('the stored picks', () => {
  it('read back as written, and skip what is not a pick', () => {
    const read = [pick(), pick({ n: 2, candidateId: '778', l2Chunks: undefined })]
    expect(decodePicks(encodePicks(read))).toEqual(read)
    expect(encodePicks([])).toBe('')
    expect(decodePicks('not json')).toEqual([])
    expect(
      decodePicks(JSON.stringify([[1, 'a'], 'x', [2, 'a', 'b', 'c', 1, 2, 3, 0.1, null]])),
    ).toHaveLength(1)
  })
})
