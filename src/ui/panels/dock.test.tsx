// @vitest-environment jsdom

/**
 * The pinned viewer dock.
 *
 * Three things here are load-bearing and none is visible in a screenshot, which is why they are
 * tested rather than looked at:
 *
 *  - **The pin and the expansion are mutually exclusive.** Two live surfaces for one node means
 *    two WebGL contexts, or two neuroglancer embeds each fetching EM. Enforced in the store, so
 *    the assertion is on the store.
 *  - **The card behind it stands down.** `showPreview` is the same rule, extended; without this
 *    the dock costs a second renderer rather than moving the first.
 *  - **A pin does not survive the graph it was made in.** A node id means nothing in the next
 *    document, and a dock left open on one would draw an empty half-screen.
 *
 * jsdom performs no layout, so nothing here can check that the dock is half the window — that is
 * a grid column and belongs to a browser. What is checkable is the number the column is given.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import {
  DEFAULT_DOCK_FRACTION,
  DOCK_MAX_FRACTION,
  DOCK_MIN_FRACTION,
} from '../../store/persistence'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 500 })
  registerSource(new MockSource({ latencyMs: 0 }))
  installStorageStub()
})

beforeEach(() => {
  clearStorage()
  act(() => {
    // `loadExample` goes through `loadGraph`, which clears both full-size surfaces itself — so
    // the graph is the whole reset, and the width is the one thing storage does not carry back.
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
    useGraphStore.getState().setDockFraction(DEFAULT_DOCK_FRACTION)
  })
})

afterEach(cleanup)

/**
 * Render the shell over the graph the fixture already loaded, and run it.
 *
 * `run` is opt-in: the dock draws "no result yet" perfectly well without one, so the tests about
 * *which* node is docked skip the evaluation entirely.
 */
async function renderRun(run = true) {
  render(<App />)
  if (run) {
    await act(async () => {
      await useGraphStore.getState().runAll()
    })
  }
}

function dock() {
  return screen.queryByRole('complementary', { name: 'Pinned viewer' })
}

