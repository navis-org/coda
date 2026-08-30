// @vitest-environment jsdom

/**
 * The dashboard, mounted over a real graph.
 *
 * Four things here are load-bearing and none of them is visible in a screenshot:
 *
 *  - **The canvas is gone, not covered.** That is what makes the grid cost contexts instead of
 *    adding them, and it is the whole reason the mode replaces `Editor` rather than floating
 *    over it. The assertion is that React Flow's pane is not in the document.
 *  - **A cell draws the node's own view**, whatever kind of node it is, because it is the same
 *    `ViewerSurface` the overlay and the dock use. A Table node's cell has a table in it.
 *  - **A cell stands down while the overlay owns the node** — `showPreview`'s rule reaching its
 *    third surface. Without it a `⤢` from a cell is a second live renderer, not a bigger one.
 *  - **✕ removes the cell, never the node.** The two are one keystroke apart everywhere else in
 *    the app, and confusing them here costs somebody a subtree.
 *
 * jsdom performs no layout, so nothing here can check that a cell spanning two columns is twice
 * as wide — that is a CSS grid and belongs to a browser. What is checkable is the span the cell
 * is given, and the arithmetic that produces it is in `gridGeometry.test.ts`.
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
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  registerSource(new MockSource({ latencyMs: 0 }))
  installStorageStub()
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().loadExample('partners')
  })
})

afterEach(cleanup)

const store = () => useGraphStore.getState()
const cells = () => document.querySelectorAll('.dash-cell')
const cellFor = (nodeId: string) => document.querySelector(`.dash-cell[data-node="${nodeId}"]`)

async function renderRun(run = true) {
  render(<App />)
  if (run) {
    await act(async () => {
      await store().runAll()
    })
  }
}

describe('entering the dashboard', () => {
  /*
   * The claim the whole design rests on. A grid of live viewers *beside* a canvas of live
   * previews is two renderers per node; swapping the surfaces trades them.
   */
  it('takes the canvas away rather than covering it', async () => {
    await renderRun(false)
    expect(document.querySelector('.react-flow')).not.toBeNull()
    act(() => store().setDashboardOpen(true))
    expect(document.querySelector('.react-flow')).toBeNull()
    expect(document.querySelector('.dashboard')).not.toBeNull()
    act(() => store().setDashboardOpen(false))
    expect(document.querySelector('.react-flow')).not.toBeNull()
  })

  /*
   * The dock is the one surface that could hold a node live at the same time as a cell — it is
   * a column beside the canvas area, so it survives the swap. Dropping the pin on the way in is
   * what keeps the "one live renderer per node" rule true without a second stand-down test in
   * the cell.
   */
  it('drops the pin, because the dock has no graph left to sit beside', async () => {
    await renderRun(false)
    act(() => store().pinNode('view'))
    expect(store().pinnedNodeId).toBe('view')
    act(() => store().setDashboardOpen(true))
    expect(store().pinnedNodeId).toBeUndefined()
    expect(screen.queryByRole('complementary', { name: 'Pinned viewer' })).toBeNull()
  })

  it('says so when there is nothing on it, rather than showing an empty grid', async () => {
    await renderRun(false)
    act(() => store().setDashboardOpen(true))
    expect(screen.getByText(/Nothing on the dashboard yet/i)).toBeTruthy()
    expect(document.querySelector('.dashboard__grid')).toBeNull()
  })

  /*
   * The view a file was saved from travels with it. Two halves, and the first is what stops
   * everything that predates this feature from changing: a graph carrying no dashboard, or one
   * saved from the canvas, opens on the canvas.
   */
  it('opens whichever view the file was saved from', async () => {
    await renderRun(false)
    act(() => {
      store().addToDashboard(['view'])
      store().setDashboardOpen(true)
    })
    expect(store().dashboardOpen).toBe(true)
    // An example carries no dashboard, so opening one lands on the canvas.
    act(() => store().loadExample('partners'))
    expect(store().dashboardOpen).toBe(false)

    // A graph whose author saved it from the grid opens into the grid.
    const saved = {
      ...store().graph,
      dashboard: { columns: 2, cells: [{ nodeId: 'view' }], open: true as const },
    }
    act(() => store().loadGraph(saved))
    expect(store().dashboardOpen).toBe(true)
    expect(document.querySelector('.dashboard__grid')).not.toBeNull()

    // And the same layout without the flag does not.
    act(() =>
      store().loadGraph({ ...saved, dashboard: { columns: 2, cells: [{ nodeId: 'view' }] } }),
    )
    expect(store().dashboardOpen).toBe(false)
    expect(document.querySelector('.react-flow')).not.toBeNull()
  })

  /*
   * The flag is written by the *mode*, so it has to be right whichever order somebody works in:
   * open the grid then add a cell, or add a cell from the canvas then open the grid. The first
   * is the case that would break if the layout and the flag were two commits — adding the first
   * cell is the moment a layout comes into existence.
   */
  it('records the grid as the view whichever order the cells and the mode arrive in', async () => {
    await renderRun(false)
    act(() => {
      store().setDashboardOpen(true)
      store().addToDashboard(['view'])
    })
    expect(store().graph.dashboard?.open).toBe(true)

    act(() => {
      store().setDashboardOpen(false)
      store().addToDashboard(['group'])
    })
    expect(store().graph.dashboard?.open).toBeUndefined()

    act(() => store().toggleDashboard())
    expect(store().graph.dashboard?.open).toBe(true)
  })

  /*
   * Pressing `D` on a graph nobody has put a node on must leave no trace — a mode toggle cannot
   * mint a dashboard, or every graph in the Zoo gains a key the first time somebody looks.
   */
  it('writes nothing at all when there is no dashboard to record the view on', async () => {
    await renderRun(false)
    act(() => store().toggleDashboard())
    expect(store().dashboardOpen).toBe(true)
    expect('dashboard' in store().graph).toBe(false)
  })

  /*
   * Not an undo step. Looking at the other view changes the document under this rule, but a ⌘Z
   * that only put you back on the canvas would sit between somebody and the edit they meant.
   */
  it('does not cost an undo step', async () => {
    await renderRun(false)
    act(() => store().addToDashboard(['view']))
    const depth = store().past.length
    act(() => {
      store().setDashboardOpen(true)
      store().setDashboardOpen(false)
    })
    expect(store().past.length).toBe(depth)
  })
})

