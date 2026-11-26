// @vitest-environment jsdom
/**
 * The SEAM half of the verdict log: which verdicts are worth sending. The sending itself is
 * `src/data/verdictLog.test.ts`'s.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resetVerdictLog, verdictLogState, writeSharing } from '../../data/verdictLog'
import { clearStorage, installStorageStub } from '../../test/jsdomStubs'
import type { VerdictInput } from './verdictRecord'
import type { Candidate, QueueTip } from './reviewQueue'
import { isSeamSource, queueVerdict, verdictInput } from './verdictRecord'

const AEDES = { deployment: 'global.daf-apis.com', datastack: 'wclee_aedes_brain' }

const INPUT: VerdictInput = {
  source: 'set:rv4-ad75ed161bb6',
  neuron: '648518347669157986',
  piece: '648518347669157986',
  end_uid: 17,
  kind: 'tip',
  x: 1000,
  y: 2000,
  z: 3000,
  candidate: '648518347600000002',
  rank: 1,
  q: 0.41,
  r: 0.93,
  p_tip: 0.8,
  conf: 0.51,
  shown: true,
  organelle: false,
  verdict: 'accept',
  searched_at: null,
  coda: null,
}

beforeAll(() => installStorageStub())

beforeEach(() => {
  clearStorage()
  resetVerdictLog()
})

describe('a row as a record', () => {
  const tip = {
    endUid: 17,
    neuronId: 'piece',
    seed: 'neuron',
    kind: 'tip',
    tipNm: [1, 2, 3],
    q: 0.4,
    r: undefined,
    pTip: 0.8,
    source: 'set:rv4-ad75ed161bb6',
  } as unknown as QueueTip
  const candidate = { candidateId: 'c', rank: 2, conf: 0.3, shown: false } as Candidate

  it('carries the tip’s numbers, the candidate’s own, and the word', () => {
    expect(verdictInput(tip, candidate, 'ends', '1.0.0')).toMatchObject({
      source: 'set:rv4-ad75ed161bb6',
      neuron: 'neuron',
      piece: 'piece',
      end_uid: 17,
      x: 1,
      candidate: 'c',
      rank: 2,
      q: 0.4,
      r: null,
      p_tip: 0.8,
      conf: 0.3,
      shown: false,
      verdict: 'ends',
      coda: '1.0.0',
    })
  })

  it('sends an organelle flag only where the set gave one: absent is not known, not no', () => {
    expect(verdictInput(tip, candidate, 'reject', null).organelle).toBeNull()
    expect(verdictInput(tip, { ...candidate, organelle: true }, 'reject', null).organelle).toBe(
      true,
    )
  })

  it('names no source for a hand pick, so no sender queues it, on a SEAM tip or not', () => {
    const record = verdictInput(tip, { ...candidate, hand: true }, 'accept', null)
    expect(record.source).toBe('')
    expect(isSeamSource(record.source)).toBe(false)
  })
})

describe('which verdicts are sent', () => {
  it('sends a verdict labelled by a published set or by a run of Find Merge Candidates', () => {
    expect(isSeamSource('set:rv4-ad75ed161bb6')).toBe(true)
    expect(isSeamSource('model:trees_sizes_tip@d0da2c7b5fe6/none')).toBe(true)
  })

  it('sends nothing whose source is somebody else’s column, or empty', () => {
    for (const source of ['my notes', 'set:', 'model:', '', null, undefined, 3]) {
      expect(isSeamSource(source)).toBe(false)
    }
  })

  it('queues a labelled verdict, and refuses one labelled by another table', () => {
    writeSharing({ on: true, name: '', email: '' })
    expect(queueVerdict(AEDES, { ...INPUT, source: 'my notes' })).toBe('no source')
    expect(verdictLogState().waiting).toBe(0)
    expect(queueVerdict(AEDES, INPUT)).toBeUndefined()
    expect(verdictLogState().waiting).toBe(1)
  })

  it('queues nothing with sharing off', () => {
    expect(queueVerdict(AEDES, INPUT)).toBe('sharing off')
    expect(verdictLogState().waiting).toBe(0)
  })
})
