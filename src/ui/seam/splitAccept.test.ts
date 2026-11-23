/**
 * Accept and Undo in the split gallery (`splitAccept.ts`) against faked servers — never a
 * chunkedgraph. Pinned: one write at a time, the gallery held while it is out, Undo sent once.
 * Also `importGraph.test.ts`' canary for the split path's session.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConfirmedSplit, EditOutcome } from '../../data/cave/edits'
import { parseGrapheneSource } from '../../data/cave/graphene'
import { toy, TWO_NEURONS, withNodeIds } from '../../packs/seam/__fixtures__/splitToy'
import { splitCandidates } from '../../packs/seam/splitGallery'
import type { SplitWriteServices } from '../../packs/seam/splitWrite'
import { otherWriteOut, registerWriteOut } from '../../data/cave/editWaits'
import { addNode, emptyGraph } from '../../core/graph'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { node } from '../../test/graph'
import { clearStorage } from '../../test/jsdomStubs'
import { settle } from './__fixtures__/splitServices'
import type { AcceptFrom } from './splitAccept'
import {
  acceptSplit,
  mayHaveWritten,
  resetSplitAcceptForTests,
  splitAccept,
  undoable,
  undoAccepted,
} from './splitAccept'
import { closeSplit, resetSplitSessionForTests, splitSession, startSplit } from './splitSession'
import { toyServices } from './__fixtures__/splitServices'

const INPUT = withNodeIds(toy({ ...TWO_NEURONS, svs: 24 }))
const FROM: AcceptFrom = {
  request: {
    deployment: 'd',
    datastack: 'toy',
    root: '720575940000000001',
    pointNm: [0, 0, 0],
  },
  graphene: parseGrapheneSource('graphene://https://cave.example.org/segmentation/table/t')!,
  input: INPUT,
  index: 0,
  candidate: [...splitCandidates(INPUT)].find(Boolean)!,
}

/** Servers that split as asked, sources under `1`, sinks under `2`. */
function servers() {
  let sources = new Set<string>()
  return {
    permission: () => Promise.resolve({ dataset: 'toy', mayEdit: true, termsPending: false }),
    latest: () => Promise.resolve([true]),
    // A one-edge cut: sent as it is, so no preview is asked.
    preview: () => Promise.reject(new Error('no preview for one edge')),
    roots: (_: unknown, svs: readonly string[]) =>
      Promise.resolve(svs.map((sv) => (sources.has(sv) ? '1' : '2'))),
    send: vi.fn((split: ConfirmedSplit): Promise<EditOutcome> => {
      sources = new Set(split.sources.map((end) => end.supervoxel))
      return Promise.resolve({ kind: 'done', operationId: '9', newRootIds: ['1', '2'] })
    }),
    undo: vi.fn((): Promise<EditOutcome> =>
      Promise.resolve({ kind: 'done', operationId: '10', newRootIds: ['3'] }),
    ),
  } satisfies SplitWriteServices
}

afterEach(() => {
  resetSplitAcceptForTests()
  resetSplitSessionForTests()
})

