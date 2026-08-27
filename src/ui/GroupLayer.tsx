/**
 * Group frames on the canvas: the box, its title, and the drag that moves everything inside it.
 *
 * **Not a React Flow node.** The library's own group node re-bases its children's `position` to
 * be relative to the parent, and this document's positions are absolute everywhere — the
 * exporters, the ELK pass, the splice hit test and every saved file. So a frame is drawn into
 * `ViewportPortal`, which puts plain DOM into the transformed viewport at flow coordinates, and
 * the document keeps one meaning of "position". The cost is that the drag is ours to write; see
 * below, where it is nine lines.
 *
 * **Three properties of the viewport are load-bearing here, and all three are inherited rather
 * than asked for.**
 *
 *  - The portal is the *last* child of the viewport, so at the default depth a frame would paint
 *    over every card. `z-index: -1` on the layer puts it under the cards and under the wires,
 *    which is where a background belongs; the viewport is itself a stacking context (`z-index:
 *    2` plus a transform), so the negative depth cannot escape it and land behind the canvas.
 *  - `.react-flow__viewport` is `pointer-events: none` and the cards switch it back on. The
 *    frame does the same, and only on the parts that are meant to be grabbable — so the
 *    **interior stays click-through**: panning, box-select and clicking a card inside a frame
 *    all behave exactly as they do on bare canvas. The outline itself is a `pointer-events:
 *    stroke` rect with an invisible band `GROUP_GRAB` wide over the top of it.
 *  - Panning is d3-zoom's, bound to `.react-flow__pane` with a *native* listener below React's
 *    root — so `stopPropagation` on a synthetic event cannot reach it. The `nopan` class is what
 *    d3's own filter reads, and it is the only thing that stops the canvas sliding out from
 *    under a frame being dragged.
 *
 * The drag itself writes through `moveNodes`, the same action a card drag uses: one frame per
 * pointer move with `commit: false`, one committing call at the end. That is what makes ⌘Z put
 * the whole gesture back rather than its last frame, and what makes a locked canvas refuse it —
 * the guard is already in the action, and the layer only adds the notice that says so.
 */

import { ViewportPortal, useReactFlow } from '@xyflow/react'
import { useRef, useState } from 'react'

import type { GraphGroup } from '../core/graph'
import type { MeasuredSizes } from '../layout/elkGraph'
import { groupBoxes } from '../layout/groupBounds'
import { useGraphStore } from '../store/graphStore'
import { LOCKED_NOTICE } from './lockCopy'

/**
 * Width of the invisible band over the outline that a pointer can grab, in flow units.
 *
 * Centred on the stroke, so it reaches ±7 either side. Wide enough to hit without aiming at a
 * 1.5px line, and narrow enough to stay clear of the cards inside — which is the other half of
 * why `GROUP_PADDING` is 24 rather than 8.
 */
export const GROUP_GRAB = 14

/** Below this much pointer travel a drag is a click, and the cards are left where they are. */
const DRAG_SLOP = 2

interface Drag {
  pointerId: number
  startX: number
  startY: number
  zoom: number
  /** Where each member was when the gesture began — deltas are applied to these, not stacked. */
  from: Array<{ id: string; position: { x: number; y: number } }>
  moved: boolean
}

export interface GroupLayerProps {
  /** What React Flow last measured for each card. Without it every box fits the fallback size. */
  measured: MeasuredSizes
  /** The frame whose title is being typed, if any. Owned by the canvas so the menu can set it. */
  editingId: string | undefined
  onEditingChange: (groupId: string | undefined) => void
  onContextMenu: (groupId: string, screenPosition: { x: number; y: number }) => void
}

