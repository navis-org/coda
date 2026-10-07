/**
 * The dashboard's model: the rules that keep a layout honest, and the two failures that are
 * invisible until somebody opens the grid.
 *
 * Headless — no DOM, no store. What is *not* here is anything about pixels: the drag arithmetic
 * lives in `ui/dashboard/gridGeometry.ts` with its own test, on `networkDrag.ts`'s rule.
 */

import { describe, expect, it } from 'vitest'

// The node pack, for its side effect: the round-trip cases below go through `deserializeGraph`,
// which drops a node whose type is not registered — and a dropped node takes its cell with it.
import '../nodes'
import type { CodaGraph } from './graph'
import { deserializeGraph, serializeGraph } from './graph'
import {
  DEFAULT_COLUMNS,
  DEFAULT_ROW_SPAN,
  ROW_SPANS,
  ROW_TRACKS,
  snapRowSpan,
  addCells,
  clampSpan,
  allOnTab,
  moveCell,
  pruneDashboard,
  removeCells,
  setColumns,
  setRail,
  setSpan,
  placeableIds,
  setViewOpen,
  unplacedNodes,
  validDashboard,
  activeTab,
  addTab,
  dashboardOf,
  duplicateTab,
  FIRST_TAB_ID,
  MAX_TAB_TITLE,
  moveTab,
  removeTab,
  renameTab,
  setActiveTab,
  tabLabel,
} from './dashboard'
import type { DashboardCell, DashboardLayout } from './dashboard'

/** The first tab's cells — every case in this half of the file is about a one-tab dashboard. */
function cellsOf(graph: CodaGraph): DashboardCell[] | undefined {
  return graph.dashboard?.tabs[0]?.cells
}

/** The ids of every tab holding a cell for this node, in strip order. */
function tabsHolding(graph: CodaGraph, nodeId: string): string[] {
  return (graph.dashboard?.tabs ?? [])
    .filter((t) => t.cells.some((c) => c.nodeId === nodeId))
    .map((t) => t.id)
}

/** A one-tab layout as `validDashboard` reads the single-tab form. */
function single(columns: number, cells: DashboardCell[]): DashboardLayout {
  return { tabs: [{ id: FIRST_TAB_ID, columns, cells }] }
}

function graphWith(ids: string[], dashboard?: CodaGraph['dashboard']): CodaGraph {
  return {
    version: 1,
    nodes: ids.map((id) => ({ id, type: 'out.table', position: { x: 0, y: 0 }, params: {} })),
    edges: [],
    ...(dashboard ? { dashboard } : {}),
  }
}

describe('placing nodes on a dashboard', () => {
  it('appends in the order given and skips a node already placed', () => {
    const g = addCells(graphWith(['a', 'b', 'c']), ['c', 'a'])
    expect(cellsOf(g)?.map((c) => c.nodeId)).toEqual(['c', 'a'])
    expect(cellsOf(addCells(g, ['b', 'c']))?.map((c) => c.nodeId)).toEqual(['c', 'a', 'b'])
  })

  /*
   * The one-cell-per-node rule, at the seam it is easiest to break. A cell is a *mount site*, so
   * a second cell for one node is a second live renderer of it — the measurement `showPreview`
   * stands cards down for. This is the half `addCells` enforces; `validDashboard` below is the
   * other way a duplicate arrives.
   */
  it('never places one node twice, however many times it is asked', () => {
    const g = addCells(addCells(graphWith(['a']), ['a', 'a']), ['a'])
    expect(cellsOf(g)).toEqual([{ nodeId: 'a' }])
  })

  it('ignores a node that is not in the graph', () => {
    expect(addCells(graphWith(['a']), ['ghost']).dashboard).toBeUndefined()
  })

  /*
   * The identity contract `commit` relies on: a gesture that changes nothing must not cost an
   * undo step. Written for every mutator, because each is reachable from a drag that can land
   * where it started.
   */
  it('returns the graph unchanged by identity when nothing happens', () => {
    const placed = addCells(graphWith(['a', 'b']), ['a'])
    expect(addCells(placed, ['a'])).toBe(placed)
    expect(removeCells(placed, ['b'])).toBe(placed)
    expect(removeCells(graphWith(['a']), ['a'])).not.toBe(placed)
    expect(moveCell(placed, 'a', 0)).toBe(placed)
    expect(moveCell(placed, 'ghost', 1)).toBe(placed)
    expect(setSpan(placed, 'a', { w: 1 })).toBe(placed)
    expect(setColumns(placed, DEFAULT_COLUMNS)).toBe(placed)
    expect(pruneDashboard(placed)).toBe(placed)
  })

  /*
   * A graph nobody has put a node on must serialise exactly as it did before this feature
   * existed, or every file in the Zoo changes bytes on its next save for something it does not
   * use. The emptied-dashboard half is the same rule `pruneGroups` follows for an emptied frame.
   */
  it('leaves no trace on a graph with nothing on the dashboard', () => {
    const bare = graphWith(['a', 'b'])
    expect('dashboard' in addCells(bare, [])).toBe(false)
    const emptied = removeCells(addCells(bare, ['a']), ['a'])
    expect('dashboard' in emptied).toBe(false)
  })
})

