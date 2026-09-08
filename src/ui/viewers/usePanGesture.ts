/**
 * A drag that pans a chart, without the four things that go wrong.
 *
 * The sibling of `useWheelZoom`, and extracted for the reason its header states: the wheel half
 * of this gesture was pulled out at the third viewer, and the *pointer* half was then copied
 * line-for-line into the third and fourth. The copies had already drifted — `HeatmapViewer` and
 * `ScatterViewer` take pointer capture on the press, which is the one thing the rule below says
 * must not happen — which is `paramPairs.ts`' second-consumer rule arriving exactly on schedule.
 *
 * Four rules, each of which the obvious version gets wrong and none of which jsdom can see:
 *
 * - **Pointer capture is taken at the slop, not at the press.** Captured from `pointerdown`, the
 *   `click` that follows is dispatched to the capturing element rather than to whatever was
 *   under the pointer — so on any chart whose marks are clickable, selection silently stops
 *   working the moment somebody zooms in. Taken once the gesture has travelled far enough to
 *   stop being a click, it still does what capture is for: a pan that runs off the edge of the
 *   card keeps going.
 * - **The hook swallows the click itself.** A pan that ends over a mark is followed by a real
 *   `click` on that mark, and selecting the thing you were only using as a handle to drag by is
 *   the failure. Handing the caller a `dragged` ref and the obligation to remember it is how one
 *   rule becomes two guards that drift — so `onClickCapture` stops it here, in the capture phase
 *   on the element the gesture is attached to, which is by construction an ancestor of every
 *   mark. The flag behind it is a ref rather than state because the click arrives *after* the
 *   gesture has ended, and because a chart re-rendering per pointer move would reconcile every
 *   mark.
 * - **The last position is a ref too.** It is read only by the next move and never rendered, so
 *   holding it in state is an allocation and a second update per pointer move for nothing.
 *   `panning` is the one piece the caller draws with, and it changes twice per gesture.
 * - **`enabled` is asked at the press, not at the spread.** A caller that attaches these
 *   handlers whenever the chart *could* zoom still needs the press ignored while it is fitted,
 *   or a fitted chart's marks become a one-pixel gamble between a click and a drag.
 *
 * What is deliberately left to the caller: `touchAction`/`cursor`/`user-select`, which are the
 * caller's own layout, and the units — `onPan` is handed pixels, because turning those into
 * matrix cells, leaf fractions or nanometres is the one line each viewer genuinely owns.
 */

import { useCallback, useRef, useState } from 'react'

import { CLICK_SLOP, tooltipPoint } from './tooltipPoint'

export interface PanGesture {
  /** True while a drag is live. For the grabbing cursor and the `user-select` suppression. */
  panning: boolean
  handlers: {
    onPointerDown: (event: React.PointerEvent) => void
    onPointerMove: (event: React.PointerEvent) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onClickCapture: (event: React.MouseEvent) => void
  }
}

export function usePanGesture(
  /** Whether a press should start a pan — typically "zoomable *and* currently zoomed". */
  enabled: boolean,
  /** The movement since the last event, in CSS pixels of the container's box. */
  onPan: (dx: number, dy: number) => void,
): PanGesture {
  const [panning, setPanning] = useState(false)
  const dragged = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  // Read through a ref, `useWheelZoom`'s rule: the callback closes over this render's window, so
  // a caller cannot be asked to memoise it and the handlers stay stable regardless.
  const latest = useRef(onPan)
  latest.current = onPan

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      dragged.current = false
      if (!enabled || event.button !== 0) return
      // `currentTarget` rather than a ref the caller has to pass: it *is* the element these
      // handlers are attached to, for the whole gesture, capture included — so there is no
      // second thing that can be pointed somewhere else.
      const point = tooltipPoint(event, event.currentTarget as HTMLElement)
      last.current = { x: point.x, y: point.y }
      setPanning(true)
    },
    [enabled],
  )

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const from = last.current
    if (!from) return
    const point = tooltipPoint(event, event.currentTarget as HTMLElement)
    const dx = point.x - from.x
    const dy = point.y - from.y
    if (!dragged.current && Math.hypot(dx, dy) > CLICK_SLOP) {
      dragged.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    last.current = { x: point.x, y: point.y }
    latest.current(dx, dy)
  }, [])

  const end = useCallback(() => {
    last.current = null
    setPanning(false)
  }, [])

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    // The click a pan ends with, stopped before it reaches the mark underneath. Capture phase,
    // so it never gets there at all rather than being un-done afterwards.
    if (dragged.current) event.stopPropagation()
  }, [])

  return {
    panning,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      // Cancel as well as up: a pointer the browser takes away (a gesture becoming a scroll, a
      // window losing focus) never sends `pointerup`, and the pan would stay live.
      onPointerCancel: end,
      onClickCapture,
    },
  }
}
