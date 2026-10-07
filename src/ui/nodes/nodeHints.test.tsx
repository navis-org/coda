// @vitest-environment jsdom

/**
 * Hint boxes docked to a card's border, in the real editor.
 *
 * The mechanism is small and almost all of it is about what a dismissal is *not*, which is the
 * part that fails silently. A dismissal that reached the document would look identical on screen
 * and would then take an undo step, mark a clean file dirty, and travel down a share link so the
 * colleague being shown a workflow opens it with the guidance already put away. None of that
 * type-checks and none of it shows up in a screenshot, so it is asserted here:
 *
 *  - the graph is **the same object** after a dismissal — not equal, the same, since the store
 *    replaces it on every real edit;
 *  - the undo stack does not grow;
 *  - the fact survives a remount, because "once ever" is the whole reason it is in `localStorage`
 *    rather than beside the Scheduler;
 *  - and it is keyed on the **text**, so the same sentence on a second card in a second graph is
 *    already read. That is the trade `ui/hints.ts` documents, and it is the behaviour the wizard
 *    depends on — a returning reader must not be re-taught by every workflow they generate.
 *
 * The geometry is not tested here and cannot be: jsdom performs no layout, so "docked above the
 * card" is a CSS rule (`bottom: 100%` against React Flow's wrapper) that only a browser can
 * check. What is checkable is that the boxes are **siblings of the card rather than children of
 * it** — `.coda-node` clips its content, so a hint rendered inside it would be
 * invisible in exactly the way jsdom cannot see.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import type { GraphNode, NodeHint } from '../../core/graph'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { hintKey, readerHints, resetHintsForTest } from '../hints'

beforeAll(() => {
  installJsdomStubs({ width: 1000, height: 700 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  resetHintsForTest()
  act(() => {
    const store = useGraphStore.getState()
    store.closeStartPage()
    store.newGraph()
  })
})

afterEach(cleanup)

/**
 * A filter node on an empty canvas carrying these hints.
 *
 * Written straight onto the graph rather than through `setHints`, so these tests stay about
 * drawing and dismissing: a hint that arrives in a generated or loaded document never passed
 * through the store's action either. Writing one is `store/hints.test.ts`.
 */
function addCardWithHints(hints: NodeHint[]): string {
  let id = ''
  act(() => {
    const store = useGraphStore.getState()
    id = store.addNode('core.filterTable', { x: 120, y: 120 })
    useGraphStore.setState({
      graph: {
        ...store.graph,
        nodes: useGraphStore
          .getState()
          .graph.nodes.map((n) => (n.id === id ? { ...n, hints } : n)),
      },
    })
  })
  return id
}

/** The boxes docked to cards — scoped to a stack, since the hint editor previews one too. */
function boxes(): HTMLElement[] {
  return [...document.querySelectorAll('.node-hints .node-hint')] as HTMLElement[]
}

describe('a hint on a card', () => {
  it('draws its markdown, in its tone, on the side it names', async () => {
    render(<App />)
    addCardWithHints([
      { text: 'Search and tick neurons **here**.', tone: 'tip' },
      { text: 'Above the card.', side: 'top' },
    ])

    await waitFor(() => expect(boxes()).toHaveLength(2))
    // Rendered prose, not source: the same `markdown.ts` subset the Text note uses.
    expect(screen.getByText('here').closest('strong')).toBeTruthy()

    const stacks = [...document.querySelectorAll('.node-hints')] as HTMLElement[]
    expect(stacks.map((s) => s.dataset.side).sort()).toEqual(['bottom', 'top'])
    // Absent means `note`, which is the one place that default is spent on screen.
    expect(
      boxes()
        .map((b) => b.dataset.tone)
        .sort(),
    ).toEqual(['note', 'tip'])
  })

  it('escapes raw HTML rather than mounting it', async () => {
    render(<App />)
    // A hint arrives in a `.coda.json` from a gist or the Zoo, exactly as a dataset blurb does.
    addCardWithHints([{ text: 'Careful: <img src=x onerror="alert(1)"> and <b>bold</b>.' }])

    await waitFor(() => expect(boxes()).toHaveLength(1))
    expect(boxes()[0]!.querySelector('img')).toBeNull()
    expect(boxes()[0]!.querySelector('b')).toBeNull()
    expect(boxes()[0]!.textContent).toContain('<b>bold</b>')
  })

  it('renders outside the card, which clips', async () => {
    render(<App />)
    addCardWithHints([{ text: 'Below the card.' }])

    await waitFor(() => expect(boxes()).toHaveLength(1))
    /*
     * `.coda-node` is `overflow: hidden`, so a hint inside it would be cut off at the border in a
     * browser and look perfectly fine here. The relationship is the assertion.
     */
    expect(boxes()[0]!.closest('.coda-node')).toBeNull()
    expect(boxes()[0]!.closest('.react-flow__node')).toBeTruthy()
  })
})

