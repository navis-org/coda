/**
 * The merge record: what it keeps, what it drops, and the one reading of it everything shares
 * (`mergedSoFar`). How the batch writes it is `mergeBatch.test.ts`; how the plan reads it,
 * `mergePlan.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import { DEFAULT_CAVE_SERVER } from '../../data/cave/deployments'
import type { MergeRecord, MergeRecordEntry, RecordScope } from './mergeRecord'
import {
  decodeRecord,
  appendEntry,
  appendRecorded,
  RECORD_KEPT_NEURONS,
  mergedSoFar as readFor,
  mergesSchema,
  mergesTable,
  recordScopeOf,
  settledEntry,
  shortenedRecord,
} from './mergeRecord'

/** Past 2⁵³, where an id that went through a number would come back different. */
const NEURON = '720575940621039145'

/** The chunkedgraph every entry here was made on. */
const SCOPE: RecordScope = {
  deployment: 'https://global.example.org',
  datastack: 'fanc_sandbox',
}
const mergedSoFar = (record: MergeRecord, root: string) => readFor(record, root, SCOPE)

const base = {
  ...SCOPE,
  reviewedRoot: NEURON,
  endUid: 3,
  neuronRoot: NEURON,
  neuron: { supervoxel: '73747834149376537', positionNm: [8, 24, 22.5] as const },
  candidate: { supervoxel: '73747834149376538', positionNm: [25.8, 43, 517.5] as const },
  at: '2026-11-16T10:00:00.000Z',
}

const RECORD: MergeRecordEntry[] = [
  {
    ...base,
    candidateRoot: '720575940000000001',
    outcome: 'merged',
    newRoot: '720575940700000001',
    operationId: '4217',
  },
  {
    ...base,
    candidateRoot: '720575940000000002',
    neuronRoot: '720575940700000001',
    outcome: 'already-merged',
    message: 'Part of the neuron already; nothing sent.',
  },
  {
    ...base,
    candidateRoot: '720575940000000003',
    neuronRoot: '720575940700000001',
    outcome: 'failed',
    status: 400,
    message: 'Refused (400): no',
  },
  // A lost reply whose roots showed the merge: a new root, no operation id.
  {
    ...base,
    candidateRoot: '720575940000000004',
    neuronRoot: '720575940700000001',
    outcome: 'merged',
    newRoot: '720575940700000002',
  },
  { ...base, reviewedRoot: '720575940699999999', candidateRoot: '9', outcome: 'unknown' },
]

