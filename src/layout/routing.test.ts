/**
 * Edge routing: the waypoints ELK already computes, and what has to be true to use them.
 *
 * Three of these are checked against the **real algorithm** rather than against a fixture, for
 * the reason the rest of `layout.test.ts` is: ELK silently ignores an option key it does not
 * recognise, so "does `FIXED_POS` reach it" is a real question, and a route that comes back
 * subtly wrong still produces a perfectly plausible-looking path.
 *
 * The other two are about the ways a route stops being true — it is computed in ELK's
 * origin-based space and has to travel with the nodes, and it describes one arrangement and has
 * to be dropped when that arrangement is edited. Both failures draw a wire into empty space, and
 * neither throws.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import type { CodaGraph, GraphNode } from '../core/graph'
import { addEdge, addNode, emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'

import type { MeasuredPorts, NodeSize } from './elkGraph'
import { FALLBACK_NODE_SIZE, elkPortId, routesFrom, toElkGraph } from './elkGraph'
import { runElk, runLayout } from './engine'
import { DEFAULT_LAYOUT_OPTIONS } from './options'
import type { XY } from './place'
import { anchorDelta, dodgeDelta, routeKey, translateRoutes } from './place'
import { defaultInputPorts, defaultOutputPorts } from '../core/ports'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

function node(id: string, type: string, x = 0, y = 0): GraphNode {
  return { id, type, position: { x, y }, params: defaultParams(requireNodeDef(type)) }
}

/** Whether the straight segment `a`→`b` passes through a card. Sampled; exactness is not the point. */
function crosses(a: XY, b: XY, card: { x: number; y: number; width: number; height: number }) {
  for (let i = 0; i <= 200; i++) {
    const t = i / 200
    const x = a.x + (b.x - a.x) * t
    const y = a.y + (b.y - a.y) * t
    if (x > card.x && x < card.x + card.width && y > card.y && y < card.y + card.height) {
      return true
    }
  }
  return false
}

/** The id of the long wire in `skipping()` — the one with two cards between its ends. */
const SKIP_EDGE = 'skip'

/**
 * A chain with a wire that skips two cards — the shape routing exists for.
 *
 * `Find Neurons → Filter → Sort → Join.left`, plus `Find Neurons → Join.right`. The long wire
 * has two cards between its ends, so a straight line between its sockets goes through both.
 *
 * It lands on a *second* input deliberately. `addEdge` evicts whatever already occupies the
 * destination, so aiming both wires at a one-input node quietly deletes the chain and leaves a
 * graph with nothing to route past — which is a passing `routes.size` of 1 describing an edge
 * that is not the one the test is about.
 */
function skipping(): CodaGraph {
  let graph = emptyGraph()
  for (const [id, type] of [
    ['find', 'neuron.findNeurons'],
    ['filter', 'core.filter'],
    ['sort', 'core.sort'],
    ['join', 'core.join'],
  ] as const) {
    graph = addNode(graph, node(id, type))
  }
  graph = addEdge(graph, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'filter',
    targetHandle: 'in',
  })
  graph = addEdge(graph, {
    source: 'filter',
    sourceHandle: 'out',
    target: 'sort',
    targetHandle: 'in',
  })
  graph = addEdge(graph, {
    source: 'sort',
    sourceHandle: 'out',
    target: 'join',
    targetHandle: 'left',
  })
  graph = addEdge(graph, {
    id: SKIP_EDGE,
    source: 'find',
    sourceHandle: 'neurons',
    target: 'join',
    targetHandle: 'right',
  })
  return graph
}

