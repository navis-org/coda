// @vitest-environment jsdom

/**
 * The three layout buttons, in the real editor.
 *
 * What is worth pinning here is not that a button renders but the *rules around the toggle*,
 * because every one of them is invisible to a type check and each would read as the feature
 * being broken rather than as a decision:
 *
 *  - a drag turns auto-layout off, so a position somebody chose outranks one ELK computed;
 *  - opening a graph turns it off too, for the same reason;
 *  - `arrangeNodes` — the layout's own write path — does *not*, or the mode would switch itself
 *    off the first time it ran;
 *  - and the options survive a reload.
 *
 * The arrangement itself is not exercised: ELK is loaded through a dynamic import and jsdom
 * measures nothing, so a pass here would arrange a set of zero-sized boxes. The mapping and the
 * arithmetic are covered headlessly in `layout/layout.test.ts` against the real algorithm.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { emptyGraph } from '../../core/graph'
import { isAnnotation } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { DEFAULT_LAYOUT_OPTIONS } from '../../layout/options'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { loadLayoutPrefs } from '../../store/persistence'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  // Node 26 shadows jsdom's localStorage, so without this every persistence path degrades
  // silently and the round-trips below would pass against nothing at all.
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    // The store is a module singleton, so state set by one case would otherwise decide the next
    // one's result by test order.
    useGraphStore.setState({ autoLayout: false, layoutOptions: { ...DEFAULT_LAYOUT_OPTIONS } })
    useGraphStore.getState().loadExample('partners')
    useGraphStore.getState().closeStartPage()
  })
})

afterEach(cleanup)

const arrangeButton = () => screen.getByRole('button', { name: /Arrange/ })
const autoButton = () => screen.getByRole('button', { name: 'Auto-layout' })
const optionsButton = () => screen.getByRole('button', { name: 'Layout options' })
const bubble = () => screen.queryByRole('group', { name: 'Layout options' })

describe('the layout controls', () => {
  it('adds three buttons to the canvas rail, beside zoom and fit', () => {
    render(<App />)
    const rail = document.querySelector('.react-flow__controls')
    expect(rail).not.toBeNull()
    for (const button of [arrangeButton(), autoButton(), optionsButton()]) {
      // In the rail rather than the toolbar: a control whose effect is on the canvas belongs
      // over the canvas, next to the other things that move the view.
      expect(rail?.contains(button)).toBe(true)
    }
  })

  it('says which arrange the button will do', () => {
    render(<App />)
    expect(arrangeButton().getAttribute('aria-label')).toBe('Arrange all nodes')

    const ids = useGraphStore
      .getState()
      .graph.nodes.slice(0, 2)
      .map((n) => n.id)
    act(() => useGraphStore.getState().setSelection(ids))
    // Two or more selected means "tidy these", and the button has to say so — otherwise the
    // same press does two different things with nothing on screen distinguishing them.
    expect(arrangeButton().getAttribute('aria-label')).toBe('Arrange the selected nodes')
  })
})

describe('the auto-layout toggle', () => {
  it('reports its state and remembers it', () => {
    render(<App />)
    expect(autoButton().getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(autoButton())
    expect(autoButton().getAttribute('aria-pressed')).toBe('true')
    expect(useGraphStore.getState().autoLayout).toBe(true)
    expect(loadLayoutPrefs().auto).toBe(true)
  })

  it('is switched off by a drag, at the end of the gesture', () => {
    render(<App />)
    fireEvent.click(autoButton())

    const first = useGraphStore.getState().graph.nodes[0]!
    // Mid-gesture frames leave it on: clearing on the first pixel of a drag would make the mode
    // impossible to keep on while nudging anything.
    act(() =>
      useGraphStore.getState().moveNodes([{ id: first.id, position: { x: 5, y: 5 } }], false),
    )
    expect(useGraphStore.getState().autoLayout).toBe(true)

    act(() =>
      useGraphStore.getState().moveNodes([{ id: first.id, position: { x: 9, y: 9 } }], true),
    )
    expect(useGraphStore.getState().autoLayout).toBe(false)
    expect(autoButton().getAttribute('aria-pressed')).toBe('false')
  })

  it('is not switched off by the layout writing its own positions', () => {
    /*
     * The reason `arrangeNodes` exists at all rather than reusing `moveNodes`. Sent down the
     * drag path, an arrange would turn the mode off every single time it ran — so auto-layout
     * would work exactly once and then appear to have a mind of its own.
     */
    render(<App />)
    fireEvent.click(autoButton())

    const first = useGraphStore.getState().graph.nodes[0]!
    act(() => useGraphStore.getState().arrangeNodes(new Map([[first.id, { x: 400, y: 200 }]])))

    expect(useGraphStore.getState().autoLayout).toBe(true)
    expect(useGraphStore.getState().graph.nodes[0]?.position).toEqual({ x: 400, y: 200 })
  })

  it('makes one undo step out of a whole arrangement', () => {
    render(<App />)
    const before = useGraphStore.getState().graph.nodes.map((n) => ({ ...n.position }))
    const moves = new Map(
      useGraphStore.getState().graph.nodes.map((n, i) => [n.id, { x: i * 100, y: 0 }]),
    )
    act(() => useGraphStore.getState().arrangeNodes(moves))
    act(() => useGraphStore.getState().undo())

    expect(useGraphStore.getState().graph.nodes.map((n) => ({ ...n.position }))).toEqual(before)
  })

  it('is switched off by opening a graph', () => {
    /*
     * Same rule as the drag: the positions in a file are somebody's decision. A mode that
     * re-arranged on open would mean a saved layout could not survive being looked at.
     */
    render(<App />)
    fireEvent.click(autoButton())
    act(() => useGraphStore.getState().loadGraph(emptyGraph('opened')))

    expect(useGraphStore.getState().autoLayout).toBe(false)
    expect(loadLayoutPrefs().auto).toBe(false)
  })
})

