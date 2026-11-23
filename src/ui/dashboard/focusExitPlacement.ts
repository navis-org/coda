/**
 * Where the Exit focus pill goes along the top edge: as near the centre as it can get without
 * covering a control or, where there is room, a cell's title. A fading pill is woken by exactly
 * the pointer movement heading for whatever it covers, so it must never sit on a button — but
 * where the buttons are depends on the column count, the cells' widths and what each cell draws
 * in its strip, so it is measured, not assumed.
 *
 * Pure over horizontal spans so it can be tested without layout (jsdom has none).
 */

export interface Span {
  left: number
  right: number
}

/** Space kept between the pill and a control beside it. */
export const PILL_CLEARANCE = 4

/**
 * The pill's left edge, as near the centre as it can get. Controls are never covered if there is
 * any room; titles are avoided too where that still leaves room, since a pill on a cell's name
 * hides which cell is which. With no clear spot at all, the centred one.
 */
export function placePill(
  width: number,
  bounds: Span,
  controls: readonly Span[],
  titles: readonly Span[] = [],
): number {
  return (
    clearSpot(width, bounds, [...controls, ...titles]) ??
    clearSpot(width, bounds, controls) ??
    (bounds.left + bounds.right - width) / 2
  )
}

/** The clear spot nearest the centre, inside `bounds`, or `undefined` if there is none. */
function clearSpot(width: number, bounds: Span, avoid: readonly Span[]): number | undefined {
  const centred = (bounds.left + bounds.right - width) / 2
  const blocked = avoid.map((c) => ({
    left: c.left - PILL_CLEARANCE,
    right: c.right + PILL_CLEARANCE,
  }))
  const fits = (x: number) =>
    x >= bounds.left &&
    x + width <= bounds.right &&
    blocked.every((b) => x + width <= b.left || x >= b.right)

  // The only places a nearest clear spot can be: the centre, or flush against something's side.
  const candidates = [centred, ...blocked.flatMap((b) => [b.left - width, b.right])]
  let best: number | undefined
  for (const x of candidates) {
    if (!fits(x)) continue
    if (best === undefined || Math.abs(x - centred) < Math.abs(best - centred)) best = x
  }
  return best
}
