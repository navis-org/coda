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

import { useCallback, useEffect } from 'react'
import { useReactFlow } from '@xyflow/react'

import { channel } from '../data/channel'
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
 *
 * **Returns whether it framed anything**, which is the seam `useFitSelectedRequests` needs: for
 * the rail and the `§` key an empty answer is the end of it, but a caller that has just *made*
 * the node it is selecting is asking a moment too early rather than asking about nothing.
 */
export function useFitSelected(): (options?: FitSelectedOptions) => boolean {
  const { fitView, getInternalNode } = useReactFlow()
  return useCallback(
    (options?: FitSelectedOptions) => {
      const nodes = useGraphStore
        .getState()
        .selection.filter((id) => {
          const node = getInternalNode(id)
          return Boolean(node && !node.hidden && node.measured.width && node.measured.height)
        })
        .map((id) => ({ id }))
      if (!nodes.length) return false
      void fitView({
        ...FIT_VIEW_OPTIONS,
        ...(options?.maxZoom === undefined ? {} : { maxZoom: options.maxZoom }),
        nodes,
        duration: FIT_DURATION,
      })
      return true
    },
    [fitView, getInternalNode],
  )
}

/** Overrides a caller may put on top of {@link FIT_VIEW_OPTIONS} for one fit. */
export interface FitSelectedOptions {
  /**
   * A lower zoom ceiling than the shared one, for a fit onto a *single* card.
   *
   * `FIT_VIEW_OPTIONS.maxZoom` is 3, which is right for the rail's Fit Selected — you asked for
   * those nodes, so fill the screen with them. Framing one 232px card at 3× fills a 1440px
   * viewport with a single node: the card's own text becomes 40px tall, the graph around it is
   * gone, and a spotlight cut around it has nothing left to dim. Seen in a browser on the tour's
   * card step before this existed.
   */
  maxZoom?: number
}

/**
 * "Frame what is selected", asked for from outside the React Flow provider.
 *
 * A channel rather than a store field, and the distinction is the same one `fitRequest` already
 * draws from the other side: `fitRequest` exists because *loading a graph* has to leave the
 * camera somewhere sensible, which is a fact about the document and belongs in the store. This
 * is a passing gesture with no state to it — nothing would ever read "a fit was once asked for"
 * — and a counter in the store would be one more field every snapshot comparison walks.
 *
 * The Guided Tour is the caller: it selects the card a step is about and frames it, so the
 * three card steps land on a readable card rather than on whatever size the last fit left. The
 * `§` key and the rail's button reach `useFitSelected` directly, being inside the provider.
 */
const fitSelectedChannel = channel<FitSelectedOptions | undefined>()

/** Ask the canvas to frame the current selection. A no-op if the canvas is not mounted. */
export function requestFitSelected(options?: FitSelectedOptions): void {
  fitSelectedChannel.notify(options)
}

/**
 * How many frames a request will wait for its nodes to be measured before giving up.
 *
 * React Flow measures through a `ResizeObserver`, so a card is measured a frame or two after
 * React commits it — around 32 ms in practice. 30 frames is half a second, which is generous
 * enough for a slow commit and short enough that a request for a node that is never going to
 * arrive stops rather than spinning for the life of the page.
 */
const FIT_RETRY_FRAMES = 30

/**
 * Subscribes the canvas to {@link requestFitSelected}. Mounted once, by `Editor`.
 *
 * **It retries across frames, and without that the whole thing is a no-op for its main caller.**
 * `useFitSelected` deliberately declines to frame nodes React Flow has not measured — see its
 * note, where the case it is guarding against is a *stale* id. But "Learn to Build" selects a
 * card in the same tick it adds it, and a card added this tick has no measured size yet: the set
 * empties, the fit declines, and the camera simply never moves. Nothing fails, and the symptom
 * appears several steps later as a node built off the edge of the screen — the Bar Chart, at the
 * far end of the chain, was where it finally became visible.
 *
 * So the request is a standing one until it can be honoured. Each new request cancels the last:
 * two fits racing to different nodes is worse than the second one waiting its turn.
 */
export function useFitSelectedRequests(): void {
  const fitSelected = useFitSelected()
  useEffect(() => {
    // 0 is the "nothing pending" value: `cancelAnimationFrame` of an id that was never issued
    // is a defined no-op, so it needs no guard of its own.
    let frame = 0
    const unsubscribe = fitSelectedChannel.subscribe((options) => {
      cancelAnimationFrame(frame)
      let left = FIT_RETRY_FRAMES
      const attempt = () => {
        if (fitSelected(options) || --left <= 0) return
        frame = requestAnimationFrame(attempt)
      }
      attempt()
    })
    return () => {
      cancelAnimationFrame(frame)
      unsubscribe()
    }
  }, [fitSelected])
}