describe('the order that is the layout', () => {
  const placed = addCells(graphWith(['a', 'b', 'c', 'd']), ['a', 'b', 'c', 'd'])
  const order = (g: CodaGraph) => cellsOf(g)?.map((c) => c.nodeId)

  /*
   * `moveCell` counts the target in the list *after* the cell is lifted out. Getting it the
   * other way round makes dragging a cell one place to the right do nothing — which reads as
   * the drag having missed, not as an off-by-one.
   */
  it('moves a cell to an index counted after it has been lifted out', () => {
    expect(order(moveCell(placed, 'a', 1))).toEqual(['b', 'a', 'c', 'd'])
    expect(order(moveCell(placed, 'd', 0))).toEqual(['d', 'a', 'b', 'c'])
    expect(order(moveCell(placed, 'b', 3))).toEqual(['a', 'c', 'd', 'b'])
  })

  it('clamps a target past either end rather than dropping the cell', () => {
    expect(order(moveCell(placed, 'a', 99))).toEqual(['b', 'c', 'd', 'a'])
    expect(order(moveCell(placed, 'd', -5))).toEqual(['d', 'a', 'b', 'c'])
  })
})

describe('spans', () => {
  it('clamps width to the column count and snaps height to the nearest on offer', () => {
    expect(clampSpan({ nodeId: 'a', w: 9, h: 9 }, 3)).toEqual({
      nodeId: 'a',
      w: 3,
      h: ROW_TRACKS,
    })
    expect(clampSpan({ nodeId: 'a', w: 0, h: -2 }, 3)).toEqual({ nodeId: 'a', h: ROW_SPANS[0] })
  })

  /*
   * Four heights, and one track is not one of them — a sixth of a window is a header and a
   * scrollbar. So `h: 1` and `h: 5` are *snapped* rather than clamped, which is the difference
   * between the two axes: a column count is a range, a row height is a short list of stops.
   */
  it('offers a third, a half, two thirds and the whole area, and nothing between', () => {
    expect([...ROW_SPANS]).toEqual([2, 3, 4, 6])
    expect(snapRowSpan(1)).toBe(2)
    expect(snapRowSpan(5)).toBe(4) // a tie goes to the shorter, which never grows a cell unasked
    expect(snapRowSpan(7)).toBe(6)
    expect(snapRowSpan(Number.NaN)).toBe(DEFAULT_ROW_SPAN)
  })

  /*
   * A width of 1 is stored as *absence*, and a height of `DEFAULT_ROW_SPAN` is too — the two
   * absences are different numbers on purpose. Same reason `groups` is optional either way: a
   * dashboard nobody has resized round trips byte-identically.
   */
  it('stores the default of each axis as absence, and they are not the same number', () => {
    const g = setSpan(addCells(graphWith(['a']), ['a']), 'a', { w: 2, h: 6 })
    expect(cellsOf(g)?.[0]).toEqual({ nodeId: 'a', w: 2, h: 6 })
    expect(cellsOf(setSpan(g, 'a', { w: 1, h: DEFAULT_ROW_SPAN }))?.[0]).toEqual({
      nodeId: 'a',
    })
    expect(DEFAULT_ROW_SPAN).not.toBe(1)
  })

  /*
   * The identity contract on the row axis, which the mixed defaults could break: a cell already
   * at the default height must not read as a change every time a drag samples it.
   */
  it('is unchanged by identity when a resize lands on the height it already has', () => {
    const g = addCells(graphWith(['a']), ['a'])
    expect(setSpan(g, 'a', { h: DEFAULT_ROW_SPAN })).toBe(g)
    // …and a value that snaps back onto it counts as the same thing.
    expect(setSpan(g, 'a', { h: DEFAULT_ROW_SPAN + 0.4 })).toBe(g)
  })

  /*
   * The silent one. An unclamped `w` reaches the stylesheet as `grid-column: span 6` in a
   * four-track grid, where CSS truncates it without complaint — so the layout draws four and the
   * resize grip goes on computing against six, and the two disagree for the rest of the session.
   */
  it('re-clamps every cell when the column count comes down', () => {
    let g = addCells(graphWith(['a', 'b']), ['a', 'b'])
    g = setColumns(g, 4)
    g = setSpan(g, 'a', { w: 4 })
    g = setSpan(g, 'b', { w: 2 })
    g = setColumns(g, 2)
    expect(activeTab(g)).toEqual({
      id: FIRST_TAB_ID,
      columns: 2,
      cells: [
        { nodeId: 'a', w: 2 },
        { nodeId: 'b', w: 2 },
      ],
    })
  })

  it('refuses a column count outside the range instead of storing it', () => {
    const g = addCells(graphWith(['a']), ['a'])
    expect(activeTab(setColumns(g, 99)).columns).toBe(6)
    expect(activeTab(setColumns(g, 0)).columns).toBe(1)
    expect(activeTab(setColumns(g, Number.NaN)).columns).toBe(DEFAULT_COLUMNS)
  })
})

