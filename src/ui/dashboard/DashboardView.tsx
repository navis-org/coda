/**
 * The dashboard: the same graph, seen as a grid instead of a canvas.
 *
 * Build the pipeline on the canvas as usual, then assemble a wall of only the nodes worth
 * looking at. There are no wires here and no viewport — a cell is a *reference* to a node id,
 * so the graph stays the one source of truth and this is a second view of it rather than a
 * second copy. What the layout is allowed to hold is in `core/dashboard.ts`.
 *
 * **It replaces the canvas rather than covering it**, which `App.tsx` does by rendering one or
 * the other into the same grid area. That is a memory decision before it is a layout one: a grid
 * of live viewers *beside* a canvas of live previews is two WebGL contexts and two copies of the
 * geometry per node — the measurement `showPreview` already stands cards down for. Unmounting
 * React Flow trades contexts instead of adding them, and it is why a cell needs no stand-down
 * rule except the one it shares with a card: not while the overlay owns this node.
 *
 * This is the version of "lock the workspace" that does not need a workspace. The lock got there
 * by freezing the canvas so it could be used as a dashboard; a grid is the same want with the
 * canvas removed, which is why a dashboard edit is deliberately **live under the lock** — see
 * `addToDashboard` in the store.
 *
 * Ordering is the layout: cells flow across `columns` tracks in list order, so a reorder is a
 * splice. Flow is not `dense`, so a cell too wide for the room left on a row moves to the next
 * one and leaves a gap — visible, and preferable to CSS quietly reordering the list somebody
 * just dragged into place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  MAX_COLUMNS,
  MIN_COLUMNS,
  ROW_TRACKS,
  dashboardOf,
  unplacedNodes,
} from '../../core/dashboard'
import { getNodeDef } from '../../core/registry'
import { useGraphStore } from '../../store/graphStore'
import { useDismissOnOutside } from '../useDismiss'
import { DashboardCellView } from './DashboardCellView'
import { dropIndex, rowHeight } from './gridGeometry'

/** What the pointer is currently over, mid-drag. */
interface Over {
  nodeId: string
  after: boolean
}

