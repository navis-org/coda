/**
 * Following the reviewed neuron through an edit (`followEdit.ts`): which part is followed, what a
 * follow records, and which tips leave the list. Over fake servers; nothing here reaches one.
 */

import { describe, expect, it, vi } from 'vitest'

import type { GrapheneSource } from '../../data/cave/graphene'
import type { FollowServices } from './followEdit'
import {
  anchorsOf,
  cutOffTips,
  followEdit,
  followPieces,
  nearEvenOf,
  pieceAnchorsOf,
} from './followEdit'
import { withoutTips } from './handPicks'
import type {
  FollowEntry,
  MergeRecord,
  MergeRecordEntry,
  PieceFollow,
  RecordScope,
} from './mergeRecord'
import { verdictKey } from './pieces'
import type { Candidate, QueueTip, Verdicts } from './reviewQueue'
import { acceptedPieces } from './reviewQueue'

const SCOPE: RecordScope = {
  deployment: 'https://global.example.org',
  datastack: 'fanc_sandbox',
}
const OPTIONS = { deployment: SCOPE.deployment }
const NEURON = '720575940621039145'
/** The neuron's two parts after a split. */
const KEPT = '720575940700000001'
const TAKEN = '720575940700000002'
const PIECE = '720575940630442210'
const BEYOND = '720575940630442211'

/** Fake servers: each supervoxel's root now, and each root's size. */
function services(
  rootOf: Record<string, string>,
  sizes: Record<string, number> = {},
): FollowServices & { asked: string[][] } {
  const asked: string[][] = []
  return {
    asked,
    graphene: async () => ({ server: 's', table: 't' }) as GrapheneSource,
    roots: async (_g, svs: readonly string[]) => {
      asked.push([...svs])
      return svs.map((sv) => rootOf[sv] ?? '0')
    },
    sizes: vi.fn(async (_g, roots: readonly string[]) => {
      return new Map(roots.filter((r) => r in sizes).map((r) => [r, sizes[r]!]))
    }),
    now: () => new Date('2026-11-24T12:00:00.000Z'),
  }
}

const request = (tips: string[], extra: Partial<Parameters<typeof followEdit>[0]> = {}) => ({
  scope: SCOPE,
  reviewedRoot: NEURON,
  from: NEURON,
  anchors: { tips, pieces: [] },
  ...extra,
})

