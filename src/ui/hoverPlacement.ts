/**
 * Where a transient hover panel goes, in viewport coordinates.
 *
 * Pure arithmetic over rectangles, and separate from the components that use it for the reason
 * `submenuPlacement` is separate from `useMenuFit`: jsdom performs no layout, so every element
 * reports the same rect (`installJsdomStubs`) and a placement decided inside an effect has no
 * coverage whatsoever. Taking the rects as arguments is what makes the decision testable at all.
 *
 * **One function because there are two callers and the arithmetic is the same; a `prefer` side
 * because their answers are opposite, and each opposition is a measurement.** Explore's
 * thumbnail preview opens **left**, because the row's name and chips are to the tile's right —
 * `previewPlacement` carries that measurement. An output port's preview opens **right**, because
 * the card whose output is being previewed is to the socket's left. Both are the same rule said
 * once: open into the empty half.
 *
 * **There is deliberately no flip to the other side, at either caller.** Where the preferred
 * side does not fit the box is clamped into the viewport, which slides it *partly* over the
 * anchor's content; flipping puts it *wholly* over the content the reader is comparing against.
 * Explore measured that in a browser at 1440px — the flip landed on the hovered row's own name
 * and the two rows either side, where the clamp landed on the tile and the checkbox gutter and
 * cleared every row's text. The same argument holds at a port, where the far side is the card.
 *
 * `covers` is the diagnostic left over from that: it says whether the box reached back past the
 * anchor onto the content the preference exists to keep clear, which is the property the whole
 * rule is about and the one a test can assert without a browser.
 */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

export interface HoverPlacement {
  left: number
  top: number
  /**
   * Whether the box reached past the anchor and onto what lies beyond it.
   *
   * False wherever there is room, which is the point of having a preference. True only once the
   * anchor is close enough to the viewport edge that the clamp pushes the box over — and it is
   * then covering strictly less than a flip would.
   */
  covers: boolean
}

export interface HoverPlacementRequest {
  /** The element hovered: a thumbnail tile, a socket. */
  anchor: Rect
  width: number
  height: number
  viewport: Viewport
  /** Which side of the anchor is empty. */
  prefer: 'left' | 'right'
  /** Gap between the anchor and the box. */
  gap: number
  /** How close to the viewport edge the box may sit. */
  margin: number
}

/**
 * Place a `width`×`height` box beside `anchor`.
 *
 * Vertically centred on the anchor and clamped, so an anchor at the top or bottom of the window
 * gets a whole box rather than a cropped one. The clamp runs in that order — centre, then bound —
 * because a viewport shorter than the box has no satisfying answer and the top edge is the
 * better half to keep.
 */
export function hoverPlacement(request: HoverPlacementRequest): HoverPlacement {
  const { anchor, width, height, viewport, prefer, gap, margin } = request
  const wanted =
    prefer === 'left' ? anchor.left - gap - width : anchor.left + anchor.width + gap
  const left = clamp(wanted, margin, Math.max(margin, viewport.width - width - margin))

  const centred = anchor.top + anchor.height / 2 - height / 2
  const top = clamp(centred, margin, Math.max(margin, viewport.height - height - margin))

  const covers =
    prefer === 'left' ? left + width > anchor.left + anchor.width : left < anchor.left
  return { left, top, covers }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