describe('arranging', () => {
  it('spaces cards by their real size, so no two of them overlap', async () => {
    /*
     * The regression that prompted this test. Sizes were read off `getNodes()`, whose nodes are
     * the objects this app builds and which therefore carry no `measured` at all — so every card
     * fell back to `FALLBACK_NODE_SIZE` and ELK arranged a row of identical 232x120 boxes. The
     * wide ones then had their neighbours packed straight through them: Explore is 520 across, a
     * dataset card 248, a Profile 560.
     *
     * Asserted as *no overlap at the real size* rather than as a spacing number, because that is
     * the property the user sees, and because a spacing threshold is exactly what a row of
     * fallback boxes can accidentally satisfy. `installJsdomStubs` reports one size for every
     * element, which is nothing like a real canvas but is emphatically not 232 — enough that a
     * layout built from measurements and one built from the fallback cannot be confused.
     */
    render(<App />)
    const card = document.querySelector<HTMLElement>('.react-flow__node[data-id]')
    const size = { width: card!.offsetWidth, height: card!.offsetHeight }
    expect(size.width).toBeGreaterThan(300)

    const arrangedIds = useGraphStore
      .getState()
      .graph.nodes.filter((n) => !isAnnotation(n.type))
      .map((n) => n.id)
    const before = useGraphStore.getState().graph.nodes.map((n) => ({ ...n.position }))

    fireEvent.click(arrangeButton())
    await waitFor(() => {
      expect(useGraphStore.getState().graph.nodes.map((n) => ({ ...n.position }))).not.toEqual(
        before,
      )
    })

    const boxes = useGraphStore
      .getState()
      .graph.nodes.filter((n) => arrangedIds.includes(n.id))
      .map((n) => ({ id: n.id, ...n.position, ...size }))
    const collisions: string[] = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!
        const b = boxes[j]!
        if (
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height
        ) {
          collisions.push(`${a.id}/${b.id}`)
        }
      }
    }
    expect(collisions).toEqual([])
  })

  it('re-arranges when a node is added, with auto-layout on', async () => {
    /*
     * The wiring, end to end, asserted as "still nothing overlaps" rather than as "the newcomer
     * moved" — a node dropped outside the graph's bounds becomes the block's own anchor, so ELK
     * placing it at the block's top-left can legitimately leave it exactly where it fell.
     *
     * The specific race this replaced — the effect cancelling its own pending arrange when it
     * re-ran after a card was laid out, and never rescheduling it — cannot be reproduced here:
     * jsdom does no layout, so every card reports a size immediately and the second pass that
     * did the cancelling never happens. See `useArrange.ts` for what that one cost.
     */
    render(<App />)
    const card = document.querySelector<HTMLElement>('.react-flow__node[data-id]')
    const size = { width: card!.offsetWidth, height: card!.offsetHeight }

    fireEvent.click(autoButton())
    await waitFor(() => {
      expect(useGraphStore.getState().past.length).toBeGreaterThan(0)
    })
    const settled = useGraphStore.getState().past.length

    act(() => {
      useGraphStore.getState().addNode('core.sort', { x: 200, y: 200 })
    })
    // The add itself is one entry; the arrange it triggers is the next.
    await waitFor(() => {
      expect(useGraphStore.getState().past.length).toBeGreaterThan(settled + 1)
    })

    const boxes = useGraphStore
      .getState()
      .graph.nodes.filter((n) => !isAnnotation(n.type))
      .map((n) => ({ id: n.id, ...n.position, ...size }))
    const collisions: string[] = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!
        const b = boxes[j]!
        if (
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height
        ) {
          collisions.push(`${a.id}/${b.id}`)
        }
      }
    }
    expect(collisions).toEqual([])
  })

  it('is one undo step even though it animates', async () => {
    render(<App />)
    const before = useGraphStore.getState().graph.nodes.map((n) => ({ ...n.position }))
    const depth = useGraphStore.getState().past.length

    fireEvent.click(arrangeButton())
    await waitFor(() => {
      expect(useGraphStore.getState().graph.nodes.map((n) => ({ ...n.position }))).not.toEqual(
        before,
      )
    })
    // The animation's frames never reach the store, so a whole arrangement is one entry.
    expect(useGraphStore.getState().past.length).toBe(depth + 1)
    act(() => useGraphStore.getState().undo())
    expect(useGraphStore.getState().graph.nodes.map((n) => ({ ...n.position }))).toEqual(before)
  })
})

