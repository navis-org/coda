// @vitest-environment jsdom

/**
 * The canvas lock, on screen: the rail, the palette, the keyboard.
 *
 * `store/lock.test.ts` pins what a locked store refuses. What this pins is the half that makes
 * the feature usable rather than merely correct — **every surface the lock covers says so**. A
 * lock whose guards work but whose buttons stay lit is indistinguishable, from the outside, from
 * an editor that has started ignoring clicks, and that is how it would be reported.
 *
 * The gestures React Flow owns — the wheel, the pan drag, the socket drag, the resize handles —
 * are refused at its props and cannot be driven in jsdom, which performs no layout and dispatches
 * no real pointer sequences. Those were checked in a browser; `docs/canvas.md` records what was
 * tried. What is observable here is every button, every command row and every key.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import { buildCommandItems, buildNodeItems } from './paletteItems'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.setState({ locked: false, autoLayout: false })
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
    useGraphStore.getState().setSelection([])
  })
})

afterEach(cleanup)

const button = (name: string | RegExp) =>
  screen.getByRole('button', { name }) as HTMLButtonElement
/** The card for a node id, as React Flow marks it. */
const card = (id: string) => {
  const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
  if (!el) throw new Error(`no card for ${id}`)
  return el
}
const lockButton = () => button('Lock canvas')
// By its exact accessible name rather than by prefix: a node card can carry its own "+ Add"
// button — Rename's rows, Find Neurons' filters — and a pattern matches those too. The button
// itself is wordless (a circle in the canvas corner), so the label is all there is to match.
const addButton = () =>
  screen.getByRole('button', { name: 'Add a node' }) as HTMLButtonElement
const browser = () => screen.queryByRole('dialog', { name: 'Add a node' })
const lock = () => act(() => useGraphStore.setState({ locked: true }))

function commands() {
  return buildCommandItems({
    store: useGraphStore.getState(),
    fitView: () => {},
    fitSelected: () => {},
  })
}
const command = (id: string) => commands().find((item) => item.id === id)

