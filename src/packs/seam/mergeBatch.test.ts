/**
 * The batch behind Merge, against a fake segmentation (`BatchServices`): a map from supervoxel to
 * root that a merge really changes, so each per-merge check reads what the merges before it did.
 * One test runs the live reads and the writer over a stubbed `fetch`, for the requests themselves;
 * nothing here reaches a server (`src/test/writeGuard.ts`).
 *
 * What is pinned is the plan doc's phase 5: the check before each merge at the server's now, the
 * three ways it answers, the check after, what a lost reply becomes, and that the first failure
 * stops everything after it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetCredentials } from '../../data/cave/credentials'
import type { ConfirmedMerge, EditOutcome } from '../../data/cave/edits'
import { parseGrapheneSource } from '../../data/cave/graphene'
import type { GraphLayout } from '../../data/cave/graphLayout'
import type { BatchServices } from './mergeBatch'
import { prepareMerges } from './mergeBatch'
import type { PlannedMerge, ReadyPlan } from './mergePlan'
import type { MergeProgress, MergeRecordEntry } from './mergeRecord'
import type { Candidate } from './reviewQueue'

const GRAPHENE = parseGrapheneSource(
  'graphene://https://cave.example.org/segmentation/table/test_table',
)!
const AS = { deployment: 'https://global.example.org', token: 'test-token' }
const NEURON = '100'

/** Eight bits of layer, as FlyWire's and Aedes' tables have: a supervoxel's top byte is 1. */
const LAYOUT: GraphLayout = {
  layerBits: 8,
  bitsPerAxis: new Map([[1, 10]]),
  baseMip: 0,
  baseResolutionNm: [8, 8, 40],
}
/** Supervoxel `n`: layer 1, so the batch's check takes it for one. */
const SV = (n: string) => String((1n << 56n) + BigInt(n))

function candidate(id: string): Candidate {
  return {
    candidateId: id,
    rank: 1,
    geoRank: 1,
    volumeUm3: 1,
    l2Chunks: 2,
    minDistUm: 0.1,
    contactNm: [1, 2, 3],
    pCand: 0.5,
    conf: 0.5,
    shown: true,
  }
}

/** Piece `n` (7, 8, 9): neuron supervoxel `n1`, its own `n2`, at tip `n`. */
function merge(root: string): PlannedMerge {
  const used = { endUid: Number(root), candidate: candidate(root) }
  return {
    candidateRoot: root,
    rows: [used],
    used,
    neuron: { supervoxel: SV(`${root}1`), positionNm: [1, 2, 3] },
    candidate: { supervoxel: SV(`${root}2`), positionNm: [4, 5, 6] },
    joinsNeuron: false,
  }
}

const PLAN: ReadyPlan = {
  ok: true,
  datastack: 'test',
  graphene: GRAPHENE,
  reviewedRoot: NEURON,
  currentRoot: NEURON,
  layout: LAYOUT,
  merges: ['7', '8', '9'].map(merge),
  rejected: [],
}

/** Supervoxel → root, as the server has it. Each piece's supervoxels start in their own roots. */
function segmentation() {
  const rootOf = new Map<string, string>()
  for (const root of ['7', '8', '9']) {
    rootOf.set(SV(`${root}1`), NEURON)
    rootOf.set(SV(`${root}2`), root)
  }
  let minted = 200
  const sent: ConfirmedMerge[] = []
  const reads: string[][] = []
  /** Join the two supervoxels' roots under a new one, as the server does. */
  const join = (merge: ConfirmedMerge): string => {
    const a = rootOf.get(merge.neuron.supervoxel)
    const b = rootOf.get(merge.candidate.supervoxel)
    const joined = String(++minted)
    for (const [sv, root] of rootOf) if (root === a || root === b) rootOf.set(sv, joined)
    return joined
  }
  const services: BatchServices = {
    roots: async (_, supervoxels) => {
      reads.push([...supervoxels])
      return supervoxels.map((sv) => rootOf.get(sv) ?? '0')
    },
    send: async (merge) => {
      sent.push(merge)
      const joined = join(merge)
      return { kind: 'done', operationId: `op${minted}`, newRootIds: [joined] }
    },
  }
  return { rootOf, sent, reads, services, join }
}

