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
import type { ExtendPair, ExtendPlan, Piece } from './pieces'
import {
  AUTO_DEPTH,
  LARGE_PIECE_CHUNKS,
  aliasOf,
  autoTakes,
  autoTooLarge,
  extendPlanOf,
  growAuto,
  pieceContacts,
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
const extendPairs = (value: Parameters<typeof extendPlanOf>[0]) => extendPlanOf(value).pairs

/** The wire's table as it was before `mode`. */
const PAIRS_ONLY = tableSchema(column('parent', 'str'), column('piece', 'str'))

const summary = (pieces: readonly Piece[]) =>
  pieces.map((piece) => `${piece.id}<${piece.parent} d${piece.depth} in ${piece.seed}`)

describe('the pairs on the wire', () => {
  it('round-trips through the table Review publishes', () => {
    const pairs = [pair('720', '801'), pair('801', '802')]
    const table = extendedTable({ pairs, roots: new Set(), refused: new Set() })
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
    // Without `mode`, as the table was before it: every row read as `extend`.
    const table = makeTable(PAIRS_ONLY, {
      parent: ['720', 'LC4', '720', '720', '7.2e+17', '720'],
      piece: ['801', '802', '720', '801', '803', null],
    })
    expect(extendPairs(table)).toEqual([pair('720', '801')])
  })

  it('never takes 0 for a piece or for what it was accepted on', () => {
    // 0 is "no object": the root of every supervoxel the chunkedgraph does not list. Read as a
    // piece it would have all of those written as the neuron's, in every box of its tree.
    const table = makeTable(PAIRS_ONLY, { parent: ['720', '0'], piece: ['0', '801'] })
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
    repSupervoxel: new BigUint64Array(candidates.length),
    tipSupervoxel: undefined,
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

describe('the plan on the wire', () => {
  it('round-trips the pieces Auto-extend was pressed on and the pairs it must not take', () => {
    const pairs = [pair('720', '801'), pair('801', '802')]
    const table = extendedTable({
      pairs,
      roots: new Set(['802']),
      refused: new Set(['802/803']),
    })
    expect(table.data['mode']).toEqual(['extend', 'auto', 'refused'])
    const plan = extendPlanOf(table)
    expect(plan.pairs).toEqual(pairs)
    expect([...plan.roots]).toEqual(['802'])
    expect([...plan.refused]).toEqual(['802/803'])
    // A refusal is not a piece to extend.
    expect(extendPairs(table)).toEqual(pairs)
    // No floor set: SEAM's cutoff alone, on the wire as on the card.
    expect(plan.autoMinQ).toBeUndefined()
  })

  it('carries the reader’s Auto-extend floor, and reads none from a table without one', () => {
    const plan = {
      pairs: [pair('720', '801')],
      roots: new Set(['801']),
      refused: new Set<string>(),
    }
    expect(extendPlanOf(extendedTable({ ...plan, autoMinQ: 0.4 })).autoMinQ).toBe(0.4)
    const old = extendedTable(plan)
    const { auto_min_q: _floor, ...before } = old.data
    expect(extendPlanOf({ ...old, data: before }).autoMinQ).toBeUndefined()
  })
})

describe('what Auto-extend takes', () => {
  const first = { shown: true, q: 0.3, organelle: false, l2Chunks: 3, id: '801' }

  /** `Auto-extend min q` (user, 2026-11-19): a floor on `q`, over SEAM's cutoff, never under it. */
  it('takes only what clears the reader’s floor too, where one is set', () => {
    expect(autoTakes(first, 0.3)).toBe(true)
    expect(autoTakes(first, 0.31)).toBe(false)
    // No `q` to hold to a floor: not taken under one, as before without one.
    expect(autoTakes({ ...first, q: null }, 0.2)).toBe(false)
    expect(autoTakes({ ...first, q: null })).toBe(true)
    // A floor below the cutoff lowers nothing: SEAM's cutoff still decides.
    expect(autoTakes({ ...first, shown: false }, 0)).toBe(false)
  })

  it('takes a first candidate that clears SEAM’s cutoff', () => {
    expect(autoTakes(first)).toBe(true)
    // A size the table does not carry is no reason to refuse it.
    expect(autoTakes({ ...first, l2Chunks: undefined })).toBe(true)
  })

  it('takes nothing without an explicit cutoff — a run with no assessor has none', () => {
    expect(autoTakes({ ...first, shown: false })).toBe(false)
    expect(autoTakes({ ...first, shown: null })).toBe(false)
    expect(autoTakes({ ...first, shown: undefined })).toBe(false)
  })

  it('knows a first candidate turned down for its size alone', () => {
    const large = { ...first, l2Chunks: LARGE_PIECE_CHUNKS }
    expect(autoTooLarge(large)).toBe(LARGE_PIECE_CHUNKS)
    expect(autoTooLarge(first)).toBeUndefined()
    expect(autoTooLarge({ ...first, l2Chunks: undefined })).toBeUndefined()
    // Turned down for something else as well: not for its size alone.
    expect(autoTooLarge({ ...large, shown: false })).toBeUndefined()
    expect(autoTooLarge({ ...large, organelle: true })).toBeUndefined()
    expect(autoTooLarge(large, 0.5)).toBeUndefined()
  })

  it('takes no organelle, no large piece and no non-object', () => {
    expect(autoTakes({ ...first, organelle: true })).toBe(false)
    expect(autoTakes({ ...first, l2Chunks: LARGE_PIECE_CHUNKS })).toBe(false)
    expect(autoTakes({ ...first, l2Chunks: LARGE_PIECE_CHUNKS - 1 })).toBe(true)
    expect(autoTakes({ ...first, id: '0' })).toBe(false)
    expect(autoTakes({ ...first, id: 'LC4' })).toBe(false)
  })
})

describe('the tree Auto-extend grows', () => {
  const plan = (
    pairs: ExtendPair[],
    roots: string[] = [],
    refused: string[] = [],
  ): ExtendPlan => ({ pairs, roots: new Set(roots), refused: new Set(refused) })
  /** What each piece's ends offer, by piece id. */
  const offering =
    (offers: Record<string, string[]>) =>
    (piece: Piece): string[] =>
      offers[piece.id] ?? []
  /** A chain 801 → 802 → … one piece a layer, `n` long beyond 801. */
  const chain = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`${801 + i}`, [`${802 + i}`]]))

  it('grows nothing where Auto-extend was not pressed', () => {
    const grown = growAuto(plan([pair('720', '801')]), ['720'], offering(chain(3)))
    expect(summary(grown.tree)).toEqual(['801<720 d1 in 720'])
    expect(grown.searched).toEqual(grown.tree)
    expect(grown.accepted.size).toBe(0)
  })

  it('takes the first candidates of the pressed piece’s ends, and of theirs, layer by layer', () => {
    const grown = growAuto(
      plan([pair('720', '801')], ['801']),
      ['720'],
      offering({ '801': ['802', '803'], '802': ['804'] }),
    )
    expect(summary(grown.tree)).toEqual([
      '801<720 d1 in 720',
      '802<801 d2 in 720',
      '803<801 d2 in 720',
      '804<802 d3 in 720',
    ])
    // Each to the piece it was pressed on; the pressed piece is the reader's, not Auto-extend's.
    expect([...grown.accepted]).toEqual([
      ['801/802', '801'],
      ['801/803', '801'],
      ['802/804', '801'],
    ])
  })

  it(`stops ${AUTO_DEPTH} layers out, and searches nothing on the last`, () => {
    const grown = growAuto(plan([pair('720', '801')], ['801']), ['720'], offering(chain(20)))
    // The pressed piece, then ten layers.
    expect(grown.tree).toHaveLength(1 + AUTO_DEPTH)
    expect(grown.accepted.size).toBe(AUTO_DEPTH)
    const last = grown.tree.at(-1)!
    expect(last.id).toBe(`${801 + AUTO_DEPTH}`)
    expect(grown.searched.map((piece) => piece.id)).not.toContain(last.id)
    expect(grown.searched).toHaveLength(AUTO_DEPTH)
    // What Auto-extend reads is what it searched, and nothing where nothing was pressed.
    expect(grown.autoRead).toEqual(grown.searched)
    expect(
      growAuto(plan([pair('720', '801')], []), ['720'], offering(chain(20))).autoRead,
    ).toEqual([])
  })

  /** Extended by hand, a piece of the last layer is searched — and Auto-extend goes no further. */
  it('takes nothing beyond its last layer, even where the reader extends a piece there', () => {
    const last = `${801 + AUTO_DEPTH}`
    const before = `${800 + AUTO_DEPTH}`
    const grown = growAuto(
      plan([pair('720', '801'), pair(before, last)], ['801']),
      ['720'],
      offering(chain(20)),
    )
    expect(grown.searched.map((piece) => piece.id)).toContain(last)
    expect(grown.accepted.has(`${last}/${802 + AUTO_DEPTH}`)).toBe(false)
    // Searched for the reader, not read by Auto-extend: a large piece there stopped nothing.
    expect(grown.autoRead.map((piece) => piece.id)).not.toContain(last)
  })

  it('counts the layers from the piece it was pressed on, not from the neuron', () => {
    const deep = [pair('720', '701'), pair('701', '702'), pair('702', '801')]
    const grown = growAuto(plan(deep, ['801']), ['720'], offering(chain(20)))
    expect(grown.accepted.size).toBe(AUTO_DEPTH)
  })

  it('starts the count again at a press nested under another’s tree', () => {
    // 801 pressed; its 5th layer, 806, extended by hand and pressed too.
    const grown = growAuto(
      plan([pair('720', '801'), pair('805', '806')], ['801', '806']),
      ['720'],
      offering(chain(30)),
    )
    // 801 takes 802..805 and 806 itself is the reader's; 806 then takes ten layers.
    expect(grown.accepted.size).toBe(4 + AUTO_DEPTH)
    expect(grown.accepted.get('806/807')).toBe('806')
  })

  it('takes nothing the reader refused, nor anything beyond it', () => {
    const grown = growAuto(
      plan([pair('720', '801')], ['801'], ['801/802']),
      ['720'],
      offering({ '801': ['802', '803'], '802': ['804'] }),
    )
    expect(grown.tree.map((piece) => piece.id)).toEqual(['801', '803'])
  })

  it('takes nothing already in the tree, a neuron or a piece', () => {
    const grown = growAuto(
      plan([pair('720', '801'), pair('720', '802')], ['801']),
      ['720', '900'],
      offering({ '801': ['720', '802', '900', '803'] }),
    )
    expect([...grown.accepted.keys()]).toEqual(['801/803'])
    // 802 keeps its place, under the neuron.
    expect(summary(grown.tree)).toContain('802<720 d1 in 720')
  })

  /** Placed under its hand pair once that is reachable: taking it too would be a second accept. */
  it('takes no piece the reader extended by hand, wherever it is placed', () => {
    const grown = growAuto(
      plan([pair('720', '801'), pair('902', '850')], ['801']),
      ['720'],
      offering({ '801': ['850', '851'] }),
    )
    expect([...grown.accepted.keys()]).toEqual(['801/851'])
  })

  it('gives a piece offered twice in one round to the nearer, then the lower id', () => {
    const pairs = [pair('720', '802'), pair('720', '801'), pair('801', '803')]
    const grown = growAuto(
      plan(pairs, ['801', '802']),
      ['720'],
      offering({ '801': ['850'], '802': ['850'], '803': ['851'] }),
    )
    expect(grown.accepted.get('801/850')).toBe('801')
    expect(grown.accepted.has('802/850')).toBe(false)
  })

  /**
   * Within one neuron the tree is breadth first, so the nearer piece comes first anyway; across
   * two it does not — the first neuron's pieces are all listed before the second's.
   */
  it('gives it to the nearer piece first, across neurons too', () => {
    // 803 is two steps from 720; 900 one step from 730, listed after all of 720's.
    const pairs = [pair('720', '801'), pair('801', '803'), pair('730', '900')]
    const grown = growAuto(
      plan(pairs, ['803', '900']),
      ['720', '730'],
      offering({ '803': ['850'], '900': ['850'] }),
    )
    expect(grown.accepted.get('900/850')).toBe('900')
    expect(grown.accepted.has('803/850')).toBe(false)
  })

  it('places a piece extended by hand beyond one Auto-extend took', () => {
    const grown = growAuto(
      plan([pair('720', '801'), pair('802', '900')], ['801']),
      ['720'],
      offering({ '801': ['802'] }),
    )
    expect(summary(grown.tree)).toContain('900<802 d3 in 720')
  })

  /** A reload, then Run, must give the tables the session had. */
  it('does not depend on the order the pairs were written in', () => {
    const pairs = [pair('720', '801'), pair('720', '802'), pair('802', '803')]
    const offers = offering({ '801': ['850', '851'], '803': ['851'], '850': ['852'] })
    const one = growAuto(plan(pairs, ['801', '802']), ['720'], offers)
    const other = growAuto(plan([...pairs].reverse(), ['802', '801']), ['720'], offers)
    expect(summary(other.tree)).toEqual(summary(one.tree))
    expect([...other.accepted].sort()).toEqual([...one.accepted].sort())
  })
})
