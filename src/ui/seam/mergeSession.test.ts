// @vitest-environment jsdom

/**
 * Submit's session (`mergeSession.ts`), with the plan and the batch faked — nothing here reaches a
 * server (`src/test/writeGuard.ts` would fail it). What is pinned is the phase-6 wiring: the plan
 * opens the overlay or says why not on the status bar, a settled lost reply is recorded at once,
 * the record is appended live with no undo step, the card is held while the batch runs, and the
 * overlay cannot close until it ends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addNode, emptyGraph } from '../../core/graph'
import type * as VerdictLog from '../../data/verdictLog'
import '../../nodes'
import type { BatchCallbacks, BatchResult } from '../../packs/seam/mergeBatch'
import type {
  MergePlan,
  PlanRequest,
  PlannedMerge,
  ReadyPlan,
} from '../../packs/seam/mergePlan'
import type { MergeRecordEntry } from '../../packs/seam/mergeRecord'
import type { QueueTip } from '../../packs/seam/reviewQueue'
import { decodeRecord, settledEntry } from '../../packs/seam/mergeRecord'
import { useGraphStore } from '../../store/graphStore'
import { node } from '../../test/graph'
import { clearStorage } from '../../test/jsdomStubs'

const planMerges = vi.fn<(request: PlanRequest) => Promise<MergePlan>>()
const prepareMerges = vi.fn()
vi.mock('../../packs/seam/mergePlan', () => ({
  planMerges: (request: PlanRequest) => planMerges(request),
}))
vi.mock('../../packs/seam/mergeBatch', () => ({
  prepareMerges: (...args: unknown[]) => prepareMerges(...args),
}))
let touring = false
vi.mock('../tour/tourState', () => ({ isTourActive: () => touring }))
/*
 * The verdict queue watched rather than written: nothing here may reach the verdict server either.
 * `queueVerdict` runs as it is, its source check and all, and lands here.
 */
const queued = vi.fn<(target: unknown, input: { verdict: string }) => undefined>()
const flushed = vi.fn(() => Promise.resolve())
vi.mock('../../data/verdictLog', async (importOriginal) => ({
  ...(await importOriginal<typeof VerdictLog>()),
  enqueueVerdict: (target: unknown, input: { verdict: string }) => queued(target, input),
  flushVerdicts: () => flushed(),
}))

const {
  STILL_OUT_MS,
  closeSubmit,
  confirmSubmit,
  currentSubmit,
  openSubmit,
  recheckSubmit,
  resetSubmit,
  stopSubmit,
  submitStopping,
  submitCheckedOf,
  submitStateOf,
} = await import('./mergeSession')

const store = () => useGraphStore.getState()
const record = () =>
  decodeRecord(store().graph.nodes.find((n) => n.id === 'review')!.params['merges'])

/** The press, in the document on screen: filled in once the store has one (`beforeEach`). */
let REQUEST = {
  docId: '',
  nodeId: 'review',
  deployment: 'https://global.example.org',
  datastack: 'test',
  sourceId: 'cave',
  datasetId: 'test:1',
  queue: [
    {
      neuronId: '100',
      seed: '100',
      endUid: 1,
      kind: 'tip',
      tipNm: [1, 2, 3],
      source: 'model:ranker@abc/assessor@def',
      candidates: [],
    },
  ] as unknown as QueueTip[],
  reviewedRoot: '100',
}

const MERGE = {
  candidateRoot: '7',
  used: {
    neuronId: '100',
    endUid: 1,
    candidate: { candidateId: '7', rank: 1, shown: true },
    tip: REQUEST.queue[0],
  },
  auto: false,
} as PlannedMerge
/** The same merge, accepted by Auto-extend alone (`PlannedMerge.auto`). */
const AUTO_MERGE = { ...MERGE, auto: true } as PlannedMerge
const PLAN: ReadyPlan = {
  ok: true,
  datastack: 'test',
  graphene: { server: 'https://cave.example.org', table: 't', base: '' },
  reviewedRoot: '100',
  currentRoot: '100',
  merges: [MERGE],
  rejected: [],
}

function entry(outcome: 'merged' | 'unknown', newRoot = '201'): MergeRecordEntry {
  const base = {
    reviewedRoot: '100',
    candidateRoot: '7',
    endUid: 1,
    neuronRoot: '100',
    neuron: { supervoxel: '71', positionNm: [1, 2, 3] as const },
    candidate: { supervoxel: '72', positionNm: [4, 5, 6] as const },
    at: '2026-11-16T10:00:00.000Z',
  }
  return outcome === 'merged' ? { ...base, outcome, newRoot } : { ...base, outcome }
}

