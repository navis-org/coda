/**
 * A record a run keeps in a param (`ParamBase.runRecord`), written by the store as the run
 * reports it — `seam:suggestMerges`' moment per neuron (`docs/seam-live-plan.md`). Pinned at the
 * store, because that is where every run passes through, the dashboard's included, where no card
 * is mounted. Out of the key, so the write runs nothing again and leaves nothing stale; the
 * card's ⟳ (`refreshNode`) empties it, and Clear Cache does not.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from '../core/graph'
import { registerNode } from '../core/registry'
import { T, tableSchema } from '../core/types'
import { emptyTable } from '../core/values'
import '../nodes'
import { node } from '../test/graph'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

const store = () => useGraphStore.getState()
const params = () => store().graph.nodes.find((n) => n.id === 'n')!.params
let moments = 0
/** What each evaluation read, so a test can count the runs and see what they saw. */
const seen: unknown[] = []

beforeAll(() => {
  registerNode({
    type: 'test.store.record',
    label: 'moment',
    category: 'analysis',
    cost: 'expensive',
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    params: [
      {
        id: 'at',
        kind: 'string',
        label: 'At',
        default: '',
        runRecord: true,
        presentational: true,
        unrecorded: true,
        internal: true,
      },
      { id: 'other', kind: 'number', label: 'Other', default: 1 },
    ],
    inferOutputs: () => ({ out: T.table() }),
    // As Suggest Merges does: keep what is recorded, record a moment where there is none.
    evaluate: (ctx) => {
      seen.push(ctx.params.at)
      if (ctx.params.at === '') ctx.record?.('at', `moment ${++moments}`)
      return { out: emptyTable(tableSchema()) }
    },
  })
})

beforeEach(() => {
  clearStorage()
  seen.length = 0
  store().newGraph()
  store().loadGraph(addNode(emptyGraph('one card'), node('n', 'test.store.record')))
})

describe('a record a run keeps', () => {
  it('is written into the document as the run reports it, with no undo step', async () => {
    const before = store().past.length
    await store().runNode('n')
    expect(params()['at']).toMatch(/^moment /)
    expect(store().past).toHaveLength(before)
  })

  it('runs nothing again and leaves nothing stale, being out of the key', async () => {
    await store().runNode('n')
    expect(seen).toEqual([''])
    expect(store().needsRun('n')).toBe(false)
    await store().runAll()
    expect(seen).toEqual([''])
  })

  it('is not taken back by undoing an edit around it', async () => {
    await store().runNode('n')
    const kept = params()['at']
    store().setParam('n', 'other', 2)
    store().undo()
    expect(params()['other']).toBe(1)
    expect(params()['at']).toBe(kept)
  })

  it('is emptied by the ⟳, and the run after it records afresh', async () => {
    await store().runNode('n')
    const first = params()['at']
    await store().refreshNode('n')
    expect(seen.at(-1)).toBe('')
    expect(params()['at']).toMatch(/^moment /)
    expect(params()['at']).not.toBe(first)
  })

  /**
   * Clear Cache in the Inspector and the menu says "forget downloaded data". Emptying the record
   * there would search the next run at a new moment, and a review card's saved verdicts could
   * name another search's answer.
   */
  it('is not emptied by Clear Cache, which forgets data and nothing in the document', async () => {
    await store().runNode('n')
    const kept = params()['at']
    store().clearNodeCache('n')
    expect(params()['at']).toBe(kept)
  })
})