describe('a cell’s control rail', () => {
  it('is stored only while open, and leaves the graph alone when nothing changes', () => {
    const g = addCells(graphWith(['a']), ['a'])
    const open = setRail(g, 'a', true)
    expect(cellsOf(open)).toEqual([{ nodeId: 'a', rail: true }])
    expect(setRail(open, 'a', true)).toBe(open)
    expect(cellsOf(setRail(open, 'a', false))).toEqual([{ nodeId: 'a' }])
    expect(setRail(g, 'a', false)).toBe(g)
  })

  it('survives a resize, which rebuilds the cell through clampSpan', () => {
    const g = setSpan(setRail(addCells(graphWith(['a']), ['a']), 'a', true), 'a', { w: 2 })
    expect(cellsOf(g)).toEqual([{ nodeId: 'a', w: 2, rail: true }])
  })

  it('round-trips through a stored layout, and a hand-edited non-true value is ignored', () => {
    const node = { id: 'a', type: 'out.table', position: { x: 0, y: 0 }, params: {} }
    const alive = new Map([['a', node]])
    const stored = (rail: unknown) =>
      validDashboard({ columns: 2, cells: [{ nodeId: 'a', rail }] }, alive)
    expect(stored(true)?.tabs[0]!.cells).toEqual([{ nodeId: 'a', rail: true }])
    expect(stored('yes')?.tabs[0]!.cells).toEqual([{ nodeId: 'a' }])
  })
})

/**
 * The view flag: which of the two surfaces the document was last seen through.
 *
 * The rule is the author's — a graph saved from the dashboard opens into it — so what these
 * cases pin is that the flag cannot be set on a graph that has no dashboard to hold it, and
 * cannot be quietly dropped by an edit that reshapes the layout around it.
 */
