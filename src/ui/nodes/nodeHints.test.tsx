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
 * it** — `.coda-node` clips with `overflow: hidden`, so a hint rendered inside it would be
 * invisible in exactly the way jsdom cannot see.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import type { HintTone, NodeHint } from '../../core/graph'
import { HINT_TONES } from '../../core/graph'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { hintKey, resetHintsForTest } from '../hints'
import type { CalloutTone } from '../markdown'

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
 * Written straight onto the graph rather than through an action, because there is no action: a
 * hint is authored by whatever generated the document (`buildWorkflow`, a starter, a Zoo entry),
 * and the store has nothing that adds one. That absence is the feature — see `NodeHint`.
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

function boxes(): HTMLElement[] {
  return [...document.querySelectorAll('.node-hint')] as HTMLElement[]
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

/**
 * The one thing about a hint that is stated in two files and checked in neither.
 *
 * `HINT_TONES` is in `src/core`, which is headless and cannot import `CalloutTone` from
 * `src/ui/markdown.ts`; the vocabulary is the same three words on purpose, because the help
 * documents already draw admonitions in exactly these and a second three-word list meaning the
 * same thing is how "tip" comes to be blue in one place and green in another. A type is not
 * enumerable at runtime, so the agreement is asserted where it lives: in the type system.
 */
type Extends<_A extends B, B> = true

describe('the tones', () => {
  it('are the same three words the help documents use', () => {
    // Mutual assignability, which for two unions is equality. Either list gaining a word the
    // other lacks stops this compiling — the only place that mistake can be caught.
    const bothWays: [Extends<HintTone, CalloutTone>, Extends<CalloutTone, HintTone>] = [
      true,
      true,
    ]
    expect(bothWays).toEqual([true, true])
    expect([...HINT_TONES].sort()).toEqual(['note', 'tip', 'warning'])
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