describe('a cell', () => {
  async function withCells(ids: string[]) {
    await renderRun()
    act(() => {
      store().addToDashboard(ids)
      store().setDashboardOpen(true)
    })
  }

  /*
   * The reuse claim. A cell knows nothing about tables, networks or neuroglancer — it renders
   * `ViewerSurface`, which is what makes "any node off the graph" possible rather than "any
   * viewer".
   */
  it('draws the node the same way the overlay would', async () => {
    await withCells(['view'])
    const cell = cellFor('view')
    expect(cell).not.toBeNull()
    expect(within(cell as HTMLElement).getByRole('table')).toBeTruthy()
    expect(cell?.textContent).toContain('DNp02')
  })

  /*
   * `showPreview`'s rule, third surface. The overlay is bigger and modal, so while it owns the
   * node there is nothing behind it worth a second context and a second copy of the geometry.
   * Named rather than blank: an empty box among boxes reads as the cell having broken.
   */
  it('stands down while the full-size overlay owns the same node', async () => {
    await withCells(['view'])
    expect(within(cellFor('view') as HTMLElement).queryByRole('table')).not.toBeNull()
    act(() => store().expandNode('view'))
    const cell = cellFor('view') as HTMLElement
    expect(within(cell).queryByRole('table')).toBeNull()
    expect(cell.textContent).toContain('Open in the full-size viewer')
    act(() => store().expandNode(undefined))
    expect(within(cellFor('view') as HTMLElement).queryByRole('table')).not.toBeNull()
  })

  it('runs its own node from the header', async () => {
    await withCells(['view'])
    act(() => store().invalidateNode('view'))
    expect(store().needsRun('view')).toBe(true)
    const run = within(cellFor('view') as HTMLElement).getByLabelText('Run this node')
    await act(async () => {
      fireEvent.click(run)
    })
    await waitFor(() => expect(store().needsRun('view')).toBe(false))
  })

  /*
   * The one that costs a subtree if it is wrong. ✕ takes the *cell* off the grid; the node, its
   * params and everything wired to it stay exactly where they were.
   */
  it('removes itself from the dashboard without touching the graph', async () => {
    await withCells(['view', 'group'])
    const before = store().graph.nodes.length
    fireEvent.click(
      within(cellFor('view') as HTMLElement).getByLabelText('Remove from dashboard'),
    )
    await waitFor(() => expect(cells().length).toBe(1))
    expect(store().graph.nodes.length).toBe(before)
    expect(store().graph.nodes.some((n) => n.id === 'view')).toBe(true)
    expect(store().graph.dashboard?.cells).toEqual([{ nodeId: 'group' }])
  })

  /*
   * Presentational params only, and behind a per-cell toggle rather than the overlay's shared
   * one — a grid sharing `panels.style` would open every rail at once. Restyling must not stale
   * the node, which is invariant 4's half of the interaction contract.
   */
  it('shows its display settings on request, and using them stales nothing', async () => {
    await withCells(['view'])
    const cell = () => cellFor('view') as HTMLElement
    expect(cell().querySelector('.overlay__rail')).toBeNull()
    fireEvent.click(within(cell()).getByLabelText('Display settings'))
    await waitFor(() => expect(cell().querySelector('.overlay__rail')).not.toBeNull())
    expect(store().needsRun('view')).toBe(false)
  })
})

