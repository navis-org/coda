// @vitest-environment jsdom

/**
 * The Text note's card, in the real editor.
 *
 * Two halves, matching the two things the feature claims. The first is that it does not look or
 * behave like a node — no sockets, no run button, no state badge — because "a text box, not a
 * node" is the whole requirement and every one of those would be a promise the card cannot keep.
 * The second is the edit cycle: double-click to write, blur to keep, Escape to abandon. Escape is
 * the one worth a test, since unmounting a focused textarea can fire blur on the way out and the
 * naive implementation therefore saves the edit it was asked to throw away.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { requireNodeDef } from '../../core/registry'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 1000, height: 700 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    const store = useGraphStore.getState()
    // The store is a module singleton: the start page renders over everything, and the previous
    // case's graph would otherwise still be on the canvas.
    store.closeStartPage()
    store.newGraph()
  })
})

afterEach(cleanup)

/** Add a note to an empty canvas and return its node id. */
function addNote(text: string): string {
  render(<App />)
  let id = ''
  act(() => {
    id = useGraphStore.getState().addNode('note.text', { x: 120, y: 120 })
    if (text) useGraphStore.getState().setParam(id, 'text', text)
  })
  return id
}

function card(): HTMLElement {
  const el = document.querySelector('.coda-note')
  if (!el) throw new Error('no note card on the canvas')
  return el as HTMLElement
}

describe('the Text note card', () => {
  it('renders its markdown as prose, not as source', async () => {
    addNote('## Step one\n\nPick the neurons with a **regex**.')

    await waitFor(() => expect(document.querySelector('.coda-note')).toBeTruthy())
    expect(screen.getByText('Step one')).toBeTruthy()
    // The parser wraps every run of text in a span, so the emphasis is the span's parent.
    expect(screen.getByText('regex').closest('strong')).toBeTruthy()
    // The markers themselves are gone — the card is not a textarea showing its own source.
    expect(card().textContent).not.toContain('**')
  })

  it('escapes raw HTML rather than mounting it', async () => {
    addNote('Careful: <img src=x onerror="alert(1)"> and <b>bold</b>.')

    await waitFor(() => expect(document.querySelector('.coda-note')).toBeTruthy())
    expect(card().querySelector('img')).toBeNull()
    expect(card().querySelector('b')).toBeNull()
    expect(card().textContent).toContain('<b>bold</b>')
  })

  it('wears none of the node chrome', async () => {
    addNote('Just a note.')
    await waitFor(() => expect(document.querySelector('.coda-note')).toBeTruthy())

    // Not a node card, and not carrying any of a node card's furniture.
    expect(document.querySelector('.coda-node')).toBeNull()
    expect(card().querySelector('.socket')).toBeNull()
    expect(card().querySelector('.state-badge')).toBeNull()
    expect(
      screen.queryAllByRole('button', { name: 'Run this node', hidden: true }),
    ).toHaveLength(0)
    // And it is not work: the toolbar must not report a paragraph of prose as a stale node.
    const store = useGraphStore.getState()
    expect(store.graph.nodes.every((n) => !store.needsRun(n.id))).toBe(true)
  })

  it('offers a hint while it is empty, and drops it once there is text', async () => {
    const id = addNote('')
    await waitFor(() => expect(document.querySelector('.coda-note')).toBeTruthy())
    expect(card().textContent).toContain('Double-click to write')

    act(() => useGraphStore.getState().setParam(id, 'text', 'Now it says something.'))
    expect(card().textContent).toBe('Now it says something.')
  })

  it('edits on double-click and keeps the text on blur', async () => {
    const id = addNote('before')
    await waitFor(() => expect(document.querySelector('.coda-note')).toBeTruthy())

    fireEvent.doubleClick(card())
    const editor = screen.getByLabelText('Note text') as HTMLTextAreaElement
    expect(editor.value).toBe('before')

    fireEvent.change(editor, { target: { value: 'after' } })
    fireEvent.blur(editor)

    expect(useGraphStore.getState().graph.nodes.find((n) => n.id === id)?.params.text).toBe(
      'after',
    )
    // Back to the rendered view, showing what was just written.
    expect(screen.queryByLabelText('Note text')).toBeNull()
    expect(card().textContent).toBe('after')
  })

  it('abandons the edit on Escape, even though leaving the field also blurs it', async () => {
    const id = addNote('before')
    await waitFor(() => expect(document.querySelector('.coda-note')).toBeTruthy())

    fireEvent.doubleClick(card())
    const editor = screen.getByLabelText('Note text') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'discard me' } })
    fireEvent.keyDown(editor, { key: 'Escape' })
    fireEvent.blur(editor)

    expect(useGraphStore.getState().graph.nodes.find((n) => n.id === id)?.params.text).toBe(
      'before',
    )
    expect(card().textContent).toBe('before')
  })

  it('drops its frame when Outline is turned off, and keeps it while editing', async () => {
    const id = addNote('framed')
    await waitFor(() => expect(document.querySelector('.coda-note')).toBeTruthy())

    // The control is inspector-only, so it must not have rendered a checkbox on the card.
    const outline = (requireNodeDef('note.text').params ?? []).find((p) => p.id === 'outline')
    expect(outline?.advanced).toBe(true)
    expect(outline?.default).toBe(true)
    expect(card().querySelector('input[type="checkbox"]')).toBeNull()
    expect(card().dataset.outline).toBeUndefined()

    act(() => useGraphStore.getState().setParam(id, 'outline', false))
    expect(card().dataset.outline).toBe('false')

    // An edit needs a visible target, so the frame returns for as long as the textarea is open.
    fireEvent.doubleClick(card())
    expect(card().dataset.editing).toBe('true')
    fireEvent.blur(screen.getByLabelText('Note text'))
    expect(card().dataset.editing).toBeUndefined()
    expect(card().dataset.outline).toBe('false')
  })

  it('is an ordinary node underneath: adding it is one undo step', async () => {
    // Empty, so the add is the only commit — writing into it is a second, coalesced like any
    // other param edit.
    const id = addNote('')
    await waitFor(() => expect(document.querySelector('.coda-note')).toBeTruthy())
    expect(useGraphStore.getState().graph.nodes).toHaveLength(1)

    act(() => useGraphStore.getState().undo())
    expect(useGraphStore.getState().graph.nodes).toHaveLength(0)
    expect(document.querySelector('.coda-note')).toBeNull()

    act(() => useGraphStore.getState().redo())
    expect(useGraphStore.getState().graph.nodes.map((n) => n.id)).toEqual([id])
  })
})
