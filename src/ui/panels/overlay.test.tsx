// @vitest-environment jsdom

/**
 * The full-size viewer overlay.
 *
 * The behaviour worth pinning down is the interaction between the overlay and the engine:
 * the rail edits presentational params, and those must re-render the view *without* marking
 * the graph stale. If that ever regresses, inspecting a result would start invalidating it.
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
import {
  clearStorage,
  installDownloadCapture,
  installFullscreenStub,
  installJsdomStubs,
} from '../../test/jsdomStubs'

/** jsdom implements no Fullscreen API at all. Shared with `ui/fullscreen.test.tsx`. */
let fullscreen: ReturnType<typeof installFullscreenStub>

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 500 })
  registerSource(new MockSource({ latencyMs: 0 }))
  fullscreen = installFullscreenStub()
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().expandNode(undefined)
    useGraphStore.getState().loadExample('partners')
  })
})

afterEach(cleanup)

/** Load a graph, run it, and open the overlay on `nodeId`. */
async function openOverlay(example: string, nodeId: string) {
  act(() => {
    useGraphStore.getState().loadExample(example)
  })
  render(<App />)
  await act(async () => {
    await useGraphStore.getState().runAll()
  })
  act(() => {
    useGraphStore.getState().expandNode(nodeId)
  })
  return waitFor(() => screen.getByRole('dialog', { name: /output/ }))
}

describe('ViewerOverlay', () => {
  it('is absent until a node is expanded', () => {
    render(<App />)
    expect(screen.queryByRole('dialog', { name: /output/ })).toBeNull()
  })

  it('opens on the node and names what it is showing', async () => {
    const dialog = await openOverlay('partners', 'view')
    expect(within(dialog).getByText('Table')).toBeTruthy()
    // The subtitle reports the shape of the result.
    expect(dialog.textContent).toMatch(/rows × \d+ col/)
  })

  /**
   * The rail draws each param's label itself, and `ParamField`'s checkbox draws one too unless
   * told otherwise — so the default variant names a boolean twice. `out.table`'s filter-row
   * toggle is the first boolean to reach this rail, which is why it survived: every other kind
   * ignores `showLabel`. Counted rather than looked at, since jsdom applies no CSS and both
   * copies are equally visible to it.
   */
  it('names a boolean rail param exactly once', async () => {
    const dialog = await openOverlay('partners', 'view')
    const rail = dialog.querySelector('.overlay__rail')!
    expect(within(rail as HTMLElement).getAllByText('Show filter row')).toHaveLength(1)
    expect(within(rail as HTMLElement).getByLabelText('Show filter row')).toBeTruthy()
  })

  it('renders the result at full size, with paging', async () => {
    const dialog = await openOverlay('partners', 'view')
    expect(within(dialog).getByRole('table')).toBeTruthy()
    expect(within(dialog).getByLabelText('Rows per page')).toBeTruthy()
    expect(dialog.textContent).toContain('DNp02')
  })

  it('closes on Escape', async () => {
    await openOverlay('partners', 'view')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(useGraphStore.getState().expandedNodeId).toBeUndefined()
    })
  })

  it('closes on the close button and on a backdrop click', async () => {
    const dialog = await openOverlay('partners', 'view')
    fireEvent.click(within(dialog).getByLabelText('Close viewer'))
    expect(useGraphStore.getState().expandedNodeId).toBeUndefined()

    act(() => useGraphStore.getState().expandNode('view'))
    const backdrop = document.querySelector('.overlay')!
    fireEvent.pointerDown(backdrop)
    expect(useGraphStore.getState().expandedNodeId).toBeUndefined()
  })

  it('does not close when clicking inside the panel', async () => {
    const dialog = await openOverlay('partners', 'view')
    fireEvent.pointerDown(dialog)
    expect(useGraphStore.getState().expandedNodeId).toBe('view')
  })

  it('hands the panel — not the document — to the Fullscreen API on request', async () => {
    const dialog = await openOverlay('partners', 'view')
    fullscreen.requests.length = 0
    fireEvent.click(within(dialog).getByLabelText('Enter fullscreen'))
    // The panel, specifically: the toolbar's ⛶ fullscreens the whole document, and the two
    // share `toggleFullscreen`, so the target is the only thing separating them.
    expect(fullscreen.requests).toEqual([dialog])
  })

  it('exposes the viewer params in the rail and applies them live', async () => {
    const dialog = await openOverlay('matrix', 'heat')

    // Heatmap declares scale + showValues as presentational, so both belong in the rail.
    const scale = within(dialog).getByLabelText('Colour scale') as HTMLSelectElement
    const showValues = within(dialog).getByLabelText('Show values') as HTMLInputElement
    expect(scale.value).toBe('sequential')

    fireEvent.change(scale, { target: { value: 'diverging' } })
    expect(
      useGraphStore.getState().graph.nodes.find((n) => n.id === 'heat')?.params.scale,
    ).toBe('diverging')

    fireEvent.click(showValues)
    expect(
      useGraphStore.getState().graph.nodes.find((n) => n.id === 'heat')?.params.showValues,
    ).toBe(false)
  })

  it('editing a presentational param does not stale the node', async () => {
    await openOverlay('matrix', 'heat')
    expect(useGraphStore.getState().nodeInfo('heat').state).toBe('ok')

    act(() => {
      useGraphStore.getState().setParam('heat', 'scale', 'diverging')
    })

    // The whole point: inspecting and restyling a result must not invalidate it.
    const store = useGraphStore.getState()
    expect(store.nodeInfo('heat').state).toBe('ok')
    expect(store.nodeOutput('heat', 'out')).toBeDefined()
  })

  it('does not show non-presentational params in the rail', async () => {
    const dialog = await openOverlay('partners', 'conn')
    // Connectivity's direction/minWeight change the data, so they belong on the node.
    expect(dialog.textContent).not.toContain('Min weight')
  })

  it('offers a download from inside the overlay', async () => {
    const capture = installDownloadCapture()
    try {
      const dialog = await openOverlay('partners', 'view')
      fireEvent.click(within(dialog).getByLabelText('Download CSV data'))
      expect(capture.downloads).toHaveLength(1)
      // Filename combines the graph name and the node label.
      expect(capture.downloads[0]!.filename).toBe('fetch-and-group-connectivity-by-type_table.csv')
    } finally {
      capture.restore()
    }
  })

  it('has no expand button once already expanded', async () => {
    const dialog = await openOverlay('partners', 'view')
    expect(within(dialog).queryByLabelText('Expand viewer')).toBeNull()
  })

  it('closes itself if the expanded node is deleted', async () => {
    await openOverlay('partners', 'view')
    act(() => {
      useGraphStore.getState().deleteNodes(['view'])
    })
    expect(useGraphStore.getState().expandedNodeId).toBeUndefined()
    expect(screen.queryByRole('dialog', { name: /output/ })).toBeNull()
  })

  it('closes when a different graph is loaded', async () => {
    await openOverlay('partners', 'view')
    act(() => {
      useGraphStore.getState().loadExample('matrix')
    })
    expect(useGraphStore.getState().expandedNodeId).toBeUndefined()
  })
})

