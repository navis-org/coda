/**
 * Which wire, if any, a dragged card is sitting on.
 *
 * The other half of the drop-to-insert gesture; `core/splice.ts` holds every decision and this
 * holds the geometry. Split because this half cannot be tested here — jsdom performs no layout,
 * so an `<svg>` path has no length and no points, and a test against it would be a test of the
 * stub.
 *
 * **The wire has to pass under the card, not near its centre.** React Flow already draws a fat
 * invisible `interactionWidth` copy of every path for its own click target, so `isPointInStroke`
 * against a point is available and was the obvious route — and it makes the target ±10 flow units
 * around a hairline, which is a precise aim for a gesture that is a whole card being thrown
 * across a canvas. Walking the path and asking whether it enters the card's rectangle is both
 * more forgiving and the thing somebody actually means by "drop it on the wire".
 *
 * It walks the **rendered** path, so a curve, an orthogonal step and an ELK route are all handled
 * with no geometry of our own — and a wire bent around a card is judged where it is drawn rather
 * than where a straight line between its sockets would have been.
 */

/** A rectangle in flow units. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * How finely a path is walked, in flow units.
 *
 * A card is 232 units across at its narrowest, so 12 cannot step over one. Small enough to be
 * exact for this and large enough that a long wire is a few hundred samples rather than a few
 * thousand.
 */
const STEP = 12

/** A ceiling on the walk, so one enormous route cannot stall a pointer move. */
const MAX_SAMPLES = 400

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

/**
 * Whether a rendered path enters a rectangle, and how squarely.
 *
 * Returns the smallest distance from the card's centre to any sampled point on the path that is
 * inside the card, or undefined when the path never enters it. The distance is what picks between
 * two wires crossing one card — the one running through the middle is the one being aimed at.
 */
export function pathThroughRect(path: SVGPathElement, rect: Rect): number | undefined {
  let length: number
  try {
    length = path.getTotalLength()
  } catch {
    // jsdom, and any browser that declines on a degenerate path. No candidate is the safe answer.
    return undefined
  }
  if (!Number.isFinite(length) || length <= 0) return undefined

  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const step = Math.max(STEP, length / MAX_SAMPLES)

  let best: number | undefined
  for (let at = 0; at <= length; at += step) {
    const point = path.getPointAtLength(at)
    if (!contains(rect, point.x, point.y)) continue
    const distance = Math.hypot(point.x - cx, point.y - cy)
    if (best === undefined || distance < best) best = distance
  }
  return best
}

/**
 * The edge id whose wire runs most squarely under this rectangle.
 *
 * Read off the DOM rather than recomputed, because the *drawn* path is the one the user is
 * aiming at: under `orthogonal` it steps around cards, and after an arrange it follows the
 * channel ELK reserved. Rebuilding either here would be a second geometry that agrees with the
 * screen only by luck.
 */
export function edgeUnderRect(rect: Rect, exclude: ReadonlySet<string>): string | undefined {
  let bestId: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY

  for (const group of document.querySelectorAll<SVGGElement>('.react-flow__edge[data-id]')) {
    const id = group.dataset.id
    if (!id || exclude.has(id)) continue
    /*
     * The interaction copy rather than the visible one: it is the same geometry, and it is the
     * element React Flow guarantees exists for every edge whatever renderer drew it. Falling back
     * to the visible path keeps this working if that copy is ever withheld.
     */
    const path =
      group.querySelector<SVGPathElement>('.react-flow__edge-interaction') ??
      group.querySelector<SVGPathElement>('path')
    if (!path) continue

    const distance = pathThroughRect(path, rect)
    if (distance !== undefined && distance < bestDistance) {
      bestDistance = distance
      bestId = id
    }
  }
  return bestId
}