/** Run a batch, keeping what it said. */
async function run(
  services: BatchServices,
  merges: readonly PlannedMerge[] = PLAN.merges,
  stopAfter = Infinity,
) {
  const record: MergeRecordEntry[] = []
  const progress = new Map<string, MergeProgress>()
  const stillOut: Promise<MergeRecordEntry | undefined>[] = []
  let asked = 0
  const result = await prepareMerges(PLAN, merges, AS, services).run({
    progress: (id, p) => progress.set(id, p),
    record: (entry) => record.push(entry),
    stopRequested: () => asked++ >= stopAfter,
    stillOut: (answer) => stillOut.push(answer),
  })
  const outcomes = record.map((e) => [e.candidateRoot, e.outcome])
  const states = [...progress].map(([id, p]) => [id, p.state])
  return { result, record, outcomes, states, stillOut }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetCredentials()
})

describe('runMerges', () => {
  it('merges in order, each checked against the root the last one made', async () => {
    const world = segmentation()
    const { result, record, outcomes } = await run(world.services)
    expect(result).toEqual({ state: 'done', currentRoot: '203' })
    expect(outcomes).toEqual([
      ['7', 'merged'],
      ['8', 'merged'],
      ['9', 'merged'],
    ])
    // Each merge was made into the root the one before made, and says which.
    expect(record.map((e) => e.neuronRoot)).toEqual([NEURON, '201', '202'])
    expect(record.map((e) => (e.outcome === 'merged' ? e.newRoot : ''))).toEqual([
      '201',
      '202',
      '203',
    ])
    expect(record[0]).toMatchObject({
      deployment: AS.deployment,
      datastack: 'test',
      reviewedRoot: NEURON,
      endUid: 7,
      operationId: 'op201',
      neuron: { supervoxel: SV('71') },
      candidate: { supervoxel: SV('72') },
    })
    // A check before and after each merge, both ends each time.
    expect(world.reads).toEqual([
      [SV('71'), SV('72')],
      [SV('71'), SV('72')],
      [SV('81'), SV('82')],
      [SV('81'), SV('82')],
      [SV('91'), SV('92')],
      [SV('91'), SV('92')],
    ])
    // What was sent is the confirmation, frozen: the caller's objects cannot change it.
    expect(world.sent.map((m) => m.candidate.supervoxel)).toEqual([
      SV('72'),
      SV('82'),
      SV('92'),
    ])
    expect(world.sent.every((m) => Object.isFrozen(m) && Object.isFrozen(m.neuron))).toBe(true)
  })

  it('sends only the merges handed to it', async () => {
    const world = segmentation()
    const { outcomes } = await run(world.services, [PLAN.merges[2]!])
    expect(outcomes).toEqual([['9', 'merged']])
    expect(world.sent).toHaveLength(1)
  })

  it('records a piece already in the neuron, sends nothing for it, and goes on', async () => {
    const world = segmentation()
    // Piece 7 is under the neuron's root before the batch starts.
    world.rootOf.set(SV('72'), NEURON)
    const { result, outcomes } = await run(world.services)
    expect(outcomes).toEqual([
      ['7', 'already-merged'],
      ['8', 'merged'],
      ['9', 'merged'],
    ])
    expect(result).toEqual({ state: 'done', currentRoot: '202' })
    expect(world.sent.map((m) => m.candidate.supervoxel)).toEqual([SV('82'), SV('92')])

    const again = segmentation()
    again.services.send = async (m) => {
      again.sent.push(m)
      const joined = again.join(m)
      // The first merge also brings piece 8 in, as a merge that bridges two pieces can.
      if (m.candidate.supervoxel === SV('72')) again.rootOf.set(SV('82'), joined)
      return { kind: 'done', operationId: 'op', newRootIds: [joined] }
    }
    const second = await run(again.services)
    expect(second.outcomes).toEqual([
      ['7', 'merged'],
      ['8', 'already-merged'],
      ['9', 'merged'],
    ])
    expect(again.sent.map((m) => m.candidate.supervoxel)).toEqual([SV('72'), SV('92')])
  })

  it('does not send a piece edited since the plan, and goes on with the rest', async () => {
    const world = segmentation()
    world.rootOf.set(SV('82'), '88')
    const { result, outcomes, record } = await run(world.services)
    expect(outcomes).toEqual([
      ['7', 'merged'],
      ['8', 'not-sent'],
      ['9', 'merged'],
    ])
    expect(record[1]!.message).toContain('88')
    expect(result.state).toBe('done')
    expect(world.sent).toHaveLength(2)
  })

  /** A graph flagged read-only answers success and keeps nothing; so can a race. */
  it('records a merge the roots do not show as made, and stops', async () => {
    const world = segmentation()
    world.services.send = async (m) => {
      world.sent.push(m)
      const joined = world.join(m)
      // Somebody else's merge lands right after ours: the pieces are not under the root we made.
      for (const [sv, root] of world.rootOf) if (root === joined) world.rootOf.set(sv, '999')
      return { kind: 'done', operationId: 'op', newRootIds: [joined] }
    }
    const { result, record, states } = await run(world.services)
    expect(record).toEqual([
      expect.objectContaining({ outcome: 'merged', newRoot: '201', neuronRoot: NEURON }),
    ])
    expect(record[0]!.message).toContain('under 999 and 999')
    // The record says merged, so the neuron's root is the one the server named.
    expect(result).toMatchObject({ state: 'failed', currentRoot: '201' })
    expect(states).toEqual([
      ['7', 'merged'],
      ['8', 'not-sent'],
      ['9', 'not-sent'],
    ])
    expect(world.sent).toHaveLength(1)
  })

  /**
   * A read-only graph answers success and keeps nothing, so both ends read fine and unmoved: the
   * server's word is not taken (audit of 77c0625, 2026-11-16), and the next plan settles it.
   */
  it('records a merge whose ends did not move as unknown, operation id in the message', async () => {
    const world = segmentation()
    world.services.send = async (m) => {
      world.sent.push(m)
      return { kind: 'done', operationId: '4217', newRootIds: ['201'] }
    }
    const { result, record } = await run(world.services)
    expect(record.map((e) => e.outcome)).toEqual(['unknown'])
    expect(record[0]).toMatchObject({ operationId: '4217' })
    expect(record[0]!.message).toContain('operation 4217')
    expect(result).toMatchObject({ state: 'failed', currentRoot: NEURON })
  })

  it('stops when somebody else has edited the neuron, sending nothing more', async () => {
    const world = segmentation()
    for (const sv of [SV('81'), SV('91')]) world.rootOf.set(sv, '555')
    const { result, outcomes, record } = await run(world.services)
    expect(outcomes).toEqual([
      ['7', 'merged'],
      ['8', 'not-sent'],
    ])
    expect(record[1]).toMatchObject({ neuronRoot: '201' })
    expect(record[1]!.message).toContain('somebody else edited it')
    expect(result).toMatchObject({ state: 'failed', currentRoot: '201' })
    expect(world.sent).toHaveLength(1)
  })

  it('stops at a refusal, recorded with the server’s status', async () => {
    const world = segmentation()
    world.services.send = async (m) => {
      world.sent.push(m)
      return {
        kind: 'refused',
        status: 400,
        message: 'Supervoxels must belong to different objects.',
      }
    }
    const { result, record, states } = await run(world.services)
    expect(record).toHaveLength(1)
    expect(record[0]).toMatchObject({ outcome: 'failed', status: 400 })
    expect(result).toMatchObject({ state: 'failed', currentRoot: NEURON })
    expect(result.message).toContain('Supervoxels must belong to different objects.')
    expect(states.slice(1)).toEqual([
      ['8', 'not-sent'],
      ['9', 'not-sent'],
    ])
    expect(world.sent).toHaveLength(1)
  })

  describe('a lost reply', () => {
    const lost = (world: ReturnType<typeof segmentation>, merged: boolean) => {
      world.services.send = async (m): Promise<EditOutcome> => {
        world.sent.push(m)
        if (merged) world.join(m)
        return { kind: 'unknown', message: '502 Bad Gateway' }
      }
    }

    /**
     * Both ends under one new root may be somebody else's edit landing in the same seconds: only
     * the plan's `settle`, which asks what they were under just before, tells the two apart
     * (audit of 77c0625, 2026-11-16). So the batch adopts nothing, and stops.
     */
    it('is unknown even where the roots show a merge, and stops the batch', async () => {
      const world = segmentation()
      lost(world, true)
      const { result, record, stillOut } = await run(world.services)
      expect(record.map((e) => e.outcome)).toEqual(['unknown'])
      expect(record[0]!.message).toContain('The next Submit checks')
      expect(result).toMatchObject({ state: 'failed', currentRoot: NEURON })
      expect(world.sent).toHaveLength(1)
      // Answered, if not usefully: nothing is still out.
      expect(stillOut).toEqual([])
    })

    /** A reply lost to a proxy's timeout can come back while the server is still writing. */
    it('is unknown where the roots have not moved: the merge can still land', async () => {
      const world = segmentation()
      lost(world, false)
      const { result, record } = await run(world.services)
      expect(record.map((e) => e.outcome)).toEqual(['unknown'])
      expect(record[0]!.message).toContain('had not moved')
      expect(result).toMatchObject({ state: 'failed', currentRoot: NEURON })
    })

    it('is unknown, never a merge into no object, where both ends read as root 0', async () => {
      const world = segmentation()
      lost(world, false)
      const read = world.services.roots
      let reads = 0
      world.services.roots = (g, s) =>
        ++reads === 2 ? Promise.resolve(['0', '0']) : read(g, s)
      const { result, record } = await run(world.services)
      expect(record.map((e) => e.outcome)).toEqual(['unknown'])
      expect(result.currentRoot).toBe(NEURON)
    })

    it('is unknown where the roots cannot be read', async () => {
      const world = segmentation()
      lost(world, true)
      const read = world.services.roots
      let reads = 0
      world.services.roots = (g, s) =>
        ++reads === 2 ? Promise.reject(new Error('timed out')) : read(g, s)
      const { result, record } = await run(world.services)
      expect(record.map((e) => e.outcome)).toEqual(['unknown'])
      expect(record[0]!.message).toContain('timed out')
      expect(result.state).toBe('failed')
    })

    /** A merge nobody answers: the batch stops waiting, never sends it again, and asks the roots. */
    it('is what no answer becomes, after the send time limit', async () => {
      const world = segmentation()
      world.services.send = (m) => {
        world.sent.push(m)
        return new Promise(() => {})
      }
      world.services.sendTimeoutMs = 5
      const { result, record, stillOut } = await run(world.services)
      expect(record.map((e) => e.outcome)).toEqual(['unknown'])
      expect(record[0]!.message).toContain('no answer')
      expect(result.state).toBe('failed')
      expect(world.sent).toHaveLength(1)
      // Handed on still out, after its `unknown` was recorded.
      expect(stillOut).toHaveLength(1)
    })

    /** Handed on before anything can throw, so Submit is held even where the batch then fails. */
    it('hands a merge still out on before recording, which may throw', async () => {
      const world = segmentation()
      world.services.send = () => new Promise(() => {})
      world.services.sendTimeoutMs = 5
      const handed: unknown[] = []
      const batch = prepareMerges(PLAN, PLAN.merges, AS, world.services)
      await expect(
        batch.run({
          progress: () => {},
          record: () => {
            throw new Error('The card is no longer on screen, so this could not be recorded.')
          },
          stopRequested: () => false,
          stillOut: (answer) => handed.push(answer),
        }),
      ).rejects.toThrow(/no longer on screen/)
      expect(handed).toHaveLength(1)
    })

    /** The answer that comes after all: what the caller records, operation id and all. */
    it.each<[string, EditOutcome, Partial<MergeRecordEntry> | undefined]>([
      [
        'a merge',
        { kind: 'done', operationId: '4217', newRootIds: ['201'] },
        { outcome: 'merged', newRoot: '201', operationId: '4217', neuronRoot: NEURON },
      ],
      [
        'a refusal',
        { kind: 'refused', status: 400, message: 'no' },
        { outcome: 'failed', status: 400 },
      ],
      ['nothing either way', { kind: 'unknown', message: '502' }, undefined],
    ])('hands on the late answer as %s', async (_, answer, entry) => {
      const world = segmentation()
      let answerNow: (outcome: EditOutcome) => void = () => {}
      world.services.send = (m) => {
        world.sent.push(m)
        return new Promise((resolve) => (answerNow = resolve))
      }
      world.services.sendTimeoutMs = 5
      const { stillOut } = await run(world.services)
      answerNow(answer)
      const late = await stillOut[0]
      if (entry === undefined) expect(late).toBeUndefined()
      else {
        expect(late).toMatchObject({ ...entry, candidateRoot: '7', datastack: 'test' })
        expect(late!.message).toContain('after the batch had stopped waiting')
      }
    })

    it('is what a throwing writer is read as, never “not sent”', async () => {
      const world = segmentation()
      world.services.send = async () => {
        throw new Error('boom')
      }
      const { record } = await run(world.services)
      expect(record.map((e) => e.outcome)).toEqual(['unknown'])
      expect(record[0]!.message).toContain('boom')
    })
  })

  it('stops where a check cannot be read, recording nothing and sending nothing', async () => {
    const world = segmentation()
    world.services.roots = () => Promise.reject(new Error('503'))
    const { result, record, states } = await run(world.services)
    expect(record).toEqual([])
    expect(world.sent).toEqual([])
    expect(result).toMatchObject({ state: 'failed', currentRoot: NEURON })
    expect(states.every(([, state]) => state === 'not-sent')).toBe(true)
  })

  it('takes a short root answer as no answer', async () => {
    const world = segmentation()
    world.services.roots = async () => [NEURON]
    const { result } = await run(world.services)
    expect(result.message).toContain('answered 1 of 2')
    expect(world.sent).toEqual([])
  })

  /** What is checked, sent and recorded is taken at Merge, never read from the caller's objects. */
  it('reads what it was prepared with, not the plan’s objects as they are now', async () => {
    const world = segmentation()
    const merges = [{ ...merge('7') }]
    const plan = { ...PLAN, merges }
    const batch = prepareMerges(plan, merges, AS, world.services)
    const held = merges[0] as { neuron: unknown; candidateRoot: string; used: unknown }
    held.neuron = { supervoxel: SV('81'), positionNm: [9, 9, 9] }
    held.candidateRoot = '8'
    held.used = { endUid: 99, candidate: candidate('8') }
    ;(plan as { reviewedRoot: string }).reviewedRoot = '555'
    const record: MergeRecordEntry[] = []
    await batch.run({
      progress: () => {},
      record: (entry) => record.push(entry),
      stopRequested: () => false,
      stillOut: () => {},
    })
    expect(world.reads[0]).toEqual([SV('71'), SV('72')])
    expect(world.sent[0]!.neuron.supervoxel).toBe(SV('71'))
    expect(record[0]).toMatchObject({
      reviewedRoot: NEURON,
      candidateRoot: '7',
      endUid: 7,
      outcome: 'merged',
      neuron: { supervoxel: SV('71') },
    })
  })

  it('stops before the next merge when asked, and says so', async () => {
    const world = segmentation()
    const { result, outcomes, states } = await run(world.services, PLAN.merges, 1)
    expect(outcomes).toEqual([['7', 'merged']])
    expect(result).toMatchObject({ state: 'stopped', currentRoot: '201' })
    expect(states.slice(1)).toEqual([
      ['8', 'not-sent'],
      ['9', 'not-sent'],
    ])
  })
})