describe('dismissing one', () => {
  it('takes it off the card without touching the document', async () => {
    render(<App />)
    addCardWithHints([{ text: 'First.' }, { text: 'Second.' }])
    await waitFor(() => expect(boxes()).toHaveLength(2))

    const before = useGraphStore.getState()
    const undoBefore = before.past.length

    act(() => {
      fireEvent.click(screen.getAllByLabelText('Dismiss hint')[0]!)
    })
    await waitFor(() => expect(boxes()).toHaveLength(1))
    expect(boxes()[0]!.textContent).toContain('Second.')

    const after = useGraphStore.getState()
    // Identity, not equality: the store replaces the graph on every real edit, so `toBe` is what
    // distinguishes "nothing changed" from "changed to the same thing".
    expect(after.graph).toBe(before.graph)
    expect(after.past.length).toBe(undoBefore)
    // Both hints are still in the document — what was read is a fact about the reader.
    expect(after.graph.nodes.flatMap((n) => n.hints ?? [])).toHaveLength(2)
  })

  it('stays dismissed across a remount, and across a different graph', async () => {
    const shared: NodeHint = { text: 'Press Run, or ⇧R, to evaluate the chain.' }

    render(<App />)
    addCardWithHints([shared])
    await waitFor(() => expect(boxes()).toHaveLength(1))
    act(() => {
      fireEvent.click(screen.getByLabelText('Dismiss hint'))
    })
    await waitFor(() => expect(boxes()).toHaveLength(0))

    cleanup()
    act(() => {
      const store = useGraphStore.getState()
      store.closeStartPage()
      store.newGraph()
    })
    render(<App />)
    /*
     * A *different* node in a *different* graph carrying the same sentence. Keyed on the text, so
     * it is already read — which is what makes "once ever" true for a wizard that mints a fresh
     * graph every time it is used, and is the trade `ui/hints.ts` states.
     */
    addCardWithHints([shared, { text: 'But this one is new.' }])
    await waitFor(() => expect(boxes()).toHaveLength(1))
    expect(boxes()[0]!.textContent).toContain('But this one is new.')
  })

  it('is offered back by the node menu, for that card only', async () => {
    render(<App />)
    const id = addCardWithHints([{ text: 'On this card.' }])
    addCardWithHints([{ text: 'On the other card.' }])
    await waitFor(() => expect(boxes()).toHaveLength(2))

    act(() => {
      for (const button of screen.getAllByLabelText('Dismiss hint')) fireEvent.click(button)
    })
    await waitFor(() => expect(boxes()).toHaveLength(0))

    act(() => {
      fireEvent.contextMenu(document.querySelector(`[data-id="${id}"]`)!)
    })
    await waitFor(() => expect(screen.queryByText('Show Hints')).toBeTruthy())
    act(() => {
      fireEvent.click(screen.getByText('Show Hints'))
    })

    // One back, not both: a right-click on one card is not a request about the whole canvas.
    await waitFor(() => expect(boxes()).toHaveLength(1))
    expect(boxes()[0]!.textContent).toContain('On this card.')
  })
})

describe('the key', () => {
  it('is the text, and nothing else on the hint', () => {
    // Re-toning a warning to a note does not make it something the reader has not read, and the
    // side is where it is drawn. Both would otherwise bring a dismissed hint back for everybody.
    expect(hintKey({ text: 'Same words.' })).toBe(
      hintKey({ text: '  Same words.  ', tone: 'warning', side: 'top' }),
    )
    expect(hintKey({ text: 'Same words.' })).not.toBe(hintKey({ text: 'Other words.' }))
  })
})