export function GroupLayer({
  measured,
  editingId,
  onEditingChange,
  onContextMenu,
}: GroupLayerProps) {
  const graph = useGraphStore((s) => s.graph)
  const selection = useGraphStore((s) => s.selection)
  // A primitive — invariant 7. Only the cursor reads it; the refusal is `moveNodes`'s own.
  const locked = useGraphStore((s) => s.locked)
  const { getZoom } = useReactFlow()
  const dragRef = useRef<Drag | null>(null)

  if (!graph.groups?.length) return null

  const boxes = groupBoxes(graph, measured)
  const byId = new Map(graph.groups.map((g) => [g.id, g]))
  const selected = new Set(selection)

  /**
   * Take hold of a frame.
   *
   * Selecting the members is part of the gesture rather than a separate click: a frame you are
   * about to move is a set you have picked, and the inspector, the mute key and ⌘D all read the
   * selection. ⌘/Ctrl adds to it, matching `multiSelectionKeyCode` on the canvas.
   */
  const onPointerDown = (event: React.PointerEvent, group: GraphGroup) => {
    if (event.button !== 0 || editingId === group.id) return
    const store = useGraphStore.getState()
    if (store.locked) {
      // The lock refuses the move at `moveNodes` regardless; this is the half that speaks, for
      // the reason every other locked surface does.
      store.setNotice(LOCKED_NOTICE)
      return
    }
    event.stopPropagation()
    const target = event.currentTarget as Element
    target.setPointerCapture(event.pointerId)

    const members = new Set(group.nodeIds)
    const from = store.graph.nodes
      .filter((n) => members.has(n.id))
      .map((n) => ({ id: n.id, position: n.position }))
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // Read once: the camera cannot move during the gesture, since the frame holds the pointer
      // and `nopan` keeps d3-zoom out of it.
      zoom: getZoom() || 1,
      from,
      moved: false,
    }
    const additive = event.metaKey || event.ctrlKey
    store.setSelection(
      additive ? [...new Set([...store.selection, ...group.nodeIds])] : group.nodeIds,
    )
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = (event.clientX - drag.startX) / drag.zoom
    const dy = (event.clientY - drag.startY) / drag.zoom
    if (!drag.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return
    drag.moved = true
    useGraphStore.getState().moveNodes(shift(drag, dx, dy), false)
  }

  const onPointerUp = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (!drag.moved) return
    const dx = (event.clientX - drag.startX) / drag.zoom
    const dy = (event.clientY - drag.startY) / drag.zoom
    // The committing frame, which is the one that becomes a single undo step for the whole drag.
    useGraphStore.getState().moveNodes(shift(drag, dx, dy), true)
  }

  return (
    <ViewportPortal>
      <div className="group-layer" data-locked={locked || undefined}>
        {boxes.map((box) => {
          const group = byId.get(box.id)
          if (!group) return null
          const isSelected =
            group.nodeIds.length > 0 && group.nodeIds.every((id) => selected.has(id))
          const editing = editingId === group.id
          const handlers = {
            onPointerDown: (event: React.PointerEvent) => onPointerDown(event, group),
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
            onDoubleClick: (event: React.MouseEvent) => {
              event.stopPropagation()
              onEditingChange(group.id)
            },
            onContextMenu: (event: React.MouseEvent) => {
              event.preventDefault()
              event.stopPropagation()
              onContextMenu(group.id, { x: event.clientX, y: event.clientY })
            },
          }

          return (
            <div
              key={group.id}
              className="group-frame"
              data-color={group.color ?? 'grey'}
              data-filled={group.filled || undefined}
              data-dashed={group.dashed || undefined}
              data-selected={isSelected || undefined}
              data-group-id={group.id}
              style={
                {
                  transform: `translate(${box.x - GROUP_GRAB / 2}px, ${
                    box.y - GROUP_GRAB / 2
                  }px)`,
                  width: box.width + GROUP_GRAB,
                  height: box.height + GROUP_GRAB,
                  // The one constant that decides this geometry, published so the stylesheet
                  // does not spell it a second time.
                  '--group-grab': `${GROUP_GRAB}px`,
                } as React.CSSProperties
              }
            >
              {/*
               * One `<svg>` and three rects, rather than a `<div>` with a border, because only
               * SVG can say "the stroke is the target and the middle is not". A bordered div
               * takes the whole rectangle or none of it, and taking the whole rectangle is what
               * makes the canvas inside a frame stop panning.
               */}
              <svg
                className="group-frame__svg"
                width={box.width + GROUP_GRAB}
                height={box.height + GROUP_GRAB}
                aria-hidden="true"
              >
                <rect
                  className="group-frame__fill"
                  x={GROUP_GRAB / 2}
                  y={GROUP_GRAB / 2}
                  width={box.width}
                  height={box.height}
                  rx="14"
                />
                <rect
                  className="group-frame__line"
                  x={GROUP_GRAB / 2}
                  y={GROUP_GRAB / 2}
                  width={box.width}
                  height={box.height}
                  rx="14"
                />
                {/*
                 * The grab band: transparent, `GROUP_GRAB` wide, centred on the same path. Last
                 * so it is on top of the two it covers, and `nopan` so d3-zoom's filter — a
                 * native listener React cannot stop — leaves the pointer alone.
                 */}
                <rect
                  className="group-frame__grab nopan"
                  x={GROUP_GRAB / 2}
                  y={GROUP_GRAB / 2}
                  width={box.width}
                  height={box.height}
                  rx="14"
                  strokeWidth={GROUP_GRAB}
                  {...handlers}
                />
              </svg>

              {(group.title || editing) && (
                <div className="group-frame__title-row">
                  {editing ? (
                    <GroupTitleInput
                      group={group}
                      onDone={() => onEditingChange(undefined)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="group-frame__title nopan"
                      title={`Group: ${group.title}`}
                      {...handlers}
                    >
                      {group.title}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ViewportPortal>
  )
}

/** Every member's starting position plus the gesture's delta. Never stacked frame on frame. */
function shift(drag: Drag, dx: number, dy: number) {
  return drag.from.map((n) => ({
    id: n.id,
    position: { x: n.position.x + dx, y: n.position.y + dy },
  }))
}

/**
 * The title field.
 *
 * Escape reverts and blur commits, and the flag is why — the same trap `NoteCard` records:
 * unmounting a focused input can fire blur on the way out, so "cancel" cannot be expressed by
 * leaving edit mode, because the blur handler would then write the edit being abandoned.
 */
function GroupTitleInput({ group, onDone }: { group: GraphGroup; onDone: () => void }) {
  const renameGroup = useGraphStore((s) => s.renameGroup)
  const [text, setText] = useState(group.title ?? '')
  const reverting = useRef(false)

  return (
    <input
      className="group-frame__title-input nopan nodrag"
      value={text}
      autoFocus
      aria-label="Group title"
      placeholder="Name this group"
      onChange={(event) => setText(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          reverting.current = true
          event.currentTarget.blur()
        }
        // Every canvas shortcut is a window listener that skips fields — but Escape and the
        // canvas's own keys reach it through React first, so the propagation stops here.
        event.stopPropagation()
      }}
      onBlur={() => {
        if (!reverting.current) renameGroup(group.id, text.trim())
        onDone()
      }}
    />
  )
}