describe('the styling sidebar', () => {
  /*
   * The tabbed panel replaces the flat rail for nodes that declare `paramGroups`. What is
   * worth pinning is that it is a *reorganisation*: the same controls, the same live
   * restyling, and the same promise that touching them never invalidates the result.
   */

  const tabs = (dialog: HTMLElement) =>
    within(dialog)
      .getAllByRole('tab')
      .map((t) => t.textContent)

  it('renders a tab per declared group, in the declared order', async () => {
    const dialog = await openOverlay('network', 'view')
    expect(tabs(dialog)).toEqual(['Node', 'Link', 'Layout', 'Filter'])
  })

  it('opens on the first tab', async () => {
    const dialog = await openOverlay('network', 'view')
    expect(
      within(dialog).getByRole('tab', { name: 'Node' }).getAttribute('aria-selected'),
    ).toBe('true')
    expect(within(dialog).getByRole('tabpanel', { name: 'Node' })).toBeTruthy()
  })

  it('draws colour as one row rather than three', async () => {
    const dialog = await openOverlay('network', 'view')
    const panel = within(dialog).getByRole('tabpanel', { name: 'Node' })
    // The mapping and what it maps sit in the same row, under one label.
    const row = panel.querySelector('.style-row')!
    expect(row.querySelector('.style-row__label')?.textContent).toBe('Colour')
    expect(within(row as HTMLElement).getByLabelText('Node colour')).toBeTruthy()
    expect(within(row as HTMLElement).getByLabelText('Node colour column')).toBeTruthy()
  })

  it('swaps the column picker for a swatch when the mapping says single colour', async () => {
    const dialog = await openOverlay('network', 'view')
    const mapping = within(dialog).getByLabelText('Node colour') as HTMLSelectElement
    fireEvent.change(mapping, { target: { value: 'constant' } })

    const panel = within(dialog).getByRole('tabpanel', { name: 'Node' })
    expect(within(panel).queryByLabelText('Node colour column')).toBeNull()
    expect(within(panel).getByLabelText('Node colour value')).toBeTruthy()
  })

  it('switches tabs to the other half of the drawing', async () => {
    const dialog = await openOverlay('network', 'view')
    expect(within(dialog).queryByLabelText('Arrows')).toBeNull()

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Link' }))
    expect(within(dialog).getByRole('tabpanel', { name: 'Link' })).toBeTruthy()
    expect(within(dialog).getByLabelText('Arrows')).toBeTruthy()
    // …and the node half is no longer on screen.
    expect(within(dialog).queryByLabelText('Node colour')).toBeNull()
  })

  it('applies an edit live, and does not stale the node', async () => {
    const dialog = await openOverlay('network', 'view')
    expect(useGraphStore.getState().nodeInfo('view').state).toBe('ok')

    fireEvent.change(within(dialog).getByLabelText('Node colour'), {
      target: { value: 'sequential' },
    })

    const store = useGraphStore.getState()
    expect(store.graph.nodes.find((n) => n.id === 'view')?.params.nodeColorMode).toBe(
      'sequential',
    )
    // The rail's guarantee, carried over: restyling must never invalidate the result.
    expect(store.nodeInfo('view').state).toBe('ok')
    expect(store.nodeOutput('view', 'out')).toBeDefined()
  })

  it('hides on the header toggle, which stays put so it can be undone', async () => {
    const dialog = await openOverlay('network', 'view')
    const toggle = () => within(dialog).getByRole('button', { name: 'Style' })
    expect(toggle().getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(toggle())
    expect(within(dialog).queryByRole('tablist')).toBeNull()
    // Closed means not rendered — but the toggle lives in the header, not in the panel it
    // controls, so it is still there to press again.
    expect(toggle().getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle())
    expect(within(dialog).getByRole('tablist')).toBeTruthy()
  })

  it('admits that the Filter tab is not presentational, where the others say nothing', async () => {
    const dialog = await openOverlay('network', 'view')
    expect(within(dialog).queryByText(/downstream nodes go stale/i)).toBeNull()

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Filter' }))
    expect(within(dialog).getByText(/downstream nodes go stale/i)).toBeTruthy()
  })

  it('shows the filter params, which the presentational-only rule would have excluded', async () => {
    const dialog = await openOverlay('network', 'view')
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Filter' }))
    expect(within(dialog).getByLabelText('Min link weight')).toBeTruthy()
    expect(within(dialog).getByLabelText('Top nodes')).toBeTruthy()
    expect(within(dialog).getByLabelText('Hide isolated')).toBeTruthy()
  })

  it('stales the node when a filter is edited — the mirror of the restyling promise', async () => {
    await openOverlay('network', 'view')
    expect(useGraphStore.getState().nodeInfo('view').state).toBe('ok')

    act(() => {
      useGraphStore.getState().setParam('view', 'minLinkWeight', 50)
    })

    // Deliberate, and the reason the tab carries a warning: unlike every other tab in this
    // panel, these params are in the provenance key.
    expect(useGraphStore.getState().nodeInfo('view').state).toBe('stale')
  })

  it('leaves an ungrouped node on the flat rail', async () => {
    // The heatmap declares no groups, so it must be untouched by any of this.
    const dialog = await openOverlay('matrix', 'heat')
    expect(within(dialog).queryByRole('tablist')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Style' })).toBeNull()
    expect(dialog.querySelector('.overlay__rail')).toBeTruthy()
    expect(within(dialog).getByLabelText('Colour scale')).toBeTruthy()
  })
})

describe('opening the overlay', () => {
  it('expands from the node header button', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())
    await act(async () => {
      await useGraphStore.getState().runAll()
    })

    const buttons = await waitFor(() => {
      const found = screen.getAllByLabelText('Expand output')
      expect(found.length).toBeGreaterThan(0)
      return found
    })
    fireEvent.click(buttons[0]!)
    expect(useGraphStore.getState().expandedNodeId).toBeTruthy()
  })

  it('is reachable from the command palette', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('Find Neurons')).toBeTruthy())
    act(() => useGraphStore.getState().setSelection(['view']))

    fireEvent.keyDown(window, { key: ' ' })
    const input = await waitFor(() => screen.getByPlaceholderText(/Search commands/))
    fireEvent.change(input, { target: { value: 'expand' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })

    expect(useGraphStore.getState().expandedNodeId).toBe('view')
  })
})