describe('the options bubble', () => {
  it('opens on the third button and closes again', () => {
    render(<App />)
    expect(bubble()).toBeNull()

    fireEvent.click(optionsButton())
    expect(bubble()).not.toBeNull()
    expect(optionsButton().getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(optionsButton())
    expect(bubble()).toBeNull()
  })

  it('holds the six controls, and each one writes through and persists', () => {
    render(<App />)
    fireEvent.click(optionsButton())

    fireEvent.change(screen.getByRole('combobox', { name: /Algorithm/ }), {
      target: { value: 'mrtree' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'DOWN' }))
    fireEvent.change(screen.getByRole('slider', { name: /Node gap/ }), {
      target: { value: '72' },
    })
    fireEvent.change(screen.getByRole('slider', { name: /Layer gap/ }), {
      target: { value: '120' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /Pack disconnected/ }))

    const options = useGraphStore.getState().layoutOptions
    expect(options).toMatchObject({
      algorithm: 'mrtree',
      direction: 'DOWN',
      nodeSpacing: 72,
      layerSpacing: 120,
      packComponents: false,
    })
    // Per-user and remembered, rather than written into the `.coda.json` — a file you were sent
    // must not silently re-arrange itself to somebody else's taste.
    expect(loadLayoutPrefs().options).toMatchObject({ algorithm: 'mrtree', direction: 'DOWN' })
  })

  it('disables Alignment away from layered rather than removing it', () => {
    render(<App />)
    fireEvent.click(optionsButton())
    const alignment = screen.getByRole('combobox', { name: /Alignment/ })
    expect((alignment as HTMLSelectElement).disabled).toBe(false)

    fireEvent.change(screen.getByRole('combobox', { name: /Algorithm/ }), {
      target: { value: 'force' },
    })
    // Still there, so the bubble does not change height under the pointer and the control's
    // absence has a visible cause.
    expect(
      (screen.getByRole('combobox', { name: /Alignment/ }) as HTMLSelectElement).disabled,
    ).toBe(true)
  })

  it('marks the direction in force', () => {
    render(<App />)
    fireEvent.click(optionsButton())
    expect(screen.getByRole('button', { name: 'RIGHT' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'UP' }))
    expect(screen.getByRole('button', { name: 'UP' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'RIGHT' }).getAttribute('aria-pressed')).toBe(
      'false',
    )
  })
})