describe('prepareMerges', () => {
  /** A merge `confirmMerge` refuses: supervoxel 0 is no object. */
  const bad: PlannedMerge = {
    ...merge('7'),
    candidate: { supervoxel: '0', positionNm: [1, 2, 3] },
  }
  /**
   * A root id as an end (audit of 77c0625): the server maps it to itself, retired or not, so the
   * per-merge check would pass it. Layer 2 here; a root is the top layer, refused the same way.
   */
  const notSupervoxel: PlannedMerge = {
    ...merge('8'),
    candidate: { supervoxel: String((2n << 56n) + 82n), positionNm: [1, 2, 3] },
  }
  it.each<[string, ReadyPlan, PlannedMerge[]]>([
    ['a merge this plan did not make', PLAN, [merge('7')]],
    ['one listed twice', PLAN, [PLAN.merges[0]!, PLAN.merges[0]!]],
    [
      'one confirmMerge refuses',
      { ...PLAN, merges: [PLAN.merges[0]!, bad] },
      [PLAN.merges[0]!, bad],
    ],
    [
      'an end that is not a supervoxel',
      { ...PLAN, merges: [PLAN.merges[0]!, notSupervoxel] },
      [PLAN.merges[0]!, notSupervoxel],
    ],
    ['merges from a plan with no id layout', { ...PLAN, layout: undefined }, [PLAN.merges[0]!]],
  ])('refuses %s before anything is sent', (_, plan, merges) => {
    const world = segmentation()
    expect(() => prepareMerges(plan, merges, AS, world.services)).toThrow()
    expect(world.sent).toEqual([])
    expect(world.reads).toEqual([])
  })

  it('runs once', async () => {
    const world = segmentation()
    const batch = prepareMerges(PLAN, PLAN.merges, AS, world.services)
    const on = {
      progress: () => {},
      record: () => {},
      stopRequested: () => false,
      stillOut: () => {},
    }
    await batch.run(on)
    await expect(batch.run(on)).rejects.toThrow('runs once')
    expect(world.sent).toHaveLength(3)
  })
})

