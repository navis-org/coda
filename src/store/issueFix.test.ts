/**
 * A run error that knows its remedy (`FixableError`), carried from `evaluate` to the two places
 * a reader can press it: the card's issue line and the run's failure notice. Pinned at the store,
 * because the notice is the only place a dashboard shows a failure — the card is on the canvas the
 * grid replaced. The case it was built for is a model download nobody had allowed (2026-11-26).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { FixableError } from '../core/errors'
import { addNode, emptyGraph } from '../core/graph'
import { registerNode } from '../core/registry'
import { T, tableSchema } from '../core/types'
import { emptyTable } from '../core/values'
import '../nodes'
import { nodeIssues } from '../ui/nodes/nodeIssues'
import { node } from '../test/graph'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

const store = () => useGraphStore.getState()
const params = () => store().graph.nodes.find((n) => n.id === 'n')!.params
const FIX = { label: 'Allow it', action: 'tickAndRun', param: 'allow' } as const

beforeAll(() => {
  registerNode({
    type: 'test.store.consent',
    label: 'Consent',
    category: 'analysis',
    cost: 'expensive',
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    params: [
      { id: 'allow', kind: 'boolean', label: 'Allow', default: false },
      { id: 'size', kind: 'number', label: 'Size', default: 1 },
    ],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: (ctx) => {
      if (ctx.params.allow !== true) throw new FixableError('Not allowed.', FIX)
      return { out: emptyTable(tableSchema()) }
    },
  })
})

beforeAll(() => {
  registerNode({
    type: 'test.store.plain',
    label: 'Plain',
    category: 'analysis',
    cost: 'expensive',
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: () => {
      throw new Error('Plain failure.')
    },
  })
  registerNode({
    type: 'test.store.fine',
    label: 'Fine',
    category: 'analysis',
    cost: 'expensive',
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    params: [{ id: 'size', kind: 'number', label: 'Size', default: 1 }],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: () => ({ out: emptyTable(tableSchema()) }),
  })
})

beforeEach(() => {
  clearStorage()
  store().newGraph()
  store().loadGraph(addNode(emptyGraph('one card'), node('n', 'test.store.consent')))
})

describe('a run error that knows its fix', () => {
  it('keeps the fix on the node, and the card draws it under the message', async () => {
    await store().runNode('n')
    const info = store().nodeInfo('n')
    expect(info).toMatchObject({ state: 'error', error: 'Not allowed.', fix: FIX })
    expect(nodeIssues(info, undefined, undefined)).toEqual([
      { severity: 'error', message: 'Not allowed.', fix: FIX },
    ])
  })

  it('puts the fix on the failure notice, for as long as the notice is that sentence', async () => {
    await store().runNode('n')
    expect(store().notice).toBe('Consent failed: Not allowed.')
    expect(store().noticeFix).toEqual({ text: store().notice, nodeId: 'n', fix: FIX })
    // Another notice replaces the sentence; `StatusNotice` then draws no fix (text differs).
    store().setNotice('Something else.')
    expect(store().noticeFix?.text).not.toBe(store().notice)
  })

  /*
   * An auto pass after an unrelated edit does not re-run an expensive node, and reported no
   * failures — which took the notice down, on a dashboard the only place the failure showed.
   */
  it('keeps the failure notice through a run that did not touch the failed node', async () => {
    store().loadGraph(
      addNode(
        addNode(emptyGraph('two cards'), node('n', 'test.store.consent')),
        node('m', 'test.store.fine'),
      ),
    )
    await store().runNode('n')
    const notice = store().notice
    expect(notice).toBe('Consent failed: Not allowed.')
    // An edit first: `refreshStates` turns the failed `n` stale and drops its fix from its info.
    store().setParam('m', 'size', 2)
    await store().runNode('m')
    expect(store().nodeInfo('m').state).toBe('ok')
    expect(store().nodeInfo('n').state).not.toBe('error')
    expect(store().notice).toBe(notice)
    expect(store().noticeFix).toEqual({ text: notice, nodeId: 'n', fix: FIX })
  })

  it('puts a failure it can fix first, so the notice carries its button', async () => {
    store().loadGraph(
      addNode(
        addNode(emptyGraph('two failures'), node('p', 'test.store.plain')),
        node('n', 'test.store.consent'),
      ),
    )
    await store().runAll()
    expect(store().notice).toBe('Consent failed: Not allowed. 1 more node failed too.')
    expect(store().noticeFix).toMatchObject({ nodeId: 'n', fix: FIX })
  })

  it('ticks the param, takes the notice down and runs the node', async () => {
    await store().runNode('n')
    const undo = store().past.length
    await store().applyFix('n', FIX)
    expect(params()['allow']).toBe(true)
    expect(store().nodeInfo('n').state).toBe('ok')
    expect(store().notice).toBeUndefined()
    // One edit, so one undo step.
    expect(store().past).toHaveLength(undo + 1)
  })

  it('works under the lock, being a param and a run', async () => {
    await store().runNode('n')
    if (!store().locked) store().toggleLocked()
    expect(store().locked).toBe(true)
    try {
      await store().applyFix('n', FIX)
      expect(params()['allow']).toBe(true)
      expect(store().nodeInfo('n').state).toBe('ok')
    } finally {
      store().toggleLocked()
    }
  })

  it('touches no param that is not one of the node’s booleans', async () => {
    await store().runNode('n')
    await store().applyFix('n', { ...FIX, param: 'size' })
    await store().applyFix('n', { ...FIX, param: 'missing' })
    expect(params()['size']).toBe(1)
    expect(params()['missing']).toBeUndefined()
    expect(store().nodeInfo('n').state).toBe('error')
  })
})