describe('the merge record', () => {
  /** Built the way the batch writes it: one entry appended at a time. */
  const text = RECORD.reduce<string>((raw, entry) => appendEntry(raw, entry), '')

  it('comes back as it went in, ids as text', () => {
    expect(decodeRecord(text)).toEqual(RECORD)
    expect(text).toContain('"720575940621039145"')
  })

  it('is empty from anything that is not a record, and starts afresh there', () => {
    for (const raw of ['', '  ', undefined, 7, 'not json', '{"a":1}']) {
      expect(decodeRecord(raw)).toEqual([])
      expect(decodeRecord(appendEntry(raw, RECORD[1]!))).toEqual([RECORD[1]])
    }
  })

  /** A merge of a piece accepted on a piece says which (`docs/seam-extend-plan.md`). */
  it('keeps the piece a merge was accepted on, and refuses one that is no id', () => {
    const onPiece = { ...RECORD[1]!, parentRoot: '720575940000000002' }
    expect(decodeRecord(appendEntry('', onPiece))).toEqual([onPiece])
    expect(decodeRecord(JSON.stringify([{ ...onPiece, parentRoot: 'seven' }]))).toEqual([])
    // Absent is the ordinary case: a piece accepted on the neuron itself.
    expect(
      decodeRecord(text).every(
        (entry) => !('parentRoot' in entry) || entry.parentRoot === undefined,
      ),
    ).toBe(true)
    // Published, so a row's tip number can be read against the root it numbers.
    const table = mergesTable([onPiece, RECORD[1]!])
    expect(table.data['accepted_on']).toEqual(['720575940000000002', null])
    // And kept when a lost reply is settled later.
    const lost = { ...onPiece, outcome: 'unknown' as const }
    expect(
      settledEntry(lost, '720575940700000009', '2026-11-17T00:00:00.000Z').parentRoot,
    ).toBe('720575940000000002')
  })

  /** The record is the log of every Submit: reading skips what it cannot read, writing keeps it. */
  it('keeps an entry it cannot read when appending', () => {
    const later = { ...RECORD[0], outcome: 'from-a-later-coda' }
    const raw = appendEntry(JSON.stringify([later]), RECORD[1]!)
    expect(JSON.parse(raw)).toEqual([later, RECORD[1]])
    expect(decodeRecord(raw)).toEqual([RECORD[1]])
  })

  /** Dropped, not guessed at: the server is asked again before anything is sent. */
  it.each([
    ['an id as a number', { reviewedRoot: 720575940 }],
    ['an id that is not one', { candidateRoot: 'abc' }],
    [
      'supervoxel 0, which is no object',
      { neuron: { supervoxel: '0', positionNm: [1, 2, 3] } },
    ],
    ['an outcome it does not know', { outcome: 'half-merged' }],
    ['a merge with no new root', { outcome: 'merged', newRoot: undefined }],
    ['a position of two numbers', { neuron: { supervoxel: '5', positionNm: [1, 2] } }],
    [
      'a position that is not finite',
      { candidate: { supervoxel: '5', positionNm: [1, 2, null] } },
    ],
    ['no tip', { endUid: '3' }],
    ['a message that is not text', { message: 42 }],
    ['an operation id that is not one', { operationId: { x: 1 } }],
    ['a status that is not a number', { status: '400' }],
    ['a datastack that is not text', { datastack: 7 }],
  ])('drops an entry with %s and keeps the rest', (_, change) => {
    const bad = { ...RECORD[0], ...change }
    const text = JSON.stringify([bad, RECORD[1]])
    expect(decodeRecord(text)).toEqual([RECORD[1]])
  })
})

describe('mergedSoFar', () => {
  /**
   * The audit of 77c0625 (2026-11-16): a sandbox table is a copy of a production one, so read for
   * every chunkedgraph a sandbox merge moved the neuron's root, and took its pieces, on production.
   */
  it('reads only the entries made on the chunkedgraph it is asked about', () => {
    const production = { ...SCOPE, datastack: 'fanc_production' }
    expect(readFor(RECORD, NEURON, production).currentRoot).toBe(NEURON)
    expect(readFor(RECORD, NEURON, production).pieces.size).toBe(0)
    const elsewhere = { ...SCOPE, deployment: 'https://other.example.org' }
    expect(readFor(RECORD, NEURON, elsewhere).roots).toEqual([NEURON])
    expect(readFor(RECORD, NEURON, undefined).roots).toEqual([NEURON])
  })

  /** Written before entries named one: kept in the param and in Merges, read for none. */
  it('reads an entry that names no chunkedgraph for none', () => {
    const { deployment: _d, datastack: _s, ...old } = RECORD[0]!
    const raw = JSON.stringify([old])
    expect(decodeRecord(raw)).toEqual([old])
    expect(mergedSoFar(decodeRecord(raw), NEURON).roots).toEqual([NEURON])
    expect(mergesTable(decodeRecord(raw)).data['datastack']).toEqual([null])
  })

  it('takes its scope from a wired CAVE Dataset, and none from anything else', () => {
    expect(recordScopeOf({ sourceId: 'cave', datasetId: 'fanc_sandbox:1' })).toEqual({
      deployment: DEFAULT_CAVE_SERVER,
      datastack: 'fanc_sandbox',
    })
    expect(
      recordScopeOf({ sourceId: 'neuprint:x', datasetId: 'fanc_sandbox:1' }),
    ).toBeUndefined()
    expect(recordScopeOf({ sourceId: 'cave', datasetId: undefined })).toBeUndefined()
  })

  it('follows the neuron through its merges, and counts only what is in it', () => {
    expect(mergedSoFar(RECORD, NEURON)).toEqual({
      currentRoot: '720575940700000002',
      roots: [NEURON, '720575940700000001', '720575940700000002'],
      pieces: new Set(['720575940000000001', '720575940000000002', '720575940000000004']),
      otherRoots: new Set(['720575940699999999']),
      elsewhere: new Set(),
      unsettled: [],
      absorbedInto: undefined,
    })
  })

  /** And what the other reviewed neurons have taken: the plan refuses those pieces here. */
  it('is the reviewed root alone where nothing was merged into it', () => {
    expect(mergedSoFar(RECORD, '720575940699999999')).toEqual({
      currentRoot: '720575940699999999',
      roots: ['720575940699999999'],
      pieces: new Set(),
      otherRoots: new Set([NEURON, '720575940700000001', '720575940700000002']),
      elsewhere: new Set(['720575940000000001', '720575940000000002', '720575940000000004']),
      // A lost reply nothing has settled: the plan asks the roots.
      unsettled: [RECORD[4]],
      absorbedInto: undefined,
    })
  })
})

