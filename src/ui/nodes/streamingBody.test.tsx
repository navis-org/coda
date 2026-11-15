// @vitest-environment jsdom

/**
 * A card body that fills in while the node above it is still running.
 *
 * `ctx.publish` puts a half-finished value on the wire with nothing downstream re-running, and a
 * body reading `inputValues` can draw it — that is the whole mechanism (`core/node.ts`). What is
 * easy to miss is the second half: a publish moves **nothing the card selects**. Not the node's
 * own output, not its state, not its warning. So the body renders once against whatever had
 * arrived and then sits still, and the failure looks like a node that published nothing.
 *
 * `previewVersion` is the tick that fixes it, and it is subscribed to only where something draws
 * arriving data — for viewers by category, and for a body that says `drawsInputs`. Pinned here
 * with the real `seam:review`, whose queue fills from `seam:suggestMerges` one end at a time,
 * because the flag and the subscription are in two files and nothing but a render connects them.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { ID_COLUMN_NAME } from '../../core/ids'
import { defaultParams } from '../../core/node'
import { registerNode, requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import { isTableValue, makeTable } from '../../core/values'
import type { TableValue } from '../../core/values'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import '../../nodes'

/**
 * Two gates the test opens by hand, so every step of the stream is a line in the test rather
 * than a race with a timer: the producer waits before it publishes, and again before it answers.
 */
let publishNow: () => void = () => {}
let answerNow: () => void = () => {}

/** The two tips, both on every publish, with `searched` saying where the run has got to. */
const ENDS = [11, 22] as const

/**
 * The tips table **as the real node publishes it**: every row from the first partial, with
 * `searched` the only column that moves.
 *
 * Worth getting right rather than approximating with a growing row count, because the two
 * shapes would put the reader's attention in different places: `seam:suggestMerges` copies the
 * whole incoming table on its first publish and fills it in, so what a reader watches grow is
 * each row's contents and the foot's count, never the length of the list.
 */
function tips(searched: readonly (boolean | null)[]): TableValue {
  return makeTable(
    tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('end_uid', 'i64'),
      column('x', 'f64'),
      column('y', 'f64'),
      column('z', 'f64'),
      column('r', 'f64'),
      column('shown', 'bool'),
      column('searched', 'bool'),
    ),
    {
      [ID_COLUMN_NAME]: ENDS.map(() => '720575940621522189'),
      end_uid: [...ENDS],
      x: ENDS.map(() => 1),
      y: ENDS.map(() => 2),
      z: ENDS.map(() => 3),
      r: ENDS.map((_, i) => (searched[i] === true ? 0.9 - i / 10 : null)),
      shown: ENDS.map((_, i) => (searched[i] === true ? true : null)),
      searched: [...searched],
    },
  )
}

function candidates(ends: readonly number[]): TableValue {
  return makeTable(
    tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      column('end_uid', 'i64'),
      column('candidateId', 'str'),
      column('rank', 'i64'),
      column('vol_um3', 'f64'),
      column('conf', 'f64'),
      column('contact_x', 'f64'),
      column('contact_y', 'f64'),
      column('contact_z', 'f64'),
      column('shown', 'bool'),
    ),
    {
      [ID_COLUMN_NAME]: ends.map(() => '720575940621522189'),
      end_uid: [...ends],
      candidateId: ends.map((end) => `64851834636839560${end}`),
      rank: ends.map(() => 1),
      vol_um3: ends.map(() => 0.25),
      conf: ends.map(() => 0.4),
      contact_x: ends.map(() => 10),
      contact_y: ends.map(() => 20),
      contact_z: ends.map(() => 30),
      shown: ends.map(() => true),
    },
  )
}

