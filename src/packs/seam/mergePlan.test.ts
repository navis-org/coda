/**
 * The pre-flight's logic, with its server calls faked (`PlanServices`): which pieces are planned,
 * which are refused and why, and in what order. The calls themselves are tested where they live
 * (`permissions.test.ts`, `rootIds.test.ts`, `mergeAnchors.test.ts`); which pieces count as
 * accepted is `acceptedPieces`', in `reviewQueue.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import type { GrapheneSource } from '../../data/cave/graphene'
import type { AnchorPair, AnchorRefusal, AnchorVolume } from './mergeAnchors'
import type { PlanRequest, PlanServices } from './mergePlan'
import { planMerges } from './mergePlan'
import type { MergeRecordEntry, RecordOutcome } from './mergeRecord'
import type { Candidate, QueueTip, Verdict } from './reviewQueue'
import { verdictKey } from './reviewQueue'

const GRAPHENE: GrapheneSource = {
  server: 'https://cave.example.org',
  table: 'test_table',
  base: 'https://cave.example.org/segmentation/table/test_table',
}
const OPTIONS = { deployment: 'https://global.example.org' }
const NEURON = '100'

/** A candidate whose contact's x is its rank, so a fake can tell its rows apart. */
function candidate(id: string, rank: number, minDistUm?: number): Candidate {
  return {
    candidateId: id,
    rank,
    geoRank: undefined,
    volumeUm3: undefined,
    l2Chunks: undefined,
    minDistUm,
    contactNm: [rank, rank, rank],
    pCand: undefined,
    conf: undefined,
    shown: true,
  }
}

function tip(endUid: number, candidates: Candidate[], neuronId = NEURON): QueueTip {
  return {
    endUid,
    neuronId,
    kind: 'tip',
    tipNm: [0, 0, 0],
    r: undefined,
    q: undefined,
    pTip: undefined,
    shown: true,
    candidates,
  }
}

/** Servers that answer as told: every root current but `stale`; an anchor `refuse` refuses. */
function services(
  over: {
    stale?: string[]
    mayEdit?: boolean
    termsPending?: boolean
    chunkedgraph?: boolean
    refuse?: (pair: AnchorPair) => AnchorRefusal | undefined
    /** Supervoxel → root at the server's now; an unlisted one is under root 0. */
    rootOf?: Record<string, string>
    /** Supervoxel → root at any earlier moment (every root here was made at 1000 ms). */
    rootBefore?: Record<string, string>
  } = {},
) {
  const asked = {
    latest: [] as string[][],
    anchored: [] as AnchorPair[],
    opened: 0,
    roots: [] as string[][],
  }
  const fake: PlanServices = {
    chunkedgraph: async () => (over.chunkedgraph === false ? undefined : GRAPHENE),
    permission: async () => ({
      dataset: 'test_dataset',
      mayEdit: over.mayEdit ?? true,
      termsPending: over.termsPending ?? false,
    }),
    latest: async (_, roots) => {
      asked.latest.push([...roots])
      return roots.map((root) => !(over.stale ?? []).includes(root))
    },
    roots: async (_, supervoxels, at) => {
      asked.roots.push([...supervoxels, String(at)])
      const table = at === 'server' ? over.rootOf : over.rootBefore
      return supervoxels.map((sv) => table?.[sv] ?? '0')
    },
    created: async (_, roots) => roots.map(() => 1000),
    openVolume: async () => {
      asked.opened++
      return { graphene: GRAPHENE } as AnchorVolume
    },
    anchor: async (_, pair) => {
      asked.anchored.push(pair)
      const reason = over.refuse?.(pair)
      if (reason) return { ok: false, reason, message: reason }
      return {
        ok: true,
        neuron: { supervoxel: `${pair.neuronRoot}1`, positionNm: [0, 0, 0] },
        candidate: { supervoxel: `${pair.candidateRoot}1`, positionNm: pair.contactNm! },
        chunks: 0,
      }
    },
  }
  return { asked, fake }
}

