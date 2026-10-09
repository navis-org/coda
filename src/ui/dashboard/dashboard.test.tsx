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
import { FIRST_TAB_ID, activeTab } from '../../core/dashboard'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { DEMO_DATASET, buildWorkflow, demoWorkflow } from '../../wizard/build'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  registerSource(new MockSource({ latencyMs: 0 }))
  installStorageStub()
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
  })
})

afterEach(cleanup)

const store = () => useGraphStore.getState()
const cells = () => document.querySelectorAll('.dash-cell')
const cellFor = (nodeId: string) => document.querySelector(`.dash-cell[data-node="${nodeId}"]`)

/** Render, run, then put these nodes on the grid and open it. */
async function withCells(ids: string[]) {
  await renderRun()
  act(() => {
    store().addToDashboard(ids)
    store().setDashboardOpen(true)
  })
}

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
    act(() => store().loadGraph(demoWorkflow('partners')))
    expect(store().dashboardOpen).toBe(false)

    // A graph whose author saved it from the grid opens into the grid.
    const saved = {
      ...store().graph,
      dashboard: {
        tabs: [{ id: FIRST_TAB_ID, columns: 2, cells: [{ nodeId: 'view' }] }],
        open: true as const,
      },
    }
    act(() => store().loadGraph(saved))
    expect(store().dashboardOpen).toBe(true)
    expect(document.querySelector('.dashboard__grid')).not.toBeNull()

    // And the same layout without the flag does not.
    act(() =>
      store().loadGraph({
        ...saved,
        dashboard: { tabs: [{ id: FIRST_TAB_ID, columns: 2, cells: [{ nodeId: 'view' }] }] },
      }),
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

/**
 * A run that happens while the grid is *already* up.
 *
 * Every other test in this file runs first and enters the dashboard second, which is the one
 * order that cannot see this: a cell mounted after the run reads its inputs once and they are
 * already there. The order a share link produces is the opposite — `dashboard.open` puts the
 * grid on screen and the reader presses Run underneath it — and a viewer drawing from its
 * **inputs** rather than from its own output then sat on its empty state until the mode was
 * toggled, because `ViewerSurface` memoised `nodeInputs` on the graph object and
 * `previewVersion`, neither of which a run moves.
 *
 * The wizard is the graph rather than a hand-written one because it is the route that produces
 * this: `dashboard: true` is an answer somebody can give, and the first Run of that workflow is
 * the moment the bug appeared.
 *
 * Both assertions are positive. `not.toContain` alone would also pass for a cell that rendered
 * nothing at all, which is the other way this can break.
 */
describe('a cell whose node is run underneath it', () => {
  it('fills in without the mode being toggled', async () => {
    act(() =>
      store().loadGraph(
        buildWorkflow({
          datasets: [DEMO_DATASET],
          start: 'search',
          analysis: 'neurons',
          visualisations: ['topology'],
          notes: false,
          dashboard: true,
        }),
      ),
    )
    await renderRun(false)
    expect(document.querySelector('.dashboard__grid')).not.toBeNull()
    // `ValuePreview`'s unrun state: the node's own output is what is missing, not its inputs.
    expect(cellFor('view')?.textContent).toContain('No result yet')

    await act(async () => {
      await store().runAll()
    })
    // The pager, which exists only once the viewer has the table on its `neurons` input — where
    // the stale read left `TopologyViewer`'s "Connect a table of neurons to measure them."
    await waitFor(() => expect(cellFor('view')?.textContent).toMatch(/1 \/ \d+/))
    expect(cellFor('view')?.textContent).not.toContain('Connect a table of neurons')
  })
})

describe('a cell', () => {
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
      within(cellFor('view') as HTMLElement).getByLabelText('Remove from the dashboard'),
    )
    await waitFor(() => expect(cells().length).toBe(1))
    expect(store().graph.nodes.length).toBe(before)
    expect(store().graph.nodes.some((n) => n.id === 'view')).toBe(true)
    expect(activeTab(store().graph).cells).toEqual([{ nodeId: 'group' }])
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

  /*
   * The canvas and the grid replace each other, so every cell is unmounted on the way out. The
   * rail is the cell's own, stored beside its size, and must still be open on the way back.
   */
  it('keeps a cell’s display settings open across leaving the dashboard and coming back', async () => {
    await withCells(['view'])
    const cell = () => cellFor('view') as HTMLElement
    const historyBefore = store().past.length
    fireEvent.click(within(cell()).getByLabelText('Display settings'))
    await waitFor(() => expect(cell().querySelector('.overlay__rail')).not.toBeNull())
    expect(activeTab(store().graph).cells).toEqual([{ nodeId: 'view', rail: true }])
    // A panel opening is not something undo should step back through.
    expect(store().past.length).toBe(historyBefore)

    act(() => store().setDashboardOpen(false))
    expect(cellFor('view')).toBeNull()
    act(() => store().setDashboardOpen(true))
    await waitFor(() => expect(cell().querySelector('.overlay__rail')).not.toBeNull())
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
    expect(activeTab(store().graph).cells[0]).toEqual({ nodeId: 'view' })

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

/**
 * The run bar, which is the run indication this view otherwise has none of.
 *
 * A cell draws values, not badges — there is no `NodeRunRing` on a grid — so a run under a wall
 * of viewers is a wall of viewers that sit there and then change. Three things about it are
 * decisions rather than styling, and each is what one of these asserts:
 *
 *  - **It is in the header, not in the column.** `--dash-row` is divided out of the grid's
 *    content box, so a bar taking a row's worth of height would resize every cell twice per run
 *    — WebGL scenes included, which is the cost this whole view is arranged around.
 *  - **It waits.** `busy` is also true for auto-run's automatic full pass, which fires 700ms
 *    after any edit and is over in about a millisecond when nothing is stale.
 *  - **A missing denominator is drawn rather than faked.** An indeterminate bar says "working,
 *    and I cannot say how far"; a full one that means the same thing reads as finished.
 *
 * `busy` is set directly here. The bar's contract is that flag plus the delay, and the
 * alternative — a node that blocks long enough to be caught mid-run — would be testing the mock
 * source's timing rather than this.
 */
describe('the run bar', () => {
  async function running(): Promise<HTMLElement> {
    await withCells(['view'])
    act(() => useGraphStore.setState({ busy: true }))
    return await screen.findByRole('progressbar')
  }

  it('is absent while nothing is running', async () => {
    await withCells(['view'])
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('waits before appearing, so a pass with nothing in it does not blink one', async () => {
    await withCells(['view'])
    act(() => useGraphStore.setState({ busy: true }))
    // The flag is up and the bar is not, which is the whole of what the delay buys.
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(await screen.findByRole('progressbar')).toBeTruthy()
  })

  /*
   * The layout claim, and the one a future tidy-up would break: moving the bar into the grid
   * looks like a better home for it and costs every cell two resizes per run.
   */
  it('sits in the header rather than in the grid', async () => {
    await running()
    expect(document.querySelector('.dashboard__bar .dashboard__progress')).not.toBeNull()
    expect(document.querySelector('.dashboard__grid .dashboard__progress')).toBeNull()
  })

  it('goes away when the run ends', async () => {
    await running()
    act(() => useGraphStore.setState({ busy: false }))
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('says it is working without claiming a fraction when there is no scope', async () => {
    const bar = await running()
    expect(bar.getAttribute('data-mode')).toBe('indeterminate')
    // No `valuenow` at all, which is what ARIA means by indeterminate — a 0 there would claim a
    // measurement rather than admit to having none.
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
  })

  /*
   * The determinate half. `runProgress` is the Scheduler's, and a run over the mock source is
   * finished long before anything could observe it mid-flight — so the store's own accessor is
   * stood in for, which is exactly the seam the component reads through.
   */
  it('draws how far along the run is once the scope is known', async () => {
    await running()
    /*
     * One object, returned every time. The Scheduler replaces its snapshot only when the count
     * moves, and `useRunProgress` hands that reference straight to a zustand selector — a stub
     * minting a fresh `{ done, total }` per call re-renders forever, which is this file's proof
     * that the identity rule is real rather than decorative.
     */
    const progress = { done: 3, total: 4 }
    act(() => useGraphStore.setState({ runProgress: () => progress }))
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('data-mode')).toBe('progress')
    expect(bar.getAttribute('aria-valuenow')).toBe('75')
    expect(bar.getAttribute('aria-valuetext')).toBe('3 of 4 nodes')
    expect(bar.getAttribute('title')).toBe('Running · 3 of 4 nodes')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('75%')

    // `plural` on the total rather than a bare "nodes", or a one-node run reads "1 of 1 nodes".
    const one = { done: 1, total: 1 }
    act(() => useGraphStore.setState({ runProgress: () => one }))
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('1 of 1 node')
  })
})

/**
 * Tabs: several pages of one dashboard.
 *
 * What is pinned here is the surface half. The model's rules — the file form, the ids, the
 * neighbour that takes a removed tab's place — are `core/dashboard.test.ts`'s.
 */
describe('tabs', () => {
  const tabs = () => screen.getAllByRole('tab').map((t) => t.textContent)
  const ids = () => [...cells()].map((c) => c.getAttribute('data-node'))

  it('draws one tab, reading "Dashboard", on a dashboard that never grew a second', async () => {
    await withCells(['view'])
    expect(tabs()).toEqual(['Dashboard'])
    expect(screen.getByRole('tab').getAttribute('aria-selected')).toBe('true')
  })

  /*
   * The memory rule, per page: a tab not on screen is unmounted, not hidden — and a node on both
   * pages keeps its one cell across the switch rather than being torn down and rebuilt.
   */
  it('shows one page at a time, and its cells only', async () => {
    await withCells(['view', 'group'])
    fireEvent.click(screen.getByLabelText('New dashboard tab'))
    expect(tabs()).toEqual(['Tab 1', 'Tab 2'])
    expect(cells().length).toBe(0)
    expect(screen.getByText(/Nothing on this tab yet/i)).toBeTruthy()

    act(() => store().addToDashboard(['conn', 'view']))
    expect(ids()).toEqual(['conn', 'view'])
    const shared = cellFor('view')
    // The ✕ takes the cell off this page, not off the dashboard — the node is on two.
    expect(within(shared as HTMLElement).getByLabelText('Remove from this tab')).toBeTruthy()
    expect(cellFor('group')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Tab 1' }))
    expect(ids()).toEqual(['view', 'group'])
    expect(cellFor('conn')).toBeNull()
    expect(cellFor('view')).toBe(shared)
  })

  it('renames in place, and a blank name goes back to the generated label', async () => {
    await withCells(['view'])
    act(() => store().addDashboardTab())
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Tab 2' }))
    const field = screen.getByLabelText('Tab name')
    fireEvent.change(field, { target: { value: '  Morphology ' } })
    fireEvent.blur(field)
    expect(tabs()).toEqual(['Tab 1', 'Morphology'])
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Morphology' }))
    fireEvent.change(screen.getByLabelText('Tab name'), { target: { value: ' ' } })
    fireEvent.blur(screen.getByLabelText('Tab name'))
    expect(tabs()).toEqual(['Tab 1', 'Tab 2'])
  })

  it('moves along the strip with the arrow keys, activating as it goes', async () => {
    await withCells(['view'])
    act(() => {
      store().addDashboardTab(['group'])
      store().setDashboardTab('main')
    })
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Tab 1' }), { key: 'ArrowRight' })
    expect(ids()).toEqual(['group'])
    expect(document.activeElement?.textContent).toBe('Tab 2')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Tab 2' }), { key: 'ArrowRight' })
    expect(ids()).toEqual(['view'])
  })

  it('offers removal from the strip, and not for the only tab', async () => {
    await withCells(['view'])
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Dashboard' }))
    expect(screen.getByRole('button', { name: 'Delete Tab' }).hasAttribute('disabled')).toBe(
      true,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    act(() => store().addDashboardTab(['group']))
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Tab 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Tab' }))
    expect(tabs()).toEqual(['Dashboard'])
    expect(ids()).toEqual(['view'])
    // Its cells, never its nodes.
    expect(store().graph.nodes.some((n) => n.id === 'group')).toBe(true)
  })

  /*
   * Undo walks graph snapshots, and the tab on screen is held only in the document — so undoing
   * an edit made on another page brings that page back, and switching itself costs no step.
   */
  it('costs no undo step to switch, and an undo lands on the tab the edit was made on', async () => {
    await withCells(['view'])
    act(() => store().addDashboardTab(['group']))
    act(() => store().setDashboardSpan('group', { w: 2 }))
    const steps = store().past.length
    act(() => store().setDashboardTab('main'))
    expect(store().past.length).toBe(steps)
    act(() => store().undo())
    expect(tabs()).toEqual(['Tab 1', 'Tab 2'])
    expect(screen.getByRole('tab', { name: 'Tab 2' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(activeTab(store().graph).cells).toEqual([{ nodeId: 'group' }])
  })

  /*
   * The share-link order, on a page other than the first: the file opens on the tab it was saved
   * from, and a run underneath it fills that tab's cells.
   */
  it('opens a saved file on the tab it was saved from, and runs underneath it', async () => {
    act(() => {
      store().addToDashboard(['view'])
      store().addDashboardTab(['conn'])
      store().setDashboardOpen(true)
    })
    const saved = store().graph
    act(() => store().loadGraph(demoWorkflow('partners')))
    act(() => store().loadGraph(saved))
    await renderRun()
    expect(screen.getByRole('tab', { name: 'Tab 2' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    await waitFor(() => expect(cellFor('conn')?.textContent).toMatch(/rows/))
  })
})
