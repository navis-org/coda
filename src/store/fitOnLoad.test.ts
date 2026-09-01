/**
 * Opening a graph asks the canvas to frame it.
 *
 * The viewport belongs to React Flow and every trigger for a load — the toolbar, the start page,
 * the palette — sits outside its provider, so this crosses the seam as a counter the canvas
 * catches. What is worth pinning is not that the counter goes up but *when it does not*: a
 * request raised for a graph with nothing in it cannot be satisfied, so the canvas would hold it
 * pending and spend it on whatever node the user added next — a viewport that lurches for no
 * reason, minutes later and nowhere near the cause.
 *
 * The canvas half — that the request is actually spent — is `ui/fitOnLoad.test.tsx`. jsdom does
 * no layout, so the framing itself cannot be observed anywhere; what that file pins is that
 * `fitView` is called at all, which is what a gate on `useNodesInitialized` used to prevent.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { demoWorkflow } from '../wizard/build'
import { useGraphStore } from './graphStore'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  useGraphStore.getState().newGraph()
})

const fits = () => useGraphStore.getState().fitRequest

function graphWithOneNode() {
  const def = requireNodeDef('out.table')
  return addNode(emptyGraph('opened'), {
    id: 'n1',
    type: def.type,
    position: { x: 900, y: 700 },
    params: defaultParams(def),
  })
}

describe('framing what was just opened', () => {
  it('asks for a fit when a file is opened', () => {
    const before = fits()
    useGraphStore.getState().loadGraph(graphWithOneNode())
    expect(fits()).toBe(before + 1)
  })

  it('asks again for the next one, so two opens in a row both land', () => {
    useGraphStore.getState().loadGraph(graphWithOneNode())
    const between = fits()
    useGraphStore.getState().loadGraph(graphWithOneNode())
    expect(fits()).toBe(between + 1)
  })

  it('covers examples and starters, which load through the same path', () => {
    const before = fits()
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
    expect(fits()).toBe(before + 1)
    useGraphStore
      .getState()
      .loadStarter({ nodeType: 'dataset.mock.opticlobe', label: 'Mini', sourceId: 'mock' })
    expect(fits()).toBe(before + 2)
  })
})

describe('what raises no request', () => {
  it('an empty canvas, which has nothing to frame', () => {
    const before = fits()
    useGraphStore.getState().newGraph()
    expect(fits()).toBe(before)
  })

  it('a loaded file that turned out to hold no nodes', () => {
    // The request would otherwise sit pending until the user added something, and fire then.
    const before = fits()
    useGraphStore.getState().loadGraph(emptyGraph('empty'))
    expect(fits()).toBe(before)
  })

  it('an ordinary edit', () => {
    useGraphStore.getState().loadGraph(graphWithOneNode())
    const before = fits()
    useGraphStore.getState().addNode('out.table', { x: 0, y: 0 })
    useGraphStore.getState().setGraphName('renamed')
    expect(fits()).toBe(before)
  })
})
