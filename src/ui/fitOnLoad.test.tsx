// @vitest-environment jsdom

/**
 * The canvas half of fit-on-load: that opening a graph actually asks React Flow to frame it.
 *
 * `store/fitOnLoad.test.ts` pins which loads raise the request. What this pins is the thing that
 * went wrong: the effect that spends it was gated on `useNodesInitialized`, and that flag read
 * **false in this app forever** — `adoptUserNodes` re-seeds a node's `measured` from the user
 * object whenever its identity changes, `rfNodes` mints fresh objects on every store change, and
 * `updateNodeInternals` (the ResizeObserver's path) does not recompute the flag. So the fit never
 * ran, except on the first open of a session, which is React Flow's own `fitView` prop resolving
 * and nothing to do with this effect.
 *
 * `Editor`'s `measuredSizes` carries measurements across an edit now, so the flag is no longer
 * doomed — but the gate is gone rather than fixed, and it is the *ungated* effect this covers.
 * The flag is still forced false here, which is the harder case: a fit asked for before anything
 * has been measured has to be issued anyway, because React Flow's own queue is what waits.
 *
 * jsdom performs no layout, so the fit itself cannot be observed here — the framing was checked
 * in a browser and is written up in `Editor.tsx`. What *is* observable, and is the whole
 * regression, is whether `fitView` gets called at all.
 */

import { act, cleanup, render } from '@testing-library/react'
import type * as ReactFlow from '@xyflow/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fitView = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))

vi.mock('@xyflow/react', async (importOriginal) => {
  const real = await importOriginal<typeof ReactFlow>()
  return {
    ...real,
    // Forced false: the effect must issue the fit without waiting. See the note above.
    useNodesInitialized: () => false,
    useReactFlow: () => ({ ...real.useReactFlow(), fitView }),
  }
})

const { App } = await import('../App')
const { MockSource } = await import('../data/mock/MockSource')
const { registerSource } = await import('../data/source')
const { useGraphStore } = await import('../store/graphStore')
const { clearStorage, installJsdomStubs } = await import('../test/jsdomStubs')

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  fitView.mockClear()
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().newGraph()
  })
})

afterEach(cleanup)

describe('framing a graph that was just opened', () => {
  it('asks for the fit even though nothing reports the nodes as measured', () => {
    render(<App />)
    fitView.mockClear()
    act(() => useGraphStore.getState().loadExample('partners'))
    expect(fitView).toHaveBeenCalled()
  })

  it('asks again for the next one, so two opens in a row both land', () => {
    render(<App />)
    act(() => useGraphStore.getState().loadExample('partners'))
    fitView.mockClear()
    act(() => useGraphStore.getState().loadExample('matrix'))
    expect(fitView).toHaveBeenCalled()
  })

  it('does not fit an ordinary edit', () => {
    render(<App />)
    act(() => useGraphStore.getState().loadExample('partners'))
    fitView.mockClear()
    act(() => useGraphStore.getState().setParam(nodeId(), 'page', 1))
    expect(fitView).not.toHaveBeenCalled()
  })
})

function nodeId(): string {
  const id = useGraphStore.getState().graph.nodes[0]?.id
  if (!id) throw new Error('no nodes')
  return id
}
