/**
 * The wire's geometry. Headless, because jsdom draws no SVG and measures no path — what a
 * browser would show is not observable here, so what is asserted is the `d` string and the
 * arithmetic behind it.
 *
 * Two of these are about failures that produce a *valid path that is wrong*, which is the class
 * of bug a snapshot cannot catch: a fillet wider than the segment it sits on, and a wire that
 * starts somewhere other than its socket.
 */

import { describe, expect, it } from 'vitest'

import type { XY } from '../layout/place'
import { CORNER_RADIUS, roundedPath, routeMidpoint, routeWaypoints } from './edgeRoute'

/** Every coordinate pair in a path, in order — enough to check where a path has been. */
function points(d: string): XY[] {
  return [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }))
}

describe('roundedPath', () => {
  it('draws a straight line through two points, with no curve in it', () => {
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]),
    ).toBe('M 0,0 L 100,0')
  })

  it('says nothing about nothing', () => {
    expect(roundedPath([])).toBe('')
    expect(roundedPath([{ x: 4, y: 7 }])).toBe('M 4,7')
  })

  it('fillets a corner with the corner itself as the control point', () => {
    const d = roundedPath([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ])
    // Into the corner, curve through it, out the other side — and the corner is the control
    // point, so the turn cannot be drawn inside out the way an arc's sweep flag can be.
    expect(d).toBe('M 0,0 L 95,0 Q 100,0 100,5 L 100,100')
  })

  it('clamps the radius to half the shorter segment, so a tight turn cannot double back', () => {
    /*
     * ELK routinely steps 10 units out of a port before turning. An unclamped 5-unit fillet at
     * both ends of a 10-unit segment consumes the whole of it and the two corners bulge past
     * each other — a wire that visibly reverses, from a path that is perfectly well-formed.
     */
    const d = roundedPath([
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 60 },
      { x: 100, y: 60 },
    ])
    /*
     * The first corner sits 6 units from the start, so its fillet is **3** rather than the
     * declared 5 — half the segment, which is the most it can take without eating into the
     * previous one. The second corner has room and takes the full 5. Pinned as a whole string
     * because the clamp is per-corner and per-side, and asserting only the minimum would pass
     * for a path that clamped the wrong end.
     */
    expect(d).toBe('M 0,0 L 3,0 Q 6,0 6,3 L 6,55 Q 6,60 11,60 L 100,60')
    // Nothing walks back past a corner it has already turned: x never decreases.
    const xs = points(d).map((p) => p.x)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
  })

  it('drops a fillet too small to be worth drawing rather than emitting a degenerate curve', () => {
    const d = roundedPath([
      { x: 0, y: 0 },
      { x: 0.4, y: 0 },
      { x: 0.4, y: 40 },
    ])
    expect(d).not.toContain('Q')
    expect(d).toContain('L 0.4,0')
  })

  it('matches React Flow’s own step radius, so one canvas has one kind of corner', () => {
    // Under `orthogonal` an ELK-routed wire and a `getSmoothStepPath` fallback are on screen at
    // once. Two fillet radii read as two kinds of wire.
    expect(CORNER_RADIUS).toBe(5)
  })
})

describe('routeWaypoints', () => {
  it('starts at the socket and ends at the socket, with ELK’s bends in between', () => {
    /*
     * The whole design of the splice. A wire has to start exactly on the socket it leaves —
     * that is the one thing a reader checks — and React Flow's coordinates are where the socket
     * *is*, where ELK's section endpoints are where it thought the port was during the pass.
     */
    const source = { x: 10, y: 20 }
    const target = { x: 300, y: 200 }
    const bends = [
      { x: 40, y: 20 },
      { x: 40, y: 200 },
    ]
    expect(routeWaypoints(source, bends, target)).toEqual([source, ...bends, target])
  })

  it('drops a bend that has landed on the socket', () => {
    // ELK returns one whenever a port sits exactly on a layer boundary. A zero-length segment
    // gives the fillet nothing to measure and the corner is drawn twice.
    const source = { x: 10, y: 20 }
    const points = routeWaypoints(
      source,
      [
        { x: 10.2, y: 19.9 },
        { x: 80, y: 20 },
      ],
      {
        x: 80,
        y: 20,
      },
    )
    expect(points).toEqual([source, { x: 80, y: 20 }])
  })

  it('keeps a route of nothing but the two sockets drawable', () => {
    expect(routeWaypoints({ x: 0, y: 0 }, [], { x: 50, y: 50 })).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ])
  })
})

describe('routeMidpoint', () => {
  it('measures by length, not by waypoint index', () => {
    /*
     * The waypoints are not evenly spaced — ELK's step out of a port is 10 units and the run
     * across the graph is several hundred — so the middle *entry* of the list is usually still
     * sitting on the source card.
     */
    const middle = routeMidpoint([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 200 },
      { x: 20, y: 200 },
    ])
    expect(middle.x).toBeCloseTo(10)
    expect(middle.y).toBeCloseTo(100)
  })

  it('answers for the degenerate cases rather than throwing', () => {
    expect(routeMidpoint([])).toEqual({ x: 0, y: 0 })
    expect(routeMidpoint([{ x: 3, y: 4 }])).toEqual({ x: 3, y: 4 })
  })
})
