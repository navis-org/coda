// @vitest-environment jsdom

/**
 * One live renderer per node.
 *
 * A viewer is a *renderer*, not a picture, and the two WebGL ones cost a graphics context and
 * their own copy of the geometry on the GPU. The card, the inspector and the overlay are three
 * independent mount points for the same node, so a node open in all three was three contexts,
 * three uploads and three redraws on every invalidation — measured in a real browser at 3 × 170
 * kB for a 21-neuron scene, and 154 draw calls for one background change.
 *
 * jsdom has no WebGL, so none of that is observable here. What *is* observable is the rule that
 * prevents it: the inspector stands a WebGL viewer down, and a card does not draw while the
 * overlay owns its node. Both are ordinary DOM facts, and both are the kind of thing that gets
 * quietly undone by a later refactor of a conditional.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T } from '../../core/types'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { ValuePreview } from './ValuePreview'
import '../../nodes'

beforeAll(() => {
  installJsdomStubs({ width: 560, height: 420 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

afterEach(cleanup)

describe('the inspector stands a WebGL viewer down', () => {
  function inspect(type: string, inputs: Record<string, ReturnType<typeof T.skeletons>>) {
    const def = requireNodeDef(type)
    const params = defaultParams(def)
    const node = { id: 'v', type, position: { x: 0, y: 0 }, params }
    return render(
      <ValuePreview
        node={node as never}
        value={undefined}
        ctx={makeInferContext(def, params, inputs)}
        compact
        summary
        onExpand={() => undefined}
      />,
    )
  }

  it('names what it would have drawn instead of drawing it again', () => {
    inspect('out.viewer3d', { skeletons: T.skeletons() })
    expect(screen.getByText(/This 3D scene is drawn on its card/)).toBeTruthy()
    // The Suspense fallback of the lazy WebGL chunk is the tell that one was mounted.
    expect(screen.queryByText(/loading 3D renderer/)).toBeNull()
  })

  it('offers the way to see it properly, since it just declined to show it', () => {
    inspect('out.viewer3d', { skeletons: T.skeletons() })
    expect(screen.getByRole('button', { name: /Open full size/ })).toBeTruthy()
  })

  it('applies to the network viewer too, which has exactly the same cost', () => {
    inspect('out.network', { in: T.network() })
    expect(screen.getByText(/This network is drawn on its card/)).toBeTruthy()
  })

  it('does not stand down without a summary asked for, which is the card and the overlay', () => {
    const def = requireNodeDef('out.viewer3d')
    const params = defaultParams(def)
    render(
      <ValuePreview
        node={{ id: 'v', type: 'out.viewer3d', position: { x: 0, y: 0 }, params } as never}
        value={undefined}
        ctx={makeInferContext(def, params, { skeletons: T.skeletons() })}
      />,
    )
    expect(screen.queryByText(/drawn on its card/)).toBeNull()
  })
})

describe('a card does not draw while the overlay owns its node', () => {
  beforeEach(() => {
    clearStorage()
    act(() => {
      useGraphStore.getState().loadExample('partners')
    })
  })

  async function runGraph() {
    await act(async () => {
      await useGraphStore.getState().runAll()
    })
  }

  function viewerId(): string {
    const found = useGraphStore.getState().graph.nodes.find((n) => n.type === 'out.table')
    if (!found) throw new Error('no viewer in the example')
    return found.id
  }

  async function previewOf(nodeId: string): Promise<Element | null> {
    return waitFor(() => {
      const wrapper = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
      if (!wrapper) throw new Error(`no card for ${nodeId}`)
      return wrapper.querySelector('.coda-node__preview')
    })
  }

  it('drops the preview while expanded and brings it back on close', async () => {
    render(<App />)
    // A table card only draws once it has a result, so the rule has to be tested on a card
    // that would otherwise be showing something.
    await runGraph()
    const id = viewerId()
    expect(await previewOf(id)).toBeTruthy()

    act(() => {
      useGraphStore.getState().expandNode(id)
    })
    expect(await previewOf(id)).toBeNull()

    act(() => {
      useGraphStore.getState().expandNode(undefined)
    })
    expect(await previewOf(id)).toBeTruthy()
  })

  it('leaves every other card alone, since the overlay owns one node', async () => {
    render(<App />)
    await runGraph()
    const id = viewerId()
    const other = useGraphStore.getState().graph.nodes.find((n) => n.id !== id)!

    act(() => {
      useGraphStore.getState().expandNode(other.id)
    })
    // The overlay is showing something else, so this card is still on screen behind it.
    expect(await previewOf(id)).toBeTruthy()
  })
})