/** A record entry with everything the plan does not read filled in. */
function entry(
  reviewedRoot: string,
  candidateRoot: string,
  outcome: RecordOutcome,
  newRoot = '',
): MergeRecordEntry {
  const base = {
    reviewedRoot,
    candidateRoot,
    endUid: 1,
    neuronRoot: reviewedRoot,
    neuron: { supervoxel: '11', positionNm: [0, 0, 0] as const },
    candidate: { supervoxel: '12', positionNm: [0, 0, 0] as const },
    at: '2026-11-16T00:00:00.000Z',
  }
  return outcome === 'merged' ? { ...base, outcome, newRoot } : { ...base, outcome }
}

/** A merge this workflow made, as the record holds it. */
const made = (reviewedRoot: string, candidateRoot: string, newRoot: string) =>
  entry(reviewedRoot, candidateRoot, 'merged', newRoot)

const request = (
  queue: QueueTip[],
  judged: [number, string, Verdict][],
  record: MergeRecordEntry[] = [],
): PlanRequest => ({
  datastack: 'test',
  queue,
  reviewedRoot: NEURON,
  verdicts: new Map(judged.map(([endUid, id, v]) => [verdictKey(endUid, id), v])),
  record,
})

/** A plan that must have been made, unwrapped. */
async function planned(req: PlanRequest, fake: PlanServices) {
  const plan = await planMerges(req, OPTIONS, fake)
  if (!plan.ok) throw new Error(plan.message)
  return plan
}

const refusals = (plan: Awaited<ReturnType<typeof planned>>) =>
  plan.rejected.map((r) => [r.candidateRoot, r.reason])

