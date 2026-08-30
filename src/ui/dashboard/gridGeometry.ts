/**
 * The two sums a dashboard gesture needs, away from the DOM that supplies their inputs.
 *
 * `networkDrag.ts`'s rule, for the same reason: jsdom performs no layout, so anything that
 * consults a rect is untestable where it is written. What is testable is the arithmetic, and
 * both of these have an off-by-one that is invisible on screen — a resize that needs half a
 * track more than it should, or a reorder that moves a cell one place and lands it back where
 * it started. Neither looks like a bug; both look like the gesture having missed.
 */

/**
 * The span a resize drag has reached.
 *
 * Derived from the cell's **own** starting rect rather than from the grid's track list, which
 * is what makes it independent of how the tracks are declared: every column is `1fr` and every
 * row the same height, so one cell of a known span measures the unit exactly —
 * `unit = (size - gap × (span - 1)) / span`. Reading `gridTemplateColumns` off the computed
 * style would work too and would be one more thing to keep agreeing with the stylesheet.
 *
 * The `+ gap` before rounding is the part worth stating: a cell of *n* tracks is *n* units plus
 * *n − 1* gaps, so the thing that repeats every `unit + gap` pixels is the cell **plus one
 * trailing gap**. Without it the halfway point of every span sits a gap too far right, and the
 * grip has to be dragged past the next column's edge before the cell grows.
 */
export function spanFromDrag(
  /** The cell's current size along this axis, in px, as it is drawn now. */
  size: number,
  /** The span that size represents. */
  span: number,
  /** How far the grip has moved along this axis since it was grabbed, in px. */
  delta: number,
  /** The grid's gap along this axis, in px. */
  gap: number,
  /** The largest span allowed: the column count, or `ROW_TRACKS`. */
  max: number,
): number {
  const tracks = Math.max(1, Math.round(span))
  const unit = (size - gap * (tracks - 1)) / tracks
  // A degenerate measurement — a cell not yet laid out, a zero-height row — must not produce
  // NaN and silently wipe the span. Keeping what we have is the honest answer.
  if (!Number.isFinite(unit) || unit <= 0) return Math.min(max, tracks)
  const next = Math.round((size + delta + gap) / (unit + gap))
  return Math.min(max, Math.max(1, next))
}

/**
 * The height of one row track, so `ROW_TRACKS` of them exactly fill the area they are given.
 *
 * The number CSS could not work out for itself, and the reason the first version had a scrollbar
 * on every dashboard: a row was `44vh`, which is a share of the *window* rather than of what is
 * left after the toolbar, the dashboard's bar, the status bar and the grid's own padding. Two of
 * those rows plus a gap came to more than the box they were in, every time, on every screen —
 * and the overflow put the bottom row's resize corner behind the status bar.
 *
 * So it is measured instead, from the grid's content box, and published as a custom property.
 * `n` tracks and `n - 1` gaps is the whole sum; what makes it worth extracting is that it is the
 * one place the exactness lives, and "exact" is the property being asked for.
 *
 * The floor is for a genuinely short window, where a sixth of the area is smaller than a card
 * header. Below it the grid scrolls, which is the honest answer — a third of 300px is not a view
 * of anything, and pretending otherwise costs the scrollbar *and* the legibility.
 */
export const MIN_ROW_PX = 64

export function rowHeight(areaPx: number, gapPx: number, tracks: number): number {
  if (!Number.isFinite(areaPx) || !Number.isFinite(gapPx) || tracks < 1) return MIN_ROW_PX
  return Math.max(MIN_ROW_PX, (areaPx - gapPx * (tracks - 1)) / tracks)
}

/**
 * Where a dragged cell lands, in the index `moveCell` expects.
 *
 * Two conversions in one, and doing either alone is what makes a reorder look broken.
 *
 * The first is `moveCell`'s convention: the target index is counted in the list **after** the
 * dragged cell has been lifted out. A drop "before the cell currently at index 4" is index 4
 * only while the dragged cell is still occupying a slot ahead of it.
 *
 * The second is the half a drop landed in. A pointer in the right half of a cell means *after*
 * it — without that, a cell can only ever be dropped to the left of something, and dragging one
 * to the end of the list is impossible.
 *
 * A drop on the dragged cell itself resolves to where it already is, so `moveCell` returns the
 * graph unchanged and no undo step is recorded.
 */
export function dropIndex(
  order: readonly string[],
  draggedId: string,
  overId: string,
  /** True when the pointer was past the target cell's midpoint along the flow direction. */
  after: boolean,
): number {
  const rest = order.filter((id) => id !== draggedId)
  const target = rest.indexOf(overId)
  // Dropped on itself: the only id not in `rest`. Answer with its current place.
  if (target < 0) return Math.max(0, order.indexOf(draggedId))
  return after ? target + 1 : target
}
