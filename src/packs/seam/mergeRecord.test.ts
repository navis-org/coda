/**
 * The merge record: what it keeps, what it drops, and the one reading of it everything shares
 * (`mergedSoFar`). How the batch writes it is `mergeBatch.test.ts`; how the plan reads it,
 * `mergePlan.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import { ID_COLUMN_NAME } from '../../core/ids'
import type { MergeRecordEntry } from './mergeRecord'
import {
  decodeRecord,
  appendEntry,
  mergedSoFar,
  mergesSchema,
  mergesTable,
  settledEntry,
} from './mergeRecord'

/** Past 2⁵³, where an id that went through a number would come back different. */
const NEURON = '720575940621039145'

const base = {
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
  ])('drops an entry with %s and keeps the rest', (_, change) => {
    const bad = { ...RECORD[0], ...change }
    const text = JSON.stringify([bad, RECORD[1]])
    expect(decodeRecord(text)).toEqual([RECORD[1]])
  })
})

describe('mergedSoFar', () => {
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
  })
})
