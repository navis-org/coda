// @vitest-environment jsdom

/**
 * Collapsing the inspector and the minimap.
 *
 * Both start closed, so the two things worth pinning are that they really are absent — not
 * merely zero-width, which would still swallow clicks along the canvas edge — and that every
 * affordance for getting them back actually works. A panel you cannot reopen is worse than one
 * that was always there.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { DEFAULT_PANELS, loadPanels, savePanels } from '../../store/persistence'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  // Node 26 shadows jsdom's localStorage, so without this the preference silently never
  // persists and the round-trip below cannot be observed at all.
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    // The store is a module singleton, so a toggle in one case would otherwise leak into the
    // next and the "closed by default" assertions would pass or fail by test order.
    useGraphStore.setState({ panels: { ...DEFAULT_PANELS } })
    useGraphStore.getState().loadExample('partners')
  })
})

afterEach(cleanup)

const inspector = () => document.querySelector('.inspector')
const minimap = () => document.querySelector('.react-flow__minimap')
const inspectorToggle = () => screen.getByRole('button', { name: /Inspector/ })

describe('panel defaults', () => {
  it('starts with both collapsed', () => {
    render(<App />)
    expect(inspector()).toBeNull()
    expect(minimap()).toBeNull()
  })

  it('renders no inspector element at all rather than a zero-width one', () => {
    // A collapsed-but-present panel still catches clicks along the right edge of the canvas.
    render(<App />)
    expect(document.querySelectorAll('aside').length).toBe(0)
  })
})

describe('the inspector', () => {
  it('opens from the toolbar and closes again', () => {
    render(<App />)
    fireEvent.click(inspectorToggle())
    expect(inspector()).not.toBeNull()

    fireEvent.click(inspectorToggle())
    expect(inspector()).toBeNull()
  })

  it('reports its state to assistive tech', () => {
    render(<App />)
    expect(inspectorToggle().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(inspectorToggle())
    expect(inspectorToggle().getAttribute('aria-pressed')).toBe('true')
  })

  it('closes from the chevron inside its own header', () => {
    render(<App />)
    fireEvent.click(inspectorToggle())
    fireEvent.click(screen.getByLabelText('Hide inspector'))
    expect(inspector()).toBeNull()
  })

  it('offers that chevron even with nothing selected', () => {
    // The empty state is the most likely place to open it by accident, so it must also be the
    // easiest to leave.
    render(<App />)
    act(() => {
      useGraphStore.getState().setSelection([])
    })
    fireEvent.click(inspectorToggle())
    expect(screen.getByLabelText('Hide inspector')).toBeTruthy()
  })

  it('toggles with the I key', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'i' })
    expect(inspector()).not.toBeNull()
    fireEvent.keyDown(window, { key: 'I' })
    expect(inspector()).toBeNull()
  })

  it('leaves the I key alone when it is a modifier chord', () => {
    // ⌘I and ⇧I belong to the browser and to any future binding; only the bare key is ours.
    render(<App />)
    fireEvent.keyDown(window, { key: 'i', metaKey: true })
    fireEvent.keyDown(window, { key: 'I', shiftKey: true })
    expect(inspector()).toBeNull()
  })
})

describe('the minimap', () => {
  it('opens and closes from its own corner button', () => {
    render(<App />)
    fireEvent.click(screen.getByLabelText('Show minimap'))
    expect(minimap()).not.toBeNull()

    fireEvent.click(screen.getByLabelText('Hide minimap'))
    expect(minimap()).toBeNull()
  })

  it('is given an explicit size, which is what its projection is computed from', () => {
    /*
     * React Flow reads `style.width`/`style.height` to build the map's viewBox. Sizing it in
     * the stylesheet instead leaves it drawing a 200x150 projection into whatever box CSS
     * produced — the map renders, and is silently wrong.
     */
    render(<App />)
    fireEvent.click(screen.getByLabelText('Show minimap'))
    const element = minimap() as HTMLElement
    expect(element.style.width).toBe('180px')
    expect(element.style.height).toBe('120px')
  })

  it('keeps its toggle mounted whether the map is or not', () => {
    // The button is rendered outside `<ReactFlow>` precisely so it does not come and go with
    // the thing it controls — a toggle that vanishes when used cannot be undone.
    render(<App />)
    expect(screen.getByLabelText('Show minimap')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Show minimap'))
    expect(screen.getByLabelText('Hide minimap')).toBeTruthy()
  })
})

describe('the stored preference', () => {
  it('defaults to both canvas panels closed when nothing is stored', () => {
    expect(loadPanels()).toEqual({ inspector: false, minimap: false, style: true })
  })

  it('round-trips', () => {
    savePanels({ inspector: true, minimap: false, style: false })
    expect(loadPanels()).toEqual({ inspector: true, minimap: false, style: false })
  })

  it('reads an absent styling sidebar as open, not as closed', () => {
    // It defaults open, so a preference written before the key existed must not be read as
    // the user having closed it.
    localStorage.setItem('coda.panels.v1', JSON.stringify({ inspector: true, minimap: true }))
    expect(loadPanels().style).toBe(true)
  })

  it('falls back to closed on a value it cannot read', () => {
    // A key written by an older build, or hand-edited. Closed is the safe answer, and throwing
    // here would take the whole app down at startup.
    localStorage.setItem('coda.panels.v1', 'not json')
    expect(loadPanels()).toEqual(DEFAULT_PANELS)
    localStorage.setItem('coda.panels.v1', '{"inspector":"yes"}')
    expect(loadPanels().inspector).toBe(false)
  })

  it('is written when a panel is toggled', () => {
    act(() => {
      useGraphStore.getState().togglePanel('minimap')
    })
    expect(loadPanels().minimap).toBe(true)
  })
})
