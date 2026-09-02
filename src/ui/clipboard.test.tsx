// @vitest-environment jsdom

/**
 * Copy, cut and paste as gestures: which events they take and, more importantly, which they
 * leave alone.
 *
 * The store half is thin enough to be checked from here rather than from a file of its own,
 * because it exists only for these three gestures. What needs pinning is all on the boundary:
 *
 *  - **A paste that is not ours must not be swallowed.** Most of what is on a clipboard is prose,
 *    a URL or a column of neuron ids, and the failure — `preventDefault` on an event nobody aimed
 *    at the canvas — is invisible from inside the app and shows up as a field that will not take
 *    a paste.
 *  - **A live text selection wins.** With prose selected in a dialog, ⌘C is about that prose even
 *    though three cards are also selected behind it.
 *  - **A repeated paste steps.** Placed absolutely, two pastes at one point land on top of each
 *    other with the new selection covering the old — indistinguishable from a paste that failed.
 *
 * jsdom implements neither `ClipboardEvent` nor `DataTransfer`, so the events are fabricated —
 * `clipboardEvent` in `test/jsdomStubs.ts`, shared with `panels/shortcuts.test.tsx`. That is a
 * real gap and it is the reason the `preventDefault` assertions are here rather than "we checked
 * it in a browser".
 */