describe('routes out of ELK', () => {
  it('bends a wire that has to get past a card, and leaves the rest straight', async () => {
    const graph = skipping()
    const { positions, routes } = await runLayout(
      graph.nodes,
      graph.edges,
      DEFAULT_LAYOUT_OPTIONS,
    )

    /*
     * The skip edge is the last one added and is the only one spanning more than one layer.
     * Exactly one route, because the other three are neighbours: a map with an entry per edge
     * would mean bend points are being invented, and an empty one would mean `sections` is not
     * being read at all — the state this shipped in for as long as the layout has existed.
     */
    expect(routes.size).toBe(1)
    expect(graph.edges).toHaveLength(4)
    const route = routes.get(SKIP_EDGE)
    expect(route).toBeDefined()
    expect(route!.length).toBeGreaterThanOrEqual(2)

    /*
     * And the detour genuinely clears the cards in the way, which is the only thing that makes
     * a route worth drawing. Asserted as geometry rather than as "it goes above": ELK picks
     * whichever side has room, and this graph's long wire lands on the *lower* of the join's
     * two inputs and so dips underneath. A test that fixed the direction would be pinning an
     * arbitrary choice and would fail the day the port order changed.
     */
    const between = ['filter', 'sort'].map((id) => ({
      ...positions.get(id)!,
      ...FALLBACK_NODE_SIZE,
    }))
    for (const point of route!) {
      for (const card of between) {
        const inside =
          point.x > card.x &&
          point.x < card.x + card.width &&
          point.y > card.y &&
          point.y < card.y + card.height
        expect(inside).toBe(false)
      }
    }
    // The route is not merely outside the cards by accident — a straight line between the same
    // two waypoints would have gone through one, which is what it detoured to avoid.
    const first = route![0]!
    const last = route![route!.length - 1]!
    expect(between.some((card) => crosses(first, last, card))).toBe(true)
  })

  it('reads nothing from an algorithm that routes nothing', async () => {
    const graph = skipping()
    // `radial` returns no `sections` at all and `force` returns sections with no bend points.
    // Both must read as "no route" rather than as an empty route, which would draw a wire
    // straight from socket to socket through everything in the way.
    for (const algorithm of ['force', 'radial'] as const) {
      const { routes } = await runLayout(graph.nodes, graph.edges, {
        ...DEFAULT_LAYOUT_OPTIONS,
        algorithm,
      })
      expect(routes.size).toBe(0)
    }
  })

  it('drops an edge whose section carries an empty bend list', () => {
    // Straight from `routesFrom`, because ELK will not produce this on demand and the
    // distinction — a present-but-empty `bendPoints` against an absent one — is what decides
    // whether the canvas draws a curve or a two-point line.
    expect(
      routesFrom({
        id: 'root',
        edges: [
          {
            id: 'a',
            sources: [],
            targets: [],
            sections: [
              { id: 's', startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 }, bendPoints: [] },
            ],
          },
          {
            id: 'b',
            sources: [],
            targets: [],
            sections: [{ id: 's', startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } }],
          },
          { id: 'c', sources: [], targets: [] },
        ],
      }).size,
    ).toBe(0)
  })
})

describe('pinned ports', () => {
  /**
   * The measurement that makes a route usable.
   *
   * Coda pairs input *i* and output *i* into one `.port-row`, so opposite sockets share a
   * height; ELK spreads them by its own `spacing.portPort` rule and has no constraint that can
   * say otherwise. Unless it is handed the real offsets, its route endpoints and the sockets
   * React Flow draws from are structurally different numbers — the wire attaches correctly
   * either way, because the component anchors on React Flow's, but the first and last segment
   * arrive at an angle that no orthogonal route should have.
   */
  it('honours measured socket offsets exactly, and still routes', async () => {
    const graph = skipping()
    const size: NodeSize = { width: 232, height: 140 }
    const measured = new Map(graph.nodes.map((n) => [n.id, size]))

    // Every socket on the left at y=48 and on the right at y=48 — the paired-row arrangement,
    // which is precisely what ELK's own spread would never produce.
    const ports: MeasuredPorts = new Map(
      graph.nodes.map((n) => {
        const def = requireNodeDef(n.type)
        const offsets = new Map<string, XY>()
        for (const port of defaultInputPorts(def)) offsets.set(port.id, { x: 0, y: 48 })
        for (const port of defaultOutputPorts(def)) offsets.set(port.id, { x: size.width, y: 48 })
        return [n.id, offsets]
      }),
    )

    const laid = await runElk(
      toElkGraph(graph.nodes, graph.edges, DEFAULT_LAYOUT_OPTIONS, measured, ports),
    )

    for (const child of laid.children ?? []) {
      for (const port of child.ports ?? []) {
        expect(port.y).toBe(48)
      }
    }
    // Pinning must not cost the routing — that would make the two halves of this feature
    // mutually exclusive.
    expect(routesFrom(laid).size).toBe(1)
  })

  it('declines to pin a card whose sockets were only partly measured', async () => {
    const graph = skipping()
    const def = requireNodeDef('core.filter')
    const first = defaultInputPorts(def)[0]!
    // One socket measured out of several. Taken literally, `FIXED_POS` puts every unmeasured
    // port at (0,0) — the card's top-left, on whichever side — and routes confidently into it.
    const ports: MeasuredPorts = new Map([['filter', new Map([[first.id, { x: 0, y: 48 }]])]])

    const laid = await runElk(
      toElkGraph(graph.nodes, graph.edges, DEFAULT_LAYOUT_OPTIONS, undefined, ports),
    )
    const filter = laid.children?.find((c) => c.id === 'filter')
    const pinned = (filter?.ports ?? []).filter((p) => p.y === 0)
    // Nothing collapsed onto the corner: the card fell back to ELK placing its own ports.
    expect(pinned.length).toBe(0)
    expect(filter?.ports?.length).toBeGreaterThan(1)
  })

  it('leaves a vertical direction free, pinned offsets or not', async () => {
    /*
     * The staircase from `elkNodeOptions`. `FIXED_POS` is `FIXED_ORDER`'s upgrade and inherits
     * its one measured failure: under DOWN, sockets held east and west make ELK reserve room
     * for a wire leaving a card's right edge and re-entering the left edge of the one below.
     */
    const graph = skipping()
    const ports: MeasuredPorts = new Map(
      graph.nodes.map((n) => {
        const def = requireNodeDef(n.type)
        const offsets = new Map<string, XY>()
        for (const port of defaultInputPorts(def)) offsets.set(port.id, { x: 0, y: 48 })
        for (const port of defaultOutputPorts(def)) offsets.set(port.id, { x: 232, y: 48 })
        return [n.id, offsets]
      }),
    )
    const { positions } = await runLayout(
      graph.nodes,
      graph.edges,
      { ...DEFAULT_LAYOUT_OPTIONS, direction: 'DOWN' },
      undefined,
      ports,
    )
    const xs = [...positions.values()].map((p) => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(120)
  })
})

describe('routes travel with the arrangement', () => {
  it('takes the same shift the positions take', () => {
    // ELK lays out from the origin. A route left there while its cards were anchored back to
    // where the work was is not subtly wrong — it is a wire drawn the whole width of the graph
    // away from the nodes it joins.
    const sizes = new Map<string, NodeSize>([
      ['a', { width: 100, height: 50 }],
      ['b', { width: 100, height: 50 }],
    ])
    const raw = new Map<string, XY>([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 200, y: 0 }],
    ])
    const routes = new Map<string, XY[]>([['e', [{ x: 110, y: -20 }]]])

    const shift = anchorDelta(raw, sizes, { x: 500, y: 300 })
    expect(shift).toEqual({ x: 500, y: 300 })

    const moved = translateRoutes(routes, shift.x, shift.y)
    expect(moved.get('e')).toEqual([{ x: 610, y: 280 }])
  })

  it('does not round on the way, unlike the positions beside it', () => {
    // A route is never serialised, so rounding it is pure loss — and the loss shows: a socket
    // sits at its card's rounded position *plus a fractional offset*, so a rounded waypoint
    // disagrees with it and the wire leaves at an angle before its first turn.
    const moved = translateRoutes(new Map([['e', [{ x: 10.4, y: 20.6 }]]]), 0.2, 0.1)
    expect(moved.get('e')![0]!.x).toBeCloseTo(10.6)
    expect(moved.get('e')![0]!.y).toBeCloseTo(20.7)
  })

  it('takes the dodge as well, accumulated over every pass', () => {
    const sizes = new Map<string, NodeSize>([['a', { width: 100, height: 50 }]])
    const positions = new Map<string, XY>([['a', { x: 0, y: 0 }]])
    // Two notes stacked, so the block has to clear one and then the other — the delta has to be
    // the sum, not the last step, or a route lands short of where its cards ended up.
    const notes = [
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 0, y: 100, width: 100, height: 40 },
    ]
    const delta = dodgeDelta(positions, sizes, notes)
    // Past the *lower* note, which only the accumulated shift reaches: clearing the first one
    // moves the block down into the second, and returning that first step alone would leave
    // every route sitting where the cards used to be.
    expect(delta.y).toBeGreaterThan(140)
    expect(delta.x).toBe(0)
  })
})

