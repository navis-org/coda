/**
 * The pre-flight's logic, with its server calls faked (`PlanServices`): which pieces are planned,
 * which are refused and why, and in what order. The calls themselves are tested where they live
 * (`permissions.test.ts`, `rootIds.test.ts`, `mergeAnchors.test.ts`); which pieces count as
 * accepted is `acceptedPieces`', in `reviewQueue.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import type { GrapheneSource } from '../../data/cave/graphene'
import type { GraphLayout } from '../../data/cave/graphLayout'
import type { AnchorPair, AnchorRefusal, AnchorVolume } from './mergeAnchors'
import type { PlannedMerge, PlanRequest, PlanServices } from './mergePlan'
import { acceptedTree, planMerges, tickedWith, withoutOrphans } from './mergePlan'
import type { MergeRecordEntry, RecordOutcome } from './mergeRecord'
import type { Candidate, QueueTip, Verdict } from './reviewQueue'
import { verdictKey } from './reviewQueue'

const GRAPHENE: GrapheneSource = {
  server: 'https://cave.example.org',
  table: 'test_table',
  base: 'https://cave.example.org/segmentation/table/test_table',
}
const OPTIONS = { deployment: 'https://global.example.org' }
/** What the anchor volume carries; the plan passes it on for the batch's supervoxel check. */
const LAYOUT = { layerBits: 8 } as GraphLayout
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