beforeAll(() => {
  installJsdomStubs({ width: 1000, height: 800 })
  // Node 26 shadows jsdom's `localStorage`, and the card's filter fold is remembered there.
  installStorageStub()
  /*
   * A stand-in for `seam:suggestMerges`: one end published, then a wait we hold open, then the
   * pair. The real node is a GPU session, a CAVE credential and a volume read; what this test is
   * about is one publish reaching the card under it, which is the same either way.
   */
  /*
   * A pass-through on the tips wire. Not decoration: it is what a reader adds the moment they
   * want the queue narrowed, and it is never itself `running` — so a caption asking "is the node
   * above me running?" would vanish behind it while the queue was still filling.
   */
  registerNode({
    type: 'test.relayTable',
    label: 'Relay',
    category: 'utility',
    cost: 'cheap',
    inputs: [{ id: 'in', label: 'In', type: T.table() }],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: (ctx) => ({ out: ctx.input('in')! }),
  })
  registerNode({
    type: 'test.publishesEnds',
    label: 'Publishes Ends',
    category: 'utility',
    cost: 'expensive',
    inputs: [],
    outputs: [
      { id: 'tips', label: 'Tips', type: T.table() },
      { id: 'candidates', label: 'Candidates', type: T.table() },
    ],
    inferOutputs: () => ({ tips: T.table(), candidates: T.table() }),
    evaluate: async (ctx) => {
      await new Promise<void>((resolve) => {
        publishNow = resolve
      })
      // The first end scored: both tips published, one of them still waiting its turn.
      ctx.publish({ tips: tips([true, null]), candidates: candidates([11]) })
      // Unwinds on a Cancel, as a real fetch does — which is what drops the partial and
      // everything derived from it.
      await new Promise<void>((resolve, reject) => {
        answerNow = resolve
        ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')))
      })
      return { tips: tips([true, true]), candidates: candidates([11, 22]) }
    },
  })
})

beforeEach(() => {
  clearStorage()
  publishNow = () => {}
  answerNow = () => {}
})

afterEach(cleanup)

function graph(relay = false): CodaGraph {
  const at = (id: string, type: string, x: number) => ({
    id,
    type,
    position: { x, y: 0 },
    params: defaultParams(requireNodeDef(type)) as never,
  })
  let g = emptyGraph('streaming')
  g = addNode(g, at('src', 'test.publishesEnds', 0))
  g = addNode(g, at('review', 'seam:review', 720))
  for (const port of ['tips', 'candidates']) {
    // The relay sits on the tips wire only, which is where a narrowing node would go.
    if (relay && port === 'tips') {
      g = addNode(g, at('relay', 'test.relayTable', 360))
      g = addEdge(g, {
        source: 'src',
        sourceHandle: 'tips',
        target: 'relay',
        targetHandle: 'in',
      })
      g = addEdge(g, {
        source: 'relay',
        sourceHandle: 'out',
        target: 'review',
        targetHandle: 'tips',
      })
      continue
    }
    g = addEdge(g, {
      source: 'src',
      sourceHandle: port,
      target: 'review',
      targetHandle: port,
    })
  }
  return g
}

const rows = () => [...document.querySelectorAll('.review-row')]