describe('the Lock button', () => {
  it('sits in the canvas rail and says which way it is', () => {
    render(<App />)
    expect(document.querySelector('.react-flow__controls')?.contains(lockButton())).toBe(true)
    expect(lockButton().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(lockButton())
    expect(useGraphStore.getState().locked).toBe(true)
    expect(lockButton().getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(lockButton())
    expect(useGraphStore.getState().locked).toBe(false)
  })

  /*
   * The whole rail dims except this one. That is the strongest statement on screen that the
   * canvas is frozen — stronger than the pressed tint, which asks to be noticed.
   */
  it('leaves every other button in the rail disabled, and itself live', () => {
    render(<App />)
    useGraphStore.getState().setSelection([nodeId()])
    lock()
    for (const name of ['Zoom in', 'Zoom out', 'Fit View', 'Fit Selected', 'Auto-layout']) {
      expect(button(name).disabled).toBe(true)
    }
    expect(
      (screen.getByRole('button', { name: /Arrange/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(lockButton().disabled).toBe(false)
    // The routing toggle is not a canvas edit: it changes how a wire is drawn and no position.
    expect(
      (screen.getByRole('button', { name: /Wire routing/ }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('gives every rail button a tooltip naming the lock rather than a dead control', () => {
    render(<App />)
    lock()
    for (const name of ['Zoom in', 'Fit View', 'Fit Selected']) {
      expect(button(name).getAttribute('title')).toMatch(/locked/i)
    }
  })
})

describe('the add button and the toolbar', () => {
  it('stands the add button and the history buttons down', () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().setParam(nodeId(), 'page', 1)
    })
    expect(addButton().disabled).toBe(false)
    lock()
    expect(addButton().disabled).toBe(true)
    expect(screen.getByTitle(/Undo — the canvas is locked/)).toBeDefined()
  })
})

describe('the palette', () => {
  it('offers the lock as one row that says which way it goes', () => {
    expect(command('cmd:lock')?.label).toBe('Lock Canvas')
    act(() => useGraphStore.setState({ locked: true }))
    expect(command('cmd:lock')?.label).toBe('Unlock Canvas')
  })

  it('disables the rows the lock covers, and leaves the rest alone', () => {
    act(() => {
      useGraphStore.getState().setSelection([nodeId()])
      useGraphStore.getState().setParam(nodeId(), 'page', 1)
      useGraphStore.setState({ locked: true })
    })
    for (const id of [
      'cmd:undo',
      'cmd:duplicate',
      'cmd:cut',
      'cmd:paste',
      'cmd:group',
      'cmd:delete',
      'cmd:browse-nodes',
      'cmd:fit',
      'cmd:fit-selected',
    ]) {
      expect(command(id)?.disabled, id).toBe(true)
      expect(command(id)?.hint, id).toMatch(/locked/i)
    }
    // Running, muting, collapsing, expanding, saving — and copying, which takes nothing away and
    // is most wanted on precisely the graph somebody froze to lift a piece out of.
    for (const id of [
      'cmd:mute',
      'cmd:collapse',
      'cmd:expand',
      'cmd:save',
      'cmd:lock',
      'cmd:copy',
    ]) {
      expect(command(id)?.disabled ?? false, id).toBe(false)
    }
  })

  /*
   * Disabled rather than dropped. A palette that answers "Bar Chart" with an empty list reads as
   * a broken search; a greyed row saying why reads as the lock.
   */
  it('keeps every node row visible, greyed, with the reason', () => {
    const rows = buildNodeItems(undefined, true)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.disabled === true)).toBe(true)
    expect(rows.every((row) => /locked/i.test(row.hint ?? ''))).toBe(true)
    expect(buildNodeItems().every((row) => row.disabled !== true)).toBe(true)
  })
})

describe('the context menus', () => {
  /*
   * The least mechanized surface — two hand-written `disabled` pairs — and so the one most worth
   * pinning. A menu item that stayed lit would fall through to the store's *silent* guard, which
   * is the "editor that has started ignoring clicks" failure the visible layer exists to prevent.
   */
  it('grey out the items that edit, and keep the ones that only look', () => {
    render(<App />)
    act(() => useGraphStore.getState().setSelection([nodeId()]))
    lock()
    fireEvent.contextMenu(card(nodeId()))
    expect((button(/^Delete/) as HTMLButtonElement).disabled).toBe(true)
    expect((button(/^Duplicate/) as HTMLButtonElement).disabled).toBe(true)
    // The alignment grid moves cards, so it is on the frozen side with Duplicate and Delete.
    expect((button('Align left edges') as HTMLButtonElement).disabled).toBe(true)
    expect(button('Align left edges').title).toMatch(/locked/i)
    expect((button(/^Cut/) as HTMLButtonElement).disabled).toBe(true)
    expect((button(/^Paste/) as HTMLButtonElement).disabled).toBe(true)
    // Muting and collapsing are not canvas edits, so the same menu still offers them — and
    // neither is copying, which is the one row of the clipboard trio that stays lit.
    expect((button(/^(Mute|Unmute)/) as HTMLButtonElement).disabled).toBe(false)
    expect((button(/^Copy/) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('the keyboard', () => {
  it('refuses ⌘Z and says why, rather than appearing to have stopped working', () => {
    render(<App />)
    act(() => useGraphStore.getState().setParam(nodeId(), 'page', 1))
    const depth = useGraphStore.getState().past.length
    lock()
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    expect(useGraphStore.getState().past.length).toBe(depth)
    expect(useGraphStore.getState().notice).toMatch(/locked/i)
  })

  it('does not open the node browser on Tab', () => {
    render(<App />)
    // The positive control first, so a query that finds nothing either way cannot pass this.
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(browser()).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    lock()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(browser()).toBeNull()
    expect(useGraphStore.getState().notice).toMatch(/locked/i)
  })

  it('still opens the palette on Space — reading the graph is never locked', () => {
    render(<App />)
    lock()
    fireEvent.keyDown(window, { key: ' ' })
    expect(screen.getByRole('listbox')).toBeDefined()
  })
})

describe('the cards', () => {
  it('take their resize handles away, since a resizer never consults nodesDraggable', () => {
    render(<App />)
    const viewer = useGraphStore
      .getState()
      .graph.nodes.find((n) => n.type.startsWith('out.'))?.id
    expect(viewer).toBeDefined()
    act(() => useGraphStore.getState().setSelection([viewer!]))
    expect(document.querySelectorAll('.coda-node__resize-handle').length).toBeGreaterThan(0)
    lock()
    expect(document.querySelectorAll('.coda-node__resize-handle').length).toBe(0)
  })
})

/** The first card's id. */
function nodeId(): string {
  const id = useGraphStore.getState().graph.nodes[0]?.id
  if (!id) throw new Error('no nodes')
  return id
}
