// @vitest-environment jsdom

/**
 * The hint editor and the node menu row that opens it, rendered directly.
 *
 * Three things here fail silently. **Cancel must write nothing** — the graph object is asserted
 * identical, since an equal-but-new graph is an undo step and a dirty file. **Keys must stop at
 * the dialog**, or Backspace in the text deletes the card being written about. And **a hint that
 * leaves from under the editor closes it**, or Save writes onto a deleted node or over whichever
 * hint an undo moved into that position. The in-canvas route (the ✎ on a box) is in
 * `ui/nodes/nodeHints.test.tsx`, which mounts the real editor.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_HINTS } from '../../core/graph'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage } from '../../test/jsdomStubs'
import { resetHintsForTest } from '../hints'
import { HintEditor } from './HintEditor'
import { NodeContextMenu } from './NodeContextMenu'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

let id = ''

beforeEach(() => {
  clearStorage()
  resetHintsForTest()
  useGraphStore.setState({ locked: false })
  useGraphStore.getState().newGraph()
  id = useGraphStore.getState().addNode('core.filterTable', { x: 0, y: 0 })
})

afterEach(cleanup)

const store = () => useGraphStore.getState()
const node = () => store().graph.nodes.find((n) => n.id === id)!

/** Opens on the node's hint at `index`, or on a new hint. */
function openEditor(index?: number): void {
  const hint = index === undefined ? undefined : node().hints![index]
  act(() => store().editHint({ nodeId: id, ...(hint ? { hint } : {}) }))
  render(<HintEditor />)
}

function type(text: string): void {
  fireEvent.change(screen.getByLabelText('Hint text'), { target: { value: text } })
}

describe('the node menu row', () => {
  function menuOn(nodeId: string) {
    render(
      <NodeContextMenu
        nodeId={nodeId}
        screenPosition={{ x: 0, y: 0 }}
        onClose={() => undefined}
      />,
    )
  }

  it('opens the editor on the clicked card', () => {
    menuOn(id)
    fireEvent.click(screen.getByText('Add Hint…'))
    expect(store().editingHint).toEqual({ nodeId: id })
  })

  it('is live under the lock', () => {
    useGraphStore.setState({ locked: true })
    menuOn(id)
    expect((screen.getByText('Add Hint…') as HTMLButtonElement).disabled).toBe(false)
  })

  it('is greyed, with the reason, once the card carries the most hints it draws', () => {
    store().setHints(
      id,
      Array.from({ length: MAX_HINTS }, (_, i) => ({ text: `Hint ${i}.` })),
    )
    menuOn(id)
    const row = screen.getByText('Add Hint…') as HTMLButtonElement
    expect(row.disabled).toBe(true)
    expect(row.title).toContain(`${MAX_HINTS} hints`)
  })

  it('is not offered on a Text note, which is prose already', () => {
    const note = store().addNode('note.text', { x: 400, y: 0 })
    menuOn(note)
    expect(screen.queryByText('Add Hint…')).toBeNull()
  })
})

describe('adding a hint', () => {
  it('saves the trimmed text with the tone and side chosen, and closes', () => {
    openEditor()
    type('  Tick a few neurons **here** first.  ')
    fireEvent.click(screen.getByRole('button', { name: 'Warning' }))
    fireEvent.click(screen.getByRole('button', { name: 'Above' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(node().hints).toEqual([
      { text: 'Tick a few neurons **here** first.', tone: 'warning', side: 'top' },
    ])
    expect(store().editingHint).toBeUndefined()
  })

  it('appends to the hints already there, with no tone or side stored for the defaults', () => {
    store().setHints(id, [{ text: 'First.' }])
    openEditor()
    type('Second.')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(node().hints).toEqual([{ text: 'First.' }, { text: 'Second.' }])
  })

  it('previews the markdown as the card will draw it', () => {
    openEditor()
    type('Look **here**.')
    expect(screen.getByText('here').closest('strong')).toBeTruthy()
    expect(screen.getByLabelText('Preview').querySelector('.node-hint')).toBeTruthy()
  })

  it('will not save an empty hint', () => {
    openEditor()
    type('   ')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('writes nothing on Cancel or Escape', () => {
    const before = store().graph
    openEditor()
    type('Never mind.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(store().editingHint).toBeUndefined()
    expect(store().graph).toBe(before)

    cleanup()
    openEditor()
    type('Never mind either.')
    fireEvent.keyDown(screen.getByLabelText('Hint text'), { key: 'Escape' })
    expect(store().editingHint).toBeUndefined()
    expect(store().graph).toBe(before)
  })

  it('keeps keys away from the canvas, and saves on ⌘⏎', () => {
    const canvas = vi.fn()
    window.addEventListener('keydown', canvas)
    try {
      openEditor()
      type('Typed.')
      fireEvent.keyDown(screen.getByLabelText('Hint text'), { key: 'Backspace' })
      expect(canvas).not.toHaveBeenCalled()

      fireEvent.keyDown(screen.getByLabelText('Hint text'), { key: 'Enter', metaKey: true })
      expect(node().hints).toEqual([{ text: 'Typed.' }])
    } finally {
      window.removeEventListener('keydown', canvas)
    }
  })
})

describe('editing a hint', () => {
  beforeEach(() => {
    store().setHints(id, [{ text: 'Keep me.' }, { text: 'Old words.', tone: 'tip' }])
  })

  it('opens on the hint it names, and saves over that one only', () => {
    openEditor(1)
    const text = screen.getByLabelText('Hint text') as HTMLTextAreaElement
    expect(text.value).toBe('Old words.')
    expect(screen.getByRole('button', { name: 'Tip' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    // Nothing changed yet, so there is nothing to save.
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    type('New words.')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(node().hints).toEqual([{ text: 'Keep me.' }, { text: 'New words.', tone: 'tip' }])
  })

  it('deletes the hint it names, for everybody', () => {
    openEditor(0)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(node().hints).toEqual([{ text: 'Old words.', tone: 'tip' }])
    expect(store().editingHint).toBeUndefined()
  })

  it('offers no Delete on a hint that does not exist yet', () => {
    openEditor()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('closes rather than writing over a neighbour when an edit shifts the list', () => {
    openEditor(0)
    type('Reworded.')
    // A hint inserted ahead of it: by position, the editor would now be on `Inserted.`.
    act(() =>
      store().setHints(id, [
        { text: 'Inserted.' },
        { text: 'Keep me.' },
        { text: 'Old words.', tone: 'tip' },
      ]),
    )
    expect(store().editingHint).toBeUndefined()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(node().hints!.map((h) => h.text)).toEqual(['Inserted.', 'Keep me.', 'Old words.'])
  })

  it('closes when the card is deleted', () => {
    openEditor(0)
    act(() => store().deleteNodes([id]))
    expect(store().editingHint).toBeUndefined()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