describe('which part is followed', () => {
  it('is the part holding the most of the neuron’s tips; the rest leave', async () => {
    const live = services({ a: KEPT, b: KEPT, c: TAKEN })
    const answer = await followEdit(request(['a', 'b', 'c']), OPTIONS, live)
    expect(answer).toEqual({
      ok: true,
      entry: {
        kind: 'followed',
        ...SCOPE,
        reviewedRoot: NEURON,
        from: NEURON,
        to: KEPT,
        at: '2026-11-24T12:00:00.000Z',
        away: ['c'],
        placed: ['a', 'b', 'c'],
        kept: 2,
        others: [{ root: TAKEN, tips: 1 }],
        left: [],
      },
    })
  })

  it('at a tie, is the larger part, asked only then', async () => {
    const live = services({ a: KEPT, b: TAKEN }, { [KEPT]: 10, [TAKEN]: 400 })
    const answer = await followEdit(request(['a', 'b']), OPTIONS, live)
    expect(answer.ok && answer.entry.to).toBe(TAKEN)
    expect(live.sizes).toHaveBeenCalledTimes(1)
    const clear = services({ a: KEPT, b: KEPT, c: TAKEN })
    await followEdit(request(['a', 'b', 'c']), OPTIONS, clear)
    expect(clear.sizes).not.toHaveBeenCalled()
  })

  it('is the reader’s choice where one is given, and then may be the root followed already', async () => {
    const live = services({ a: KEPT, b: KEPT, c: TAKEN })
    const other = await followEdit(
      request(['a', 'b', 'c'], { from: KEPT, prefer: TAKEN }),
      OPTIONS,
      live,
    )
    expect(other.ok && [other.entry.to, other.entry.away]).toEqual([TAKEN, ['a', 'b']])
    // Placing tips searched since: the same part again.
    const again = await followEdit(
      request(['a', 'b', 'c'], { from: KEPT, prefer: KEPT }),
      OPTIONS,
      live,
    )
    expect(again.ok && again.entry.to).toBe(KEPT)
  })

  it('refuses a chosen part that holds none of the tips now', async () => {
    const live = services({ a: KEPT, b: KEPT })
    const answer = await followEdit(
      request(['a', 'b'], { from: KEPT, prefer: TAKEN }),
      OPTIONS,
      live,
    )
    expect(!answer.ok && answer.message).toMatch(/holds none of the neuron’s tips now/)
  })

  it('leaves a tip whose supervoxel is on no object, rather than dropping it', async () => {
    const live = services({ a: KEPT, b: KEPT })
    const answer = await followEdit(request(['a', 'b', 'lost']), OPTIONS, live)
    expect(answer.ok && answer.entry.away).toEqual([])
  })

  it('names the merged pieces that went with another part', async () => {
    const live = services({ a: KEPT, b: KEPT, pa: KEPT, pb: TAKEN })
    const answer = await followEdit(
      {
        ...request(['a', 'b']),
        anchors: {
          tips: ['a', 'b'],
          pieces: [
            { id: PIECE, supervoxel: 'pa' },
            { id: BEYOND, supervoxel: 'pb' },
            { id: '720575940630442212', supervoxel: 'gone' },
          ],
        },
      },
      OPTIONS,
      live,
    )
    expect(answer.ok && answer.entry.left).toEqual([BEYOND])
    // A piece on no object, as a tip there, is not said to have gone anywhere.
    // One request for the tips and the pieces together.
    expect(live.asked).toEqual([['a', 'b', 'pa', 'pb', 'gone']])
  })

  it('says why, where it cannot follow', async () => {
    const none = await followEdit(request([]), OPTIONS, services({}))
    expect(none.ok).toBe(false)
    expect(!none.ok && none.message).toMatch(/Run Suggest Merges again/)
    const same = await followEdit(request(['a']), OPTIONS, services({ a: NEURON }))
    expect(!same.ok && same.message).toMatch(/has not been edited/)
    const failing = services({})
    failing.roots = async () => {
      throw new Error('503')
    }
    const failed = await followEdit(request(['a']), OPTIONS, failing)
    expect(!failed.ok && failed.message).toMatch(/could not be read: 503/)
  })
})

describe('another part with nearly as many tips', () => {
  const entry = (kept: number, others: FollowEntry['others']) =>
    ({ kept, others }) as unknown as FollowEntry
  it('is offered from four fifths of the followed part’s tips', () => {
    expect(nearEvenOf(entry(72, [{ root: TAKEN, tips: 67 }]))).toEqual({
      root: TAKEN,
      tips: 67,
    })
    expect(nearEvenOf(entry(100, [{ root: TAKEN, tips: 79 }]))).toBeUndefined()
    expect(nearEvenOf(entry(100, []))).toBeUndefined()
    expect(nearEvenOf(undefined)).toBeUndefined()
  })
})

const candidate = (id: string): Candidate => ({
  candidateId: id,
  rank: 1,
  geoRank: 1,
  volumeUm3: undefined,
  l2Chunks: undefined,
  minDistUm: undefined,
  contactNm: undefined,
  pCand: undefined,
  conf: undefined,
  shown: false,
})

const tip = (
  root: string,
  endUid: number,
  tipSv: string | undefined,
  candidates: string[] = [],
): QueueTip => ({
  endUid,
  neuronId: root,
  seed: NEURON,
  junction: false,
  search: 'done',
  kind: 'tip',
  tipNm: [0, 0, 0],
  ...(tipSv !== undefined ? { tipSv } : {}),
  r: undefined,
  q: undefined,
  pTip: undefined,
  shown: false,
  cleared: false,
  source: undefined,
  candidates: candidates.map(candidate),
})

const follow = (away: string[], left: string[] = []): FollowEntry => ({
  kind: 'followed',
  ...SCOPE,
  reviewedRoot: NEURON,
  from: NEURON,
  to: KEPT,
  at: '2026-11-24T12:00:00.000Z',
  away,
  placed: ['a', 'b', 'c'],
  kept: 1,
  others: [],
  left,
})