describe('the view a graph was saved from', () => {
  it('is absent until somebody looks at the grid, and written only when true', () => {
    const g = addCells(graphWith(['a']), ['a'])
    expect(g.dashboard?.open).toBeUndefined()
    expect(setViewOpen(g, true).dashboard).toEqual({ ...g.dashboard, open: true })
    expect(g.dashboard?.tabs).toHaveLength(1)
    // Back to the canvas removes the key rather than storing `false` — `GraphGroup.filled`'s
    // idiom, so a graph seen once as a grid and then closed round trips as it always did.
    expect('open' in (setViewOpen(setViewOpen(g, true), false).dashboard ?? {})).toBe(false)
  })

  /*
   * The case that keeps a graph nobody has put a node on serialising exactly as it did before
   * this feature existed. Pressing `D` on an empty canvas must not mint a dashboard.
   */
  it('cannot be recorded on a graph with no dashboard to record it on', () => {
    const bare = graphWith(['a'])
    expect(setViewOpen(bare, true)).toBe(bare)
    expect('dashboard' in setViewOpen(bare, true)).toBe(false)
  })

  it('is unchanged by identity when it already says what it is told', () => {
    const g = setViewOpen(addCells(graphWith(['a']), ['a']), true)
    expect(setViewOpen(g, true)).toBe(g)
  })

  /*
   * `setColumns` is the one mutator that builds a layout literal rather than spreading the old
   * one, so it is the only place the flag could be dropped — silently, and only for somebody who
   * moved the column slider before saving.
   */
  it('survives every edit that reshapes the layout around it', () => {
    let g = setViewOpen(addCells(graphWith(['a', 'b']), ['a', 'b']), true)
    g = setColumns(g, 4)
    g = setSpan(g, 'a', { w: 2 })
    g = moveCell(g, 'b', 0)
    g = removeCells(g, ['a'])
    expect(g.dashboard?.open).toBe(true)
    // …and goes with the layout when the last cell does.
    expect('dashboard' in removeCells(g, ['b'])).toBe(false)
  })

  it('round trips, and a hand-edited truthy value is not a decision', () => {
    const g = setViewOpen(addCells(graphWith(['a']), ['a']), true)
    expect(deserializeGraph(serializeGraph(g)).graph.dashboard?.open).toBe(true)
    const alive = new Map([
      ['a', { id: 'a', type: 'out.table', position: { x: 0, y: 0 }, params: {} }],
    ])
    expect(
      validDashboard({ columns: 2, cells: [{ nodeId: 'a' }], open: 'yes' }, alive)?.open,
    ).toBeUndefined()
    expect(
      validDashboard({ columns: 2, cells: [{ nodeId: 'a' }], open: 1 }, alive)?.open,
    ).toBeUndefined()
  })
})

describe('a cell whose node is gone', () => {
  /*
   * `removeNodes` calls this beside `pruneGroups`. Deletion arrives by four routes, and a cell
   * holding a dead id is worse than a frame around missing cards: the cell is a mount site, so
   * it draws a header for a node that cannot be found.
   */
  it('is pruned, and an emptied dashboard goes with it', () => {
    const g = addCells(graphWith(['a', 'b']), ['a', 'b'])
    const pruned = pruneDashboard({ ...g, nodes: g.nodes.filter((n) => n.id === 'b') })
    expect(cellsOf(pruned)).toEqual([{ nodeId: 'b' }])
    expect('dashboard' in pruneDashboard({ ...g, nodes: [] })).toBe(false)
  })

  it('is dropped by the deleting path itself, not only by a later pass', async () => {
    const { removeNodes } = await import('./graph')
    const g = addCells(graphWith(['a', 'b']), ['a', 'b'])
    expect(cellsOf(removeNodes(g, ['a']))).toEqual([{ nodeId: 'b' }])
  })
})