/** A lost reply the plan showed was a merge: appended as one, and the neuron moves on. */
describe('settling a lost reply', () => {
  it('appends the same merge as made, and moves the neuron to its root', () => {
    const lost = RECORD[4]!
    const settled = settledEntry(lost, '720575940700000009', '2026-11-16T11:00:00.000Z')
    expect(settled).toMatchObject({
      ...SCOPE,
      reviewedRoot: lost.reviewedRoot,
      candidateRoot: lost.candidateRoot,
      neuronRoot: lost.neuronRoot,
      neuron: lost.neuron,
      outcome: 'merged',
      newRoot: '720575940700000009',
      at: '2026-11-16T11:00:00.000Z',
    })
    const after = decodeRecord(appendEntry(JSON.stringify(RECORD), settled))
    expect(mergedSoFar(after, lost.reviewedRoot)).toMatchObject({
      currentRoot: '720575940700000009',
      unsettled: [],
    })
  })
})

describe('a late answer to a lost reply', () => {
  const lost = RECORD[4]!
  /** A refusal of the same pair at the same root: nothing was written, so nothing to settle. */
  it('is settled as not made by the server’s refusal of the same pair', () => {
    const refused: MergeRecordEntry = { ...lost, outcome: 'failed', status: 400 }
    expect(mergedSoFar([lost, refused], lost.reviewedRoot).unsettled).toEqual([])
    const other: MergeRecordEntry = { ...refused, candidateRoot: '720575940000000008' }
    expect(mergedSoFar([lost, other], lost.reviewedRoot).unsettled).toEqual([lost])
  })

  /** `done` that the roots did not show: its operation id survives the settlement. */
  it('keeps the server’s operation id through the settlement', () => {
    const answered: MergeRecordEntry = { ...lost, outcome: 'unknown', operationId: '4217' }
    expect(decodeRecord(JSON.stringify([answered]))).toEqual([answered])
    expect(mergesTable([answered]).data['operation_id']).toEqual(['4217'])
    const settled = settledEntry(answered, '720575940700000009', '2026-11-16T11:00:00.000Z')
    expect(settled).toMatchObject({ outcome: 'merged', operationId: '4217' })
    // The reply was not lost: the server answered, and the roots were slow to show it.
    expect(settled.message).toMatch(/answered merged \(operation 4217\)/)
  })
})

