/**
 * Where to put a chart tooltip, in the coordinates its box is actually positioned in.
 *
 * **`position: fixed` does not survive the canvas, and that is the whole of this module.** A
 * transformed ancestor becomes the containing block for `fixed` descendants as well as for
 * `absolute` ones — and React Flow's viewport pane carries
 * `transform: translate(x, y) scale(z)`. So a tooltip written as `fixed` with `left:
 * event.clientX` is correct in the expanded overlay, which sits outside that pane, and lands
 * hundreds of pixels away on a node card, which does not. Measured in a browser before this
 * existed: a dendrogram bracket hovered at (1254, 417) put its tooltip at (1787, 498), and a
 * heatmap cell at (1098, 655) put its at (1693, 950).
 *
 * Two things go wrong at once there, which is why the correction is not just a subtraction.
 * The pointer's viewport coordinates have to be made **relative to the containing block**, and
 * the distance from it has to be divided by the **zoom**, because a length inside a `scale(z)`
 * pane is drawn `z` times as long. `offsetWidth` is layout-space and ignores transforms while
 * `getBoundingClientRect()` has applied them, so their ratio *is* the zoom — the same identity
 * `layout/measure.ts` leans on to read a card's size independently of the camera.
 *
 * `NetworkViewer` never had this bug: it is `position: absolute` and takes sigma's container
 * coordinates, which is the pattern `.viewer`'s own stylesheet comment describes. This is that
 * pattern, made available to the viewers that draw their own marks.
 */

/** Just the two fields, so a React synthetic event and a native one both fit. */
export interface PointerLike {
  clientX: number
  clientY: number
}

export interface ViewerPoint {
  x: number
  y: number
}

/**
 * The pointer, in `container`'s own untransformed coordinates.
 *
 * `container` must be the tooltip's **containing block** — the nearest positioned ancestor of
 * the element the tooltip renders into, which is `.viewer` or `.viewer__scroll` depending on
 * the viewer. Passing the wrong one is off by that element's own offset, which on a card is
 * small enough to look like a styling choice.
 *
 * A null container answers the pointer unchanged. That is the pre-mount case, where there is
 * nothing to be relative to and no tooltip on screen either.
 */
export function tooltipPoint(event: PointerLike, container: HTMLElement | null): ViewerPoint {
  if (!container) return { x: event.clientX, y: event.clientY }

  const rect = container.getBoundingClientRect()
  // An unmeasured or hidden box has a zero on one side or the other; dividing by the ratio
  // then would send the tooltip to infinity rather than merely to the wrong place.
  const scale =
    rect.width > 0 && container.offsetWidth > 0 ? rect.width / container.offsetWidth : 1

  return {
    x: (event.clientX - rect.left) / scale,
    y: (event.clientY - rect.top) / scale,
  }
}

/**
 * Below this much pointer travel a drag is read as a click.
 *
 * Here rather than in either viewer for `labelStep`'s reason, one directory over: two slops that
 * rounded differently would make the same gesture select on one chart and pan on the other. It
 * sits beside `tooltipPoint` because that is already the module both gesture handlers import for
 * the other half of the same question — where the pointer is.
 */
export const CLICK_SLOP = 3
