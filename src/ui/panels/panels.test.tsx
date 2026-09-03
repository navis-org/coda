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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
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
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
  })
})

afterEach(cleanup)

const inspector = () => document.querySelector('.inspector')
const minimap = () => document.querySelector('.react-flow__minimap')
const inspectorToggle = () => screen.getByRole('button', { name: /Inspector/ })

/**
 * Give every card a layout box, and hand back the undo.
 *
 * `getDimensions` — React Flow's measurement — reads `offsetWidth`/`offsetHeight`, which jsdom
 * reports as zero for everything, and a zero-sized measurement is dropped before it becomes a
 * change. Scoped to `.react-flow__node` so nothing else in the shell starts claiming a size it
 * does not have.
 */
function stubNodeOffsets(width = 232, height = 120): () => void {
  const dimension = (value: number) => ({
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('react-flow__node') ? value : 0
    },
  })
  const original = {
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', dimension(width))
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', dimension(height))
  // jsdom's own descriptors, put back — not deleted, which would take the zero-reporting
  // getters every other suite in this file relies on with them.
  return () => {
    for (const [name, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    }
  }
}

/**
 * The five icon-only buttons in the toolbar.
 *
 * Taking a label off a button takes its accessible name with it unless something puts one back,
 * and nothing about the rendering says which happened — the icon draws either way. So this
 * asserts the name, that it comes from `aria-label` rather than from stray text, and that a
 * pointer gets a tooltip too. Assistant and Inspector additionally have to keep announcing
 * *state*, which they used to say in the glyph itself (`▐` against `▕`) and now say only
 * through `aria-pressed`. The bell is the fifth and sits beside Run rather than in the cluster,
 * but it is the same kind of control and carries the same risk.
 */
describe('the icon cluster', () => {
  const NAMED = [
    'Share workflow',
    'Connections',
    'Assistant',
    'Inspector',
    'Notify me when a run finishes',
  ]

  it('keeps every name, as an icon with no text', () => {
    render(<App />)
    for (const name of NAMED) {
      const button = screen.getByRole('button', { name })
      expect(button.querySelector('svg')).toBeTruthy()
      expect(button.textContent).toBe('')
      expect(button.getAttribute('title')).toBeTruthy()
    }
  })

  it('says open-or-closed through aria-pressed, since the glyph no longer does', () => {
    render(<App />)
    expect(inspectorToggle().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(inspectorToggle())
    expect(inspectorToggle().getAttribute('aria-pressed')).toBe('true')
    // And the tooltip names which way the next click goes, which the icon cannot.
    expect(inspectorToggle().getAttribute('title')).toMatch(/^Hide/)
  })

  it('offers the bell disabled, and says who took the decision away', () => {
    /*
     * jsdom has no `Notification`, which is the `unsupported` branch and stands in here for the
     * two states a real browser reaches: an iOS Safari tab that was never installed, and a
     * permission the user refused — which can never be asked for again from this side.
     *
     * Disabled *and* still present, because the alternative was hiding it: a control that is
     * simply absent gives nobody a reason why the feature they were told about is missing. The
     * tooltip has to carry that, and it also has to say the other channel still works, or the
     * honest reading of a struck-through bell is that nothing will tell you anything.
     */
    render(<App />)
    const bell = screen.getByRole('button', { name: 'Notify me when a run finishes' })
    expect((bell as HTMLButtonElement).disabled).toBe(true)
    expect(bell.getAttribute('aria-pressed')).toBe('false')
    expect(bell.getAttribute('title')).toMatch(/tab title still changes/)
  })
})

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

  it('summarises a table as text rather than drawing one', async () => {
    /*
     * This panel is 320 × 300, the smallest surface a viewer is drawn on. A 60-column annotation
     * table there was a grid showing about three columns behind a sideways scrollbar — so it was
     * both unreadable and the most expensive thing on screen, laid out again on every change of
     * selection. Turned ninety degrees the whole schema fits.
     *
     * A generous page size is set deliberately: the node's own setting must not bring the grid
     * back, which is the half a small one would not prove.
     */
    render(<App />)
    fireEvent.click(inspectorToggle())

    const store = useGraphStore.getState()
    const ds = store.addNode('neuron.dataset', { x: 0, y: 0 })
    const find = useGraphStore.getState().addNode('neuron.findNeurons', { x: 200, y: 0 })
    const view = useGraphStore.getState().addNode('out.table', { x: 400, y: 0 })
    act(() => {
      const s = useGraphStore.getState()
      s.setParam(ds, 'dataset', 'optic-lobe-mini')
      s.connect({ source: ds, sourceHandle: 'dataset', target: find, targetHandle: 'dataset' })
      s.connect({ source: find, sourceHandle: 'neurons', target: view, targetHandle: 'in' })
      s.setParam(view, 'pageSize', 500)
    })
    await act(async () => {
      await useGraphStore.getState().runAll()
    })
    act(() => {
      useGraphStore.getState().setSelection([view])
    })

    const panel = inspector()!
    // No grid at all — not a short one. `1–1 of 58,340` under a one-row table was the report
    // that this replaced: a table shrunk is still a table.
    expect(panel.querySelectorAll('.data-table').length).toBe(0)

    // One line per column, each naming its type, and the first row's value beside it.
    const rows = panel.querySelectorAll('.table-summary__row')
    const table = useGraphStore.getState().nodeOutput(view, 'out')
    const columns = table && 'schema' in table ? table.schema.columns.length : 0
    expect(columns).toBeGreaterThan(3)
    expect(rows.length).toBe(columns)
    expect(panel.textContent).toContain('neuronId')
  })
})