/**
 * The shortcuts that have to outlive the canvas.
 *
 * `Editor` is unmounted while the dashboard is up, so a key bound there is a key that silently
 * stops working in half the app — which is how `F` came to do nothing on the grid, along with
 * `I` and `/`, which nobody had tried yet. `useAppShortcuts` is mounted by `App`, so these are
 * driven through the shell in both views rather than asserted against a listener.
 *
 * Fullscreen itself is not among them: the Fullscreen API is absent under jsdom, and what would
 * be tested is the stub. What is testable is that the *binding* survives the canvas going away,
 * which the three below establish for the listener they all share.
 */
describe('the app shortcuts', () => {
  const press = (key: string) =>
    act(() => {
      fireEvent.keyDown(document.body, { key })
    })

  it('reach the inspector, the assistant and the dashboard from either view', async () => {
    await renderRun(false)
    const inspector = () => store().panels.inspector
    const assistant = () => store().panels.assistant
    const before = { inspector: inspector(), assistant: assistant() }

    press('i')
    expect(inspector()).toBe(!before.inspector)
    press('/')
    expect(assistant()).toBe(!before.assistant)

    // Now with the canvas gone — the case that was broken.
    press('d')
    expect(store().dashboardOpen).toBe(true)
    expect(document.querySelector('.react-flow')).toBeNull()
    press('i')
    expect(inspector()).toBe(before.inspector)
    press('/')
    expect(assistant()).toBe(before.assistant)
    // …and the same key comes back out, one binding rather than the two it used to take.
    press('d')
    expect(store().dashboardOpen).toBe(false)
  })

  it('leave a modified key alone, because ⌘D is Duplicate', async () => {
    await renderRun(false)
    act(() => {
      fireEvent.keyDown(document.body, { key: 'd', metaKey: true })
    })
    expect(store().dashboardOpen).toBe(false)
  })

  it('are letters again inside a field', async () => {
    await renderRun(false)
    const name = document.querySelector('.toolbar__name') as HTMLInputElement
    act(() => {
      fireEvent.keyDown(name, { key: 'd' })
    })
    expect(store().dashboardOpen).toBe(false)
  })
})

describe('the grid', () => {
  it('offers only nodes that are not already on it', async () => {
    await renderRun(false)
    act(() => {
      store().addToDashboard(['view'])
      store().setDashboardOpen(true)
    })
    fireEvent.click(screen.getByRole('button', { name: /Add node/ }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByText('Table')).toBeNull()
    expect(within(menu).getByText('Connectivity')).toBeTruthy()
  })

  /*
   * The row axis, on the store rather than on pixels: jsdom performs no layout, so what is
   * checkable here is the span the cell is given. That the four spans tile the screen is
   * `gridGeometry.test.ts`, and what they look like was driven in a browser.
   */
  it('offers four heights and snaps to the nearest', async () => {
    await renderRun(false)
    act(() => {
      store().addToDashboard(['view'])
      store().setDashboardOpen(true)
    })
    const span = () => cellFor('view')?.getAttribute('style') ?? ''
    // The default is half the area, and it is stored as absence.
    expect(span()).toContain('span 3')
    expect(store().graph.dashboard?.cells[0]).toEqual({ nodeId: 'view' })

    act(() => store().setDashboardSpan('view', { h: 5 }))
    expect(span()).toContain('span 4')
    act(() => store().setDashboardSpan('view', { h: 1 }))
    expect(span()).toContain('span 2')
    act(() => store().setDashboardSpan('view', { h: 99 }))
    expect(span()).toContain('span 6')
  })

  it('re-tracks the grid and clamps a cell that was wider than the new count', async () => {
    await renderRun(false)
    act(() => {
      store().addToDashboard(['view'])
      store().setDashboardOpen(true)
      store().setDashboardColumns(4)
      store().setDashboardSpan('view', { w: 4 })
    })
    expect(cellFor('view')?.getAttribute('style')).toContain('span 4')
    act(() => store().setDashboardColumns(2))
    expect(cellFor('view')?.getAttribute('style')).toContain('span 2')
  })

  /*
   * The drop layer exists only while a drag is running. Mounted always, it would be a
   * transparent sheet over every viewer in the grid — no rotating a 3D scene, no sorting a
   * table — and the failure would be blamed on the viewer rather than on the dashboard.
   */
  it('lays a drop target over its cells only while one is being dragged', async () => {
    await renderRun(false)
    act(() => {
      store().addToDashboard(['view', 'group'])
      store().setDashboardOpen(true)
    })
    expect(document.querySelectorAll('.dash-cell__drop').length).toBe(0)
    const grip = within(cellFor('view') as HTMLElement).getByLabelText('Reorder cell')
    fireEvent.dragStart(grip, { dataTransfer: { setData: () => {}, types: [] } })
    await waitFor(() => expect(document.querySelectorAll('.dash-cell__drop').length).toBe(2))
    fireEvent.dragEnd(grip)
    await waitFor(() => expect(document.querySelectorAll('.dash-cell__drop').length).toBe(0))
  })
})