export function DashboardView() {
  const graph = useGraphStore((s) => s.graph)
  const setDashboardOpen = useGraphStore((s) => s.setDashboardOpen)
  const addToDashboard = useGraphStore((s) => s.addToDashboard)
  const moveDashboardCell = useGraphStore((s) => s.moveDashboardCell)
  const setDashboardColumns = useGraphStore((s) => s.setDashboardColumns)
  /*
   * The count, not the array. A primitive — invariant 7 — and it is all that is *rendered*: the
   * ids themselves are read in the click handler, which runs long after any tick that changed
   * them. Subscribing to the array re-rendered the whole grid every time somebody clicked a card
   * on the canvas, for a row that is not on screen unless the menu is open.
   */
  const selectionCount = useGraphStore((s) => s.selection.length)

  const [dragging, setDragging] = useState<string | undefined>(undefined)
  const [over, setOver] = useState<Over | undefined>(undefined)
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef<HTMLDivElement>(null)
  // Stable, because `useDismissOnOutside` has it in an effect dep list — a fresh arrow per render
  // detaches and re-attaches two window listeners on every render while the menu is open.
  const closeAdd = useCallback(() => setAddOpen(false), [])
  useDismissOnOutside(addRef, closeAdd, { onEscape: true, enabled: addOpen })

  const layout = useMemo(() => dashboardOf(graph), [graph])
  // Keyed on `cells` rather than on `layout`, which changes identity whenever the graph does —
  // including on every committed sample of a resize drag.
  const order = useMemo(() => layout.cells.map((c) => c.nodeId), [layout.cells])
  /* The grid element only exists when there is something in it — see the empty state below. */
  const hasCells = layout.cells.length > 0

  /**
   * Nodes that could be added, and how many there are.
   *
   * Which nodes may have a cell is `canHaveCell`'s to say, not this file's — see `unplacedNodes`.
   *
   * Built only while the menu is open. It is an O(n) pass allocating an object per node, and it
   * was recomputing on every graph commit — including every committed sample of a resize drag —
   * for a list nobody was looking at. The *count* is needed either way, for the disabled state.
   */
  const candidates = useMemo(
    () =>
      addOpen
        ? unplacedNodes(graph).map((n) => ({
            id: n.id,
            label: n.title ?? getNodeDef(n.type)?.label ?? n.type,
          }))
        : [],
    [addOpen, graph],
  )
  const candidateCount = useMemo(() => unplacedNodes(graph).length, [graph])

  /*
   * The row height, measured rather than guessed.
   *
   * `ROW_TRACKS` tracks and their gaps have to come to exactly the area the grid was given, and
   * only the grid knows what that is: it is what is left after the toolbar, this view's own bar,
   * the status bar and the padding, which is four numbers no `vh` can see. Guessing it is what
   * gave every dashboard a scrollbar it had not earned, with the bottom row's resize corner
   * behind the status bar.
   *
   * Written straight to the element as a custom property rather than held in state, `ViewerDock`'s
   * drag-paint rule: this fires on every window resize, and a `setState` per frame would
   * re-render every cell in the grid — including the WebGL ones, whose whole cost is the
   * re-render. Nothing in React needs to know the number; the stylesheet is the only reader.
   *
   * `contentRect` excludes the padding, which is exactly the box the tracks have to fill — which
   * is also why there is no priming call: a `ResizeObserver` delivers an entry on `observe`, in
   * browsers and in `installJsdomStubs`' stub alike, so the one measurement that mattered would
   * have been a second, hand-computed one that had to subtract the padding itself. The CSS
   * fallback on `--dash-row` covers the frame before the first callback.
   *
   * The gap is read once, not per callback: this fires ~60 times a second while a window is being
   * resized, and `getComputedStyle` is a forced style resolution each time. It comes off the
   * stylesheet rather than a constant here, so the stylesheet stays the one place it is declared.
   */
  const gridRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const gap = parseFloat(getComputedStyle(grid).rowGap) || 0
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        grid.style.setProperty(
          '--dash-row',
          `${rowHeight(entry.contentRect.height, gap, ROW_TRACKS)}px`,
        )
      }
    })
    observer.observe(grid)
    return () => observer.disconnect()
    // Re-attached when the grid mounts or unmounts, which is what having any cells decides.
  }, [hasCells])

  /*
   * The drag's own state, mirrored into a ref so the four callbacks below can have empty dep
   * lists.
   *
   * That is what makes `React.memo` on `DashboardCellView` worth anything: a handler rebuilt when
   * `over` changes is a new prop on every cell, so every cell re-renders on every midpoint the
   * pointer crosses — the exact cost the memo was added to remove. `order` is in here for the
   * same reason and a stronger one: it is derived from the graph, so an `onDrop` that closed over
   * it changed identity on every commit, drag or no drag.
   *
   * Written during render rather than in an effect: these are read only from event handlers, which
   * cannot run before the commit that would have set them, and an effect would leave a frame in
   * which the ref disagrees with what is on screen.
   */
  const dragRef = useRef<{ dragging?: string; over?: Over; order: readonly string[] }>({
    order,
  })
  dragRef.current.dragging = dragging
  dragRef.current.over = over
  dragRef.current.order = order

  const endDrag = useCallback(() => {
    setDragging(undefined)
    setOver(undefined)
  }, [])

  const commitDrop = useCallback(() => {
    const { dragging: from, over: to, order: cells } = dragRef.current
    if (from && to) moveDashboardCell(from, dropIndex(cells, from, to.nodeId, to.after))
    endDrag()
  }, [endDrag, moveDashboardCell])

  const onDragOverCell = useCallback((nodeId: string, after: boolean) => {
    // Written unconditionally rather than compared first: React bails on an equal primitive, and
    // this is one object per `dragover` — which fires continuously while the pointer is still.
    setOver((prev) =>
      prev?.nodeId === nodeId && prev.after === after ? prev : { nodeId, after },
    )
  }, [])

  return (
    <div className="dashboard" data-tour="dashboard">
      <div className="dashboard__bar">
        <strong className="dashboard__title">Dashboard</strong>
        <span className="dashboard__count">
          {layout.cells.length} of {graph.nodes.length} nodes
        </span>

        <div className="dashboard__spacer" />

        <label className="dashboard__cols">
          Columns
          <input
            type="range"
            min={MIN_COLUMNS}
            max={MAX_COLUMNS}
            step={1}
            value={layout.columns}
            onChange={(e) => setDashboardColumns(Number(e.target.value))}
            aria-label="Grid columns"
          />
          <span>{layout.columns}</span>
        </label>

        {/*
         * Adding from *inside* the dashboard, as well as from the canvas. Without it the only
         * route in is a right-click on a card, so building a dashboard means leaving it — and
         * the thing you are trying to judge is how the grid looks with one more cell on it.
         */}
        {/* `dropdown`, not a fourth hand-written menu panel: the anchored-popover box is
            `.dropdown__panel`'s, and this only moves it to the right-hand edge. */}
        <div className="dropdown dashboard__add" ref={addRef}>
          <button
            type="button"
            className="btn"
            aria-expanded={addOpen}
            disabled={candidateCount === 0}
            title={
              candidateCount === 0
                ? 'Every node is already on the dashboard'
                : 'Put another node on the dashboard'
            }
            onClick={() => setAddOpen((open) => !open)}
          >
            + Add node
          </button>
          {addOpen && (
            <div className="dropdown__panel dashboard__addMenu" role="menu">
              {selectionCount > 0 && (
                <button
                  type="button"
                  className="dropdown__item"
                  onClick={() => {
                    // Read here rather than subscribed to: the ids cannot have moved between the
                    // menu opening and this click, and the array is not something to re-render
                    // the whole grid for. `addCells` drops any that cannot have a cell.
                    addToDashboard(useGraphStore.getState().selection)
                    setAddOpen(false)
                  }}
                >
                  Add the {selectionCount} selected
                </button>
              )}
              <div className={selectionCount > 0 ? 'dropdown__group' : undefined}>
                {candidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="dropdown__item"
                    onClick={() => {
                      addToDashboard([c.id])
                      setAddOpen(false)
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className="btn"
          onClick={() => setDashboardOpen(false)}
          title="Back to the canvas (the dashboard is saved with the graph)"
        >
          ← Canvas
        </button>
      </div>

      {!hasCells ? (
        <div className="dashboard__empty">
          <p>
            <strong>Nothing on the dashboard yet.</strong>
          </p>
          <p>
            Add the nodes worth looking at — from <em>+ Add node</em> above, or by
            right-clicking a card on the canvas. A cell points at the node; the graph stays the
            source of truth.
          </p>
        </div>
      ) : (
        <div
          ref={gridRef}
          className="dashboard__grid"
          style={{ '--dash-cols': layout.columns } as React.CSSProperties}
          onDragOver={(event) => {
            // The grid's own handler catches the gaps between cells, so a drag that strays into
            // one keeps its `dropEffect` rather than flickering to "no drop" and back.
            if (dragging) event.preventDefault()
          }}
        >
          {layout.cells.map((cell) => (
            <DashboardCellView
              key={cell.nodeId}
              cell={cell}
              columns={layout.columns}
              dragging={dragging}
              dropSide={
                over?.nodeId === cell.nodeId ? (over.after ? 'after' : 'before') : undefined
              }
              onDragStart={setDragging}
              onDragEnd={endDrag}
              onDragOverCell={onDragOverCell}
              onDrop={commitDrop}
            />
          ))}
        </div>
      )}
    </div>
  )
}