/**
 * The live services over a stubbed `fetch`: the checks ask `roots_binary` at the server's now (no
 * timestamp), and the merge goes as the writer sends it, with the token.
 */
describe('the live requests', () => {
  it('reads at the server’s now and writes once, with the reader’s token', async () => {
    const asked: string[] = []
    let merged = false
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      asked.push(`${init.method ?? 'GET'} ${url}`)
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
      if (url.includes('/merge')) {
        merged = true
        return new Response('{"operation_id":"4217","new_root_ids":["201"]}', { status: 200 })
      }
      const roots = merged ? [201n, 201n] : [100n, 7n]
      return new Response(BigUint64Array.from(roots).buffer, { status: 200 })
    })
    const record: MergeRecordEntry[] = []
    const result = await prepareMerges(PLAN, [PLAN.merges[0]!], AS).run({
      progress: () => {},
      record: (entry) => record.push(entry),
      stopRequested: () => false,
      stillOut: () => {},
    })
    expect(result).toEqual({ state: 'done', currentRoot: '201' })
    expect(record).toEqual([
      expect.objectContaining({ outcome: 'merged', operationId: '4217' }),
    ])
    const table = 'https://cave.example.org/segmentation/api/v1/table/test_table'
    expect(asked).toEqual([
      `POST ${table}/roots_binary`,
      `POST ${table}/merge?int64_as_str=1&priority=True`,
      `POST ${table}/roots_binary`,
    ])
  })
})