describe('routeKey', () => {
  const sized = (graph: CodaGraph) =>
    new Map(graph.nodes.map((n) => [n.id, { width: 232, height: 120 }]))

  it('changes when a card moves, where structureKey deliberately does not', () => {
    const graph = skipping()
    const before = routeKey(graph, sized(graph))
    const moved: CodaGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'filter' ? { ...n, position: { x: n.position.x + 40, y: n.position.y } } : n,
      ),
    }
    expect(routeKey(moved, sized(moved))).not.toBe(before)
  })

  it('changes when a wire is added, so a re-wired graph does not keep old waypoints', () => {
    const graph = skipping()
    const before = routeKey(graph, sized(graph))
    const rewired = addEdge(graph, {
      source: 'filter',
      sourceHandle: 'out',
      target: 'join',
      targetHandle: 'right',
    })
    expect(routeKey(rewired, sized(rewired))).not.toBe(before)
  })

  it('holds still for an edit that moves nothing', () => {
    // A param edit is the case that matters: it happens constantly and changes no geometry, so
    // dropping the routes on one would make routing survive only until the next keystroke.
    const graph = skipping()
    const before = routeKey(graph, sized(graph))
    const edited: CodaGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'filter' ? { ...n, params: { ...n.params, expr: 'pre > 10' } } : n,
      ),
    }
    expect(routeKey(edited, sized(edited))).toBe(before)
  })

  it('rounds, so a sub-pixel animation frame is not a different arrangement', () => {
    const graph = skipping()
    const nudged: CodaGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => ({
        ...n,
        position: { x: n.position.x + 0.2, y: n.position.y - 0.1 },
      })),
    }
    expect(routeKey(nudged, sized(nudged))).toBe(routeKey(graph, sized(graph)))
  })
})

describe('the ELK port ids a route is keyed against', () => {
  it('names the edge, not the ports, so the canvas can look one up by edge id', async () => {
    const graph = skipping()
    const { routes } = await runLayout(graph.nodes, graph.edges, DEFAULT_LAYOUT_OPTIONS)
    for (const id of routes.keys()) {
      expect(graph.edges.some((e) => e.id === id)).toBe(true)
      expect(id).not.toContain(elkPortId('', ''))
    }
  })
})