/** A reviewed neuron this workflow merged, as a piece, into another: drawn as that one now. */
describe('a neuron merged into another', () => {
  it('is that neuron at its root now', () => {
    const into: MergeRecordEntry = {
      ...base,
      candidateRoot: '720575940699999999',
      outcome: 'merged',
      newRoot: '720575940700000003',
    }
    const later: MergeRecordEntry = {
      ...base,
      candidateRoot: '720575940000000005',
      neuronRoot: '720575940700000003',
      outcome: 'merged',
      newRoot: '720575940700000004',
    }
    expect(mergedSoFar([into, later], '720575940699999999').absorbedInto).toBe(
      '720575940700000004',
    )
    expect(mergedSoFar([into, later], NEURON).absorbedInto).toBeUndefined()
  })

  /** A into B, then B into C: A is C now, not B's retired root. */
  it('follows one neuron into the next to the end', () => {
    const C = '720575940600000000'
    const bIntoC: MergeRecordEntry = {
      ...base,
      reviewedRoot: C,
      neuronRoot: C,
      candidateRoot: NEURON,
      outcome: 'merged',
      newRoot: '720575940600000001',
    }
    const aIntoB: MergeRecordEntry = {
      ...base,
      candidateRoot: '720575940699999999',
      outcome: 'merged',
      newRoot: '720575940700000003',
    }
    expect(mergedSoFar([aIntoB, bIntoC], '720575940699999999').absorbedInto).toBe(
      '720575940600000001',
    )
  })
})

describe('the Merges table', () => {
  it('has a row per entry, in its schema’s columns, ids as text', () => {
    const table = mergesTable(RECORD)
    expect(table.length).toBe(RECORD.length)
    expect(table.schema).toEqual(mergesSchema())
    expect(Object.keys(table.data)).toEqual(mergesSchema().columns.map((c) => c.name))
    expect(table.data[ID_COLUMN_NAME]![0]).toBe(NEURON)
    expect(table.data['new_root']).toEqual([
      '720575940700000001',
      null,
      null,
      '720575940700000002',
      null,
    ])
    expect(table.data['operation_id']).toEqual(['4217', null, null, null, null])
    expect(table.data['candidate_z']![0]).toBe(517.5)
    expect(table.data['message']![2]).toBe('Refused (400): no')
    expect(table.data['datastack']![0]).toBe('fanc_sandbox')
  })
})

/**
 * A neuron the card no longer keeps in full keeps of its record what `mergedSoFar` reads
 * (`reviewEviction.ts`, user, 2026-11-19): the next Submit must read it exactly as before.
 */
