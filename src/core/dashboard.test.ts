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
  isOnDashboard,
  moveCell,
  pruneDashboard,
  removeCells,
  setColumns,
  setSpan,
  placeableIds,
  setViewOpen,
  unplacedNodes,
  validDashboard,
} from './dashboard'

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
    expect(g.dashboard?.cells.map((c) => c.nodeId)).toEqual(['c', 'a'])
    expect(addCells(g, ['b', 'c']).dashboard?.cells.map((c) => c.nodeId)).toEqual([
      'c',
      'a',
      'b',
    ])
  })

  /*
   * The one-cell-per-node rule, at the seam it is easiest to break. A cell is a *mount site*, so
   * a second cell for one node is a second live renderer of it — the measurement `showPreview`
   * stands cards down for. This is the half `addCells` enforces; `validDashboard` below is the
   * other way a duplicate arrives.
   */
  it('never places one node twice, however many times it is asked', () => {
    const g = addCells(addCells(graphWith(['a']), ['a', 'a']), ['a'])
    expect(g.dashboard?.cells).toEqual([{ nodeId: 'a' }])
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
  const order = (g: CodaGraph) => g.dashboard?.cells.map((c) => c.nodeId)

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
    expect(g.dashboard?.cells[0]).toEqual({ nodeId: 'a', w: 2, h: 6 })
    expect(setSpan(g, 'a', { w: 1, h: DEFAULT_ROW_SPAN }).dashboard?.cells[0]).toEqual({
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
    expect(g.dashboard).toEqual({
      columns: 2,
      cells: [
        { nodeId: 'a', w: 2 },
        { nodeId: 'b', w: 2 },
      ],
    })
  })

  it('refuses a column count outside the range instead of storing it', () => {
    const g = addCells(graphWith(['a']), ['a'])
    expect(setColumns(g, 99).dashboard?.columns).toBe(6)
    expect(setColumns(g, 0).dashboard?.columns).toBe(1)
    expect(setColumns(g, Number.NaN).dashboard?.columns).toBe(DEFAULT_COLUMNS)
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
    expect(pruned.dashboard?.cells).toEqual([{ nodeId: 'b' }])
    expect('dashboard' in pruneDashboard({ ...g, nodes: [] })).toBe(false)
  })

  it('is dropped by the deleting path itself, not only by a later pass', async () => {
    const { removeNodes } = await import('./graph')
    const g = addCells(graphWith(['a', 'b']), ['a', 'b'])
    expect(removeNodes(g, ['a']).dashboard?.cells).toEqual([{ nodeId: 'b' }])
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
    ).toEqual({ columns: 3, cells: [{ nodeId: 'a', w: 2 }, { nodeId: 'b' }] })
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
    ).toEqual({ columns: 2, cells: [{ nodeId: 'a' }] })
  })

  it('clamps a span and a column count that arrived out of range', () => {
    expect(
      validDashboard({ columns: 40, cells: [{ nodeId: 'a', w: 40, h: 40 }] }, alive),
    ).toEqual({
      columns: 6,
      cells: [{ nodeId: 'a', w: 6, h: ROW_TRACKS }],
    })
  })

  /*
   * A height off the list is the shape a hand-edited file takes, and it is also what every cell
   * written by the version of this that allowed three row spans looks like. Snapped on load, so
   * no stored `h` can reach the stylesheet as a track count the drag could never reproduce.
   */
  it('snaps a stored height that is not one of the four on offer', () => {
    expect(
      validDashboard({ columns: 2, cells: [{ nodeId: 'a', h: 5 }] }, alive)?.cells,
    ).toEqual([{ nodeId: 'a', h: 4 }])
    expect(
      validDashboard({ columns: 2, cells: [{ nodeId: 'a', h: 1 }] }, alive)?.cells,
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
      columns: DEFAULT_COLUMNS,
      cells: [{ nodeId: 'b', w: 2, h: 2 }, { nodeId: 'a' }],
    })
  })

  it('loses the cell for a node the load dropped, without a warning about it', () => {
    const g = addCells(graphWith(['a', 'b']), ['a', 'b'])
    const json = JSON.parse(serializeGraph(g))
    json.nodes[0].type = 'nobody.registers.this'
    const loaded = deserializeGraph(JSON.stringify(json))
    expect(loaded.graph.dashboard?.cells).toEqual([{ nodeId: 'b' }])
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
    expect(g.dashboard?.cells).toEqual([{ nodeId: 'a' }])
    // The selection-shaped call, which is how it used to get in.
    expect(addCells(withNote(), ['note']).dashboard).toBeUndefined()
  })

  it('is dropped on load, because a file is the other way one arrives', () => {
    const nodes = withNote().nodes
    const alive = new Map(nodes.map((n) => [n.id, n]))
    expect(
      validDashboard({ columns: 2, cells: [{ nodeId: 'note' }, { nodeId: 'a' }] }, alive)
        ?.cells,
    ).toEqual([{ nodeId: 'a' }])
  })

  it('is filtered out of what the surfaces offer, in the order asked', () => {
    const g = withNote()
    expect(placeableIds(g, ['note', 'a', 'ghost'])).toEqual(['a'])
    expect(unplacedNodes(g).map((n) => n.id)).toEqual(['a'])
    expect(unplacedNodes(addCells(g, ['a']))).toEqual([])
  })
})

describe('isOnDashboard', () => {
  it('answers for a graph with no dashboard at all', () => {
    expect(isOnDashboard(graphWith(['a']), 'a')).toBe(false)
    expect(isOnDashboard(addCells(graphWith(['a']), ['a']), 'a')).toBe(true)
  })
})