describe('a card body drawing from a still-running input', () => {
  it('lists a published end before the run that produced it has finished', async () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().closeStartPage()
      useGraphStore.getState().loadGraph(graph())
    })
    const state = () => useGraphStore.getState().nodeInfo('src').state
    await waitFor(() => {
      if (!document.querySelector('.review-body')) throw new Error('no review card')
      if (state() !== 'running') throw new Error(`the producer is ${state()}`)
    })
    // Nothing published yet: the card is drawn, waiting, and says so.
    expect(rows()).toHaveLength(0)
    expect(document.querySelector('.review-body')?.textContent).toContain('Nothing to review')

    /*
     * The assertion the flag exists for. A publish moves `previewVersion` and nothing else —
     * the producer is still running, so its cache entry is untouched, and the review node's own
     * state, output and warning are all what they were. Without `drawsInputs` this card has
     * selected nothing that moved and the queue stays empty until the run ends.
     */
    act(() => publishNow())
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(state()).toBe('running')
    /*
     * Said once, where the reader is working. The count is the point: both tips are listed from
     * the first publish, so the length of the list says nothing about how far the run has got —
     * only `searched` does.
     */
    expect(document.querySelector('.review-body__filling')?.textContent).toBe(
      'still searching — 1 to go',
    )

    // And the finished answer replaces the partial rather than landing beside it.
    act(() => answerNow())
    await waitFor(() => expect(state()).toBe('ok'))
    expect(rows()).toHaveLength(2)
    expect(document.querySelector('.review-body__filling')).toBeNull()
  })

  /**
   * The half a card cannot do on its own: the viewer a reader actually judges a merge in is a
   * **Neuroglancer node downstream of Review**, fed from outputs only Review's `evaluate`
   * produces. Without `derivePreviews` those sat at the previous run's values until the whole
   * search settled, so clicking a row mid-run moved the list and nothing else.
   *
   * Asserted on the port rather than on a second card, because the port is what any downstream
   * node reads and a Neuroglancer card in jsdom has no WebGL to draw with.
   */
  it('feeds the nodes below it while the search is still going', async () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().closeStartPage()
      useGraphStore.getState().loadGraph(graph())
    })
    await waitFor(() => {
      if (useGraphStore.getState().nodeInfo('src').state !== 'running') throw new Error('idle')
    })
    act(() => publishNow())
    await waitFor(() => expect(rows()).toHaveLength(2))

    // Nothing picked yet, so the pair is empty — the node ran, on a cursor pointing nowhere.
    await waitFor(() => {
      const pair = useGraphStore.getState().nodeOutput('review', 'current')
      if (!isTableValue(pair)) throw new Error('Review has published no Current')
      expect(pair.length).toBe(0)
    })

    // A reader clicking the row, which is an edit to this node's params made mid-run.
    act(() => useGraphStore.getState().setParam('review', 'current', '11'))
    await waitFor(() => {
      const pair = useGraphStore.getState().nodeOutput('review', 'current')
      if (!isTableValue(pair)) throw new Error('Review has published no Current')
      // The neuron and the candidate, which is the whole picture a reader is judging.
      expect(pair.length).toBe(2)
    })
    expect(useGraphStore.getState().nodeInfo('src').state).toBe('running')

    /*
     * **And it was never cached.** A value computed from half an input is the answer for no
     * provenance key (invariant 4); cached, it would be a complete-looking result that no later
     * run would be scheduled to replace. So it goes when the partial under it does.
     */
    act(() => useGraphStore.getState().cancelRun())
    await waitFor(() => {
      expect(useGraphStore.getState().nodeOutput('review', 'current')).toBeUndefined()
    })
  })

  /**
   * The caption asks about this card's **inputs**, not about the node two wires up.
   *
   * A reader narrowing the queue puts a node in between, and that node is never itself
   * `running` — the walk is parked on the streaming node above it. What it does hold is a
   * partial derived from one, which is the same fact read where the card can see it.
   */
  it('still says it is filling with a node wired in between', async () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().closeStartPage()
      useGraphStore.getState().loadGraph(graph(true))
    })
    await waitFor(() => {
      if (useGraphStore.getState().nodeInfo('src').state !== 'running') throw new Error('idle')
    })
    act(() => publishNow())
    await waitFor(() => expect(rows()).toHaveLength(2))
    // The relay is what Review reads, and the relay is not running — it is holding a partial.
    expect(useGraphStore.getState().nodeInfo('relay').state).not.toBe('running')
    expect(document.querySelector('.review-body__filling')).not.toBeNull()

    act(() => answerNow())
    await waitFor(() => expect(useGraphStore.getState().nodeInfo('review').state).toBe('ok'))
    expect(document.querySelector('.review-body__filling')).toBeNull()
  })
})
