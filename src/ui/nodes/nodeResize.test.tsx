// @vitest-environment jsdom

/**
 * Resizable viewer cards.
 *
 * Two things here fail silently rather than loudly. The handles sit *on* the card's edge and
 * `.coda-node` clips with `overflow: hidden`, so rendering the resizer inside the card leaves
 * corners that look grabbable and are half cut off — the same trap the run outline hit. And a
 * resize must not touch results: it is a view decision, and if it invalidated the node every
 * drag would throw away a fetch.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { allNodeDefs } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { isViewer } from './CodaNodeView'

beforeAll(() => {
  installJsdomStubs({ width: 420, height: 300 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().loadExample('partners')
  })
})

afterEach(cleanup)

/** Ids of the graph's nodes by type, from the store rather than the DOM. */
function nodeIdOfType(type: string): string {
  const found = useGraphStore.getState().graph.nodes.find((n) => n.type === type)
  if (!found) throw new Error(`no ${type} in the example`)
  return found.id
}

function select(nodeId: string): void {
  act(() => {
    useGraphStore.getState().setSelection([nodeId])
  })
}

async function cardFor(nodeId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const wrapper = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
    const card = wrapper?.querySelector('.coda-node')
    if (!card) throw new Error(`no card for ${nodeId}`)
    return card as HTMLElement
  })
}

describe('resize handles', () => {
  it('renders outside the card, so the grab targets are not clipped away', async () => {
    render(<App />)
    const table = nodeIdOfType('out.table')
    select(table)

    const card = await cardFor(table)
    const wrapper = card.parentElement!
    const controls = [...wrapper.querySelectorAll('.react-flow__resize-control')]
    expect(controls.length).toBeGreaterThan(0)
    // The load-bearing assertion: siblings of the clipping card, not descendants of it.
    for (const control of controls) expect(card.contains(control)).toBe(false)
  })

  it('leaves nodes whose height their params decide alone', async () => {
    // A drag handle on a Filter would promise a control that does nothing: its height is
    // whatever its fields need.
    render(<App />)
    const filter = nodeIdOfType('core.filter')
    select(filter)

    const card = await cardFor(filter)
    expect(card.parentElement!.querySelectorAll('.react-flow__resize-control')).toHaveLength(0)
  })
})

describe('what a resize costs', () => {
  it('undoes a drag back to where it started, not to the last frame before release', () => {
    // A gesture arrives as a stream of uncommitted frames plus one committing frame. Taking
    // the history entry from the last of those undid a single frame — and for a drag the last
    // two frames are usually identical, so undo appeared to do nothing at all.
    const id = useGraphStore.getState().graph.nodes[0]!.id
    const start = useGraphStore.getState().graph.nodes[0]!.position

    act(() => {
      const store = useGraphStore.getState()
      store.moveNodes([{ id, position: { x: 111, y: 111 } }], false)
      store.moveNodes([{ id, position: { x: 222, y: 222 } }], false)
      store.moveNodes([{ id, position: { x: 333, y: 333 } }], true)
    })
    act(() => {
      useGraphStore.getState().undo()
    })
    expect(useGraphStore.getState().graph.nodes.find((n) => n.id === id)?.position).toEqual(
      start,
    )
  })

  it('does not invalidate the node it resizes', async () => {
    const store = useGraphStore.getState()
    await act(async () => {
      await store.runAll()
    })
    const table = nodeIdOfType('out.table')
    expect(useGraphStore.getState().nodeInfo(table).state).toBe('ok')

    act(() => {
      useGraphStore
        .getState()
        .resizeNodes([{ id: table, size: { width: 600, height: 480 } }], true)
    })

    const after = useGraphStore.getState()
    expect(after.graph.nodes.find((n) => n.id === table)?.size).toEqual({
      width: 600,
      height: 480,
    })
    // Still fresh: a card's size cannot change a result, so it is not part of the key.
    expect(after.nodeInfo(table).state).toBe('ok')
  })

  it('is undoable, and coalesces the drag into one step', async () => {
    render(<App />)
    const table = nodeIdOfType('out.table')
    const before = useGraphStore.getState().past.length

    act(() => {
      // Mid-drag frames, then the release. Only the release records history.
      useGraphStore
        .getState()
        .resizeNodes([{ id: table, size: { width: 500, height: 400 } }], false)
      useGraphStore
        .getState()
        .resizeNodes([{ id: table, size: { width: 600, height: 480 } }], true)
    })
    expect(useGraphStore.getState().past.length).toBe(before + 1)

    act(() => {
      useGraphStore.getState().undo()
    })
    expect(
      useGraphStore.getState().graph.nodes.find((n) => n.id === table)?.size,
    ).toBeUndefined()
  })
})

/**
 * Who is allowed to declare a `defaultSize`.
 *
 * It sizes React Flow's *wrapper*, and only a resizable card — `data-sized` — is told to fill
 * one. Declare it on any other node and the wrapper is taller than the card, which on its own
 * would just be invisible slack. What makes it visible is the state bar: `.coda-node::before`
 * is inset against the wrapper, because `.coda-node` is deliberately unpositioned so the
 * handles and the run ring can escape its clip. So the bar takes the *wrapper's* height and
 * hangs below the card as a coloured line with nothing beside it.
 *
 * Nothing throws and nothing fails a type check, which is why this is asserted over the whole
 * registry rather than left to be noticed on one node. Annotations are exempt: a note is drawn
 * by `NoteCard`, which has no state bar and does fill its wrapper.
 */
describe('defaultSize', () => {
  it('is declared only by nodes whose cards can actually fill it', () => {
    const offenders = allNodeDefs()
      .filter((def) => def.defaultSize && !def.annotation && !isViewer(def))
      .map((def) => def.type)
    expect(offenders).toEqual([])
  })
})
