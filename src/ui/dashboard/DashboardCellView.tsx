/**
 * One cell of the dashboard: a node, drawn in a box, with the two gestures that move it.
 *
 * The inside is `ViewerSurface` under `variant="cell"` — the same component the overlay and the
 * dock use, so a cell shows a Network node's network, a Connectivity node's table and an Explore
 * node's browser without knowing that any of those exist. That is the whole reason a cell can be
 * "any node off the graph" rather than "any viewer".
 *
 * What this file owns is the frame and the three things a frame in a grid has to do:
 *
 *  - **Say where it is.** `grid-column: span w` / `grid-row: span h`, straight off the cell.
 *  - **Be reorderable.** HTML5 drag and drop, from a grip in the header. The drop *target* is a
 *    layer that only exists mid-drag and sits above everything, which is not decoration: half
 *    the things in a cell are `<iframe>`s and WebGL canvases, and an `iframe` eats every pointer
 *    and drag event that lands on it. A cell whose body is a neuroglancer embed would otherwise
 *    be the one cell nothing can be dropped onto — silently, and only for that node.
 *  - **Be resizable.** A corner grip with pointer capture, the idiom `ViewerDock`'s width grip
 *    and `GroupLayer` already use. The arithmetic is in `gridGeometry.ts`, headless.
 *
 * The buttons are the interaction contract in miniature: **look, restyle, run — never restructure.**
 * `⚙` shows the node's presentational rail, `▸` runs this node, `⤢` hands it to the full-size
 * overlay, `✕` takes the cell off the dashboard. Nothing here rewires, deletes or moves a card,
 * because the graph is the source of truth and this is a view of it.
 *
 * `✕` removes the *cell*, not the node, and the title says so. The two are one keystroke apart
 * on every other surface in the app, and getting them confused here costs somebody a subtree.
 */

import { memo, useCallback, useRef, useState } from 'react'

import type { DashboardCell } from '../../core/dashboard'
import { DEFAULT_ROW_SPAN, ROW_TRACKS } from '../../core/dashboard'
import { useGraphStore } from '../../store/graphStore'
import { ViewerSurface } from '../panels/ViewerSurface'
import { spanFromDrag } from './gridGeometry'

/** Where a drop would land relative to this cell, while one is being dragged over it. */
export type DropSide = 'before' | 'after' | undefined

interface ResizeDrag {
  /** The cell's box when the grip was grabbed. Every sample is measured against this. */
  width: number
  height: number
  startW: number
  startH: number
  x: number
  y: number
  /**
   * The grid's gaps, read once off the computed style rather than from a constant here.
   *
   * The stylesheet is the one place the gap is declared; a number in this file agreeing with it
   * is a comment claiming two languages agree, which `markGeometry.ts` already records as the
   * thing not to do. Column and row gaps are read separately because they need not be equal.
   */
  gapX: number
  gapY: number
}

