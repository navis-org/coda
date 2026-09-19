import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { flowGraph } from '../../nodes/lib/flowChartOps'
import type { BoxSize, FlowChartShape, XY } from './flowChartLayout'
import {
  routeArrowHead,
  flowChartShape,
  orthogonalCorners,
  routeMidpoint,
  routePath,
} from './flowChartLayout'

const NODE_SCHEMA = tableSchema(column('id', 'str'), column('hops', 'i64'))
const EDGE_SCHEMA = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64'),
)

function network(
  nodes: Array<{ id: string; hops?: number | null }>,
  edges: Array<[string, string, number?]>,
): NetworkValue {
  return {
    kind: 'network',
    directed: true,
    nodes: tableFromRows(
      NODE_SCHEMA,
      nodes.map((n) => ({ id: n.id, hops: n.hops ?? null })),
    ),
    edges: tableFromRows(
      EDGE_SCHEMA,
      edges.map(([source, target, weight]) => ({ source, target, weight: weight ?? 1 })),
    ),
  }
}

/** Every box the same size, which is what makes the coordinates readable in an assertion. */
function sizes(ids: readonly string[], size: BoxSize = { width: 60, height: 24 }) {
  return new Map(ids.map((id) => [id, size]))
}

function boxOf(shape: FlowChartShape, id: string) {
  const box = shape.boxes.find((b) => b.id === id)
  if (!box) throw new Error(`no box ${id}`)
  return box
}

function arrowOf(shape: FlowChartShape, source: string, target: string) {
  const arrow = shape.arrows.find((a) => a.source === source && a.target === target)
  if (!arrow) throw new Error(`no arrow ${source}->${target}`)
  return arrow
}