function tip(
  endUid: number,
  candidates: Candidate[],
  neuronId = NEURON,
  seed = neuronId,
): QueueTip {
  return {
    endUid,
    neuronId,
    seed,
    junction: false,
    search: 'done',
    kind: 'tip',
    tipNm: [0, 0, 0],
    r: undefined,
    q: undefined,
    pTip: undefined,
    shown: true,
    source: undefined,
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
    /** Which root the neuron-side anchor is found on; the neuron's own where this says nothing. */
    onRoot?: (pair: AnchorPair) => string | undefined
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
      return { graphene: GRAPHENE, layout: LAYOUT } as unknown as AnchorVolume
    },
    anchor: async (_, pair) => {
      asked.anchored.push(pair)
      const reason = over.refuse?.(pair)
      if (reason) return { ok: false, reason, message: reason }
      const onRoot = over.onRoot?.(pair) ?? pair.neuronRoot
      return {
        ok: true,
        onRoot,
        neuron: { supervoxel: `${onRoot}1`, positionNm: [0, 0, 0] },
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
    deployment: OPTIONS.deployment,
    datastack: 'test',
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
  judged: [string, Verdict][],
  record: MergeRecordEntry[] = [],
): PlanRequest => ({
  datastack: 'test',
  queue,
  reviewedRoot: NEURON,
  verdicts: new Map(judged.map(([id, v]) => [verdictKey(NEURON, id), v])),
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
  const all: [string, Verdict][] = [
    ['7', 'accept'],
    ['8', 'accept'],
    ['9', 'accept'],
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
        ['7', 'accept'],
        ['7', 'accept'],
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
          [NEURON, 'accept'],
          ['101', 'accept'],
          ['9', 'accept'],
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
          ['200', 'accept'],
          ['201', 'accept'],
          ['9', 'accept'],
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

  /** Before any request: one cell that is no id would fail the currency read for every piece. */
  it('refuses a piece whose id is not one before asking the server about it', async () => {
    const odd = [tip(1, [candidate('abc', 1, 0.1), candidate('7', 2, 0.2)])]
    const { fake, asked } = services()
    const plan = await planned(
      request(odd, [
        ['abc', 'accept'],
        ['7', 'accept'],
      ]),
      fake,
    )
    expect(refusals(plan)).toEqual([['abc', 'bad-id']])
    expect(asked.latest).toEqual([[NEURON, '7']])
  })

  it('carries the id layout with the merges, for the batch to check the ends by', async () => {
    expect((await planned(request(queue, all), services().fake)).layout).toBe(LAYOUT)
  })

  /** The audit of 77c0625: a sandbox merge is no merge on production, whose ids it shares. */
  it('reads only the record entries made on its own chunkedgraph', async () => {
    const sandbox = { ...made(NEURON, '7', '101'), datastack: 'test_sandbox' }
    const plan = await planned(request(queue, all, [sandbox]), services().fake)
    expect(plan.currentRoot).toBe(NEURON)
    expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['7', '8', '9'])
  })

  it('names a piece this workflow merged into another reviewed neuron', async () => {
    const record = [made('200', '8', '201')]
    const two = [...queue, tip(5, [candidate('8', 1)], '200')]
    const plan = await planned(request(two, all, record), services().fake)
    expect(refusals(plan)).toEqual([['8', 'merged-elsewhere']])
    expect(plan.rejected[0]!.message).toMatch(/Merged into another neuron/)
  })
})

/**
 * A neuron grown piece by piece (`docs/seam-extend-plan.md`): a piece accepted on a tip of
 * another accepted piece, none of it merged before Submit. The plan is a tree from the neuron
 * outwards.
 *
 * The fixture: on the neuron (100), pieces 7 and 8; on 7's tip, piece 9; on 9's tip, piece 11.
 * **The queue lists the pieces' tips before the neuron's**, so "as the reader met them" would put
 * a piece ahead of what it is merged onto.
 */
describe('planning a neuron grown piece by piece', () => {
  const queue = [
    tip(1, [candidate('11', 1, 0.1)], '9', NEURON),
    tip(1, [candidate('9', 1, 0.1)], '7', NEURON),
    tip(1, [candidate('7', 1, 0.1), candidate('8', 2, 0.2)]),
  ]
  const verdicts = new Map<string, Verdict>([
    [verdictKey(NEURON, '7'), 'accept'],
    [verdictKey(NEURON, '8'), 'accept'],
    [verdictKey('7', '9'), 'accept'],
    [verdictKey('9', '11'), 'accept'],
  ])
  const grown = (record: MergeRecordEntry[] = []): PlanRequest => ({
    datastack: 'test',
    queue,
    reviewedRoot: NEURON,
    verdicts,
    record,
  })
  /**
   * The anchor lands on the piece the candidate was accepted on, where that is still its own
   * root — one of the roots read as the neuron's side — and on the neuron itself otherwise.
   */
  const ACCEPTED_ON: Record<string, string> = { '9': '7', '11': '9' }
  const onParent = (pair: AnchorPair) => {
    const on = ACCEPTED_ON[pair.candidateRoot]
    return on !== undefined && pair.alsoNeuron?.includes(on) ? on : undefined
  }

  it('merges from the neuron outwards, whatever order the queue lists the tips in', async () => {
    const plan = await planned(grown(), services({ onRoot: onParent }).fake)
    expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['7', '8', '9', '11'])
    expect(plan.rejected).toEqual([])
  })

  it('looks for the neuron end on the pieces between, and says which it landed on', async () => {
    const { fake, asked } = services({ onRoot: onParent })
    const plan = await planned(grown(), fake)
    // The neuron's side: the neuron as it stands, and the pieces on this piece's own way to
    // it, nearest first — never a piece beside it (8 is no part of 9's side).
    expect(asked.anchored.map((p) => [p.candidateRoot, p.neuronRoot, p.alsoNeuron])).toEqual([
      ['7', NEURON, []],
      ['8', NEURON, []],
      ['9', NEURON, ['7']],
      ['11', NEURON, ['9', '7']],
    ])
    expect(plan.merges.map((m) => [m.candidateRoot, m.parent, m.needs])).toEqual([
      ['7', undefined, undefined],
      ['8', undefined, undefined],
      ['9', '7', '7'],
      ['11', '9', '9'],
    ])
    // The neuron end is a supervoxel of the piece it landed on.
    expect(plan.merges[2]!.neuron.supervoxel).toBe('71')
  })

  /** The candidate touches whichever piece is there: not always the one it was accepted on. */
  it('needs the piece the anchor landed on, which need not be its parent', async () => {
    const { fake } = services({
      onRoot: (pair) =>
        pair.candidateRoot === '11' ? '7' : pair.candidateRoot === '9' ? NEURON : undefined,
    })
    const plan = await planned(grown(), fake)
    expect(plan.merges.map((m) => [m.candidateRoot, m.parent, m.needs])).toEqual([
      ['7', undefined, undefined],
      ['8', undefined, undefined],
      // On the neuron itself: nothing has to land first, though the ticks still follow 7.
      ['9', '7', undefined],
      ['11', '9', '7'],
    ])
  })

  /**
   * A merge point on a piece beside it, or on a root nobody named: nothing the reader accepted
   * joins the two, and nothing says that end will be part of the neuron when the merge is sent.
   * That piece is refused — and what hangs on it — and the rest of the plan stands.
   */
  it.each(['8', '555'])(
    'refuses a piece whose merge point is on %s, a root that is not on its way to the neuron',
    async (elsewhere) => {
      const { fake } = services({
        onRoot: (pair) => (pair.candidateRoot === '9' ? elsewhere : onParent(pair)),
      })
      const plan = await planned(grown(), fake)
      expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['7', '8'])
      expect(refusals(plan)).toEqual([
        ['9', 'neuron-absent'],
        ['11', 'parent-refused'],
      ])
      expect(plan.rejected[0]!.message).toMatch(
        new RegExp(`is on ${elsewhere}, which is neither the neuron nor a piece between`),
      )
    },
  )

  it('refuses everything beyond a piece that cannot be merged, and nothing beside it', async () => {
    const { fake, asked } = services({
      onRoot: onParent,
      refuse: (p) => (p.candidateRoot === '7' ? 'too-far' : undefined),
    })
    const plan = await planned(grown(), fake)
    expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['8'])
    expect(refusals(plan)).toEqual([
      ['7', 'too-far'],
      ['9', 'parent-refused'],
      ['11', 'parent-refused'],
    ])
    expect(plan.rejected[1]!.message).toMatch(/^7, which lies between it and the neuron/)
    // No box is read for a piece with nothing to be merged onto.
    expect(asked.anchored.map((p) => p.candidateRoot)).toEqual(['7', '8'])
  })

  it('refuses what hangs on an outdated piece', async () => {
    const plan = await planned(grown(), services({ onRoot: onParent, stale: ['9'] }).fake)
    expect(plan.merges.map((m) => m.candidateRoot)).toEqual(['7', '8'])
    expect(refusals(plan)).toEqual([
      ['9', 'outdated'],
      ['11', 'parent-refused'],
    ])
  })

  /** A piece this workflow merged already is part of the neuron's root: nothing to wait for. */
  it('anchors on the neuron as it stands where the piece before is merged already', async () => {
    const { fake, asked } = services({ onRoot: onParent })
    const plan = await planned(grown([made(NEURON, '7', '201')]), fake)
    expect(plan.currentRoot).toBe('201')
    expect(plan.merges.map((m) => [m.candidateRoot, m.parent, m.needs])).toEqual([
      // 9 hangs on a piece that is in the neuron: one step out, like 8, and met before it.
      ['9', undefined, undefined],
      ['8', undefined, undefined],
      ['11', '9', '9'],
    ])
    expect(asked.anchored.map((p) => [p.candidateRoot, p.neuronRoot, p.alsoNeuron])).toEqual([
      ['9', '201', []],
      ['8', '201', []],
      ['11', '201', ['9']],
    ])
    expect(refusals(plan)).toEqual([['7', 'already-merged']])
  })

  /**
   * 9 is in the neuron already (its merge point was on the neuron), 7 was never merged and is
   * outdated now. 11 hangs on 9: what became of 7, further in, does not hold it up.
   */
  it('stops a piece’s way at the first piece that is in the neuron already', async () => {
    const { fake, asked } = services({ onRoot: onParent, stale: ['7'] })
    const plan = await planned(grown([made(NEURON, '9', '201')]), fake)
    expect(plan.merges.map((m) => [m.candidateRoot, m.parent, m.needs])).toEqual([
      ['11', undefined, undefined],
      ['8', undefined, undefined],
    ])
    expect(asked.anchored.find((p) => p.candidateRoot === '11')!.alsoNeuron).toEqual([])
    expect(refusals(plan)).toEqual([
      ['9', 'already-merged'],
      ['7', 'outdated'],
    ])
  })

  /** A piece's root heads tips in the queue; that does not make it a neuron under review. */
  it('does not take a piece of this neuron for another neuron under review', async () => {
    const plan = await planned(grown(), services({ onRoot: onParent }).fake)
    expect(plan.merges.map((m) => m.joinsNeuron)).toEqual([false, false, false, false])
  })

  describe('the accepted pieces as a tree', () => {
    const row = (neuronId: string, endUid: number, id: string, gap: number) => ({
      neuronId,
      endUid,
      candidate: candidate(id, 1, gap),
    })

    /** A piece merged already is the neuron: what was accepted on it is one step out. */
    it('grows from the pieces that are in the neuron already, as from the neuron', () => {
      const accepted = new Map([
        ['8', [row(NEURON, 1, '8', 0.1)]],
        // On 7, merged in an earlier batch, and on 8, which is still its own root.
        ['12', [row('8', 2, '12', 0.1), row('7', 3, '12', 0.2)]],
      ])
      const { pieces, pathOf } = acceptedTree(accepted, [NEURON, '7'])
      expect(pathOf.get('12')).toEqual([])
      expect(pieces.get('12')!.map((r) => r.neuronId)).toEqual(['7'])
    })

    /** The search's and the card's rule (`piecesOf`): the fewest steps from the neuron. */
    it('puts a piece accepted on the neuron and on a piece of it straight onto the neuron', () => {
      // 9 is listed on piece 7 (nearer, twice) and on the neuron itself.
      const accepted = new Map([
        ['7', [row(NEURON, 1, '7', 0.1)]],
        ['9', [row('7', 3, '9', 0.05), row(NEURON, 2, '9', 0.2), row('7', 4, '9', 0.3)]],
      ])
      const { pieces, pathOf } = acceptedTree(accepted, [NEURON])
      // Only its row on the neuron: it is merged once, onto one thing.
      expect(pieces.get('9')!.map((one) => [one.neuronId, one.endUid])).toEqual([[NEURON, 2]])
      expect(pathOf.get('9')).toEqual([])
      expect(pathOf.get('7')).toEqual([])
    })

    it('puts a piece accepted only on a piece onto that piece, with its rows there', () => {
      const accepted = new Map([
        ['7', [row(NEURON, 1, '7', 0.1)]],
        ['9', [row('7', 3, '9', 0.05), row('7', 4, '9', 0.3)]],
        ['11', [row('9', 1, '11', 0.1)]],
      ])
      const { pieces, pathOf } = acceptedTree(accepted, [NEURON])
      expect(pieces.get('9')!.map((one) => [one.neuronId, one.endUid])).toEqual([
        ['7', 3],
        ['7', 4],
      ])
      expect(pathOf.get('9')).toEqual(['7'])
      // Nearest first.
      expect(pathOf.get('11')).toEqual(['9', '7'])
    })

    /** Two pieces accepted on the neuron and on each other cannot hold each other up. */
    it('is not stopped by two pieces accepted on each other as well as on the neuron', () => {
      const accepted = new Map([
        ['7', [row('8', 5, '7', 0.01), row(NEURON, 1, '7', 0.2)]],
        ['8', [row('7', 6, '8', 0.01), row(NEURON, 2, '8', 0.2)]],
      ])
      const { pathOf } = acceptedTree(accepted, [NEURON])
      expect(pathOf.get('7')).toEqual([])
      expect(pathOf.get('8')).toEqual([])
    })

    it('has no way back for a piece accepted on what is no accepted piece, or in a loop', () => {
      const accepted = new Map([
        ['9', [row('7', 1, '9', 0.1)]],
        ['20', [row('21', 1, '20', 0.1)]],
        ['21', [row('20', 1, '21', 0.1)]],
      ])
      const { pieces, pathOf } = acceptedTree(accepted, [NEURON])
      expect([...pathOf.keys()]).toEqual([])
      expect([...pieces.keys()]).toEqual(['9', '20', '21'])
    })

    it('says so in the plan, and reads no box for it', async () => {
      const stray = [tip(1, [candidate('9', 1, 0.1)], '7', NEURON)]
      const { fake, asked } = services()
      const plan = await planned(
        { ...grown(), queue: stray, verdicts: new Map([[verdictKey('7', '9'), 'accept']]) },
        fake,
      )
      expect(refusals(plan)).toEqual([['9', 'parent-refused']])
      expect(plan.rejected[0]!.message).toMatch(
        /no way back to the neuron through the accepted pieces/,
      )
      expect(asked.anchored).toEqual([])
    })
  })

  /** The dialog's ticks: what is ticked can always be sent. */
  describe('the ticks', () => {
    const merges = [
      { candidateRoot: '7' },
      { candidateRoot: '8' },
      { candidateRoot: '9', parent: '7' },
      { candidateRoot: '11', parent: '9' },
    ] as PlannedMerge[]
    const all = new Set(['7', '8', '9', '11'])

    it('unticks everything accepted beyond a piece with it', () => {
      expect([...tickedWith(merges, all, '7', false)]).toEqual(['8'])
      expect([...tickedWith(merges, all, '9', false)]).toEqual(['7', '8'])
      expect([...tickedWith(merges, all, '8', false)]).toEqual(['7', '9', '11'])
    })

    it('ticks what a piece’s merge point is on with it, and what that waits for', () => {
      const cross = [
        { candidateRoot: '7' },
        { candidateRoot: '8', parent: '7' },
        { candidateRoot: '9' },
        { candidateRoot: '11', parent: '9', needs: '8' },
      ] as PlannedMerge[]
      expect([...tickedWith(cross, new Set(), '11', true)].sort()).toEqual([
        '11',
        '7',
        '8',
        '9',
      ])
      // And unticking the piece its merge point is on takes it along.
      expect([...tickedWith(cross, new Set(['7', '8', '9', '11']), '8', false)]).toEqual([
        '7',
        '9',
      ])
    })

    it('ticks the pieces between a piece and the neuron with it', () => {
      expect([...tickedWith(merges, new Set(['8']), '11', true)].sort()).toEqual([
        '11',
        '7',
        '8',
        '9',
      ])
      expect([...tickedWith(merges, new Set(), '8', true)]).toEqual(['8'])
    })

    /** The merge point can be on a piece further in than the one it hangs on: that one counts too. */
    it('drops a piece whose merge point is on an unticked piece', () => {
      const deep = [
        { candidateRoot: '7' },
        { candidateRoot: '9', parent: '7' },
        { candidateRoot: '11', parent: '9', needs: '7' },
      ] as PlannedMerge[]
      expect([...withoutOrphans(deep, new Set(['9', '11']))]).toEqual([])
      expect([...withoutOrphans(deep, new Set(['7', '9', '11']))]).toEqual(['7', '9', '11'])
    })

    it('drops a piece whose way to the neuron passes through an unticked one', () => {
      expect([...withoutOrphans(merges, new Set(['8', '9', '11']))]).toEqual(['8'])
      expect([...withoutOrphans(merges, new Set(['7', '11']))]).toEqual(['7'])
      expect([...withoutOrphans(merges, all)]).toEqual(['7', '8', '9', '11'])
    })
  })
})