describe('ViewerDock', () => {
  it('is absent until something is pinned', async () => {
    await renderRun()
    expect(dock()).toBeNull()
    // And the shell says so, which is what sizes the column.
    expect(document.querySelector('.app')?.getAttribute('data-dock')).toBeNull()
  })

  it('draws the node beside the canvas, with the canvas still there', async () => {
    await renderRun()
    act(() => useGraphStore.getState().pinNode('view'))
    const panel = await waitFor(() => {
      const found = dock()
      expect(found).not.toBeNull()
      return found!
    })
    expect(within(panel).getByRole('table')).toBeTruthy()
    expect(panel.textContent).toContain('DNp02')
    // Not a modal: the canvas is still mounted and still reachable.
    expect(document.querySelector('.canvas-area')).not.toBeNull()
    expect(screen.queryByRole('dialog', { name: /output/ })).toBeNull()
    expect(document.querySelector('.app')?.getAttribute('data-dock')).toBe('open')
  })

  it('unpins from its own button', async () => {
    await renderRun()
    act(() => useGraphStore.getState().pinNode('view'))
    const panel = await waitFor(() => dock()!)
    fireEvent.click(within(panel).getByLabelText('Unpin viewer'))
    expect(useGraphStore.getState().pinnedNodeId).toBeUndefined()
    expect(dock()).toBeNull()
  })

  /*
   * The memory rule, from both directions. A node drawn in two full-size surfaces at once is two
   * renderers; the store is what refuses, so neither caller has to remember.
   */
  it('releases the pin when the same node is expanded, and the reverse', async () => {
    await renderRun()
    act(() => useGraphStore.getState().pinNode('view'))
    act(() => useGraphStore.getState().expandNode('view'))
    expect(useGraphStore.getState().pinnedNodeId).toBeUndefined()
    expect(useGraphStore.getState().expandedNodeId).toBe('view')

    act(() => useGraphStore.getState().pinNode('view'))
    expect(useGraphStore.getState().expandedNodeId).toBeUndefined()
    expect(useGraphStore.getState().pinnedNodeId).toBe('view')
  })

  /*
   * Closing the overlay is `expandNode(undefined)`, which must not be read as "clear everything
   * full-size" — a dock open behind a modal is a thing somebody set up on purpose.
   */
  it('survives the overlay being closed', async () => {
    await renderRun()
    act(() => useGraphStore.getState().pinNode('view'))
    act(() => useGraphStore.getState().expandNode('table'))
    act(() => useGraphStore.getState().expandNode(undefined))
    expect(useGraphStore.getState().pinnedNodeId).toBe('view')
  })

  it('closes when the pinned node is deleted, and when a new graph is loaded', async () => {
    await renderRun()
    act(() => useGraphStore.getState().pinNode('view'))
    act(() => useGraphStore.getState().deleteNodes(['view']))
    expect(useGraphStore.getState().pinnedNodeId).toBeUndefined()

    act(() => useGraphStore.getState().pinNode('table'))
    act(() => useGraphStore.getState().loadGraph(demoWorkflow('matrix')))
    expect(useGraphStore.getState().pinnedNodeId).toBeUndefined()
    expect(dock()).toBeNull()
  })

  /**
   * The card behind a pinned viewer draws nothing — the same rule that already applied to the
   * overlay, for the same measured reason. Read off the DOM rather than off `showPreview`,
   * because the point is that no second renderer is mounted.
   */
  it('stands the node card down while it holds the node', async () => {
    await renderRun()
    const previews = () => document.querySelectorAll('.coda-node__preview').length
    const before = previews()
    expect(before).toBeGreaterThan(0)
    act(() => useGraphStore.getState().pinNode('view'))
    await waitFor(() => expect(previews()).toBe(before - 1))
    act(() => useGraphStore.getState().pinNode(undefined))
    await waitFor(() => expect(previews()).toBe(before))
  })

  it('toggles from the card and reports its state to a reader', async () => {
    await renderRun()
    const pin = screen.getAllByLabelText('Pin output to the side')[0]!
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pin)
    expect(useGraphStore.getState().pinnedNodeId).toBeTruthy()
    const pressed = screen.getByLabelText('Unpin output')
    expect(pressed.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(pressed)
    expect(useGraphStore.getState().pinnedNodeId).toBeUndefined()
  })

  /*
   * `P` toggles against the selected node, not against "is anything pinned": with a second
   * viewer selected it moves the dock rather than closing it.
   */
  it('binds P to the selection, and moves rather than closes', async () => {
    await renderRun(false)
    act(() => useGraphStore.getState().setSelection(['view']))
    fireEvent.keyDown(window, { key: 'p' })
    expect(useGraphStore.getState().pinnedNodeId).toBe('view')

    act(() => useGraphStore.getState().setSelection(['table']))
    fireEvent.keyDown(window, { key: 'p' })
    expect(useGraphStore.getState().pinnedNodeId).toBe('table')

    fireEvent.keyDown(window, { key: 'p' })
    expect(useGraphStore.getState().pinnedNodeId).toBeUndefined()
  })

  it('leaves the dock alone when more than one node is selected', async () => {
    await renderRun(false)
    act(() => useGraphStore.getState().setSelection(['view', 'table']))
    fireEvent.keyDown(window, { key: 'p' })
    expect(useGraphStore.getState().pinnedNodeId).toBeUndefined()
  })

  describe('width', () => {
    it('is published to the shell as a percentage of the window', async () => {
      await renderRun(false)
      act(() => useGraphStore.getState().pinNode('view'))
      const app = document.querySelector<HTMLElement>('.app')!
      expect(app.style.getPropertyValue('--dock-width')).toBe(`${DEFAULT_DOCK_FRACTION * 100}%`)
    })

    it('is clamped at both ends, so neither column can be squeezed out', () => {
      const store = useGraphStore.getState()
      act(() => store.setDockFraction(0.95))
      expect(useGraphStore.getState().dockFraction).toBe(DOCK_MAX_FRACTION)
      act(() => store.setDockFraction(0.01))
      expect(useGraphStore.getState().dockFraction).toBe(DOCK_MIN_FRACTION)
      // A width read back from storage as nonsense is the default, not NaN — which would reach
      // `grid-template-columns` as an invalid value and silently drop the whole declaration.
      act(() => store.setDockFraction(Number.NaN))
      expect(useGraphStore.getState().dockFraction).toBe(DEFAULT_DOCK_FRACTION)
    })

    it('is reachable from the keyboard through the grip', async () => {
      await renderRun(false)
      act(() => useGraphStore.getState().pinNode('view'))
      const grip = await waitFor(() => screen.getByRole('separator', { name: 'Dock width' }))
      const before = useGraphStore.getState().dockFraction
      fireEvent.keyDown(grip, { key: 'ArrowLeft' })
      expect(useGraphStore.getState().dockFraction).toBeGreaterThan(before)
      fireEvent.keyDown(grip, { key: 'ArrowRight' })
      expect(useGraphStore.getState().dockFraction).toBeCloseTo(before, 10)
    })

    it('survives a reload', async () => {
      act(() => useGraphStore.getState().setDockFraction(0.3))
      // Same read the store makes when it is created.
      const { loadDockFraction } = await import('../../store/persistence')
      expect(loadDockFraction()).toBe(0.3)
    })
  })
})