describe('editing one from the card', () => {
  it('opens the editor from the ✎, and saving rewords the box as one undo step', async () => {
    render(<App />)
    addCardWithHints([{ text: 'Keep me.' }, { text: 'Old words.' }])
    await waitFor(() => expect(boxes()).toHaveLength(2))

    act(() => {
      fireEvent.click(screen.getAllByLabelText('Edit hint')[1]!)
    })
    const dialog = await screen.findByRole('dialog', { name: 'Edit hint' })
    expect((dialog.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Old words.')

    act(() => {
      fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'New words.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })
    await waitFor(() => expect(boxes()[1]!.textContent).toContain('New words.'))
    expect(screen.queryByRole('dialog', { name: 'Edit hint' })).toBeNull()
  })
})

/**
 * A hint derived from the reader's browser (`NodeDefinition.readerHints`), never written to the document.
 *
 * jsdom has no `showOpenFilePicker`, so it stands in for Firefox and Safari here; the Chromium
 * case stubs the picker onto `window`.
 */
describe('a hint derived from this browser', () => {
  function addLinkTable(params: Record<string, string>): string {
    let id = ''
    act(() => {
      const store = useGraphStore.getState()
      id = store.addNode('core.linkTable', { x: 120, y: 120 })
      for (const [key, value] of Object.entries(params)) store.setParam(id, key, value)
    })
    return id
  }

  const FORGETS = /cannot keep a local file across a reload/

  it('says a local file must be chosen again after a reload, and is not in the document', async () => {
    render(<App />)
    addLinkTable({ fileId: 'file-abc', fileName: 'synapses.parquet' })

    await waitFor(() => expect(boxes()).toHaveLength(1))
    expect(boxes()[0]!.textContent).toMatch(FORGETS)
    // Nothing in the document to edit, so no ✎ — only the ×.
    expect(screen.queryByLabelText('Edit hint')).toBeNull()
    expect(useGraphStore.getState().graph.nodes.flatMap((n) => n.hints ?? [])).toEqual([])
  })

  it('is absent for a URL, which survives a reload in every browser', async () => {
    render(<App />)
    addLinkTable({ url: 'https://example.org/synapses.parquet' })
    // Give the card a render in which a box would have appeared.
    await waitFor(() => expect(document.querySelector('.upload-body')).toBeTruthy())
    expect(boxes()).toHaveLength(0)
  })

  it('reads a stored node with its defaults filled, as a file written elsewhere arrives', () => {
    // No `fileId` key at all — read raw, it was the text "undefined" and so a local file.
    const stored = {
      id: 'n',
      type: 'core.linkTable',
      params: { url: 'https://x.org/a.parquet' },
    }
    expect(readerHints(stored as unknown as GraphNode)).toHaveLength(0)
  })

  it('is absent where the browser can remember the file', async () => {
    const win = window as Window & { showOpenFilePicker?: unknown }
    win.showOpenFilePicker = () => Promise.resolve([])
    try {
      render(<App />)
      addLinkTable({ fileId: 'file-abc', fileName: 'synapses.parquet' })
      await waitFor(() => expect(document.querySelector('.upload-body')).toBeTruthy())
      expect(boxes()).toHaveLength(0)
    } finally {
      delete win.showOpenFilePicker
    }
  })

  it('dismisses like any other, and the node menu offers it back', async () => {
    render(<App />)
    const id = addLinkTable({ fileId: 'file-abc', fileName: 'synapses.parquet' })
    await waitFor(() => expect(boxes()).toHaveLength(1))
    const before = useGraphStore.getState().graph

    act(() => {
      fireEvent.click(screen.getByLabelText('Dismiss hint'))
    })
    await waitFor(() => expect(boxes()).toHaveLength(0))
    expect(useGraphStore.getState().graph).toBe(before)

    act(() => {
      fireEvent.contextMenu(document.querySelector(`[data-id="${id}"]`)!)
    })
    await waitFor(() => expect(screen.queryByText('Show Hints')).toBeTruthy())
    act(() => {
      fireEvent.click(screen.getByText('Show Hints'))
    })
    await waitFor(() => expect(boxes()).toHaveLength(1))
  })
})
