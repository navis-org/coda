/**
 * The pieces a neuron is extended with: which, in what order, joined where.
 *
 * Everything here feeds tables a reader reviews merges from, and every way of getting it wrong
 * produces a full, believable table: pieces in another order after a reload, a junction end
 * searched as though it were open, a piece's size left out of the neuron's.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import type { ExtendPair, Piece } from './pieces'
import {
  aliasOf,
  pieceContacts,
  extendPairs,
  extendedSchema,
  extendedTable,
  junctionOf,
  pieceLineage,
  piecesOf,
} from './pieces'
import { rootsOf } from './rootedBox'
import type { PublishedEnd, TipRow } from './searchTips'
import { searchOnly } from './searchTips'

const pair = (parent: string, piece: string): ExtendPair => ({ parent, piece })

const summary = (pieces: readonly Piece[]) =>
  pieces.map((piece) => `${piece.id}<${piece.parent} d${piece.depth} in ${piece.seed}`)

describe('the pairs on the wire', () => {
  it('round-trips through the table Review publishes', () => {
    const pairs = [pair('720', '801'), pair('801', '802')]
    const table = extendedTable(pairs)
    expect(table.schema).toEqual(extendedSchema())
    expect(extendPairs(table)).toEqual(pairs)
  })

  it('reads nothing from anything that is not such a table', () => {
    expect(extendPairs(undefined)).toEqual([])
    expect(extendPairs({ kind: 'dataset', sourceId: 'x', datasetId: 'y', label: 'z' })).toEqual(
      [],
    )
    expect(
      extendPairs(makeTable(tableSchema(column('other', 'str')), { other: ['1'] })),
    ).toEqual([])
  })

  it('leaves out a row that is not two chunkedgraph ids, a piece on itself, and a repeat', () => {
    // Each id is about to be a root asked of a chunkedgraph, so a name or a float is not let by.
    const table = makeTable(extendedSchema(), {
      parent: ['720', 'LC4', '720', '720', '7.2e+17', '720'],
      piece: ['801', '802', '720', '801', '803', null],
    })
    expect(extendPairs(table)).toEqual([pair('720', '801')])
  })

  it('never takes 0 for a piece or for what it was accepted on', () => {
    // 0 is "no object": the root of every supervoxel the chunkedgraph does not list. Read as a
    // piece it would have all of those written as the neuron's, in every box of its tree.
    const table = makeTable(extendedSchema(), { parent: ['720', '0'], piece: ['0', '801'] })
    expect(extendPairs(table)).toEqual([])
  })
})

describe('the tree', () => {
  it('follows the pairs out from a seed, breadth first', () => {
    const pieces = piecesOf(
      [pair('801', '803'), pair('720', '802'), pair('720', '801'), pair('803', '804')],
      ['720'],
    )
    expect(summary(pieces)).toEqual([
      '801<720 d1 in 720',
      '802<720 d1 in 720',
      '803<801 d2 in 720',
      '804<803 d3 in 720',
    ])
    expect(pieces[3]!.path).toEqual(['720', '801', '803', '804'])
  })

  it('orders a level by its parents first, then by id', () => {
    // 900 is on 801 and 850 on 802: the parents' order decides, though 850 is the lower id. So a
    // piece's own continuations stay together, in the order the pieces before them were listed.
    const pieces = piecesOf(
      [
        pair('720', '801'),
        pair('720', '802'),
        pair('802', '850'),
        pair('801', '900'),
        pair('801', '870'),
      ],
      ['720'],
    )
    expect(pieces.map((piece) => piece.id)).toEqual(['801', '802', '870', '900', '850'])
  })

  it('does not depend on the order the pairs were written in', () => {
    // The order of clicks. A reload followed by Run has to build the tables the session did.
    const pairs = [
      pair('720', '802'),
      pair('801', '803'),
      pair('720', '801'),
      pair('802', '803'),
      pair('803', '804'),
    ]
    const forwards = summary(piecesOf(pairs, ['720']))
    const backwards = summary(piecesOf([...pairs].reverse(), ['720']))
    expect(backwards).toEqual(forwards)
  })

  it('takes the shorter route to a piece, and at a tie the parent with the lower id', () => {
    // 803 is one step from the seed and also two steps, by way of 801: one step wins.
    const short = piecesOf(
      [pair('720', '801'), pair('801', '803'), pair('720', '803')],
      ['720'],
    )
    expect(short.find((piece) => piece.id === '803')).toMatchObject({ parent: '720', depth: 1 })
    // 805 is two steps by either 801 or 802: the lower id.
    const tie = piecesOf(
      [pair('720', '802'), pair('720', '801'), pair('802', '805'), pair('801', '805')],
      ['720'],
    )
    expect(tie.find((piece) => piece.id === '805')).toMatchObject({ parent: '801', depth: 2 })
  })

  it('compares ids as ids, not as text', () => {
    // '99' is the lower id and the later string.
    const tie = piecesOf(
      [pair('720', '99'), pair('720', '100'), pair('100', '805'), pair('99', '805')],
      ['720'],
    )
    expect(tie.find((piece) => piece.id === '805')!.parent).toBe('99')
    expect(tie.slice(0, 2).map((piece) => piece.id)).toEqual(['99', '100'])
  })

  it('says nothing for a pair no seed reaches', () => {
    // Its parent was un-accepted, or it belongs to another run: kept by Review, dormant here.
    expect(piecesOf([pair('801', '803')], ['720'])).toEqual([])
  })

  it('puts a piece in one tree, the one that reaches it in fewer steps', () => {
    const pieces = piecesOf(
      [pair('720', '801'), pair('801', '900'), pair('730', '900')],
      ['720', '730'],
    )
    expect(pieces.filter((piece) => piece.id === '900')).toHaveLength(1)
    expect(pieces.find((piece) => piece.id === '900')).toMatchObject({ seed: '730', depth: 1 })
  })

  it('takes the pieces a neuron at a time, though it places them level by level', () => {
    // One neuron's pieces overlap each other in the volume and two neurons' do not: taken level
    // by level across both, the search would drop and ask again for the same roots each turn.
    const pieces = piecesOf(
      [pair('720', '801'), pair('801', '803'), pair('730', '901'), pair('901', '903')],
      ['720', '730'],
    )
    expect(pieces.map((piece) => piece.id)).toEqual(['801', '803', '901', '903'])
    // Which tree a shared piece joins is still decided by the fewest steps, not by which neuron
    // is listed first: 950 is two steps from 720 and one from 730.
    const shared = piecesOf(
      [pair('720', '801'), pair('801', '950'), pair('730', '950')],
      ['720', '730'],
    )
    expect(shared.map((piece) => `${piece.id} in ${piece.seed}`)).toEqual([
      '801 in 720',
      '950 in 730',
    ])
  })

  it('never extends a seed as a piece of another, nor loops', () => {
    const pieces = piecesOf(
      [pair('720', '730'), pair('720', '801'), pair('801', '720'), pair('801', '801')],
      ['720', '730'],
    )
    expect(summary(pieces)).toEqual(['801<720 d1 in 720'])
  })
})

/** A finished end listing these candidates, each with a gap and a contact. */
function endWith(
  candidates: ReadonlyArray<{
    root: string
    gap: number
    at: readonly [number, number, number]
  }>,
): PublishedEnd {
  return searchOnly({
    tip: 0,
    rows: candidates.length,
    candRoot: BigUint64Array.from(candidates, (one) => BigInt(one.root)),
    columns: {
      min_dist_um: Float64Array.from(candidates, (one) => one.gap),
      contact_x_nm: Float64Array.from(candidates, (one) => one.at[0]),
      contact_y_nm: Float64Array.from(candidates, (one) => one.at[1]),
      contact_z_nm: Float64Array.from(candidates, (one) => one.at[2]),
    },
    missingQuery: false,
    pooled: candidates.length,
    tooFar: 0,
    anothersTip: 0,
  })
}