const CHAIN = network(
  [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  [
    ['a', 'b'],
    ['b', 'c'],
  ],
)

describe('flowChartShape', () => {
  it('places layers along the flow and stacks within them across it', () => {
    const graph = flowGraph(
      network(
        [
          { id: 'a', hops: 0 },
          { id: 'b', hops: 1 },
          { id: 'c', hops: 1 },
        ],
        [
          ['a', 'b'],
          ['a', 'c'],
        ],
      ),
      { layerColumn: 'hops' },
    )
    const shape = flowChartShape(graph, { direction: 'lr', sizes: sizes(['a', 'b', 'c']) })

    // One layer is one x.
    expect(boxOf(shape, 'b').x).toBe(boxOf(shape, 'c').x)
    expect(boxOf(shape, 'a').x).toBeLessThan(boxOf(shape, 'b').x)
    // Two boxes in one layer are at different y, and do not overlap.
    const b = boxOf(shape, 'b')
    const c = boxOf(shape, 'c')
    expect(Math.abs(b.y - c.y)).toBeGreaterThanOrEqual(b.height)
  })

  it('orders layers left to right by layer index', () => {
    const shape = flowChartShape(flowGraph(CHAIN), {
      direction: 'lr',
      sizes: sizes(['a', 'b', 'c']),
    })
    const xs = ['a', 'b', 'c'].map((id) => boxOf(shape, id).x)
    expect(xs[0]!).toBeLessThan(xs[1]!)
    expect(xs[1]!).toBeLessThan(xs[2]!)
  })

  it('starts the drawing at the origin', () => {
    const shape = flowChartShape(flowGraph(CHAIN), {
      direction: 'lr',
      sizes: sizes(['a', 'b', 'c']),
    })
    for (const box of shape.boxes) {
      expect(box.x - box.width / 2).toBeGreaterThanOrEqual(-0.001)
      expect(box.y - box.height / 2).toBeGreaterThanOrEqual(-0.001)
    }
    for (const arrow of shape.arrows) {
      for (const point of arrow.points) {
        expect(point.x).toBeGreaterThanOrEqual(-0.001)
        expect(point.y).toBeGreaterThanOrEqual(-0.001)
      }
    }
  })

  /**
   * The projection is over the *algorithm*, not over the coordinates.
   *
   * Asked of square boxes, because that is the only case where the two orientations are a
   * coordinate transpose: a box's extent along the flow is its text width one way round and its
   * text height the other, so oblong boxes give two layouts that are genuinely different
   * pictures rather than one picture turned. The test below that pins the asymmetry itself.
   */
  it('transposes for top-to-bottom, given square boxes', () => {
    const graph = flowGraph(CHAIN)
    const square = { width: 40, height: 40 }
    const lr = flowChartShape(graph, {
      direction: 'lr',
      sizes: sizes(['a', 'b', 'c'], square),
    })
    const tb = flowChartShape(graph, {
      direction: 'tb',
      sizes: sizes(['a', 'b', 'c'], square),
    })
    for (const id of ['a', 'b', 'c']) {
      expect(boxOf(tb, id).y).toBeCloseTo(boxOf(lr, id).x, 6)
      expect(boxOf(tb, id).x).toBeCloseTo(boxOf(lr, id).y, 6)
    }
  })

  it('spends an oblong box differently in each orientation, text not rotating', () => {
    const graph = flowGraph(CHAIN)
    const wide = { width: 120, height: 20 }
    const lr = flowChartShape(graph, { direction: 'lr', sizes: sizes(['a', 'b', 'c'], wide) })
    const tb = flowChartShape(graph, { direction: 'tb', sizes: sizes(['a', 'b', 'c'], wide) })
    // Left to right, three 120-wide boxes in a row make a long drawing; top to bottom, three
    // 20-tall boxes make a short one. Transposing would have made the two extents equal.
    expect(lr.width).toBeGreaterThan(tb.height)
  })

  it('keeps a box the size of its text in both orientations, which is not a transpose', () => {
    const graph = flowGraph(CHAIN)
    const size = { width: 90, height: 20 }
    for (const direction of ['lr', 'tb'] as const) {
      const shape = flowChartShape(graph, {
        direction,
        sizes: sizes(['a', 'b', 'c'], size),
      })
      // Text does not rotate: the box is 90 x 20 whichever way the layers run.
      expect(boxOf(shape, 'b').width).toBe(90)
      expect(boxOf(shape, 'b').height).toBe(20)
    }
  })
})

describe('routing corridors', () => {
  /**
   * The property the dummy nodes exist for.
   *
   * `a -> d` skips two layers. Without a corridor in each of them the arrow runs from a's right
   * face to d's left face in a straight line, which passes through whatever is in between — and
   * `b` and `c` are exactly in between. With corridors, the ordering step has to give the route
   * an across-slot of its own, so the arrow's interior points clear both boxes.
   */
  it('routes a skip-layer arrow clear of the boxes it passes', () => {
    const graph = flowGraph(
      network(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
        [
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'd'],
          ['a', 'd'],
        ],
      ),
    )
    const shape = flowChartShape(graph, {
      direction: 'lr',
      sizes: sizes(['a', 'b', 'c', 'd']),
    })
    const skip = arrowOf(shape, 'a', 'd')
    // Two faces per corridor, plus the two endpoints.
    expect(skip.points.length).toBe(6)

    const blocking = [boxOf(shape, 'b'), boxOf(shape, 'c')]
    for (const point of skip.points.slice(1, -1)) {
      for (const box of blocking) {
        const insideX = Math.abs(point.x - box.x) < box.width / 2
        const insideY = Math.abs(point.y - box.y) < box.height / 2
        expect(insideX && insideY).toBe(false)
      }
    }
  })

  /**
   * The bug every uniform-size fixture hides.
   *
   * A layer band is as deep as its deepest box and every box is centred in it, so a box narrower
   * than its widest neighbour sits inset from both band edges — and a route ending at the *band*
   * leaves its arrowhead floating in the gap. About 40px on the node's own demo graph. Every
   * fixture above gives each box the same size, which makes band and box coincide, and the
   * browser probe cannot see it either: an arrow that stops short passes "no arrow passes through
   * a box" more comfortably than one that arrives.
   */
  it('ends a route on the boxes own faces, not on their layer bands', () => {
    const graph = flowGraph(
      network(
        [
          { id: 'narrow', hops: 0 },
          { id: 'wide', hops: 0 },
          { id: 'target', hops: 1 },
        ],
        [['narrow', 'target']],
      ),
      { layerColumn: 'hops' },
    )
    // `wide` sets the first layer's depth and takes no part in the route.
    const shape = flowChartShape(graph, {
      direction: 'lr',
      sizes: new Map([
        ['narrow', { width: 40, height: 24 }],
        ['wide', { width: 200, height: 24 }],
        ['target', { width: 40, height: 24 }],
      ]),
    })
    const arrow = arrowOf(shape, 'narrow', 'target')
    const narrow = boxOf(shape, 'narrow')
    const target = boxOf(shape, 'target')
    expect(arrow.points[0]!.x).toBeCloseTo(narrow.x + narrow.width / 2, 6)
    expect(arrow.points[arrow.points.length - 1]!.x).toBeCloseTo(target.x - target.width / 2, 6)
  })

  it('gives an adjacent-layer arrow two points and no corridor', () => {
    const shape = flowChartShape(flowGraph(CHAIN), {
      direction: 'lr',
      sizes: sizes(['a', 'b', 'c']),
    })
    expect(arrowOf(shape, 'a', 'b').points).toHaveLength(2)
  })

  it('ends a feedback arrow at its real target', () => {
    const graph = flowGraph(
      network(
        [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        [
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'a'],
        ],
      ),
    )
    const shape = flowChartShape(graph, { direction: 'lr', sizes: sizes(['a', 'b', 'c']) })
    const back = shape.arrows.find((arrow) => arrow.kind === 'back')!
    expect(back.source).toBe('c')
    expect(back.target).toBe('a')
    // Laid out from a to c and flipped, so the last point is next to `a` — which is where the
    // arrowhead goes. Unflipped, the head would sit on the box the feedback comes *from*.
    const a = boxOf(shape, 'a')
    const last = back.points[back.points.length - 1]!
    const first = back.points[0]!
    expect(Math.abs(last.x - a.x)).toBeLessThan(Math.abs(first.x - a.x))
  })

  it('fans several arrows at one box out along its face instead of overlapping them', () => {
    const graph = flowGraph(
      network(
        [
          { id: 'hub', hops: 0 },
          { id: 'x', hops: 1 },
          { id: 'y', hops: 1 },
          { id: 'z', hops: 1 },
        ],
        [
          ['hub', 'x'],
          ['hub', 'y'],
          ['hub', 'z'],
        ],
      ),
      { layerColumn: 'hops' },
    )
    const shape = flowChartShape(graph, {
      direction: 'lr',
      sizes: sizes(['hub', 'x', 'y', 'z']),
    })
    const exits = ['x', 'y', 'z'].map((id) => arrowOf(shape, 'hub', id).points[0]!.y)
    expect(new Set(exits).size).toBe(3)
    // …and every one of them is still on the box's own face.
    const hub = boxOf(shape, 'hub')
    for (const y of exits) expect(Math.abs(y - hub.y)).toBeLessThanOrEqual(hub.height / 2)
  })

  it('bulges a same-layer arrow off the flow axis, past both boxes', () => {
    const graph = flowGraph(
      network(
        [
          { id: 'a', hops: 0 },
          { id: 'b', hops: 0 },
        ],
        [['a', 'b']],
      ),
      { layerColumn: 'hops' },
    )
    const shape = flowChartShape(graph, { direction: 'lr', sizes: sizes(['a', 'b']) })
    const within = arrowOf(shape, 'a', 'b')
    expect(within.kind).toBe('within')
    const rightEdge = Math.max(...shape.boxes.map((box) => box.x + box.width / 2))
    expect(Math.max(...within.points.map((p) => p.x))).toBeGreaterThan(rightEdge)
  })

  it('includes the routes in the bounds, not only the boxes', () => {
    const graph = flowGraph(
      network(
        [
          { id: 'a', hops: 0 },
          { id: 'b', hops: 0 },
        ],
        [['a', 'b']],
      ),
      { layerColumn: 'hops' },
    )
    const shape = flowChartShape(graph, { direction: 'lr', sizes: sizes(['a', 'b']) })
    const furthest = Math.max(...shape.arrows.flatMap((a) => a.points.map((p) => p.x)))
    expect(shape.width).toBeGreaterThanOrEqual(furthest - 0.001)
  })

  it('draws an autapse as a loop with somewhere to bend', () => {
    const graph = flowGraph(network([{ id: 'a' }], [['a', 'a']]))
    const shape = flowChartShape(graph, { direction: 'lr', sizes: sizes(['a']) })
    const loop = arrowOf(shape, 'a', 'a')
    expect(loop.kind).toBe('self')
    expect(loop.points.length).toBeGreaterThanOrEqual(3)
  })
})