describe('a stored layout', () => {
  // A Map, not a Set: `validDashboard` asks each node's *type*, since an annotation cannot have
  // a cell. Both entries are ordinary nodes here; the annotation case is its own test below.
  const node = (id: string, type = 'out.table') => ({
    id,
    type,
    position: { x: 0, y: 0 },
    params: {},
  })
  const alive = new Map([
    ['a', node('a')],
    ['b', node('b')],
  ])

  it('keeps what is well formed and drops the rest, silently', () => {
    expect(
      validDashboard({ columns: 3, cells: [{ nodeId: 'a', w: 2 }, { nodeId: 'b' }] }, alive),
    ).toEqual(single(3, [{ nodeId: 'a', w: 2 }, { nodeId: 'b' }]))
    expect(validDashboard({ columns: 2, cells: 'nope' }, alive)).toBeUndefined()
    expect(validDashboard(undefined, alive)).toBeUndefined()
  })

  /*
   * Both halves of the one-cell-per-node rule have to hold here as well as in `addCells`: a
   * hand-edited file is the other way a duplicate arrives, and what it causes is two live
   * renderers rather than a visible mistake.
   */
  it('drops a cell naming a node that is not there, and a node named twice', () => {
    expect(
      validDashboard(
        { columns: 2, cells: [{ nodeId: 'a' }, { nodeId: 'ghost' }, { nodeId: 'a' }] },
        alive,
      ),
    ).toEqual(single(2, [{ nodeId: 'a' }]))
  })

  it('clamps a span and a column count that arrived out of range', () => {
    expect(
      validDashboard({ columns: 40, cells: [{ nodeId: 'a', w: 40, h: 40 }] }, alive),
    ).toEqual(single(6, [{ nodeId: 'a', w: 6, h: ROW_TRACKS }]))
  })

  /*
   * A height off the list is the shape a hand-edited file takes, and it is also what every cell
   * written by the version of this that allowed three row spans looks like. Snapped on load, so
   * no stored `h` can reach the stylesheet as a track count the drag could never reproduce.
   */
  it('snaps a stored height that is not one of the four on offer', () => {
    expect(
      validDashboard({ columns: 2, cells: [{ nodeId: 'a', h: 5 }] }, alive)?.tabs[0]?.cells,
    ).toEqual([{ nodeId: 'a', h: 4 }])
    expect(
      validDashboard({ columns: 2, cells: [{ nodeId: 'a', h: 1 }] }, alive)?.tabs[0]?.cells,
    ).toEqual([{ nodeId: 'a', h: 2 }])
  })

  it('is a layout of nothing rather than an empty one, when every cell went', () => {
    expect(validDashboard({ columns: 2, cells: [{ nodeId: 'ghost' }] }, alive)).toBeUndefined()
  })

  /*
   * The end-to-end claim the feature rests on: the dashboard is part of the document, so it
   * travels with the file, the share link and the Zoo entry. `serializeGraph` spreads the graph
   * rather than listing keys, which is what makes this true — and what would silently stop being
   * true if it ever started listing them.
   */
  it('survives a save and a load', () => {
    const g = setSpan(addCells(graphWith(['a', 'b']), ['b', 'a']), 'b', { w: 2, h: 2 })
    const back = deserializeGraph(serializeGraph(g)).graph
    expect(back.dashboard).toEqual({
      tabs: [
        {
          id: FIRST_TAB_ID,
          columns: DEFAULT_COLUMNS,
          cells: [{ nodeId: 'b', w: 2, h: 2 }, { nodeId: 'a' }],
        },
      ],
    })
  })

  it('keeps the cell for a node this build does not have, so the layout saves back whole', () => {
    // The node loads as a placeholder rather than being dropped, and a placeholder is an
    // ordinary card as far as a cell is concerned — its cell shows why it cannot run.
    const g = addCells(graphWith(['a', 'b']), ['a', 'b'])
    const json = JSON.parse(serializeGraph(g))
    json.nodes[0].type = 'nobody.registers.this'
    const loaded = deserializeGraph(JSON.stringify(json))
    expect(cellsOf(loaded.graph)).toEqual([{ nodeId: 'a' }, { nodeId: 'b' }])
    expect(loaded.warnings.join(' ')).not.toMatch(/dashboard/i)
    const saved = JSON.parse(serializeGraph(loaded.graph))
    expect(saved.nodes[0].type).toBe('nobody.registers.this')
    expect(saved.dashboard.cells).toEqual([{ nodeId: 'a' }, { nodeId: 'b' }])
  })

  it('loses the cell for a node the load dropped, without a warning about it', () => {
    const g = addCells(graphWith(['a', 'b']), ['a', 'b'])
    const json = JSON.parse(serializeGraph(g))
    delete json.nodes[0].type
    const loaded = deserializeGraph(JSON.stringify(json))
    expect(cellsOf(loaded.graph)).toEqual([{ nodeId: 'b' }])
    expect(loaded.warnings.join(' ')).not.toMatch(/dashboard/i)
  })
})

/**
 * The eligibility rule, at the two seams that create cells.
 *
 * Written per surface it was three spellings of one editorial rule with two live holes — the
 * "add the selection" gestures both passed the whole selection having checked only the clicked
 * node. Enforced here, no caller can produce a cell that draws a header over an empty box.
 */