/** A batch the test drives: `run` hands back its callbacks and resolves when told. */
function heldBatch() {
  let finish: (result: BatchResult) => void = () => {}
  let on: BatchCallbacks | undefined
  prepareMerges.mockImplementation(() => ({
    run: (callbacks: BatchCallbacks) => {
      on = callbacks
      return new Promise<BatchResult>((resolve) => (finish = resolve))
    },
  }))
  return { on: () => on!, finish: (result: BatchResult) => finish(result) }
}

/** Open a Submit and wait for its plan. */
async function opened(plan: MergePlan = PLAN) {
  planMerges.mockResolvedValueOnce(plan)
  openSubmit(REQUEST)
  await vi.waitFor(() => expect(currentSubmit()?.phase).not.toBe('planning'))
}

beforeEach(() => {
  clearStorage()
  resetSubmit()
  store().newGraph()
  store().loadGraph(addNode(emptyGraph('submit'), node('review', 'seam:review')))
  store().setNotice(undefined)
  REQUEST = { ...REQUEST, docId: store().activeTabId }
  planMerges.mockReset()
  prepareMerges.mockReset()
  queued.mockReset()
  flushed.mockClear()
})

afterEach(() => {
  resetSubmit()
})

describe('Submit', () => {
  it('says on the status bar, and opens nothing, during a tour', () => {
    touring = true
    openSubmit(REQUEST)
    touring = false
    expect(currentSubmit()).toBeUndefined()
    expect(store().notice).toMatch(/tour/)
    expect(planMerges).not.toHaveBeenCalled()
  })

  it('opens the overlay with the plan, or says why not', async () => {
    await opened()
    expect(currentSubmit()).toMatchObject({ phase: 'ready', plan: PLAN, running: false })
    closeSubmit()
    await opened({ ok: false, message: 'Your CAVE account may not edit test.' })
    expect(currentSubmit()).toBeUndefined()
    expect(store().notice).toBe('Your CAVE account may not edit test.')
  })

  it('counts the pieces checked, for this check and this card alone', async () => {
    let told: PlanRequest | undefined
    let finish: (plan: MergePlan) => void = () => {}
    planMerges.mockImplementation((request) => {
      told = request
      return new Promise((resolve) => (finish = resolve))
    })
    openSubmit(REQUEST)
    expect(submitCheckedOf(REQUEST.docId, REQUEST.nodeId)).toBeUndefined()
    told!.onProgress!(3, 10)
    expect(submitCheckedOf(REQUEST.docId, REQUEST.nodeId)).toEqual({ done: 3, total: 10 })
    expect(submitCheckedOf(REQUEST.docId, 'another')).toBeUndefined()
    finish(PLAN)
    await vi.waitFor(() => expect(currentSubmit()?.phase).toBe('ready'))
    expect(submitCheckedOf(REQUEST.docId, REQUEST.nodeId)).toBeUndefined()
    // A check that was closed says nothing more, though its reads may still be finishing.
    closeSubmit()
    const stale = told!
    planMerges.mockImplementation(() => new Promise(() => {}))
    openSubmit(REQUEST)
    stale.onProgress!(9, 10)
    expect(submitCheckedOf(REQUEST.docId, REQUEST.nodeId)).toBeUndefined()
  })

  /** A Re-check plans from the open overlay: its count must not take the overlay down. */
  it('keeps the overlay up while a Re-check counts', async () => {
    await opened()
    let told: PlanRequest | undefined
    planMerges.mockImplementation((request) => {
      told = request
      return new Promise(() => {})
    })
    recheckSubmit()
    told!.onProgress!(1, 5)
    expect(currentSubmit()?.phase).toBe('ready')
    expect(submitCheckedOf(REQUEST.docId, REQUEST.nodeId)).toBeUndefined()
  })

  it('records a settled lost reply as soon as the plan arrives', async () => {
    const lost = entry('unknown')
    const settled = settledEntry(lost, '150', '2026-11-16T11:00:00.000Z')
    await opened({ ...PLAN, currentRoot: '150', settled: [settled] })
    expect(record()).toEqual([
      expect.objectContaining({ outcome: 'merged', newRoot: '150', candidateRoot: '7' }),
    ])
  })

  /**
   * The record keeps its last ten neurons in full (`appendRecorded`), shortened where it grows: in
   * the same write as the append, through the batch's own hold.
   */
  it('shortens a neuron past the record’s last ten, as it appends', async () => {
    const others = Array.from({ length: 10 }, (_, i) => ({
      ...entry('merged', `30${i}`),
      reviewedRoot: `20${i}`,
      neuronRoot: `20${i}`,
    }))
    store().setParam('review', 'merges', JSON.stringify(others))
    await opened()
    const batch = heldBatch()
    confirmSubmit([MERGE])
    batch.on().record(entry('merged', '201'), '201', ['7'])
    expect(record()[0]).toEqual({
      short: true,
      reviewedRoot: '200',
      candidateRoot: '7',
      outcome: 'merged',
      newRoot: '300',
    })
    expect(record().slice(1)).toEqual([...others.slice(1), entry('merged', '201')])
    stopSubmit()
    batch.finish({ state: 'stopped', currentRoot: '201', message: 'Stopped.' })
  })

  it('holds the card, appends the record live, and lets go when the batch ends', async () => {
    await opened()
    const batch = heldBatch()
    const past = store().past.length
    confirmSubmit([MERGE])
    expect(prepareMerges).toHaveBeenCalledWith(PLAN, [MERGE], {
      deployment: REQUEST.deployment,
    })
    expect(currentSubmit()).toMatchObject({ running: true })

    // Held: the card cannot be deleted, and the overlay cannot be closed.
    store().deleteNodes(['review'])
    expect(store().graph.nodes).toHaveLength(1)
    closeSubmit()
    expect(currentSubmit()).toBeDefined()

    // Each entry lands on the param as it is now, with no undo step; the neuron follows.
    batch.on().progress('7', { state: 'sending' })
    batch.on().record(entry('merged', '201'), '201', ['7'])
    store().setParam('review', 'verdicts', '1:7=accept') // an edit in between is kept
    // A merge onto pieces short of the neuron moves those, never the neuron.
    batch.on().record({ ...entry('merged', '250'), neuronRoot: '8' }, '201', [])
    expect(currentSubmit()).toMatchObject({ neuronRoot: '201' })
    batch.on().record({ ...entry('merged', '202'), neuronRoot: '201' }, '202', ['7'])
    expect(record().map((e) => (e.outcome === 'merged' ? e.newRoot : ''))).toEqual([
      '201',
      '250',
      '202',
    ])
    expect(store().past).toHaveLength(past + 1)
    expect(currentSubmit()).toMatchObject({ neuronRoot: '202' })

    expect(submitStopping()).toBe(false)
    stopSubmit()
    expect(batch.on().stopRequested()).toBe(true)
    expect(submitStopping()).toBe(true)
    batch.finish({
      state: 'stopped',
      currentRoot: '202',
      message: 'Stopped before this merge.',
    })
    await vi.waitFor(() => expect(currentSubmit()).toMatchObject({ running: false }))
    // The batch is over, so nothing is stopping any more.
    expect(submitStopping()).toBe(false)
    expect(store().notice).toBe('Stopped before this merge.')
    store().deleteNodes(['review'])
    expect(store().graph.nodes).toHaveLength(0)
    closeSubmit()
    expect(currentSubmit()).toBeUndefined()
  })

  /** Never as `accept`: SEAM must not take its own pick for a reader's verdict (user, 2026-11-18). */
  it('sends a piece Auto-extend accepted, once merged, as `auto-accepted`', async () => {
    await opened({ ...PLAN, merges: [AUTO_MERGE] })
    const batch = heldBatch()
    confirmSubmit([AUTO_MERGE])
    batch.on().record(entry('unknown'), '100', [])
    expect(queued).not.toHaveBeenCalled()
    // Merged onto pieces short of the neuron: not in it yet, and it may never be.
    batch.on().record({ ...entry('merged', '250'), neuronRoot: '8' }, '100', [])
    expect(queued).not.toHaveBeenCalled()
    // In with the merge that took its group in.
    batch.on().record({ ...entry('merged'), candidateRoot: '8' }, '201', ['8', '7'])
    expect(queued).toHaveBeenCalledTimes(1)
    expect(queued.mock.calls[0]![0]).toEqual({
      deployment: REQUEST.deployment,
      datastack: REQUEST.datastack,
    })
    expect(queued.mock.calls[0]![1]).toMatchObject({
      verdict: 'auto-accepted',
      neuron: '100',
      piece: '100',
      candidate: '7',
    })
    // One post when the batch ends, not one per merge.
    expect(flushed).not.toHaveBeenCalled()
    batch.finish({ state: 'done', currentRoot: '201', message: '' })
    await vi.waitFor(() => expect(flushed).toHaveBeenCalledTimes(1))
  })

  it('sends nothing for a merge the reader accepted: their press was the record', async () => {
    await opened()
    const batch = heldBatch()
    confirmSubmit([MERGE])
    batch.on().record(entry('merged'), '201', ['7'])
    batch.finish({ state: 'done', currentRoot: '201', message: '' })
    await vi.waitFor(() => expect(currentSubmit()).toMatchObject({ running: false }))
    expect(queued).not.toHaveBeenCalled()
    expect(flushed).not.toHaveBeenCalled()
  })

  it('starts nothing, and holds nothing, where the batch cannot be prepared', async () => {
    await opened()
    prepareMerges.mockImplementation(() => {
      throw new Error('Both sides of the merge are supervoxel 5.')
    })
    expect(() => confirmSubmit([MERGE])).toThrow(/supervoxel 5/)
    expect(currentSubmit()).toMatchObject({ running: false, progress: undefined })
    store().deleteNodes(['review'])
    expect(store().graph.nodes).toHaveLength(0)
  })

  /** Two documents from one file share node ids: the press names its document too. */
  it('checks nothing for a card not in the document on screen', async () => {
    REQUEST = { ...REQUEST, docId: 'another-document' }
    openSubmit(REQUEST)
    await vi.waitFor(() => expect(currentSubmit()).toBeUndefined())
    expect(planMerges).not.toHaveBeenCalled()
    expect(store().notice).toMatch(/no longer on screen/)
  })

  /** And Merge holds the card through the store, which asks the same. */
  it('starts no batch on a card gone from the document', async () => {
    await opened()
    store().loadGraph(emptyGraph('elsewhere'))
    expect(() => confirmSubmit([MERGE])).toThrow(/no longer on screen/)
    expect(prepareMerges).not.toHaveBeenCalled()
  })

  /** A Re-check still out when Merge is pressed must not land a fresh plan over the batch. */
  it('drops a Re-check overtaken by Merge', async () => {
    await opened()
    let answer: (plan: MergePlan) => void = () => {}
    planMerges.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    recheckSubmit()
    heldBatch()
    confirmSubmit([MERGE])
    answer({ ...PLAN, currentRoot: '999' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(currentSubmit()).toMatchObject({ running: true, neuronRoot: '100' })
  })

  /** The plan was made from the pressed document's card; another on screen is not that one. */
  it('closes, and says why, where the document changed during the check', async () => {
    let answer: (plan: MergePlan) => void = () => {}
    planMerges.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    openSubmit(REQUEST)
    store().newWorkflow()
    answer(PLAN)
    await vi.waitFor(() => expect(currentSubmit()).toBeUndefined())
    expect(store().notice).toMatch(/no longer on screen/)
  })

  /**
   * A merge the batch stopped waiting for is still with the server: a plan made meanwhile finds
   * its roots unmoved and would send the same pair again (audit of 77c0625, 2026-11-16).
   */
  describe('a merge still out', () => {
    /** Run a batch whose merge times out, and hand back the answer to give it later. */
    async function timedOut(merge: PlannedMerge = MERGE) {
      await opened({ ...PLAN, merges: [merge] })
      const batch = heldBatch()
      confirmSubmit([merge])
      let answer: (entry: MergeRecordEntry | undefined) => void = () => {}
      batch.on().record(entry('unknown'), '100', [])
      batch.on().stillOut(new Promise((resolve) => (answer = resolve)), true)
      batch.finish({ state: 'failed', currentRoot: '100', message: 'The reply was lost.' })
      await vi.waitFor(() => expect(currentSubmit()).toMatchObject({ running: false }))
      closeSubmit()
      return (entry: MergeRecordEntry | undefined) => answer(entry)
    }

    /** The merge landed, late: an Auto-extend piece is sent all the same, and only once. */
    it('sends a piece Auto-extend accepted when its late answer says merged', async () => {
      const answer = await timedOut(AUTO_MERGE)
      expect(queued).not.toHaveBeenCalled()
      answer(entry('merged', '201'))
      await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1))
      expect(queued.mock.calls[0]![1]).toMatchObject({
        verdict: 'auto-accepted',
        candidate: '7',
      })
      await vi.waitFor(() => expect(flushed).toHaveBeenCalledTimes(1))
    })

    it('sends nothing when the late answer says it did not land', async () => {
      const answer = await timedOut(AUTO_MERGE)
      answer({ ...entry('unknown') } as MergeRecordEntry)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(queued).not.toHaveBeenCalled()
    })

    /** Closing the tab meanwhile would lose the answer: the browser asks first, until it comes. */
    it('asks before the tab closes while it waits', async () => {
      const added = vi.spyOn(window, 'addEventListener')
      const removed = vi.spyOn(window, 'removeEventListener')
      const answer = await timedOut()
      const asks = () =>
        added.mock.calls.filter(([type]) => type === 'beforeunload').length -
        removed.mock.calls.filter(([type]) => type === 'beforeunload').length
      expect(asks()).toBe(1)
      answer(undefined)
      await vi.waitFor(() => expect(asks()).toBe(0))
      added.mockRestore()
      removed.mockRestore()
    })

    it('holds every Submit until it answers, then records the answer', async () => {
      const answer = await timedOut()
      expect(submitStateOf(REQUEST.docId, 'review')).toBe('waiting')
      expect(submitStateOf(REQUEST.docId, 'another-card')).toBe('waiting')
      openSubmit(REQUEST)
      expect(currentSubmit()).toBeUndefined()
      expect(store().notice).toMatch(/has not answered yet/)

      answer({ ...entry('merged', '201'), operationId: '4217' } as MergeRecordEntry)
      await vi.waitFor(() => expect(submitStateOf(REQUEST.docId, 'review')).toBe('none'))
      expect(record().map((e) => e.outcome)).toEqual(['unknown', 'merged'])
      expect(record()[1]).toMatchObject({ newRoot: '201', operationId: '4217' })
      expect(store().notice).toMatch(/answered: merged/)
    })

    /** Several merges are out at once, so several can be still out: Submit waits for all. */
    it('holds every Submit until the last of several answers, recording each', async () => {
      await opened()
      const batch = heldBatch()
      confirmSubmit([MERGE])
      const answers: ((entry: MergeRecordEntry | undefined) => void)[] = []
      for (const _ of [1, 2]) {
        batch.on().record(entry('unknown'), '100', [])
        batch.on().stillOut(new Promise((resolve) => answers.push(resolve)), true)
      }
      batch.finish({ state: 'failed', currentRoot: '100', message: 'The reply was lost.' })
      await vi.waitFor(() => expect(currentSubmit()).toMatchObject({ running: false }))
      closeSubmit()

      answers[0]!({ ...entry('merged', '201'), operationId: '1' } as MergeRecordEntry)
      await vi.waitFor(() => expect(record()).toHaveLength(3))
      expect(submitStateOf(REQUEST.docId, 'review')).toBe('waiting')
      answers[1]!(undefined)
      await vi.waitFor(() => expect(submitStateOf(REQUEST.docId, 'review')).toBe('none'))
      expect(record().map((e) => e.outcome)).toEqual(['unknown', 'unknown', 'merged'])
    })

    /** An answer landing while the batch still holds the card is recorded once it lets go. */
    it('records an answer that lands before the batch has let go of the card', async () => {
      await opened()
      const batch = heldBatch()
      confirmSubmit([MERGE])
      batch.on().record(entry('unknown'), '100', [])
      batch
        .on()
        .stillOut(Promise.resolve({ ...entry('merged', '201') } as MergeRecordEntry), true)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(record().map((e) => e.outcome)).toEqual(['unknown'])
      batch.finish({ state: 'failed', currentRoot: '100', message: 'The reply was lost.' })
      await vi.waitFor(() =>
        expect(record().map((e) => e.outcome)).toEqual(['unknown', 'merged']),
      )
    })

    it('lets go, recording nothing, where the answer says nothing either way', async () => {
      const answer = await timedOut()
      answer(undefined)
      await vi.waitFor(() => expect(submitStateOf(REQUEST.docId, 'review')).toBe('none'))
      expect(record().map((e) => e.outcome)).toEqual(['unknown'])
    })

    /** Past the limit a later batch may have moved the neuron on: an old root is not appended. */
    it('lets go after STILL_OUT_MS, and drops an answer that comes after it', async () => {
      // Only the session's own timer is faked: `vi.waitFor` keeps the real clock.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const answer = await timedOut()
        expect(submitStateOf(REQUEST.docId, 'review')).toBe('waiting')
        vi.advanceTimersByTime(STILL_OUT_MS)
        expect(submitStateOf(REQUEST.docId, 'review')).toBe('none')
        expect(store().notice).toMatch(/has not answered in 10 minutes/)
        answer(entry('merged', '201'))
        await vi.advanceTimersByTimeAsync(0)
        expect(record().map((e) => e.outcome)).toEqual(['unknown'])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('confirms once', async () => {
    await opened()
    heldBatch()
    confirmSubmit([MERGE])
    expect(() => confirmSubmit([MERGE])).toThrow(/already been sent/)
    expect(prepareMerges).toHaveBeenCalledTimes(1)
  })
})