describe('routePath', () => {
  const bend: XY[] = [
    { x: 0, y: 0 },
    { x: 100, y: 40 },
  ]

  it('rounds the corners of an orthogonal route rather than mitring them', () => {
    // `roundedPath`'s spelling — `M x,y` with a space after the command — since that is the
    // canvas wire builder this shares its fillet rule with.
    const d = routePath(bend, 'orthogonal', 'lr')
    expect(d.startsWith('M 0,0')).toBe(true)
    expect(d).toContain('Q')
    expect(d.endsWith('100,40')).toBe(true)
  })

  it('drops the interior points for a straight route', () => {
    const d = routePath(
      [
        { x: 0, y: 0 },
        { x: 50, y: 99 },
        { x: 100, y: 0 },
      ],
      'straight',
      'lr',
    )
    expect(d).toBe('M0 0L100 0')
  })

  /**
   * The regression this is for: a two-point route is *most* arrows (adjacent layers), and the
   * Catmull-Rom pass this used put its control points exactly on the straight line between them
   * — so "curves" drew a picture of straight lines and every unit test still passed, because
   * they all used three points.
   */
  it('actually curves a two-point route, which is most arrows', () => {
    const d = routePath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 60 },
      ],
      'curved',
      'lr',
    )
    expect(d).toBe('M0 0C50 0 50 60 100 60')
    // Straight for comparison: same ends, no bow.
    expect(
      routePath(
        [
          { x: 0, y: 0 },
          { x: 100, y: 60 },
        ],
        'straight',
        'lr',
      ),
    ).toBe('M0 0L100 60')
  })

  it('leaves a segment straight where its two ends already share the cross axis', () => {
    // A horizontal arrow is a horizontal arrow; bowing it would be decoration.
    const d = routePath(
      [
        { x: 0, y: 10 },
        { x: 80, y: 10 },
      ],
      'curved',
      'lr',
    )
    expect(d).toBe('M0 10C40 10 40 10 80 10')
  })

  it('passes a curved route through every interior point', () => {
    // Catmull-Rom, so each segment ends exactly on the next point rather than near it — which
    // is what keeps a curve inside the corridor that was reserved for it.
    const d = routePath(
      [
        { x: 0, y: 0 },
        { x: 50, y: 30 },
        { x: 100, y: 0 },
      ],
      'curved',
      'lr',
    )
    expect(d.startsWith('M0 0')).toBe(true)
    expect(d).toContain('50 30')
    expect(d.endsWith('100 0')).toBe(true)
  })

  it('is empty for no points and a bare move for one', () => {
    expect(routePath([], 'orthogonal', 'lr')).toBe('')
    expect(routePath([{ x: 3, y: 4 }], 'curved', 'lr')).toBe('M3 4')
  })
})