describe('a node that cannot be drawn', () => {
  const withNote = (): CodaGraph => ({
    version: 1,
    nodes: [
      { id: 'a', type: 'out.table', position: { x: 0, y: 0 }, params: {} },
      { id: 'note', type: 'note.text', position: { x: 0, y: 0 }, params: {} },
    ],
    edges: [],
  })

  it('gets no cell however it is offered one', () => {
    const g = addCells(withNote(), ['a', 'note'])
    expect(cellsOf(g)).toEqual([{ nodeId: 'a' }])
    // The selection-shaped call, which is how it used to get in.
    expect(addCells(withNote(), ['note']).dashboard).toBeUndefined()
  })

  it('is dropped on load, because a file is the other way one arrives', () => {
    const nodes = withNote().nodes
    const alive = new Map(nodes.map((n) => [n.id, n]))
    expect(
      validDashboard({ columns: 2, cells: [{ nodeId: 'note' }, { nodeId: 'a' }] }, alive)
        ?.tabs[0]?.cells,
    ).toEqual([{ nodeId: 'a' }])
  })

  it('is filtered out of what the surfaces offer, in the order asked', () => {
    const g = withNote()
    expect(placeableIds(g, ['note', 'a', 'ghost'])).toEqual(['a'])
    expect(unplacedNodes(g).map((n) => n.id)).toEqual(['a'])
    expect(unplacedNodes(addCells(g, ['a']))).toEqual([])
  })
})

describe('allOnTab', () => {
  it('answers for a graph with no dashboard at all', () => {
    expect(allOnTab(activeTab(graphWith(['a'])), ['a'])).toBe(false)
    const g = addCells(graphWith(['a', 'b']), ['a'])
    expect(allOnTab(activeTab(g), ['a'])).toBe(true)
    // `every`: a mixed selection is not on, so the gesture finishes putting it on.
    expect(allOnTab(activeTab(g), ['a', 'b'])).toBe(false)
    // And no selection is never "all on", or an empty gesture would offer to remove nothing.
    expect(allOnTab(activeTab(g), [])).toBe(false)
  })
})

/**
 * Tabs: several pages of one dashboard, each its own grid.
 *
 * The load-bearing claims are about what does *not* change — a dashboard that never grows a
 * second page must be byte-identical on disk to one written before tabs existed — and about the
 * two ids that must keep naming the right thing when the strip moves under them.
 */
