// @vitest-environment jsdom

/**
 * Align and distribute, where somebody reaches them.
 *
 * The arithmetic is `layout/align.test.ts`; what is worth pinning here is the wiring around it,
 * which is where a tool grid usually goes wrong: that a press acts on the *selection* the same
 * way Mute does, that it is one undo step, that a press changing nothing leaves no undo step at
 * all, that the menu stays open so two alignments are two presses rather than two right-clicks,
 * and that the tools are dimmed with a reason rather than hidden when there is too little
 * selected to mean anything.
 *
 * Sizes are the one thing jsdom cannot supply — it performs no layout, so `measureCardSizes`
 * reads `offsetWidth: 0` from every card and `resolveSize` falls back to the declared size. The
 * graphs here are built from one node type for exactly that reason: with every card the same
 * width the expected positions can be written down by hand and do not depend on the fallback.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { addNode, emptyGraph } from '../../core/graph'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

/** Three cards of one type — see the module note on why they are all the same. */
function threeCards() {
  const def = requireNodeDef('core.tableFromUrl')
  let g = emptyGraph('align')
  for (const [id, x, y] of [
    ['a', 0, 0],
    ['b', 500, 40],
    ['c', 900, 90],
  ] as const) {
    g = addNode(g, { id, type: def.type, position: { x, y }, params: defaultParams(def) })
  }
  return g
}

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.setState({ locked: false, autoLayout: false })
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(threeCards())
    useGraphStore.getState().setSelection([])
  })
})

afterEach(cleanup)

const store = () => useGraphStore.getState()
const positions = () =>
  Object.fromEntries(store().graph.nodes.map((n) => [n.id, { ...n.position }]))
const card = (id: string) => {
  const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
  if (!el) throw new Error(`no card for ${id}`)
  return el
}
const tool = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

/** The node menu, opened on `id` with `select` selected first. */
function menuOn(id: string, select: string[]) {
  render(<App />)
  act(() => store().setSelection(select))
  fireEvent.contextMenu(card(id))
}

describe('aligning from the node menu', () => {
  it('brings every left edge onto the leftmost, for the whole selection', () => {
    menuOn('a', ['a', 'b', 'c'])
    fireEvent.click(tool('Align left edges'))
    expect(positions()).toEqual({
      a: { x: 0, y: 0 },
      b: { x: 0, y: 40 },
      c: { x: 0, y: 90 },
    })
  })

  /* Equal widths, so a right-align puts every left edge on the rightmost card's. */
  it('aligns the other edges too, and the vertical pair', () => {
    menuOn('a', ['a', 'b', 'c'])
    fireEvent.click(tool('Align right edges'))
    expect(Object.values(positions()).map((p) => p.x)).toEqual([900, 900, 900])
    fireEvent.click(tool('Align top edges'))
    expect(Object.values(positions()).map((p) => p.y)).toEqual([0, 0, 0])
  })

  it('evens the gaps, leaving the outermost pair where they are', () => {
    menuOn('a', ['a', 'b', 'c'])
    fireEvent.click(tool('Distribute horizontally'))
    const after = positions()
    expect(after.a).toEqual({ x: 0, y: 0 })
    expect(after.c).toEqual({ x: 900, y: 90 })
    // Three cards of one width across a span of 900 + width: the middle one lands halfway.
    expect(after.b?.x).toBe(450)
  })

  it('offers the tools dimmed when the card under the pointer is on its own', () => {
    menuOn('c', ['a'])
    // A right-click on an unselected card is about that card — and one card is not two, so the
    // grid dims rather than quietly acting on the selection somewhere else on the canvas.
    expect(tool('Align left edges').disabled).toBe(true)
    expect(positions().c).toEqual({ x: 900, y: 90 })
  })
})

describe('what a press costs', () => {
  it('is one undo step, and ⌘Z puts every card back', () => {
    menuOn('a', ['a', 'b', 'c'])
    const before = positions()
    const depth = store().past.length
    fireEvent.click(tool('Align left edges'))
    expect(store().past.length).toBe(depth + 1)
    act(() => store().undo())
    expect(positions()).toEqual(before)
  })

  /*
   * `moveNodes` mints a fresh graph whatever it is handed, so a press that changes no position
   * would otherwise leave an undo step behind for nothing — and the second press of any of these
   * is exactly that press.
   */
  it('leaves no undo step for a press that changes nothing', () => {
    menuOn('a', ['a', 'b', 'c'])
    fireEvent.click(tool('Align left edges'))
    const depth = store().past.length
    fireEvent.click(tool('Align left edges'))
    expect(store().past.length).toBe(depth)
  })

  /*
   * An alignment is a position somebody chose, so it goes down the *drag* path — which is what
   * ends auto-layout. Left on, the next structural edit would put every card straight back where
   * ELK wants it, and a card that springs back from where you just put it is an editor refusing
   * to be edited.
   */
  it('ends auto-layout, as dragging the cards there by hand would', () => {
    act(() => useGraphStore.setState({ autoLayout: true }))
    menuOn('a', ['a', 'b', 'c'])
    fireEvent.click(tool('Align left edges'))
    expect(store().autoLayout).toBe(false)
  })

  /*
   * Every other row in this menu closes it, because every other row is a single decision.
   * "Align their left edges, then even the vertical gaps" is one thought and two presses.
   */
  it('leaves the menu open, so a second alignment is a second press', () => {
    menuOn('a', ['a', 'b', 'c'])
    fireEvent.click(tool('Align left edges'))
    fireEvent.click(tool('Distribute vertically'))
    expect(Object.values(positions()).map((p) => p.x)).toEqual([0, 0, 0])
    expect(positions().b?.y).toBe(45)
  })
})

describe('when the tools cannot mean anything', () => {
  it('needs two cards to align and three to distribute, and says which', () => {
    menuOn('a', ['a'])
    expect(tool('Align left edges').disabled).toBe(true)
    expect(tool('Align left edges').title).toMatch(/at least 2 cards/)
    cleanup()

    menuOn('a', ['a', 'b'])
    expect(tool('Align left edges').disabled).toBe(false)
    expect(tool('Distribute horizontally').disabled).toBe(true)
    expect(tool('Distribute horizontally').title).toMatch(/at least 3 cards/)
  })

  /*
   * Dimmed rather than dropped, for the palette's reason: a grid that vanished with one card
   * selected leaves nowhere to find out the feature exists.
   */
  it('stands down while the canvas is locked, and says that instead', () => {
    menuOn('a', ['a', 'b', 'c'])
    act(() => useGraphStore.setState({ locked: true }))
    expect(tool('Align left edges').disabled).toBe(true)
    expect(tool('Align left edges').title).toMatch(/locked/i)
  })
})

describe('the same grid on a group frame', () => {
  it('acts on the frame’s members rather than on the selection', () => {
    render(<App />)
    act(() => {
      store().setSelection(['a', 'b', 'c'])
      store().groupSelection()
      // The selection is deliberately something else: a frame is already a set of cards.
      store().setSelection(['a'])
    })
    fireEvent.contextMenu(document.querySelector('.group-frame__grab')!)
    fireEvent.click(tool('Align top edges'))
    expect(Object.values(positions()).map((p) => p.y)).toEqual([0, 0, 0])
  })
})