import { cleanup, render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { fragmentFrom } from '../core/clipboard'
import { addNode, emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import { useGraphStore } from '../store/graphStore'
import { clearStorage, clipboardEvent } from '../test/jsdomStubs'
import { useClipboardShortcuts } from './clipboard'
import { LOCKED_NOTICE } from './lockCopy'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

const store = () => useGraphStore.getState()

/** Two unconnected cards at known positions, so a paste's placement is readable. */
function twoNodes() {
  let g = emptyGraph('two')
  for (const [id, type, x] of [
    ['a', 'core.tableFromUrl', 100],
    ['b', 'out.table', 300],
  ] as const) {
    g = addNode(g, {
      id,
      type,
      position: { x, y: 50 },
      params: defaultParams(requireNodeDef(type)),
    })
  }
  return g
}

beforeEach(() => {
  clearStorage()
  useGraphStore.setState({ locked: false, clipboard: undefined, notice: undefined })
  store().newGraph()
  store().loadGraph(twoNodes())
})

afterEach(() => {
  cleanup()
  // `getSelection` is spied on rather than assigned, so it comes back: a stub left standing makes
  // every later copy look like one taken over a text selection, which is exactly the guard being
  // tested and so fails somewhere else entirely.
  vi.restoreAllMocks()
})

/**
 * The canvas's own two handlers, as `Editor` passes them.
 *
 * `refuseIfLocked` is copied from `Editor.tsx` rather than imported — it is three lines there and
 * lives inside the component. What matters is that it says something, which is what the locked
 * cases below assert.
 */
function Harness({ pasteAt = { x: 0, y: 0 } }: { pasteAt?: { x: number; y: number } }) {
  useClipboardShortcuts({
    pastePoint: () => pasteAt,
    refuseIfLocked: () => {
      if (!useGraphStore.getState().locked) return false
      useGraphStore.getState().setNotice(LOCKED_NOTICE)
      return true
    },
  })
  return null
}

function fire(event: Event, target: EventTarget = window): void {
  act(() => {
    target.dispatchEvent(event)
  })
}

describe('copying', () => {
  it('puts the selection on the event’s clipboard and claims the keystroke', () => {
    render(<Harness />)
    store().setSelection(['a'])
    const event = clipboardEvent('copy')
    fire(event)
    expect(event.defaultPrevented).toBe(true)
    expect(JSON.parse(event.clipboardData.getData('text/plain')).nodes).toHaveLength(1)
    // And this app's own memory of it, which is what a menu row pastes from.
    expect(store().clipboard).toBeTruthy()
  })

  it('leaves the event alone with nothing selected', () => {
    render(<Harness />)
    const event = clipboardEvent('copy')
    fire(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves it alone while text is selected, whatever the canvas has', () => {
    render(<Harness />)
    store().setSelection(['a', 'b'])
    vi.spyOn(document, 'getSelection').mockReturnValue({
      toString: () => 'a sentence from a dialog',
    } as Selection)
    const event = clipboardEvent('copy')
    fire(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves it alone in a field somebody is typing in', () => {
    render(<Harness />)
    store().setSelection(['a'])
    const input = document.createElement('input')
    document.body.append(input)
    const event = clipboardEvent('copy')
    fire(event, input)
    expect(event.defaultPrevented).toBe(false)
    input.remove()
  })

  it('works while the canvas is locked, because it takes nothing away', () => {
    render(<Harness />)
    store().setSelection(['a'])
    useGraphStore.setState({ locked: true })
    const event = clipboardEvent('copy')
    fire(event)
    expect(event.defaultPrevented).toBe(true)
    expect(store().notice).toBeUndefined()
  })
})

describe('cutting', () => {
  it('copies and deletes, as one undo step', () => {
    render(<Harness />)
    store().setSelection(['a'])
    const event = clipboardEvent('cut')
    fire(event)
    expect(store().graph.nodes.map((n) => n.id)).toEqual(['b'])
    expect(event.clipboardData.getData('text/plain')).toContain('core.tableFromUrl')
    act(() => store().undo())
    expect(store().graph.nodes).toHaveLength(2)
  })

  it('is refused by the lock, and says so', () => {
    render(<Harness />)
    store().setSelection(['a'])
    useGraphStore.setState({ locked: true })
    fire(clipboardEvent('cut'))
    expect(store().graph.nodes).toHaveLength(2)
    expect(store().notice).toBe(LOCKED_NOTICE)
  })
})

describe('pasting', () => {
  const fragment = () => fragmentFrom(twoNodes(), ['a'])!

  it('lands at the point the canvas gave, re-identified and selected', () => {
    render(<Harness pasteAt={{ x: 800, y: 600 }} />)
    fire(clipboardEvent('paste', fragment()))
    expect(store().graph.nodes).toHaveLength(3)
    const pasted = store().graph.nodes.find((n) => !['a', 'b'].includes(n.id))!
    expect(pasted.position).toEqual({ x: 800, y: 600 })
    expect(store().selection).toEqual([pasted.id])
  })

  it('steps a repeat rather than stacking it invisibly', () => {
    render(<Harness pasteAt={{ x: 800, y: 600 }} />)
    fire(clipboardEvent('paste', fragment()))
    fire(clipboardEvent('paste', fragment()))
    const positions = store()
      .graph.nodes.filter((n) => !['a', 'b'].includes(n.id))
      .map((n) => `${n.position.x},${n.position.y}`)
    expect(positions).toHaveLength(2)
    expect(new Set(positions).size).toBe(2)
  })

  it('leaves a paste that is not a graph entirely alone', () => {
    render(<Harness />)
    const event = clipboardEvent('paste', '720575940622093134\n720575940627708688')
    fire(event)
    expect(event.defaultPrevented).toBe(false)
    expect(store().graph.nodes).toHaveLength(2)
    // Not even a notice: nothing here was addressed to the canvas.
    expect(store().notice).toBeUndefined()
  })

  it('is refused by the lock, and says so', () => {
    render(<Harness />)
    useGraphStore.setState({ locked: true })
    const event = clipboardEvent('paste', fragment())
    fire(event)
    expect(store().graph.nodes).toHaveLength(2)
    expect(store().notice).toBe(LOCKED_NOTICE)
    // Claimed all the same: it was ours, and refusing it is an answer.
    expect(event.defaultPrevented).toBe(true)
  })

  it('is not stolen from a field somebody is typing in', () => {
    render(<Harness />)
    const input = document.createElement('input')
    document.body.append(input)
    const event = clipboardEvent('paste', fragment())
    fire(event, input)
    expect(event.defaultPrevented).toBe(false)
    expect(store().graph.nodes).toHaveLength(2)
    input.remove()
  })
})