describe('tabs', () => {
  const ids = (g: CodaGraph) => g.dashboard?.tabs.map((t) => t.id)
  const on = (g: CodaGraph, tabId: string) =>
    g.dashboard?.tabs.find((t) => t.id === tabId)?.cells.map((c) => c.nodeId)

  it('writes a single untitled tab in the form every dashboard had before tabs', () => {
    const g = setViewOpen(addCells(graphWith(['a', 'b']), ['a', 'b']), true)
    const stored = JSON.parse(serializeGraph(g)).dashboard
    expect(Object.keys(stored)).toEqual(['columns', 'cells', 'open'])
    expect(stored).toEqual({
      columns: DEFAULT_COLUMNS,
      cells: [{ nodeId: 'a' }, { nodeId: 'b' }],
      open: true,
    })
  })

  /*
   * The byte-identity claim end to end: a file written by a build that had no tabs comes back
   * out exactly as it went in, apart from the save stamp every write changes.
   */
  it('round trips a pre-tabs file byte-identically', () => {
    const before = serializeGraph(
      setViewOpen(addCells(graphWith(['a', 'b']), ['b', 'a']), true),
    )
    const after = serializeGraph(deserializeGraph(before).graph)
    const unstamped = (json: string) => json.replace(/"modifiedAt": "[^"]*"/, '')
    expect(unstamped(after)).toBe(unstamped(before))
  })

  it('adds a page after the others and puts it on screen, with the grid it came from', () => {
    let g = setColumns(addCells(graphWith(['a']), ['a']), 4)
    g = addTab(g)
    expect(ids(g)).toEqual([FIRST_TAB_ID, 't2'])
    expect(activeTab(g)).toEqual({ id: 't2', columns: 4, cells: [] })
    expect(g.dashboard?.active).toBe('t2')
  })

  /*
   * The one way a layout comes into existence without a cell: asking for a second page is a
   * decision, where pressing `D` is not.
   */
  it('mints a layout of two empty pages on a graph that had none', () => {
    const g = addTab(graphWith(['a']))
    expect(g.dashboard?.tabs.map((t) => t.cells)).toEqual([[], []])
    expect(activeTab(g).id).toBe('t2')
  })

  it('lets a node sit on several tabs, once on each', () => {
    let g = addCells(graphWith(['a', 'b']), ['a'])
    g = addTab(g)
    g = addCells(g, ['a', 'a', 'b'])
    expect(on(g, FIRST_TAB_ID)).toEqual(['a'])
    expect(on(g, 't2')).toEqual(['a', 'b'])
    expect(tabsHolding(g, 'a')).toEqual([FIRST_TAB_ID, 't2'])
    expect(allOnTab(activeTab(g), ['b'])).toBe(true)
    expect(allOnTab(g.dashboard!.tabs[0]!, ['b'])).toBe(false)
    expect(unplacedNodes(g, FIRST_TAB_ID).map((n) => n.id)).toEqual(['b'])
  })

  it('addresses a tab that is not on screen, and does nothing for one that does not exist', () => {
    const g = addTab(addCells(graphWith(['a', 'b']), ['a']))
    expect(on(addCells(g, ['b'], FIRST_TAB_ID), FIRST_TAB_ID)).toEqual(['a', 'b'])
    expect(on(removeCells(g, ['a'], FIRST_TAB_ID), FIRST_TAB_ID)).toEqual([])
    expect(addCells(g, ['b'], 'ghost')).toBe(g)
    expect(setColumns(g, 5, 'ghost')).toBe(g)
  })

  it('switches tabs by id, and never mints a layout to switch on', () => {
    const g = addTab(addCells(graphWith(['a']), ['a']))
    const back = setActiveTab(g, FIRST_TAB_ID)
    // Absence means the first, so switching back removes the key rather than storing it.
    expect('active' in (back.dashboard ?? {})).toBe(false)
    expect(setActiveTab(back, FIRST_TAB_ID)).toBe(back)
    expect(setActiveTab(back, 'ghost')).toBe(back)
    const bare = graphWith(['a'])
    expect(setActiveTab(bare, FIRST_TAB_ID)).toBe(bare)
  })

  it('names a tab trimmed and capped, and a blank name is no name', () => {
    const g = addTab(addCells(graphWith(['a']), ['a']))
    const named = renameTab(g, 't2', '   Morphology  ')
    expect(activeTab(named).title).toBe('Morphology')
    expect(renameTab(named, 't2', 'Morphology')).toBe(named)
    expect('title' in activeTab(renameTab(named, 't2', '  '))).toBe(false)
    expect(activeTab(renameTab(g, 't2', 'x'.repeat(99))).title).toHaveLength(MAX_TAB_TITLE)
  })

  it('labels an untitled tab "Dashboard" alone and by position among others', () => {
    let g = addCells(graphWith(['a']), ['a'])
    expect(tabLabel(dashboardOf(g), activeTab(g))).toBe('Dashboard')
    g = addTab(g)
    const layout = dashboardOf(g)
    expect(layout.tabs.map((t) => tabLabel(layout, t))).toEqual(['Tab 1', 'Tab 2'])
  })

  it('writes the list form for a second tab or a name, with `active` only when not the first', () => {
    const one = renameTab(addCells(graphWith(['a']), ['a']), FIRST_TAB_ID, 'Overview')
    expect(JSON.parse(serializeGraph(one)).dashboard).toEqual({
      tabs: [
        {
          id: FIRST_TAB_ID,
          title: 'Overview',
          columns: DEFAULT_COLUMNS,
          cells: [{ nodeId: 'a' }],
        },
      ],
    })
    const two = setViewOpen(addTab(one, 'Detail'), true)
    const stored = JSON.parse(serializeGraph(two)).dashboard
    expect(Object.keys(stored)).toEqual(['tabs', 'active', 'open'])
    expect(stored.active).toBe('t2')
    expect(stored.tabs[1]).toEqual({
      id: 't2',
      title: 'Detail',
      columns: DEFAULT_COLUMNS,
      cells: [],
    })
    // …and loads back as it was written.
    expect(deserializeGraph(serializeGraph(two)).graph.dashboard).toEqual(two.dashboard)
  })

  it('removes a tab — its cells, not its nodes — and refuses the only one', () => {
    let g = addCells(graphWith(['a', 'b']), ['a'])
    expect(removeTab(g, FIRST_TAB_ID)).toBe(g)
    g = addCells(addTab(g), ['b'])
    const gone = removeTab(g, 't2')
    expect(ids(gone)).toEqual([FIRST_TAB_ID])
    expect(cellsOf(gone)).toEqual([{ nodeId: 'a' }])
    expect(gone.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })

  /*
   * Every tab strip's convention: the right-hand neighbour takes a removed tab's place, else the
   * left. Removing a tab that is *not* on screen must leave the screen alone.
   */
  it('hands the screen to a neighbour when the tab on it goes', () => {
    let g = addCells(graphWith(['a']), ['a'])
    g = addTab(addTab(addTab(g))) // main, t2, t3, t4 — t4 on screen
    expect(activeTab(removeTab(setActiveTab(g, 't2'), 't2')).id).toBe('t3')
    expect(activeTab(removeTab(g, 't4')).id).toBe('t3')
    expect(activeTab(removeTab(g, 't2')).id).toBe('t4')
  })

  /*
   * `active` is an id, but its absence means "the first" — and the first is what a move changes.
   * A move that put another tab first would otherwise silently switch the screen to it.
   */
  it('keeps the tab on screen on screen when the strip is reordered', () => {
    let g = addCells(graphWith(['a']), ['a'])
    g = setActiveTab(addTab(g), FIRST_TAB_ID)
    const moved = moveTab(g, 't2', 0)
    expect(ids(moved)).toEqual(['t2', FIRST_TAB_ID])
    expect(activeTab(moved).id).toBe(FIRST_TAB_ID)
    expect(moveTab(g, 't2', 1)).toBe(g)
  })

  it('duplicates a tab beside itself and puts the copy on screen', () => {
    let g = setSpan(addCells(graphWith(['a', 'b']), ['a', 'b']), 'a', { w: 2 })
    g = addTab(renameTab(g, FIRST_TAB_ID, 'Overview'))
    const copy = duplicateTab(g, FIRST_TAB_ID)
    expect(ids(copy)).toEqual([FIRST_TAB_ID, 't3', 't2'])
    expect(activeTab(copy)).toEqual({
      id: 't3',
      title: 'Overview copy',
      columns: DEFAULT_COLUMNS,
      cells: [{ nodeId: 'a', w: 2 }, { nodeId: 'b' }],
    })
  })

  /*
   * A tab is kept when its last node is deleted — a page somebody made is not decoration — and
   * the layout goes only when it has become the thing a graph with no dashboard already is.
   */
  it('keeps an emptied tab through a deletion, and drops only a layout that is no layout', () => {
    let g = addCells(graphWith(['a', 'b']), ['a'])
    g = addCells(addTab(g), ['b'])
    const pruned = pruneDashboard({ ...g, nodes: g.nodes.filter((n) => n.id === 'a') })
    expect(ids(pruned)).toEqual([FIRST_TAB_ID, 't2'])
    expect(on(pruned, 't2')).toEqual([])
    const named = renameTab(addCells(graphWith(['a']), ['a']), FIRST_TAB_ID, 'Overview')
    expect(ids(removeCells(named, ['a']))).toEqual([FIRST_TAB_ID])
  })

  it('reads the list form leniently', () => {
    const node = (id: string) => ({
      id,
      type: 'out.table',
      position: { x: 0, y: 0 },
      params: {},
    })
    const alive = new Map([
      ['a', node('a')],
      ['b', node('b')],
    ])
    const layout = validDashboard(
      {
        tabs: [
          { id: 'main', columns: 3, cells: [{ nodeId: 'a' }, { nodeId: 'a' }] },
          { id: 'main', title: '  Two ', cells: 'nope' },
          { title: 7, cells: [{ nodeId: 'a' }, { nodeId: 'ghost' }, { nodeId: 'b' }] },
          'junk',
        ],
        active: 'nowhere',
        open: true,
      },
      alive,
    )
    expect(layout).toEqual({
      tabs: [
        { id: 'main', columns: 3, cells: [{ nodeId: 'a' }] },
        { id: 't2', title: 'Two', columns: DEFAULT_COLUMNS, cells: [] },
        { id: 't3', columns: DEFAULT_COLUMNS, cells: [{ nodeId: 'a' }, { nodeId: 'b' }] },
      ],
      open: true,
    })
    expect(validDashboard({ tabs: [] }, alive)).toBeUndefined()
    expect(
      validDashboard({ tabs: [{ id: 'x', cells: [{ nodeId: 'ghost' }] }] }, alive),
    ).toBeUndefined()
    expect(
      validDashboard(
        {
          tabs: [
            { id: 'x', cells: [] },
            { id: 'y', cells: [] },
          ],
          active: 'x',
        },
        alive,
      )?.active,
    ).toBeUndefined()
  })
})