describe('orthogonalCorners', () => {
  it('leaves every segment axis-aligned', () => {
    for (const route of [
      [
        { x: 0, y: 0 },
        { x: 100, y: 40 },
      ],
      [
        { x: 0, y: 0 },
        { x: 20, y: 90 },
      ],
      [
        { x: 0, y: 0 },
        { x: 40, y: 10 },
        { x: 40, y: 80 },
        { x: 130, y: 80 },
      ],
    ]) {
      const corners = orthogonalCorners(route, 'lr')
      for (let i = 0; i + 1 < corners.length; i++) {
        const a = corners[i]!
        const b = corners[i + 1]!
        const moved = { x: Math.abs(b.x - a.x) > 1e-9, y: Math.abs(b.y - a.y) > 1e-9 }
        expect(moved.x && moved.y).toBe(false)
      }
    }
  })

  it('keeps the two endpoints exactly where the route put them', () => {
    const route = [
      { x: 3, y: 7 },
      { x: 90, y: 55 },
    ]
    const corners = orthogonalCorners(route, 'lr')
    expect(corners[0]).toEqual(route[0])
    expect(corners[corners.length - 1]).toEqual(route[1])
  })

  it('adds nothing to a route that is already axis-aligned', () => {
    const straight = [
      { x: 0, y: 5 },
      { x: 50, y: 5 },
    ]
    expect(orthogonalCorners(straight, 'lr')).toEqual(straight)
  })

  it('has nothing to say about no points', () => {
    expect(orthogonalCorners([], 'lr')).toEqual([])
  })
})