function DashboardCellViewInner({
  cell,
  columns,
  dragging,
  dropSide,
  onDragStart,
  onDragEnd,
  onDragOverCell,
  onDrop,
}: {
  cell: DashboardCell
  /** The grid's track count — the ceiling on `w`. */
  columns: number
  /** The cell currently being dragged, if any. Drives the drop layer's existence. */
  dragging: string | undefined
  dropSide: DropSide
  onDragStart: (nodeId: string) => void
  onDragEnd: () => void
  onDragOverCell: (nodeId: string, after: boolean) => void
  onDrop: () => void
}) {
  const nodeId = cell.nodeId
  const runNode = useGraphStore((s) => s.runNode)
  const expandNode = useGraphStore((s) => s.expandNode)
  const removeFromDashboard = useGraphStore((s) => s.removeFromDashboard)
  const setDashboardSpan = useGraphStore((s) => s.setDashboardSpan)
  // A primitive — invariant 7. The cell stands down while the overlay draws this same node,
  // which is `showPreview`'s rule reaching its third surface rather than a new one.
  const expanded = useGraphStore((s) => s.expandedNodeId === nodeId)

  const [railOpen, setRailOpen] = useState(false)
  const frameRef = useRef<HTMLElement>(null)
  const resizeRef = useRef<ResizeDrag | undefined>(undefined)

  const w = cell.w ?? 1
  // Not `?? 1`: a row track is a sixth of the screen and no cell is ever one. See
  // `DEFAULT_ROW_SPAN` for why the two axes disagree about what absence means.
  const h = cell.h ?? DEFAULT_ROW_SPAN

  const onResizeDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const frame = frameRef.current
      const grid = frame?.parentElement
      if (!frame || !grid) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const box = frame.getBoundingClientRect()
      const style = getComputedStyle(grid)
      resizeRef.current = {
        width: box.width,
        height: box.height,
        startW: w,
        startH: h,
        x: event.clientX,
        y: event.clientY,
        gapX: parseFloat(style.columnGap) || 0,
        gapY: parseFloat(style.rowGap) || 0,
      }
    },
    [w, h],
  )

  const onResizeMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = resizeRef.current
      if (!drag) return
      /*
       * Committed on every sample that *changes* a span, not on release.
       *
       * The opposite of `ViewerDock`'s grip, and the difference is what is being written: the
       * dock paints a CSS custom property because a store write there re-renders the surface
       * whose whole point is to stay untouched, at sixty hertz. Here the value is discrete —
       * a whole track — so a drag across a cell produces two or three writes, not sixty, and
       * `commit` drops the ones that change nothing by identity. The tag on `setDashboardSpan`
       * folds what is left into one undo step.
       */
      setDashboardSpan(nodeId, {
        w: spanFromDrag(drag.width, drag.startW, event.clientX - drag.x, drag.gapX, columns),
        /*
         * Raw tracks, not a height. The drag has to be measured against the grid the cell is
         * actually laid out on; `clampSpan` is what rounds the result to one of the four heights
         * on offer, and it is the only place that knows what they are.
         */
        h: spanFromDrag(
          drag.height,
          drag.startH,
          event.clientY - drag.y,
          drag.gapY,
          ROW_TRACKS,
        ),
      })
    },
    [columns, nodeId, setDashboardSpan],
  )

  const onResizeUp = useCallback(() => {
    resizeRef.current = undefined
  }, [])

  return (
    <section
      ref={frameRef}
      className="dash-cell"
      style={{ gridColumn: `span ${w}`, gridRow: `span ${h}` }}
      data-node={nodeId}
      data-drop={dropSide}
      data-dragged={dragging === nodeId ? '' : undefined}
      aria-label={`Dashboard cell`}
    >
      <div className="dash-cell__panel viewer-surface">
        {expanded ? (
          /*
           * The stand-down. A viewer is a renderer, not a picture — the overlay is bigger and
           * modal, so while it owns this node there is nothing behind it worth two contexts and
           * two copies of the geometry. Named rather than blank: an empty box in a grid of
           * boxes reads as the cell having broken.
           */
          <p className="dash-cell__standby">Open in the full-size viewer</p>
        ) : (
          <ViewerSurface
            nodeId={nodeId}
            controls={railOpen ? 'rail' : 'hidden'}
            leading={
              <div
                className="dash-cell__grip"
                draggable
                role="button"
                tabIndex={0}
                aria-label="Reorder cell"
                title="Drag to reorder"
                onDragStart={(event) => {
                  // Firefox starts no drag at all without payload, and the id is what the drop
                  // handler would otherwise have to read out of React state mid-gesture.
                  event.dataTransfer.setData('text/plain', nodeId)
                  event.dataTransfer.effectAllowed = 'move'
                  onDragStart(nodeId)
                }}
                onDragEnd={onDragEnd}
              >
                ⠿
              </div>
            }
            actions={
              <>
                <button
                  type="button"
                  className="btn btn--ghost"
                  aria-pressed={railOpen}
                  onClick={() => setRailOpen((open) => !open)}
                  title={railOpen ? 'Hide the display settings' : 'Display settings'}
                  aria-label="Display settings"
                >
                  ⚙
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void runNode(nodeId)}
                  title="Run this node"
                  aria-label="Run this node"
                >
                  ▸
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => expandNode(nodeId)}
                  title="Open full size — every setting, including the style panel"
                  aria-label="Expand"
                >
                  ⤢
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => removeFromDashboard([nodeId])}
                  title="Take this off the dashboard — the node stays on the canvas"
                  aria-label="Remove from dashboard"
                >
                  ✕
                </button>
              </>
            }
          />
        )}
      </div>

      {/*
       * The drop layer, and it exists only while something is being dragged. Mounted always, it
       * would be a transparent sheet over every viewer in the grid — no rotating a 3D scene, no
       * sorting a table. See the file note for why it has to be a layer rather than handlers on
       * the panel.
       */}
      {dragging && (
        <div
          className="dash-cell__drop"
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            const box = event.currentTarget.getBoundingClientRect()
            onDragOverCell(nodeId, event.clientX > box.left + box.width / 2)
          }}
          onDrop={(event) => {
            event.preventDefault()
            onDrop()
          }}
        />
      )}

      {/*
       * The resize grip. Below the drop layer in the DOM but never live at the same time — a
       * drag in progress means the layer is over it — so the two gestures cannot both claim a
       * pointer. `touch-action: none` in the stylesheet, or a touch drag scrolls the grid
       * instead.
       */}
      <div
        className="dash-cell__resize"
        role="separator"
        aria-label="Resize cell"
        aria-orientation="horizontal"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
    </section>
  )
}

/**
 * Memoised, and it is the cell rather than the grid that has to be.
 *
 * `DashboardView` re-renders on four pieces of state that concern at most two cells — the add
 * menu opening, the dragged id, the drop side, the selection — and each of those walked all *n*
 * cells and reconciled the `ViewerSurface` inside every one. Viewers are not memoised, so that
 * is a table's rows or a scene's children rebuilt *n* times for opening a menu.
 *
 * Safe because a cell does not read the graph through its props: `ViewerSurface` subscribes to
 * `s.graph` itself, so a memoised cell still updates when its node runs, is renamed or is
 * restyled. What the props carry is only this cell's *place* in the grid, and those really do
 * change only when they change.
 *
 * It buys nothing without stable callbacks, which is what the refs in `DashboardView` are for —
 * an `onDrop` rebuilt on every `over` change would re-render every cell exactly as before.
 */
export const DashboardCellView = memo(DashboardCellViewInner)