describe('acceptSplit', () => {
  it('writes one split at a time, then offers its edit to Undo once', async () => {
    const services = servers()
    resetSplitAcceptForTests(services)
    acceptSplit(FROM)
    acceptSplit(FROM)
    expect(splitAccept()?.step).toBe('checking')
    await settle()
    expect(services.send).toHaveBeenCalledTimes(1)
    expect(splitAccept()?.result).toMatchObject({ kind: 'split' })

    undoAccepted()
    undoAccepted()
    await settle()
    expect(services.undo).toHaveBeenCalledTimes(1)
    expect(splitAccept()).toMatchObject({ undo: { ok: true } })
    undoAccepted()
    expect(services.undo).toHaveBeenCalledTimes(1)
  })

  it('says why Undo did nothing where the writer refuses it', async () => {
    const services = servers()
    services.undo.mockRejectedValue(new Error('already been undone'))
    resetSplitAcceptForTests(services)
    acceptSplit(FROM)
    await settle()
    undoAccepted()
    await settle()
    expect(splitAccept()).toMatchObject({
      undo: { ok: false, message: expect.stringMatching(/already been undone/) },
    })
  })

  /** A send Coda stopped waiting for is still out: nothing else goes until it answers. */
  it('holds the gallery for a send still out, then keeps its late edit for Undo', async () => {
    const services = servers()
    let answer: (outcome: EditOutcome) => void = () => undefined
    services.send.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    resetSplitAcceptForTests({ ...services, sendTimeoutMs: 5 })
    resetSplitSessionForTests(toyServices())
    startSplit({ ...FROM.request, pointNm: [2000, 250, 0] })
    await settle()
    const shown = splitSession()

    acceptSplit(FROM)
    await vi.waitFor(() => expect(splitAccept()?.result?.kind).toBe('unknown'))
    expect(splitAccept()).toMatchObject({ out: true })
    expect(mayHaveWritten(splitAccept()?.result)).toBe(true)
    expect(undoable(splitAccept())).toBeUndefined()
    closeSplit()
    expect(splitSession()).toBe(shown)
    acceptSplit(FROM)
    expect(services.send).toHaveBeenCalledTimes(1)

    answer({ kind: 'done', operationId: '11', newRootIds: ['1', '2'] })
    await settle()
    expect(splitAccept()).toMatchObject({
      result: { kind: 'unknown', done: { operationId: '11' } },
    })
    expect(undoable(splitAccept())).toMatchObject({ operationId: '11' })
    closeSplit()
    expect(splitSession()).toBeUndefined()
  })

  it('offers Undo once, whatever came of it', async () => {
    const services = servers()
    services.undo.mockResolvedValue({ kind: 'unknown', message: 'lost' })
    resetSplitAcceptForTests(services)
    acceptSplit(FROM)
    await settle()
    undoAccepted()
    await settle()
    expect(splitAccept()).toMatchObject({ undo: { ok: false } })
    expect(undoable(splitAccept())).toBeUndefined()
  })

  /** Two edits in flight to one neuron would apply one to a root the reader never saw. */
  it('waits while a merge is out, and says so', async () => {
    const services = servers()
    resetSplitAcceptForTests(services)
    registerWriteOut('merge', () => 'Merges are being sent.')
    try {
      acceptSplit(FROM)
      await settle()
      expect(services.send).not.toHaveBeenCalled()
      expect(useGraphStore.getState().notice).toBe('Merges are being sent.')
    } finally {
      registerWriteOut('merge', () => undefined)
    }
    expect(otherWriteOut('merge')).toBeUndefined()
    acceptSplit(FROM)
    // The split is out now: a merge is told to wait.
    expect(otherWriteOut('merge')).toMatch(/split is being written/)
    await settle()
    expect(services.send).toHaveBeenCalledTimes(1)
  })

  it('lets go of the gallery when Undo never answers', async () => {
    const services = servers()
    services.undo.mockReturnValue(new Promise(() => undefined))
    resetSplitAcceptForTests({ ...services, sendTimeoutMs: 5 })
    acceptSplit(FROM)
    await settle()
    undoAccepted()
    await vi.waitFor(() => expect(splitAccept()).toMatchObject({ undo: { ok: false } }))
    expect(splitAccept()?.step).toBeUndefined()
  })

  /** The card's neurons, as edits on its input (`selectionEdits`), in the document on screen. */
  const cardEdits = () =>
    useGraphStore.getState().graph.nodes.find((one) => one.id === 'ng')?.params[
      'selectionEdits'
    ]
  /** A Neuroglancer card in a fresh document, with a pick already made, and the press over it. */
  function onCard(): AcceptFrom {
    clearStorage()
    useGraphStore.getState().newGraph()
    useGraphStore
      .getState()
      .loadGraph(
        addNode(
          emptyGraph('split'),
          node('ng', 'out.neuroglancer', { selectionEdits: ['+7'] }),
        ),
      )
    const card = { docId: useGraphStore.getState().activeTabId, nodeId: 'ng' }
    return { ...FROM, request: { ...FROM.request, card } }
  }

  it('puts the new roots in the card in place of the old one, and the undo’s root after', async () => {
    resetSplitAcceptForTests(servers())
    const from = onCard()
    acceptSplit(from)
    await settle()
    expect(cardEdits()).toEqual(['+1', '+2', '+7', `-${FROM.request.root}`])
    undoAccepted()
    await settle()
    expect(cardEdits()).toEqual(['+3', '+7', `-${FROM.request.root}`])
  })

  it('leaves the card alone where every end was read under the old root still', async () => {
    const services: SplitWriteServices = {
      ...servers(),
      roots: (_, svs) => Promise.resolve(svs.map(() => FROM.request.root)),
    }
    resetSplitAcceptForTests(services)
    acceptSplit(onCard())
    await settle()
    expect(splitAccept()?.result?.kind).toBe('unknown')
    expect(cardEdits()).toEqual(['+7'])
  })

  /** Node ids repeat across documents: another document's card of the same id is not this one. */
  it('writes nothing into a document that is not the one the key was pressed in', async () => {
    resetSplitAcceptForTests(servers())
    const from = onCard()
    acceptSplit({
      ...from,
      request: { ...from.request, card: { docId: 'elsewhere', nodeId: 'ng' } },
    })
    await settle()
    expect(splitAccept()?.result?.kind).toBe('split')
    expect(cardEdits()).toEqual(['+7'])
  })

  it('is one undo step of its own, kept apart from a pick made just before', async () => {
    resetSplitAcceptForTests(servers())
    const from = onCard()
    // A pick (the card's own write) an instant before the answer lands.
    useGraphStore.getState().setParam('ng', 'selectionEdits', ['+7', '+8'])
    const steps = useGraphStore.getState().past.length
    acceptSplit(from)
    await settle()
    expect(useGraphStore.getState().past.length).toBe(steps + 1)
    useGraphStore.getState().undo()
    expect(cardEdits()).toEqual(['+7', '+8'])
  })

  it('writes nothing, and no undo step, where the card already shows the new roots', async () => {
    resetSplitAcceptForTests(servers())
    const from = onCard()
    useGraphStore
      .getState()
      .setParam('ng', 'selectionEdits', ['+1', '+2', '+7', `-${FROM.request.root}`])
    const steps = useGraphStore.getState().past.length
    acceptSplit(from)
    await settle()
    expect(useGraphStore.getState().past.length).toBe(steps)
  })

  it('leaves a node that is no longer a Neuroglancer card alone', async () => {
    resetSplitAcceptForTests(servers())
    const from = onCard()
    acceptSplit({
      ...from,
      request: { ...from.request, card: { ...from.request.card!, nodeId: 'gone' } },
    })
    await settle()
    expect(splitAccept()?.result?.kind).toBe('split')
    expect(cardEdits()).toEqual(['+7'])
  })

  it('shows the pieces once a split still out answers that it was made', async () => {
    const services = servers()
    let answer: (outcome: EditOutcome) => void = () => undefined
    services.send.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    resetSplitAcceptForTests({ ...services, sendTimeoutMs: 5 })
    acceptSplit(onCard())
    await vi.waitFor(() => expect(splitAccept()).toMatchObject({ out: true }))
    expect(cardEdits()).toEqual(['+7'])
    answer({ kind: 'done', operationId: '11', newRootIds: ['1', '2'] })
    await settle()
    expect(cardEdits()).toEqual(['+1', '+2', '+7', `-${FROM.request.root}`])
  })

  it('sets the card right once an undo still out answers that it was made', async () => {
    const services = servers()
    let answer: (outcome: EditOutcome) => void = () => undefined
    services.undo.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    resetSplitAcceptForTests({ ...services, sendTimeoutMs: 5 })
    acceptSplit(onCard())
    await settle()
    undoAccepted()
    await vi.waitFor(() => expect(splitAccept()).toMatchObject({ out: true }))
    expect(otherWriteOut('merge')).toMatch(/split is being written/)
    answer({ kind: 'done', operationId: '12', newRootIds: ['3'] })
    await settle()
    expect(splitAccept()).toMatchObject({ undo: { ok: true } })
    // The pieces un-added, not noted removed: no input will send them.
    expect(cardEdits()).toEqual(['+3', '+7', `-${FROM.request.root}`])
  })
})