const tipAt = (x: number, y = 0, z = 0, row = 0): TipRow => ({
  neuronId: '801',
  endUid: row,
  nm: [x, y, z],
  eTip: undefined,
  row,
})

/** One piece's contact, through the walk the node takes for all of a parent's pieces. */
const contactOf = (ends: Parameters<typeof pieceContacts>[0], id: string) =>
  pieceContacts(ends, [id]).get(id)

describe('where a piece joins', () => {
  it('reads the contact off the parent’s ends, at the smallest gap', () => {
    // Listed at two of the parent's tips. The nearer is where Submit will make the merge.
    const ends = [
      endWith([
        { root: '900', gap: 0.01, at: [1, 1, 1] },
        { root: '801', gap: 0.3, at: [10, 20, 30] },
      ]),
      endWith([{ root: '801', gap: 0.05, at: [40, 50, 60] }]),
    ]
    expect(contactOf(ends, '801')).toEqual([40, 50, 60])
    // Several pieces of one parent in the one walk, each at its own smallest gap.
    expect([...pieceContacts(ends, ['801', '900', '777'])]).toEqual([
      ['900', [1, 1, 1]],
      ['801', [40, 50, 60]],
    ])
  })

  it('has no contact for a piece the parent’s ends do not list, or list without a place', () => {
    expect(
      contactOf([endWith([{ root: '900', gap: 0.1, at: [1, 1, 1] }])], '801'),
    ).toBeUndefined()
    expect(
      contactOf([endWith([{ root: '801', gap: 0.1, at: [Number.NaN, 1, 1] }])], '801'),
    ).toBeUndefined()
    expect(contactOf([], '801')).toBeUndefined()
  })

  it('names the one tip nearest the contact — not every tip within the radius', () => {
    // A piece of one level-2 chunk is shorter than the own-tip radius: both its ends are within
    // 2 µm of where it joins. Dropping both left nothing to search (phase 0, 6 of 26 pieces).
    const tips = [tipAt(1500), tipAt(200), tipAt(900)]
    expect(junctionOf(tips, [0, 0, 0], 2)).toBe(1)
  })

  it('names none where no tip is within the radius, or there is no contact', () => {
    // A piece joined by its side, or a joining end the sample above did not keep.
    expect(junctionOf([tipAt(2500), tipAt(9000)], [0, 0, 0], 2)).toBeUndefined()
    expect(junctionOf([tipAt(10)], undefined, 2)).toBeUndefined()
    expect(junctionOf([], [0, 0, 0], 2)).toBeUndefined()
  })

  it('measures the distance in all three axes', () => {
    expect(junctionOf([tipAt(1500, 1500, 1500)], [0, 0, 0], 2)).toBeUndefined()
    expect(junctionOf([tipAt(1000, 1000, 1000)], [0, 0, 0], 2)).toBe(0)
  })
})

