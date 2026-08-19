/**
 * Waypoints to an SVG path. Pure arithmetic, and deliberately not inside the edge component.
 *
 * jsdom performs no layout and draws no SVG, so anything left in a component is covered by
 * nothing at all — the same standing `networkDraw.ts` and `scatterPlot.ts` have. What is here is
 * the whole of the geometry; what is in `RoutedEdge.tsx` is which of these to call.
 */

import type { XY } from '../layout/place'

/**
 * Corner radius where a wire turns, in flow units.
 *
 * Matched to React Flow's own `getSmoothStepPath` default so a wire ELK routed and a wire the
 * step fallback drew turn by the same amount — under `orthogonal` both are on screen at once,
 * and two fillet radii read as two kinds of wire rather than one kind that sometimes detours.
 */
export const CORNER_RADIUS = 5

function distance(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** The point `d` along the way from `from` to `to`. */
function towards(from: XY, to: XY, d: number): XY {
  const length = distance(from, to)
  if (length === 0) return { ...to }
  const t = d / length
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
}

/**
 * A path through every waypoint, with the corners filleted.
 *
 * Quadratic curves rather than arcs, with the corner itself as the control point: an arc needs a
 * radius, a sweep flag and a large-arc flag that all have to agree with the turn's direction, and
 * getting any of them wrong yields a valid path that loops the wrong way round. A quadratic is
 * decided entirely by the three points, so a corner cannot be drawn inside out.
 *
 * **The radius is clamped to half of each adjacent segment**, which is what keeps a route through
 * a tight gap from drawing over itself. ELK's own bend points are frequently 10 units apart — it
 * steps out of a port before turning — so an unclamped 5-unit fillet on both ends of a 10-unit
 * segment consumes the entire segment, and the corners bulge past each other into a wire that
 * visibly doubles back.
 *
 * Two waypoints or fewer is a straight line and says so, rather than being a degenerate curve.
 */
export function roundedPath(points: readonly XY[], radius = CORNER_RADIUS): string {
  const first = points[0]
  const end = points[points.length - 1]
  if (!first || !end) return ''
  if (points.length === 1) return `M ${first.x},${first.y}`

  let d = `M ${first.x},${first.y}`
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1]
    const corner = points[i]
    const next = points[i + 1]
    if (!previous || !corner || !next) continue
    const r = Math.min(radius, distance(previous, corner) / 2, distance(corner, next) / 2)
    if (r < 0.5) {
      // Too tight to fillet — a curve here would be shorter than the rounding error that
      // produced it. A plain corner is honest and invisible at this size.
      d += ` L ${corner.x},${corner.y}`
      continue
    }
    const into = towards(corner, previous, r)
    const out = towards(corner, next, r)
    d += ` L ${into.x},${into.y} Q ${corner.x},${corner.y} ${out.x},${out.y}`
  }
  return `${d} L ${end.x},${end.y}`
}

/**
 * The full waypoint list for one wire: the real source socket, ELK's bends, the real target.
 *
 * **The ends are React Flow's and the middle is ELK's, and that split is the whole design.** A
 * wire has to start exactly on the socket it comes out of — that is the one thing a reader
 * checks — and React Flow's `sourceX`/`sourceY` are where the socket is *now*, where ELK's
 * `startPoint` is where it thought the port was during the pass. Under `FIXED_POS` those agree
 * to the pixel, which is why the measured offsets are worth collecting; where they do not, this
 * is what keeps the wire attached and lets only the detour be approximate.
 *
 * Duplicate points are dropped. A bend landing on the socket is what ELK returns whenever a port
 * sits exactly on the layer boundary, and a zero-length segment gives `towards` nothing to
 * measure — the fillet degenerates and the corner is drawn twice.
 */
export function routeWaypoints(source: XY, bends: readonly XY[], target: XY): XY[] {
  const points: XY[] = [source]
  const same = (a: XY, b: XY) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5
  for (const bend of bends) {
    const last = points[points.length - 1]
    if (last && same(bend, last)) continue
    points.push(bend)
  }
  const last = points[points.length - 1]
  if (!last || !same(target, last)) points.push(target)
  return points
}

/**
 * The midpoint of a route, by arc length — where a label or a badge would go.
 *
 * By length rather than by waypoint index, because the waypoints are not evenly spaced: ELK's
 * step out of a port is 10 units and the run across the graph is several hundred, so the middle
 * *point* of the list is usually still sitting on the source card.
 */
export function routeMidpoint(points: readonly XY[]): XY {
  const first = points[0]
  const end = points[points.length - 1]
  if (!first || !end) return { x: 0, y: 0 }
  if (points.length === 1) return { ...first }

  const segments: Array<{ from: XY; to: XY; length: number }> = []
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]
    const to = points[i]
    if (!from || !to) continue
    const length = distance(from, to)
    segments.push({ from, to, length })
    total += length
  }

  let walked = 0
  for (const segment of segments) {
    if (walked + segment.length >= total / 2) {
      return towards(segment.from, segment.to, total / 2 - walked)
    }
    walked += segment.length
  }
  return { ...end }
}
