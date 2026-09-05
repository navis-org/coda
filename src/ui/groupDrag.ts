/**
 * Moving every card in a frame with one pointer, shared by the two surfaces that offer it.
 *
 * The outline of an expanded frame (`GroupLayer`) and the box a collapsed one folds into
 * (`GroupCollapsedCard`) are the same gesture on two drawings: take hold, move the members, let
 * go. Written twice they would agree until one of them learned something — and the things this
 * has to know are exactly the ones that are silent when they are wrong.
 *
 *  - The write goes through **`moveNodes`**, the same action a card drag uses: one call per
 *    pointer move with `commit: false`, one committing call at the end. That is what makes ⌘Z put
 *    the whole gesture back rather than its last frame, what switches auto-layout off, and what
 *    makes a locked canvas refuse it.
 *  - Deltas are applied to the positions captured at `pointerdown`, never stacked frame on frame,
 *    so a dropped move cannot make the group drift.
 *  - The zoom is read **once**: the camera cannot move during the gesture, because the surface
 *    holds the pointer and `nopan` keeps d3-zoom out of it.
 *  - Selecting the members is part of the gesture rather than a separate click — a frame you are
 *    about to move is a set you have picked, and the inspector, the mute key and ⌘D all read the
 *    selection. ⌘/Ctrl adds to it, matching `multiSelectionKeyCode` on the canvas.
 *
 * The lock is refused at `moveNodes` regardless; what happens here is the half that *speaks*,
 * for the reason every other locked surface does.
 */

import { useReactFlow } from '@xyflow/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useRef } from 'react'

import type { GraphGroup } from '../core/graph'
import { useGraphStore } from '../store/graphStore'
import { LOCKED_NOTICE } from './lockCopy'

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

export interface GroupDragHandlers {
  onPointerDown: (event: ReactPointerEvent) => void
  onPointerMove: (event: ReactPointerEvent) => void
  onPointerUp: (event: ReactPointerEvent) => void
  onPointerCancel: (event: ReactPointerEvent) => void
}

/** Every member's starting position plus the gesture's delta. Never stacked frame on frame. */
function shift(drag: Drag, dx: number, dy: number) {
  return drag.from.map((n) => ({
    id: n.id,
    position: { x: n.position.x + dx, y: n.position.y + dy },
  }))
}

/**
 * Handlers for dragging one frame's members.
 *
 * `disabled` is for a surface with its own reason to stand aside — a title being typed, say —
 * rather than for the lock, which answers for itself.
 */
export function useGroupDrag(): (
  group: GraphGroup,
  options?: { disabled?: boolean },
) => GroupDragHandlers {
  const { getZoom } = useReactFlow()
  const dragRef = useRef<Drag | null>(null)

  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = (event.clientX - drag.startX) / drag.zoom
    const dy = (event.clientY - drag.startY) / drag.zoom
    if (!drag.moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return
    drag.moved = true
    useGraphStore.getState().moveNodes(shift(drag, dx, dy), false)
  }, [])

  const onPointerUp = useCallback((event: ReactPointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (!drag.moved) return
    const dx = (event.clientX - drag.startX) / drag.zoom
    const dy = (event.clientY - drag.startY) / drag.zoom
    // The committing frame, which is the one that becomes a single undo step for the whole drag.
    useGraphStore.getState().moveNodes(shift(drag, dx, dy), true)
  }, [])

  return useCallback(
    (group, options) => ({
      onPointerDown: (event) => {
        if (event.button !== 0 || options?.disabled) return
        const store = useGraphStore.getState()
        if (store.locked) {
          store.setNotice(LOCKED_NOTICE)
          return
        }
        event.stopPropagation()
        const target = event.currentTarget as Element
        target.setPointerCapture(event.pointerId)

        const members = new Set(group.nodeIds)
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          zoom: getZoom() || 1,
          from: store.graph.nodes
            .filter((n) => members.has(n.id))
            .map((n) => ({ id: n.id, position: n.position })),
          moved: false,
        }
        const additive = event.metaKey || event.ctrlKey
        store.setSelection(
          additive ? [...new Set([...store.selection, ...group.nodeIds])] : group.nodeIds,
        )
      },
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    }),
    [getZoom, onPointerMove, onPointerUp],
  )
}
