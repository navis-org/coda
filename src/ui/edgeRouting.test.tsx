// @vitest-environment jsdom

/**
 * The wire, drawn. What each routing puts on screen, and what a route must never cost.
 *
 * Two modes reach here — `curved` and `orthogonal`. A third, `routed`, was built and removed;
 * `EdgeRouting` records why, and the case it failed is pinned in `layoutControls.test.tsx`.
 *
 * jsdom performs no layout and paints nothing, so the `d` attribute is the whole of what can be
 * observed — which is enough, because every failure this guards against is a *path string that
 * is well-formed and wrong*: a curve in a mode that promised steps, a step in a mode that
 * promised curves, or a wire that begins somewhere other than the socket it comes out of.
 *
 * The geometry behind those strings is `edgeRoute.test.ts`; the routes reaching them are
 * `layout/routing.test.ts`. This is the seam between the two.
 */

import { cleanup, render } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { CodaEdge } from './CodaEdge'
import { installJsdomStubs } from '../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
})

afterEach(cleanup)

const EDGE_TYPES = { coda: CodaEdge }

const NODES = [
  { id: 'a', position: { x: 0, y: 0 }, data: {}, width: 200, height: 100 },
  { id: 'b', position: { x: 600, y: 300 }, data: {}, width: 200, height: 100 },
]

/**
 * Render one wire and hand back its path.
 *
 * React Flow needs measured nodes before it draws an edge at all, and jsdom measures nothing —
 * so the nodes carry explicit `width`/`height`, which is what `adoptUserNodes` reads when it has
 * no measurement of its own.
 */
function pathFor(data: Record<string, unknown>): string {
  const { container } = render(
    <ReactFlowProvider>
      <ReactFlow
        nodes={NODES}
        edges={[{ id: 'e', source: 'a', target: 'b', type: 'coda', data }]}
        edgeTypes={EDGE_TYPES}
      />
    </ReactFlowProvider>,
  )
  return container.querySelector('.react-flow__edge-path')?.getAttribute('d') ?? ''
}

describe('what each routing draws', () => {
  it('draws a bezier with no route and no step — which is what the editor always drew', () => {
    const d = pathFor({})
    expect(d).toContain('C')
    expect(d).not.toContain('Q')
  })

  it('steps a wire with no route under orthogonal, rather than falling back to a curve', () => {
    /*
     * The case that decides whether the mode is coherent. Most wires are never bent — only 10 of
     * 32 across the bundled examples come back with bend points at all — so "ELK gave me
     * nothing" is the *common* branch, and letting it draw a bezier would leave `orthogonal`
     * looking like it applied to a third of the canvas.
     */
    const d = pathFor({ step: true })
    expect(d).not.toContain('C')
    expect(d).toMatch(/[LQ]/)
  })

  it('follows the waypoints when it has them', () => {
    const d = pathFor({
      route: [
        { x: 300, y: 50 },
        { x: 300, y: 350 },
      ],
    })
    // The turn at x=300 is in the path, filleted rather than mitred.
    expect(d).toContain('Q 300,')
    expect(d).not.toContain('C')
  })

  it('starts and ends on the sockets, not on ELK’s idea of where they were', () => {
    /*
     * The splice. ELK's section endpoints are where it *thought* the ports were during the
     * pass; React Flow's are where the sockets are now. Under `FIXED_POS` the two agree, and
     * where they cannot — a card resized since, an unmeasured socket — a wire that began at
     * ELK's guess would float off its own node. Nothing here is diagonal enough to notice at a
     * glance, which is exactly why it is asserted rather than looked at.
     */
    const route = [{ x: 12345, y: 6789 }]
    const d = pathFor({ route })
    const first = /^M (-?[\d.]+),(-?[\d.]+)/.exec(d)
    expect(first).not.toBeNull()
    // Wherever the socket is, the path opens on it — and never on the absurd waypoint above.
    expect(Number(first![1])).not.toBe(12345)
    expect(d.trimEnd().endsWith('12345,6789')).toBe(false)
    // But the waypoint is in the middle, so the route was honoured rather than dropped.
    expect(d).toContain('12345')
  })

  it('marks a wire that followed the waypoints, and only that wire', () => {
    /*
     * `data-routed` exists for the tests rather than for the stylesheet, and it earns its place:
     * nothing about the path *shape* distinguishes an ELK route from a computed step. Measured,
     * `getSmoothStepPath` emits between 0 and 4 corners depending only on where the sockets
     * landed, so a plain step path routinely has more of them than a routed one. The remaining
     * option — telling the two strings apart by their punctuation — is an accident of two
     * generators' formatting and would keep a real regression green the day either changed a
     * space.
     */
    const { container } = render(
      <ReactFlowProvider>
        <ReactFlow
          nodes={NODES}
          edges={[
            {
              id: 'r',
              source: 'a',
              target: 'b',
              type: 'coda',
              data: { route: [{ x: 300, y: 50 }], step: true },
            },
          ]}
          edgeTypes={EDGE_TYPES}
        />
      </ReactFlowProvider>,
    )
    expect(container.querySelectorAll('.react-flow__edge-path[data-routed]')).toHaveLength(1)
    cleanup()

    // A step path with no waypoints is not marked — it is the fallback, not a route.
    const plain = render(
      <ReactFlowProvider>
        <ReactFlow
          nodes={NODES}
          edges={[{ id: 's', source: 'a', target: 'b', type: 'coda', data: { step: true } }]}
          edgeTypes={EDGE_TYPES}
        />
      </ReactFlowProvider>,
    )
    expect(
      plain.container.querySelectorAll('.react-flow__edge-path[data-routed]'),
    ).toHaveLength(0)
  })
})

describe('what a routed wire keeps', () => {
  it('keeps the fat invisible hit path, so right-click still finds the detour', () => {
    /*
     * `BaseEdge` draws a second copy of the same `d` at `interactionWidth`. Without it the edge
     * menu and the Delete-key selection would still be testing against the straight line the
     * wire no longer takes — clickable everywhere except where it is drawn.
     */
    const { container } = render(
      <ReactFlowProvider>
        <ReactFlow
          nodes={NODES}
          edges={[
            {
              id: 'e',
              source: 'a',
              target: 'b',
              type: 'coda',
              data: {
                route: [
                  { x: 300, y: 50 },
                  { x: 300, y: 350 },
                ],
              },
            },
          ]}
          edgeTypes={EDGE_TYPES}
        />
      </ReactFlowProvider>,
    )
    const drawn = container.querySelector('.react-flow__edge-path')?.getAttribute('d')
    const hit = container.querySelector('.react-flow__edge-interaction')?.getAttribute('d')
    expect(hit).toBe(drawn)
  })

  it('keeps the style the canvas gave it, so a wire still wears its type colour', () => {
    const { container } = render(
      <ReactFlowProvider>
        <ReactFlow
          nodes={NODES}
          edges={[
            {
              id: 'e',
              source: 'a',
              target: 'b',
              type: 'coda',
              style: { stroke: 'var(--socket-table)', strokeWidth: 1.8 },
              data: { route: [{ x: 300, y: 50 }] },
            },
          ]}
          edgeTypes={EDGE_TYPES}
        />
      </ReactFlowProvider>,
    )
    const path = container.querySelector<SVGPathElement>('.react-flow__edge-path')
    expect(path?.style.stroke).toBe('var(--socket-table)')
  })
})
