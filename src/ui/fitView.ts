/**
 * The framing every fit shares, and the two fits themselves.
 *
 * `FIT_VIEW_OPTIONS` lived in `Editor.tsx` until a second caller wanted it. It is shared so that
 * React Flow's own initial fit, a load's fit, the rail's Fit View and Fit Selected all frame
 * alike — the padding and the zoom ceiling are a tuning knob, and the thing that has to hold is
 * that one turn of it moves all four. It did not: the palette's Fit View passed a bare duration
 * and framed to React Flow's defaults, so the same command landed differently depending on which
 * surface you reached it from. Both fits are hooks here now, and nothing calls `fitView` with a
 * hand-written option set.
 */

import { useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'

import { useGraphStore } from '../store/graphStore'

export const FIT_VIEW_OPTIONS = { padding: 0.05, maxZoom: 3 }

/**
 * One duration for every viewport animation the rail and the palette start — the two fits and
 * the two zoom steps — so the whole set reads as one gesture family rather than four.
 */
export const FIT_DURATION = 240

/**
 * Frame the whole graph — the rail's Fit View, the `View ▸ Fit View` command, and the fit a load
 * asks for. The shared options are the entire point; see the module note.
 */
export function useFitAll(): () => void {
  const { fitView } = useReactFlow()
  return useCallback(
    () => void fitView({ ...FIT_VIEW_OPTIONS, duration: FIT_DURATION }),
    [fitView],
  )
}

/**
 * Frame the current selection — the button in the controls rail, the `§` key and the palette
 * command all end up here.
 *
 * **The unmeasurable set is checked before the call, not left to React Flow.** `fitView({ nodes })`
 * intersects the ids with the nodes it has measured and, finding none, fits a zero-sized box: the
 * bounds degrade to `{0, 0, 0, 0}`, the zoom clamps to `maxZoom` and the camera lands on the flow
 * origin — miles from the graph, with the selection nowhere on screen. That reads as the button
 * throwing the canvas away rather than as "there was nothing to frame", so an empty set does
 * nothing at all instead. A card that is selected is a card that was rendered, so this is the
 * pathological case (a stale id, a hidden node), not the ordinary one.
 *
 * Reads the selection through `getState()` at call time rather than subscribing: this is an
 * action, and a hook that re-ran on every selection change would re-render its whole rail.
 */
export function useFitSelected(): () => void {
  const { fitView, getInternalNode } = useReactFlow()
  return useCallback(() => {
    const nodes = useGraphStore
      .getState()
      .selection.filter((id) => {
        const node = getInternalNode(id)
        return Boolean(node && !node.hidden && node.measured.width && node.measured.height)
      })
      .map((id) => ({ id }))
    if (!nodes.length) return
    void fitView({ ...FIT_VIEW_OPTIONS, nodes, duration: FIT_DURATION })
  }, [fitView, getInternalNode])
}