/** What the card lists after the record's follows: `cutOffTips`, dropped by `withoutTips`. */
const withoutCutOff = (
  queue: readonly QueueTip[],
  record: MergeRecord,
  scope: RecordScope,
  verdicts: Verdicts,
) => withoutTips(queue, cutOffTips(queue, record, scope, verdicts))

/** A piece merged into the neuron at tip 1, by supervoxel `pa`, making `newRoot`. */
const mergeOf = (newRoot: string): MergeRecordEntry => ({
  ...SCOPE,
  reviewedRoot: NEURON,
  candidateRoot: PIECE,
  endUid: 1,
  neuronRoot: NEURON,
  neuron: { supervoxel: '1', positionNm: [0, 0, 0] },
  candidate: { supervoxel: 'pa', positionNm: [0, 0, 0] },
  at: '2026-11-24T11:00:00.000Z',
  outcome: 'merged',
  newRoot,
})

/** Accepted pairs, as the card reads them: `parent|piece` → accept. */
const accepted = (...pairs: [string, string][]): Verdicts =>
  new Map(pairs.map(([parent, piece]) => [verdictKey(parent, piece), 'accept' as const]))
const NONE: Verdicts = new Map()

describe('the tips that leave the list', () => {
  it('are the neuron’s tips on another part; one with no supervoxel stays', () => {
    const queue = [tip(NEURON, 1, 'a'), tip(NEURON, 2, 'c'), tip(NEURON, 3, undefined)]
    const left = withoutCutOff(queue, [follow(['c'])], SCOPE, NONE)
    expect(left.map((one) => one.endUid)).toEqual([1, 3])
  })

  it('is none where nothing is dropped, so the list is kept', () => {
    const queue = [tip(NEURON, 1, 'a')]
    expect(cutOffTips(queue, [], SCOPE, NONE)).toBe('')
    expect(cutOffTips(queue, [follow(['z'])], SCOPE, NONE)).toBe('')
  })

  it('take a piece accepted only at a dropped tip, and every piece beyond it', () => {
    const queue = [
      tip(NEURON, 1, 'a'),
      tip(NEURON, 2, 'c', [PIECE]),
      tip(PIECE, 5, 'p', [BEYOND]),
      tip(BEYOND, 6, 'q'),
    ]
    const verdicts = accepted([NEURON, PIECE], [PIECE, BEYOND])
    const left = withoutCutOff(queue, [follow(['c'])], SCOPE, verdicts)
    expect(left.map((one) => one.endUid)).toEqual([1])
  })

  it('keep a piece accepted at a kept tip as well', () => {
    const queue = [
      tip(NEURON, 1, 'a', [PIECE]),
      tip(NEURON, 2, 'c', [PIECE]),
      tip(PIECE, 5, 'p'),
    ]
    const left = withoutCutOff(queue, [follow(['c'])], SCOPE, accepted([NEURON, PIECE]))
    expect(left.map((one) => one.endUid)).toEqual([1, 5])
  })

  it('include a merged piece’s tips on another part, whether or not the follow lost the piece', () => {
    const made = '720575940699999999'
    const merge = mergeOf(made)
    // A merged piece's tips are the neuron's now, so their own supervoxels decide them.
    const queue = [tip(NEURON, 1, 'a', [PIECE]), tip(PIECE, 5, 'p')]
    const verdicts = accepted([NEURON, PIECE])
    for (const lost of [[], [PIECE]]) {
      const record = [merge, { ...follow(['p'], lost), from: made }]
      expect(withoutCutOff(queue, record, SCOPE, verdicts).map((one) => one.endUid)).toEqual([
        1,
      ])
    }
  })

  it('keep a piece accepted on a merged piece that stayed, though the tip that piece hung on left', () => {
    const made = '720575940699999999'
    // P was accepted at tip 2 and merged; Q was accepted on P's tip 5 and is not merged yet.
    const queue = [
      tip(NEURON, 2, 'c', [PIECE]),
      tip(PIECE, 5, 'p', [BEYOND]),
      tip(BEYOND, 6, 'q'),
    ]
    const verdicts = accepted([NEURON, PIECE], [PIECE, BEYOND])
    const record = [mergeOf(made), { ...follow(['c']), from: made }]
    expect(withoutCutOff(queue, record, SCOPE, verdicts).map((one) => one.endUid)).toEqual([
      5, 6,
    ])
  })

  it('take a merged piece the follow lost, with its tips and what hangs on them', () => {
    const made = '720575940699999999'
    const queue = [
      tip(NEURON, 1, 'a', [PIECE]),
      // No supervoxel: dropped because its piece went, not by where it is.
      tip(PIECE, 5, undefined, [BEYOND]),
      tip(BEYOND, 6, 'q'),
    ]
    const verdicts = accepted([NEURON, PIECE], [PIECE, BEYOND])
    const record = [mergeOf(made), { ...follow([], [PIECE]), from: made }]
    expect(withoutCutOff(queue, record, SCOPE, verdicts).map((one) => one.endUid)).toEqual([1])
  })

  it('come back when a later follow places them on the part followed', () => {
    const queue = [tip(NEURON, 1, 'a'), tip(NEURON, 2, 'c')]
    const undone = { ...follow([]), from: KEPT, to: '720575940700000003' }
    expect(withoutCutOff(queue, [follow(['c']), undone], SCOPE, NONE)).toHaveLength(2)
  })
})