describe('the minimap', () => {
  it('opens and closes from its button in the controls rail', () => {
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

  /**
   * Every card drawn, not just the ones that declare a size.
   *
   * The minimap draws from React Flow's own node lookup and skips anything it has no dimensions
   * for — and the dimensions it reads are the *user* node's, not its measurement. Coda rebuilds
   * every node object on each store change, so the only cards carrying a size there were the
   * ones with a `node.size` or a `defaultSize`; everything that cannot be resized was missing
   * from the map entirely. `Editor` now hands React Flow's own measurements back to it.
   *
   * jsdom performs no layout, so `offsetWidth` is zero and React Flow discards its own
   * measurement before it ever reaches a change — hence the stub. It is what makes this
   * observable at all here; without it the map is empty either way.
   */
  it('draws every card, including the ones that carry no declared size', () => {
    const offsets = stubNodeOffsets()
    try {
      render(<App />)
      fireEvent.click(screen.getByLabelText('Show minimap'))
      const drawn = document.querySelectorAll('.react-flow__minimap-node').length
      expect(drawn).toBe(useGraphStore.getState().graph.nodes.length)
      expect(drawn).toBeGreaterThan(1)
    } finally {
      offsets()
    }
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
    expect(loadPanels()).toEqual({
      inspector: false,
      minimap: false,
      assistant: false,
      // The two whose absence means *open* — see `PanelState`. A build predating either key
      // must not read as "the user closed it".
      style: true,
      workflows: true,
    })
  })

  it('round-trips', () => {
    savePanels({
      inspector: true,
      minimap: false,
      assistant: true,
      style: false,
      workflows: false,
    })
    expect(loadPanels()).toEqual({
      inspector: true,
      minimap: false,
      assistant: true,
      style: false,
      workflows: false,
    })
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

/**
 * The New menu, which is the list of places somebody can begin.
 *
 * Two things worth pinning, and neither would fail loudly. **Every backend offers its escape
 * hatch**: those are the entry point for a server this build ships no node for, and CATMAID's was
 * simply absent for as long as the menu had one hand-written "Other" entry — a missing menu item
 * looks exactly like a menu. And **the specialist volumes are held back**, which is `starter:
 * false`; asserting that against the flag would be checking the menu against the expression it
 * is built from, so the three are named.
 */
describe('the New menu', () => {
  /*
   * Adding a CATMAID node makes `validate` peek at that instance's project list, and a peek that
   * cannot answer starts the listing — which is the design (invariant 2) and is a real request
   * leaving the process. Stubbed so the case is hermetic; the rejection is swallowed exactly as
   * a dead server's would be, which is the state the assertions below run in anyway.
   */
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no network in tests'))),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function openNew(): HTMLElement {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /^New/ }))
    const panel = document.querySelector('.dropdown__panel')
    if (!(panel instanceof HTMLElement)) throw new Error('New menu did not open')
    return panel
  }

  /**
   * The flyout for one backend, from an already-open menu. Hover is what opens a `Submenu`.
   *
   * Takes the panel rather than opening one, because a test that reads two backends would
   * otherwise render a second `App` and every query would then find two of everything.
   */
  function openBackend(panel: HTMLElement, label: string): HTMLElement {
    const row = [...panel.querySelectorAll('.dropdown__item--parent')].find(
      (el) => el.querySelector('strong')?.textContent === label,
    )
    if (!(row instanceof HTMLElement)) throw new Error(`no "${label}" row in the New menu`)
    fireEvent.pointerEnter(row.parentElement!)
    const flyout = row.parentElement!.querySelector('.dropdown__flyout')
    if (!(flyout instanceof HTMLElement)) throw new Error(`"${label}" did not open`)
    return flyout
  }

  const itemTitles = (panel: HTMLElement) =>
    [...panel.querySelectorAll('.dropdown__item strong')].map((el) => el.textContent)

  /*
   * One submenu per backend, not per source. CATMAID is the only backend where those differ —
   * FAFB and L1 are two servers and therefore two `CatmaidSource`s — and grouping on the source
   * put a second row in the menu spelled as a hostname. Nothing about that fails loudly.
   */
  it('folds the datasets into one submenu per backend', () => {
    const panel = openNew()
    const parents = [...panel.querySelectorAll('.dropdown__item--parent strong')].map(
      (el) => el.textContent,
    )
    expect(parents).toEqual(['neuPrint', 'CAVE', 'CATMAID'])
  })

  it('offers a custom node for every backend, inside that backend’s submenu', () => {
    const panel = openNew()
    expect(itemTitles(openBackend(panel, 'neuPrint'))).toContain('Custom neuPrint')
    expect(itemTitles(openBackend(panel, 'CAVE'))).toContain('Custom CAVE')
    expect(itemTitles(openBackend(panel, 'CATMAID'))).toContain('Custom CATMAID')
  })

  it('puts both CATMAID datasets in the one submenu', () => {
    const titles = itemTitles(openBackend(openNew(), 'CATMAID'))
    expect(titles).toContain('FAFB')
    expect(titles).toContain('L1')
  })

  /*
   * The synthetic dataset is the Workflow Wizard's first answer instead — a demo dataset is worth
   * reaching for when you want a pipeline to look at, not as somewhere to begin real work. It was
   * the only entry the mock backend had, so its group goes with it rather than becoming a row
   * with nothing under it.
   */
  it('offers no synthetic dataset, and no empty group where it was', () => {
    const panel = openNew()
    expect(itemTitles(panel)).not.toContain('Demo Data')
    expect(
      [...panel.querySelectorAll('.dropdown__item--parent strong')].map((el) => el.textContent),
    ).not.toContain('Mock connectome')
  })

  it('keeps the datasets people start from and drops the specialist volumes', () => {
    const panel = openNew()
    const titles = [
      ...itemTitles(openBackend(panel, 'neuPrint')),
      ...itemTitles(openBackend(panel, 'CAVE')),
    ]
    for (const kept of ['MaleCNS', 'Hemibrain', 'MANC', 'FlyWire FAFB public']) {
      expect(titles).toContain(kept)
    }
    for (const dropped of ['Optic Lobe', 'FIB-19', 'Mushroom Body']) {
      expect(titles).not.toContain(dropped)
    }
  })

  /* The row says what is inside it, derived from the same table the flyout is built from. */
  it('names the datasets on the row that holds them', () => {
    const panel = openNew()
    const row = [...panel.querySelectorAll('.dropdown__item--parent')].find(
      (el) => el.querySelector('strong')?.textContent === 'neuPrint',
    )
    expect(row?.querySelector('span')?.textContent).toBe(
      itemTitles(openBackend(panel, 'neuPrint'))
        .filter((title) => !title?.startsWith('Custom'))
        .join(' · '),
    )
  })

  it('builds a starter from a custom entry', () => {
    const flyout = openBackend(openNew(), 'CATMAID')
    const item = [...flyout.querySelectorAll('.dropdown__item')].find(
      (el) => el.querySelector('strong')?.textContent === 'Custom CATMAID',
    )
    if (!(item instanceof HTMLElement)) throw new Error('No Custom CATMAID entry')
    act(() => {
      fireEvent.click(item)
    })
    const types = useGraphStore.getState().graph.nodes.map((node) => node.type)
    expect(types).toContain('dataset.catmaid')
    // The generic starter: a dataset, a browser and somewhere for the picks to land.
    expect(types).toContain('neuron.explore')
  })

  /*
   * The two rows that produce a whole workflow, which used to be a `Workflows` menu of their own.
   * A top-level button for two rows, beside a "New" that means the same thing — where do I begin
   * — was one menu too many. The rule between them and Empty is the statement: Empty decides
   * nothing for you, these two decide a whole pipeline.
   */
  it('offers the wizard and the Zoo under Empty, in that order', () => {
    const panel = openNew()
    const titles = itemTitles(panel).slice(0, 3)
    expect(titles).toEqual(['Empty', 'Workflow Wizard…', 'Browse Workflows…'])
  })

  it('opens the wizard rather than building anything on the spot', () => {
    const panel = openNew()
    const wizard = [...panel.querySelectorAll('.dropdown__item')].find(
      (el) => el.querySelector('strong')?.textContent === 'Workflow Wizard…',
    )
    fireEvent.click(wizard!)
    expect(useGraphStore.getState().wizardOpen).toBe(true)
    // Nothing was loaded: the wizard asks its four questions first.
    expect(useGraphStore.getState().graph.nodes.length).toBeGreaterThan(0)
  })
})