describe('one neuron, not two objects that touch', () => {
  const piece: Pick<Piece, 'seed' | 'path'> = { seed: '720', path: ['720', '801', '803'] }

  it('reads the path’s roots as the seed’s, and leaves the seed’s and every other alone', () => {
    const alias = aliasOf(piece)
    expect([...alias]).toEqual([
      [801n, 720n],
      [803n, 720n],
    ])
    const known = new Map([
      [1n, 720n],
      [2n, 801n],
      [3n, 803n],
      [4n, 900n],
      [5n, 0n],
    ])
    const labels = BigUint64Array.from([1n, 2n, 3n, 4n, 5n])
    expect([...rootsOf(labels, known, alias)]).toEqual([720n, 720n, 720n, 900n, 0n])
    // Without one, and with an empty one, the box is what the chunkedgraph said.
    expect([...rootsOf(labels, known, undefined)]).toEqual([720n, 801n, 803n, 900n, 0n])
    expect([...rootsOf(labels, known, new Map())]).toEqual([720n, 801n, 803n, 900n, 0n])
  })
})

describe('what the run says of a piece', () => {
  const piece: Piece = { id: '801', seed: '720', parent: '720', depth: 1, path: ['720', '801'] }

  it('gives every row of the piece its lineage, and marks the end it joins by', () => {
    expect(pieceLineage(piece, 3, 1)).toEqual([
      { seed: '720', parent: '720', depth: 1, junction: false },
      { seed: '720', parent: '720', depth: 1, junction: true },
      { seed: '720', parent: '720', depth: 1, junction: false },
    ])
    // No joining end found: none is marked, rather than the first.
    expect(pieceLineage(piece, 2, undefined).map((one) => one.junction)).toEqual([false, false])
    expect(pieceLineage(piece, 0, undefined)).toEqual([])
  })
})
