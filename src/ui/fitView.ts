/**
 * The framing both fits share, and the "fit what is selected" half.
 *
 * `FIT_VIEW_OPTIONS` lived in `Editor.tsx` until a second caller wanted it. It is shared so a
 * freshly opened graph, React Flow's own initial fit and Fit Selected all frame alike, and
 * `maxZoom: 1` so a two-node graph — or one selected card — is not blown up to fill a monitor.
 */

import { useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'

import { useGraphStore } from '../store/graphStore'

export const FIT_VIEW_OPTIONS = { padding: 0.05, maxZoom: 3 }

/** Matches the duration a load's fit animates over, so the two read as the same gesture. */
const FIT_DURATION = 240

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