describe('what a follow places', () => {
  it('is the neuron’s and its merged pieces’ tips, and the merged pieces themselves', () => {
    const mine = [
      tip(NEURON, 1, 'a'),
      tip(PIECE, 5, 'p'),
      tip(BEYOND, 6, 'q'),
      tip(NEURON, 2, undefined),
    ]
    const merge = mergeOf(KEPT)
    expect(
      anchorsOf(mine, [merge], NEURON, {
        pieces: new Set([PIECE]),
        left: new Set(),
        pieceFollows: new Map(),
      }),
    ).toEqual({
      // BEYOND is accepted and not merged: its tips leave with the tip it hangs on.
      tips: ['a', 'p'],
      pieces: [{ id: PIECE, supervoxel: 'pa' }],
      unknown: 0,
    })
  })

  it('places a piece by the merge that took it in, and counts one the record keeps short', () => {
    const later = {
      ...mergeOf(KEPT),
      outcome: 'not-sent' as const,
      candidate: { supervoxel: 'other', positionNm: [0, 0, 0] as const },
    }
    const short = {
      short: true as const,
      ...SCOPE,
      reviewedRoot: NEURON,
      candidateRoot: BEYOND,
      outcome: 'merged' as const,
      newRoot: KEPT,
    }
    const so = {
      pieces: new Set([PIECE, BEYOND]),
      left: new Set<string>(),
      pieceFollows: new Map(),
    }
    expect(anchorsOf([], [mergeOf(KEPT), later, short], NEURON, so)).toEqual({
      tips: [],
      pieces: [{ id: PIECE, supervoxel: 'pa' }],
      unknown: 1,
    })
  })
})

/** A piece's follow: PIECE from its own root to `to`, its tips in `away` left behind. */
const pieceFollow = (to: string, away: string[] = []): PieceFollow => ({
  kind: 'piece-followed',
  ...SCOPE,
  reviewedRoot: NEURON,
  piece: PIECE,
  from: PIECE,
  to,
  at: '2026-11-25T12:00:00.000Z',
  supervoxel: 'pc',
  away,
})
const TRIMMED = '720575940700000009'

/** A candidate with its contact's supervoxel and gap. */
const withContact = (id: string, candSv: string | undefined, gapUm: number): Candidate => ({
  ...candidate(id),
  minDistUm: gapUm,
  ...(candSv !== undefined ? { candSv } : {}),
})

