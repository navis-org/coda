/**
 * `setParams`: several params of one node in one commit — one undo step — for an edit that spans
 * them (a region rename moves strokes and channel rows together). Two `setParam`s are two steps,
 * and undoing one leaves the other half-applied.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  const table = requireNodeDef('core.tableFromUrl')
  useGraphStore.getState().newGraph()
  useGraphStore.getState().loadGraph(
    addNode(emptyGraph('one node'), {
      id: 'src',
      type: table.type,
      position: { x: 0, y: 0 },
      params: defaultParams(table),
    }),
  )
})

const store = () => useGraphStore.getState()
const params = () => store().graph.nodes.find((n) => n.id === 'src')!.params

describe('setParams', () => {
  it('writes every param in one undo step, and one ⌘Z takes them all back', () => {
    const before = { ...params() }
    const depth = store().past.length
    store().setParams('src', { url: 'https://example.org/a.csv', refresh: 3 })
    expect(params()).toMatchObject({ url: 'https://example.org/a.csv', refresh: 3 })
    expect(store().past.length).toBe(depth + 1)
    store().undo()
    expect(params().url).toBe(before.url)
    expect(params().refresh).toBe(before.refresh)
  })
})