describe('a shortened record', () => {
  const OTHER = '720575940699999999'
  // `RECORD` without its unknown, which is the other neuron's: every merge of NEURON is settled.
  const settled = RECORD.slice(0, -1)
  const text = JSON.stringify(settled)
  const answers = (record: MergeRecord) => {
    const read = mergedSoFar(record, NEURON)
    return { ...read, pieces: [...read.pieces], elsewhere: [...read.elsewhere] }
  }

  it('reads for every merge to come as the full one did, at a third of the length', () => {
    const short = shortenedRecord(text, new Set())!
    expect(answers(decodeRecord(short))).toEqual(answers(decodeRecord(text)))
    expect(short.length).toBeLessThan(text.length / 3)
    // Of the four: the two that put a piece in the neuron. A refusal moves nothing.
    expect(decodeRecord(short).map((entry) => entry.outcome)).toEqual([
      'merged',
      'already-merged',
      'failed',
      'merged',
    ])
  })

  it('leaves the neurons kept, and says where there is nothing to shorten', () => {
    expect(shortenedRecord(text, new Set([NEURON]))).toBeUndefined()
    expect(shortenedRecord('', new Set())).toBeUndefined()
    const once = shortenedRecord(text, new Set())!
    expect(shortenedRecord(once, new Set())).toBeUndefined()
  })

  /** Settling a lost reply reads its supervoxels; a later refusal can be what settles it. */
  it('leaves a neuron whole while a merge of it is unsettled', () => {
    const open = JSON.stringify(RECORD)
    const short = decodeRecord(shortenedRecord(open, new Set())!)
    expect(short.filter((entry) => entry.reviewedRoot === OTHER)).toEqual([RECORD.at(-1)])
    expect(short.filter((entry) => entry.reviewedRoot === NEURON)).toHaveLength(4)
  })

  it('keeps what it cannot read, and the order, and takes appends after it', () => {
    const raw = JSON.stringify([{ hand: 'edit' }, ...settled])
    const short = shortenedRecord(raw, new Set())!
    expect(JSON.parse(short)[0]).toEqual({ hand: 'edit' })
    const next = {
      ...settled[0]!,
      candidateRoot: '720575940000000009',
      newRoot: '720575940700000003',
      neuronRoot: '720575940700000002',
    }
    expect(mergedSoFar(decodeRecord(appendEntry(short, next)), NEURON).currentRoot).toBe(
      '720575940700000003',
    )
  })

  it('is read by its scope, as a full entry is', () => {
    const short = decodeRecord(shortenedRecord(text, new Set())!)
    const elsewhere = readFor(short, NEURON, { ...SCOPE, datastack: 'fanc_production' })
    expect(elsewhere.currentRoot).toBe(NEURON)
    expect(elsewhere.pieces.size).toBe(0)
  })

  it('lists its rows in Merges with what it no longer holds empty', () => {
    const table = mergesTable(decodeRecord(shortenedRecord(text, new Set())!))
    expect(table.data['candidateId']).toEqual([
      '720575940000000001',
      '720575940000000002',
      '720575940000000003',
      '720575940000000004',
    ])
    expect(table.data['outcome']).toEqual(['merged', 'already-merged', 'failed', 'merged'])
    expect(table.data['new_root']).toEqual([
      '720575940700000001',
      null,
      null,
      '720575940700000002',
    ])
    expect(table.data['neuron_supervoxel']).toEqual([null, null, null, null])
    expect(table.data['datastack']![0]).toBe('fanc_sandbox')
  })

  /** Where the record grows (`mergeSession.ts`): the last ten neurons it names are kept. */
  it('is made as an entry is appended, by the record’s own last ten neurons', () => {
    const neuron = (i: number) => `72057594000000${String(i).padStart(4, '0')}`
    const one = (i: number) => ({
      ...settled[0]!,
      reviewedRoot: neuron(i),
      neuronRoot: neuron(i),
      newRoot: `72057594070000${String(i).padStart(4, '0')}`,
    })
    let raw = ''
    for (let i = 1; i <= RECORD_KEPT_NEURONS; i++) raw = appendRecorded(raw, one(i))
    expect(decodeRecord(raw).some((entry) => 'short' in entry)).toBe(false)
    raw = appendRecorded(raw, one(RECORD_KEPT_NEURONS + 1))
    const read = decodeRecord(raw)
    expect(read.filter((entry) => 'short' in entry).map((entry) => entry.reviewedRoot)).toEqual(
      [neuron(1)],
    )
    expect(read.at(-1)).toEqual(one(RECORD_KEPT_NEURONS + 1))
  })

  /** Another reviewed neuron is any the record names (`otherRoots`), whatever became of its merge. */
  it('keeps a refusal, so its neuron is still one under review', () => {
    const refused = { ...RECORD[2]!, reviewedRoot: OTHER, neuronRoot: OTHER }
    const raw = JSON.stringify([refused])
    const short = decodeRecord(shortenedRecord(raw, new Set())!)
    expect(short).toEqual([
      {
        short: true,
        ...SCOPE,
        reviewedRoot: OTHER,
        candidateRoot: refused.candidateRoot,
        outcome: 'failed',
      },
    ])
    expect(mergedSoFar(short, NEURON).otherRoots).toEqual(
      mergedSoFar([refused], NEURON).otherRoots,
    )
  })

  it('reads no short entry that is malformed', () => {
    const bad = [
      ['merged', null, null, NEURON, '720575940000000001'],
      ['already-merged', null, null, 'x', '720575940000000001'],
      ['unknown', null, null, NEURON, '720575940000000001'],
      ['failed', null, null, NEURON, '720575940000000001', '720575940700000001'],
    ]
    expect(decodeRecord(JSON.stringify(bad))).toEqual([])
  })
})
