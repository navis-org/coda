/**
 * Where a thumbnail's hover preview goes.
 *
 * Pure arithmetic over rectangles, and separate from the component for the reason
 * `submenuPlacement` is separate from `useMenuFit`: jsdom performs no layout, so every element
 * reports the same 800×480 rect (`installJsdomStubs`) and a placement decided inside an effect
 * has no coverage whatsoever. Taking the rects as arguments is what makes the decision testable
 * at all.
 *
 * **It opens left, which is the opposite of a submenu's rule, and the reason is what is behind
 * it.** A preview is the picture of the row the pointer is on, so a reader is comparing it
 * against that row's name, chips and figures — all of which live to the *right* of the thumbnail
 * in `NeuronRow`'s layout. Opening rightwards covers exactly the thing being compared against.
 * To the left is the checkbox gutter and then the backdrop, which is nothing.
 *
 * **There is deliberately no right-hand fallback, and that is a measurement rather than a
 * simplification.** The first version had one, on the reasoning that the panel is centred with
 * 28px of padding so a 1440px window has no 190px gutter to open into. Driven in a real browser
 * it does the thing the left preference exists to prevent: at 1440 the tile sits 85px in, the
 * fallback lands at 171, and the preview covers the hovered row's own name and the two rows
 * either side of it. Clamping to the left margin instead lands it at 8 — over the tile and the
 * checkbox, and clear of every row's text.
 *
 * That is not a close call at any width, which is why the branch is gone rather than reordered.
 * Text begins at the tile's right edge, so a clamped-left preview covers `MARGIN + size -
 * tile.right` of it and a right-hand one covers the whole `size`; the first is smaller than the
 * second whenever the tile is not itself against the viewport edge. The right answer would only
 * start winning if the thumbnail moved to the right-hand end of the row, and then it is not a
 * fallback — `tile.left - GAP - size` fits outright and this function already returns it.
 *
 * What is left over from that version is `covers`, which is the diagnostic worth keeping: it
 * says whether the preview reaches past the tile and onto the row, which is the property the
 * whole rule is about and the one a test can assert without a browser.
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

export interface PreviewPlacement {
  left: number
  top: number
  /**
   * Whether the preview reaches past the tile's right edge and onto the row's text.
   *
   * False wherever there is room, which is the point of opening left. True only once the tile is
   * close enough to the viewport edge that the clamp pushes it over — and it is then covering
   * strictly less than the alternative would.
   */
  covers: boolean
}

/** Gap between the tile and the preview. */
const GAP = 10

/** How close to the viewport edge the preview may sit. */
const MARGIN = 8

/**
 * Place a `size`×`size` preview against `tile`.
 *
 * Vertically centred on the tile and clamped, so a row at the top or bottom of a scrolled list
 * gets a whole preview rather than a cropped one. The clamp runs in that order — centre, then
 * bound — because a viewport shorter than the preview has no satisfying answer and the top edge
 * is the better half to keep.
 */
export function previewPlacement(
  tile: Rect,
  size: number,
  viewport: Viewport,
): PreviewPlacement {
  const left = clamp(
    tile.left - GAP - size,
    MARGIN,
    Math.max(MARGIN, viewport.width - size - MARGIN),
  )

  const centred = tile.top + tile.height / 2 - size / 2
  const top = clamp(centred, MARGIN, Math.max(MARGIN, viewport.height - size - MARGIN))

  return { left, top, covers: left + size > tile.left + tile.width }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