describe('planMerges', () => {
  const queue = [
    tip(1, [candidate('7', 1, 0.1), candidate('8', 2, 0.2)]),
    tip(2, [candidate('9', 1, 0.3)]),
  ]
  const all: [number, string, Verdict][] = [
    [1, '7', 'accept'],
    [1, '8', 'accept'],
    [2, '9', 'accept'],
  ]

  it('plans every current, anchored piece in the order the reader met them', async () => {
    const plan = await planned(request(queue, all), services().fake)
    expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['7', '8', '9'])
    expect(plan.rejected).toEqual([])
    expect(plan.currentRoot).toBe(NEURON)
  })

  it('refuses every piece when the neuron is not current, and opens no volume', async () => {
    const { fake, asked } = services({ stale: [NEURON] })
    const plan = await planned(request(queue, all), fake)
    expect(plan.merges).toEqual([])
    expect(refusals(plan)).toEqual([
      ['7', 'neuron-outdated'],
      ['8', 'neuron-outdated'],
      ['9', 'neuron-outdated'],
    ])
    expect(asked.opened).toBe(0)
  })

  it('refuses an outdated piece on its own, in queue order with the rest', async () => {
    const { fake } = services({
      stale: ['8'],
      refuse: (p) => (p.candidateRoot === '9' ? 'too-far' : undefined),
    })
    const plan = await planned(request(queue, all), fake)
    expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['7'])
    expect(refusals(plan)).toEqual([
      ['8', 'outdated'],
      ['9', 'too-far'],
    ])
  })

  it('opens no volume when no piece is current', async () => {
    const { fake, asked } = services({ stale: ['7', '8', '9'] })
    const plan = await planned(request(queue, all), fake)
    expect(refusals(plan).map(([, reason]) => reason)).toEqual([
      'outdated',
      'outdated',
      'outdated',
    ])
    expect(asked.opened).toBe(0)
  })

  /*
   * The record is what says what the neuron is now: after this workflow's merges, its reviewed
   * root is no longer current and must not be asked about — the last merge's root is.
   */
  it('takes the neuron’s root from the record, and skips what it has merged', async () => {
    const { fake, asked } = services({ stale: [NEURON] })
    const record = [made(NEURON, '7', '101')]
    const plan = await planned(request(queue, all, record), fake)
    expect(plan.currentRoot).toBe('101')
    expect(asked.latest).toEqual([['101', '8', '9']])
    expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['8', '9'])
    expect(plan.merges.every((m) => m.neuron.supervoxel === '1011')).toBe(true)
    expect(refusals(plan)).toEqual([['7', 'already-merged']])
  })

  /*
   * Only `merged` moves the root, and only `merged` and `already-merged` put a piece in the
   * neuron. A merge that failed, was never sent or whose reply was lost is planned again — and
   * after a lost reply that did merge, the recorded root is outdated, which refuses the neuron.
   */
  it('counts only the pieces the record says are in the neuron', async () => {
    const record = [
      entry(NEURON, '7', 'already-merged'),
      entry(NEURON, '8', 'failed'),
      entry(NEURON, '9', 'unknown'),
      entry(NEURON, '9', 'not-sent'),
    ]
    const plan = await planned(request(queue, all, record), services().fake)
    expect(plan.currentRoot).toBe(NEURON)
    expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['8', '9'])
    expect(refusals(plan)).toEqual([['7', 'already-merged']])
  })

  /*
   * A lost reply that nothing settled. If the merge was made, the neuron is at a root the record
   * does not name, and the currency check would refuse it on every Submit from then on.
   */
  describe('a lost reply', () => {
    // `entry` puts the neuron's side on supervoxel 11 and the piece's on 12.
    const record = [entry(NEURON, '7', 'unknown')]
    /** Our merge, landed: both ends under 150, which was made from the neuron and piece 7. */
    const landed = {
      rootOf: { '11': '150', '12': '150' },
      rootBefore: { '11': NEURON, '12': '7' },
    }

    it('is settled as this merge where the roots show it and nothing after it', async () => {
      const { fake, asked } = services({ stale: [NEURON], ...landed })
      const plan = await planned(request(queue, all, record), fake)
      // Now, then just before the shared root was made.
      expect(asked.roots).toEqual([
        ['11', '12', 'server'],
        ['11', '12', '999'],
      ])
      expect(plan.currentRoot).toBe('150')
      expect(plan.settled).toEqual({ entry: record[0], newRoot: '150' })
      expect(asked.latest).toEqual([['150', '8', '9']])
      expect(refusals(plan)).toEqual([['7', 'already-merged']])
    })

    /** Ours landed, then somebody else edited the neuron: their root is not adopted. */
    it('is left, and the neuron refused, where somebody else edited after it', async () => {
      const { fake } = services({
        stale: [NEURON],
        rootOf: { '11': '160', '12': '160' },
        rootBefore: { '11': '150', '12': '150' },
      })
      const plan = await planned(request(queue, all, record), fake)
      expect(plan.settled).toBeUndefined()
      expect(plan.currentRoot).toBe(NEURON)
      expect(refusals(plan).map(([, reason]) => reason)).toEqual([
        'neuron-outdated',
        'neuron-outdated',
        'neuron-outdated',
      ])
    })

    it.each([
      ['roots that have not moved', { '11': NEURON, '12': '7' }],
      ['two different roots', { '11': '150', '12': '151' }],
      ['root 0 on both sides', {}],
    ])('is left unsettled by %s', async (_, rootOf) => {
      const { fake } = services({ rootOf })
      const plan = await planned(request(queue, all, record), fake)
      expect(plan.currentRoot).toBe(NEURON)
      expect(plan.settled).toBeUndefined()
      expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['7', '8', '9'])
    })

    /*
     * The lost merge can land after a later batch's check: that batch then stopped on "somebody
     * else edited it", and the lost reply is no longer the neuron's last entry.
     */
    it('is settled though later entries follow it, until a merge does', async () => {
      const later = [...record, entry(NEURON, '8', 'not-sent')]
      const { fake } = services({ stale: [NEURON], ...landed })
      expect((await planned(request(queue, all, later), fake)).currentRoot).toBe('150')

      const merged = [...later, entry(NEURON, '9', 'merged', '170')]
      const second = services({ ...landed })
      expect((await planned(request(queue, all, merged), second.fake)).currentRoot).toBe('170')
      expect(second.asked.roots).toEqual([])
    })
  })

  it('reads only its own neuron’s record', async () => {
    // A piece this neuron did not accept: another neuron's record must not move this one's root.
    const record = [made('200', '77', '201')]
    const plan = await planned(request(queue, all, record), services().fake)
    expect(plan.currentRoot).toBe(NEURON)
    expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['7', '8', '9'])
  })

  it('asks nothing about currency when every accepted piece is already merged', async () => {
    const { fake, asked } = services()
    const record = ['7', '8', '9'].map((candidateRoot, i) =>
      made(NEURON, candidateRoot, `10${i + 1}`),
    )
    const plan = await planned(request(queue, all, record), fake)
    expect(plan.merges).toEqual([])
    expect(asked.latest).toEqual([])
    expect(plan.currentRoot).toBe('103')
  })

  it('tries a piece’s other rows when the nearest will not anchor', async () => {
    const twice = [tip(1, [candidate('7', 1, 0.1)]), tip(2, [candidate('7', 2, 0.5)])]
    const { fake, asked } = services({
      refuse: (p) => (p.contactNm![0] === 1 ? 'candidate-absent' : undefined),
    })
    const plan = await planned(
      request(twice, [
        [1, '7', 'accept'],
        [2, '7', 'accept'],
      ]),
      fake,
    )
    expect(asked.anchored.map((p) => p.contactNm![0])).toEqual([1, 2])
    expect(plan.merges).toHaveLength(1)
    expect(plan.merges[0]!.used.endUid).toBe(2)
  })

  it('refuses a piece no row anchors, with the nearest row’s reason', async () => {
    const { fake } = services({
      refuse: (p) => (p.candidateRoot === '8' ? 'too-far' : undefined),
    })
    expect(refusals(await planned(request(queue, all), fake))).toEqual([['8', 'too-far']])
  })

  it('plans nothing without permission, or without a chunkedgraph, and says why', async () => {
    const refused = await planMerges(
      request(queue, all),
      OPTIONS,
      services({ mayEdit: false }).fake,
    )
    expect(refused).toEqual({
      ok: false,
      message: 'Your CAVE account may not edit test_dataset.',
    })
    const terms = await planMerges(
      request(queue, all),
      OPTIONS,
      services({ mayEdit: false, termsPending: true }).fake,
    )
    expect(terms.ok === false && terms.message).toMatch(/accepted its terms of service/)
    const none = await planMerges(
      request(queue, all),
      OPTIONS,
      services({ chunkedgraph: false }).fake,
    )
    expect(none.ok === false && none.message).toMatch(/has no chunkedgraph/)
  })

  it('turns a failed check into a plan that says so, and lets a cancel through', async () => {
    const { fake } = services()
    const failing = { ...fake, latest: () => Promise.reject(new Error('503 from CAVE')) }
    expect(await planMerges(request(queue, all), OPTIONS, failing)).toEqual({
      ok: false,
      message: 'The check before merging could not finish: 503 from CAVE',
    })
    const cancelled = {
      ...fake,
      latest: () => Promise.reject(new DOMException('stopped', 'AbortError')),
    }
    await expect(planMerges(request(queue, all), OPTIONS, cancelled)).rejects.toThrow('stopped')
  })

  /** Every root the neuron has had is the neuron, not a piece of it, whatever the queue says. */
  it('refuses the neuron itself, by its reviewed root or a root this workflow gave it', async () => {
    const selfish = [
      tip(1, [candidate(NEURON, 1, 0.1), candidate('101', 2, 0.2)]),
      tip(2, [candidate('9', 1)]),
    ]
    const { fake, asked } = services({ stale: ['101'] })
    const record = [made(NEURON, '7', '101'), made(NEURON, '8', '102')]
    const plan = await planned(
      request(
        selfish,
        [
          [1, NEURON, 'accept'],
          [1, '101', 'accept'],
          [2, '9', 'accept'],
        ],
        record,
      ),
      fake,
    )
    expect(refusals(plan)).toEqual([
      [NEURON, 'already-merged'],
      ['101', 'already-merged'],
    ])
    expect(asked.latest).toEqual([['102', '9']])
    expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['9'])
  })

  /** Joining two reviewed neurons is planned, and flagged for the dialog (user, 2026-11-16). */
  it('plans a piece that is another neuron under review, or what it became, flagged', async () => {
    const two = [
      tip(1, [candidate('200', 1, 0.1), candidate('201', 2, 0.2), candidate('9', 3, 0.3)]),
      tip(5, [candidate('7', 1)], '200'),
    ]
    const record = [made('200', '7', '201')]
    const plan = await planned(
      request(
        two,
        [
          [1, '200', 'accept'],
          [1, '201', 'accept'],
          [1, '9', 'accept'],
        ],
        record,
      ),
      services().fake,
    )
    expect(plan.rejected).toEqual([])
    expect(plan.merges.map((m) => [m.candidateRoot, m.joinsNeuron])).toEqual([
      ['200', true],
      ['201', true],
      ['9', false],
    ])
  })

  it('lists refusals in the order the reader met the pieces, whichever step refused them', async () => {
    const { fake } = services({
      stale: ['7'],
      refuse: (p) => (p.candidateRoot === '9' ? 'too-far' : undefined),
    })
    const record = [made(NEURON, '8', '101')]
    const plan = await planned(request(queue, all, record), fake)
    expect(refusals(plan)).toEqual([
      ['7', 'outdated'],
      ['8', 'already-merged'],
      ['9', 'too-far'],
    ])
  })

  /** A reader who may not edit is often refused the currency read too, with a token alarm. */
  it('asks permission before currency, and nothing else once it is refused', async () => {
    const { fake, asked } = services({ mayEdit: false })
    await planMerges(request(queue, all), OPTIONS, fake)
    expect(asked.latest).toEqual([])
    expect(asked.opened).toBe(0)
  })

  it('plans nothing on a currency answer that does not cover every root', async () => {
    const { fake, asked } = services()
    const short = { ...fake, latest: async () => [true, true] }
    const plan = await planMerges(request(queue, all), OPTIONS, short)
    expect(plan).toEqual({
      ok: false,
      message:
        'The check before merging could not finish: The currency check answered 2 of 4 roots, so which are current is unknown.',
    })
    expect(asked.anchored).toEqual([])
  })

  /** With nothing left to send, every reason is known without a server — even a failing one. */
  it('answers with the reasons alone when nothing is left to send', async () => {
    const { fake } = services()
    const down = { ...fake, permission: () => Promise.reject(new Error('auth down')) }
    const record = ['7', '8', '9'].map((candidateRoot, i) =>
      made(NEURON, candidateRoot, `10${i + 1}`),
    )
    const plan = await planned(request(queue, all, record), down)
    expect(refusals(plan).map(([, reason]) => reason)).toEqual([
      'already-merged',
      'already-merged',
      'already-merged',
    ])
  })

  it('names a piece this workflow merged into another reviewed neuron', async () => {
    const record = [made('200', '8', '201')]
    const two = [...queue, tip(5, [candidate('8', 1)], '200')]
    const plan = await planned(request(two, all, record), services().fake)
    expect(refusals(plan)).toEqual([['8', 'merged-elsewhere']])
    expect(plan.rejected[0]!.message).toMatch(/Merged into another neuron/)
  })
})
