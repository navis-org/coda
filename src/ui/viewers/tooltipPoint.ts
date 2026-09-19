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

/** How far the card sits from the pointer, on whichever side it ends up. */
export const TOOLTIP_OFFSET = 12

/** Air left between the card and the edge of the surface it is clamped into. */
const TOOLTIP_GUTTER = 4

export interface TooltipFit {
  /** The pointer, in the container's own coordinates — `tooltipPoint`'s answer. */
  x: number
  y: number
  /** The card's measured size. Zero on either axis falls back to the naive position. */
  width: number
  height: number
  /** The containing block's own box. */
  containerWidth: number
  containerHeight: number
}

/**
 * Where the hover card goes, given the pointer and how big the card turned out.
 *
 * **Below and right unless that would put it off the surface**, which is the correction: it used
 * to be below and right *always*, so a mark near the right or bottom edge — the last column of a
 * Sankey, the tail of a ranking, the rightmost bar — opened its card outside `.viewer`'s box and
 * the card was clipped away entirely. Invisible on a wide card and reliable in the expanded
 * overlay, where the surface is large enough that most marks are nowhere near an edge.
 *
 * The flip is to the **other side of the pointer** rather than a slide along the edge, because a
 * card pinned to the edge covers the mark it describes. Clamped afterwards all the same, for the
 * case where neither side fits — a container narrower than the card, which is a compact preview.
 *
 * Pure, and separate from the component for `submenuPlacement`'s reason: placement has to be
 * *measured* rather than decided at a breakpoint, and the arithmetic is the part a jsdom suite
 * can hold. A zero measurement — which is every size in jsdom, and the first frame anywhere —
 * answers the naive position rather than pretending to fit it.
 */
export function tooltipPlacement(fit: TooltipFit): ViewerPoint {
  const naive = { x: fit.x + TOOLTIP_OFFSET, y: fit.y + TOOLTIP_OFFSET }
  if (!(fit.width > 0) || !(fit.height > 0)) return naive
  if (!(fit.containerWidth > 0) || !(fit.containerHeight > 0)) return naive

  const clamp = (value: number, extent: number, container: number) =>
    Math.max(TOOLTIP_GUTTER, Math.min(value, container - extent - TOOLTIP_GUTTER))

  const overflowsRight = naive.x + fit.width > fit.containerWidth - TOOLTIP_GUTTER
  const overflowsBelow = naive.y + fit.height > fit.containerHeight - TOOLTIP_GUTTER

  const x = overflowsRight ? fit.x - TOOLTIP_OFFSET - fit.width : naive.x
  const y = overflowsBelow ? fit.y - TOOLTIP_OFFSET - fit.height : naive.y

  return {
    x: clamp(x, fit.width, fit.containerWidth),
    y: clamp(y, fit.height, fit.containerHeight),
  }
}