describe('routeArrowHead', () => {
  it('points along the last leg of the route, not at the box centre', () => {
    const head = routeArrowHead(
      [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
        { x: 100, y: 50 },
      ],
      'orthogonal',
      'lr',
    )!
    expect(head.at).toEqual({ x: 100, y: 50 })
    expect(head.angle).toBeCloseTo(0, 6)
  })

  it('skips a zero-length final leg rather than reporting no direction', () => {
    const head = routeArrowHead(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 0 },
      ],
      'orthogonal',
      'lr',
    )!
    expect(head.angle).toBeCloseTo(0, 6)
  })

  it('has nothing to say about a single point', () => {
    expect(routeArrowHead([{ x: 1, y: 1 }], 'orthogonal', 'lr')).toBeUndefined()
    expect(
      routeArrowHead(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        'orthogonal',
        'lr',
      ),
    ).toBeUndefined()
  })

  /**
   * The bug this argument exists for: the stroke is not the polyline.
   *
   * `orthogonal` draws `orthogonalCorners(points, 'lr')`, whose last leg is axis-aligned; the raw
   * polyline's last leg is the diagonal that leg replaced. Read from the polyline the head sat at
   * an angle to the line it terminates and pointed past its own box.
   */
  it('points along the drawn stroke, not along the waypoints', () => {
    const diagonal: XY[] = [
      { x: 0, y: 0 },
      { x: 100, y: 60 },
    ]
    // Straight really is the diagonal.
    expect(routeArrowHead(diagonal, 'straight', 'lr')!.angle).toBeCloseTo(
      Math.atan2(60, 100),
      6,
    )
    // Orthogonal arrives horizontally, because its last leg is the one `orthogonalCorners` made.
    expect(routeArrowHead(diagonal, 'orthogonal', 'lr')!.angle).toBeCloseTo(0, 6)
    // A curve arrives along its own final tangent, which is the same dominant axis.
    expect(routeArrowHead(diagonal, 'curved', 'lr')!.angle).toBeCloseTo(0, 6)
    // All three end on the box, wherever they came from.
    for (const routing of ['straight', 'orthogonal', 'curved'] as const) {
      expect(routeArrowHead(diagonal, routing, 'lr')!.at).toEqual({ x: 100, y: 60 })
    }
  })

  /**
   * An arrow arrives along the **flow**, however steep it is.
   *
   * This asserted the opposite — that a mostly-vertical segment arrives vertically — which was
   * the dominant-axis rule `orthogonalCorners` used to follow, and which put a steep
   * connection's long leg down the source box's own face. In a left-to-right chart every arrow
   * enters its box from the left, whatever its slope; top-to-bottom, from above.
   */
  it('arrives along the flow axis however steep the segment is', () => {
    const upright: XY[] = [
      { x: 0, y: 0 },
      { x: 20, y: 90 },
    ]
    for (const routing of ['orthogonal', 'curved'] as const) {
      expect(routeArrowHead(upright, routing, 'lr')!.angle).toBeCloseTo(0, 6)
      expect(routeArrowHead(upright, routing, 'tb')!.angle).toBeCloseTo(Math.PI / 2, 6)
    }
  })

  /**
   * The defect the flow axis was threaded through for.
   *
   * Turning on the longer axis, a steep hop ran its long leg at the *source's* own face — which
   * in a layered chart is where the rest of that column sits. Measured in a browser at 3.4px
   * into a neighbouring box. Turning on the flow axis puts it in the inter-layer gap instead.
   */
  it('puts the long leg of a steep hop in the gap, not against the source face', () => {
    const steep: XY[] = [
      { x: 0, y: 0 },
      { x: 40, y: 200 },
    ]
    const corners = orthogonalCorners(steep, 'lr')
    // The turn is half way along the flow, so the vertical run is at x = 20 — not at x = 0,
    // which is the face every box in the source's column shares.
    expect(corners.map((c) => c.x)).toEqual([0, 20, 20, 40])
  })
})

describe('routeMidpoint', () => {
  it('walks half the route length rather than taking the middle point', () => {
    // Three points, but the first leg is nine times the second: the halfway mark is inside it.
    const mid = routeMidpoint(
      [
        { x: 0, y: 0 },
        { x: 90, y: 0 },
        { x: 100, y: 0 },
      ],
      'straight',
      'lr',
    )!
    expect(mid.x).toBeCloseTo(50, 6)
  })

  /**
   * The reported bug: the three routings draw three different strokes over one set of points, so
   * a midpoint read from the *waypoints* is the same for all three and the labels never moved
   * when the control changed.
   */
  it('puts the label on the stroke each routing actually draws', () => {
    // One corridor, offset well off the straight line between the ends.
    const route: XY[] = [
      { x: 0, y: 0 },
      { x: 50, y: 80 },
      { x: 100, y: 0 },
    ]
    const straight = routeMidpoint(route, 'straight', 'lr')!
    const orthogonal = routeMidpoint(route, 'orthogonal', 'lr')!
    const curved = routeMidpoint(route, 'curved', 'lr')!

    // Straight ignores the corridor entirely, so its halfway mark is on the chord.
    expect(straight).toEqual({ x: 50, y: 0 })
    // The other two follow the detour, so they sit out near it — and not on the chord.
    expect(orthogonal.y).toBeGreaterThan(20)
    expect(curved.y).toBeGreaterThan(20)
    // And no two of the three agree, which is the whole point of passing the routing in.
    expect(orthogonal).not.toEqual(straight)
    expect(curved).not.toEqual(straight)
  })

  it('answers for a two-point route and for none', () => {
    expect(
      routeMidpoint(
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        'straight',
        'lr',
      ),
    ).toEqual({ x: 5, y: 5 })
    expect(routeMidpoint([], 'straight', 'lr')).toBeUndefined()
  })
})