describe('following a piece of the list (phase 4)', () => {
  const rowOn = (endUid: number, one: Candidate): QueueTip => ({
    ...tip(NEURON, endUid, undefined),
    candidates: [one],
  })

  it('places it by a row it was accepted on, else one on the neuron’s tips, nearest gap first', () => {
    const mine = [
      rowOn(1, withContact(PIECE, 'onNeuron', 0.8)),
      // On a piece's tip: nearer, and no contact with the neuron itself.
      { ...rowOn(2, withContact(PIECE, 'judged', 0.1)), neuronId: BEYOND },
      tip(PIECE, 5, 'p'),
      tip(PIECE, 6, undefined),
    ]
    const anchors = (verdicts: Verdicts) =>
      pieceAnchorsOf(mine, mine, PIECE, PIECE, acceptedPieces(mine, verdicts))
    expect(anchors(NONE)).toEqual({
      piece: PIECE,
      from: PIECE,
      contact: 'onNeuron',
      tips: ['p'],
    })
    expect(anchors(accepted([BEYOND, PIECE]))?.contact).toBe('judged')
  })

  it('reads its contact off the rows still listed, and its own tips off the list before', () => {
    const near = rowOn(1, withContact(PIECE, 'cutOff', 0.1))
    const kept = rowOn(2, withContact(PIECE, 'kept', 0.5))
    const own = [near, kept, tip(PIECE, 5, 'p')]
    expect(pieceAnchorsOf([kept], own, PIECE, PIECE, new Map())).toEqual({
      piece: PIECE,
      from: PIECE,
      contact: 'kept',
      tips: ['p'],
    })
  })

  it('cannot be placed where no row says its contact’s supervoxel', () => {
    expect(
      pieceAnchorsOf(
        [rowOn(1, withContact(PIECE, undefined, 0.1))],
        [],
        PIECE,
        PIECE,
        acceptedPieces([rowOn(1, withContact(PIECE, undefined, 0.1))], NONE),
      ),
    ).toBeUndefined()
  })

  it('goes where its contact is, its tips elsewhere leaving; unchanged and lost pieces apart', async () => {
    const live = services({ pc: TRIMMED, p: TRIMMED, q: '720575940700000010', other: BEYOND })
    const answer = await followPieces(
      {
        scope: SCOPE,
        reviewedRoot: NEURON,
        pieces: [
          { piece: PIECE, from: PIECE, contact: 'pc', tips: ['p', 'q', 'nowhere'] },
          { piece: BEYOND, from: BEYOND, contact: 'other', tips: [] },
          {
            piece: '720575940630442212',
            from: '720575940630442212',
            contact: 'gone',
            tips: [],
          },
        ],
      },
      OPTIONS,
      live,
    )
    // One lookup for everything.
    expect(live.asked).toHaveLength(1)
    // A short answer is a read that failed, never "on no object".
    const short = await followPieces(
      {
        scope: SCOPE,
        reviewedRoot: NEURON,
        pieces: [{ piece: PIECE, from: PIECE, contact: 'pc', tips: [] }],
      },
      OPTIONS,
      { ...live, roots: async () => [] },
    )
    expect(!short.ok && short.message).toMatch(
      /could not be read: the chunkedgraph answered 0 of 1/,
    )
    expect(answer).toEqual({
      ok: true,
      entries: [{ ...pieceFollow(TRIMMED, ['q']), at: '2026-11-24T12:00:00.000Z' }],
      refused: [
        {
          piece: '720575940630442212',
          message: expect.stringMatching(/on no object now/) as unknown as string,
        },
      ],
    })
  })

  it('drops the piece’s own tips on another part, and what was accepted on them', () => {
    const queue = [
      tip(NEURON, 1, 'a', [PIECE]),
      tip(PIECE, 5, 'p', [BEYOND]),
      tip(PIECE, 6, 'q'),
      tip(BEYOND, 7, 'b'),
    ]
    const verdicts = accepted([NEURON, PIECE], [PIECE, BEYOND])
    const left = withoutCutOff(queue, [pieceFollow(TRIMMED, ['p'])], SCOPE, verdicts)
    expect(left.map((one) => one.endUid)).toEqual([1, 6])
  })

  it('places a piece merged in by hand by its contact when the neuron is followed', () => {
    const merged = '720575940700000011'
    const record = [pieceFollow(merged)]
    const so = {
      pieces: new Set([PIECE]),
      left: new Set<string>(),
      pieceFollows: new Map([[PIECE, record[0]!]]),
    }
    expect(anchorsOf([tip(PIECE, 5, 'p')], record, NEURON, so)).toEqual({
      tips: ['p'],
      pieces: [{ id: PIECE, supervoxel: 'pc' }],
      unknown: 0,
    })
  })
})
