/**
 * Where a thumbnail's hover preview goes.
 *
 * The arithmetic is `hoverPlacement`'s, shared with the output port preview; what lives here is
 * the measurement that picks this surface's side and size.
 *
 * **It opens left, which is the opposite of a port preview's rule, and the reason is what is
 * behind it.** A preview is the picture of the row the pointer is on, so a reader is comparing
 * it against that row's name, chips and figures — all of which live to the *right* of the
 * thumbnail in `NeuronRow`'s layout. Opening rightwards covers exactly the thing being compared
 * against. To the left is the checkbox gutter and then the backdrop, which is nothing.
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
 * fallback — `tile.left - GAP - size` fits outright and `hoverPlacement` already returns it.
 *
 * What is left over from that version is `covers`, which is the diagnostic worth keeping: it
 * says whether the preview reaches past the tile and onto the row, which is the property the
 * whole rule is about and the one a test can assert without a browser.
 */

import { hoverPlacement } from '../hoverPlacement'
import type { HoverPlacement, Rect, Viewport } from '../hoverPlacement'

/** Gap between the tile and the preview. */
const GAP = 10

/** How close to the viewport edge the preview may sit. */
const MARGIN = 8

/**
 * Place a `size`×`size` preview against `tile`.
 */
export function previewPlacement(tile: Rect, size: number, viewport: Viewport): HoverPlacement {
  return hoverPlacement({
    anchor: tile,
    width: size,
    height: size,
    viewport,
    prefer: 'left',
    gap: GAP,
    margin: MARGIN,
  })
}
