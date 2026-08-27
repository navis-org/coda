/**
 * Align and distribute, the arithmetic.
 *
 * Three things are worth pinning and the rest is a sum: that a size is *used* (the six edges
 * differ only in whether they read one, and four of them silently degrade to a left-align if it
 * is missed), that distribute evens the **gaps** rather than the centres — the difference is an
 * overlap, on a canvas whose cards run 232 to 560 wide — and that neither returns a move for a
 * card that is already where it should be, since `moveNodes` would leave an undo step for it.
 */

import { describe, expect, it } from 'vitest'

import type { GraphNode } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import '../nodes'
import { FALLBACK_NODE_SIZE } from './elkGraph'
import { alignNodes, distributeNodes } from './align'

function node(id: string, x: number, y: number): GraphNode {
  const def = requireNodeDef('core.tableFromUrl')
  return { id, type: def.type, position: { x, y }, params: defaultParams(def) }
}

/** Three cards of deliberately different sizes — the case every edge but left/top depends on. */
const wide = new Map([
  ['a', { width: 100, height: 50 }],
  ['b', { width: 300, height: 150 }],
  ['c', { width: 200, height: 100 }],
])

const nodes = [node('a', 0, 0), node('b', 500, 40), node('c', 1000, 90)]
const at = (moves: ReturnType<typeof alignNodes>, id: string) =>
  moves.find((m) => m.id === id)?.position

describe('align', () => {
  it('brings every left edge onto the leftmost one, and moves nothing else', () => {
    const moves = alignNodes(nodes, wide, 'left')
    expect(moves.length).toBe(2)
    expect(at(moves, 'b')).toEqual({ x: 0, y: 40 })
    expect(at(moves, 'c')).toEqual({ x: 0, y: 90 })
  })

  /* The half that needs a width. Aligned by *edge*, so a card's position depends on its size. */
  it('brings every right edge onto the rightmost one', () => {
    const moves = alignNodes(nodes, wide, 'right')
    // c reaches furthest: 1000 + 200 = 1200.
    expect(at(moves, 'a')).toEqual({ x: 1100, y: 0 })
    expect(at(moves, 'b')).toEqual({ x: 900, y: 40 })
    expect(moves.some((m) => m.id === 'c')).toBe(false)
  })

  it('centres on the selection’s box rather than on any one card', () => {
    const moves = alignNodes(nodes, wide, 'centerX')
    // The box runs 0 → 1200, so the centre line is 600.
    for (const id of ['a', 'b', 'c']) {
      const item = at(moves, id) ?? nodes.find((n) => n.id === id)!.position
      expect(item.x + wide.get(id)!.width / 2).toBe(600)
    }
  })

  it('works the other way up, and leaves the axis it is not about alone', () => {
    const moves = alignNodes(nodes, wide, 'bottom')
    // Bottoms are 50, 190, 190 — b and c already share the lowest.
    expect(at(moves, 'a')).toEqual({ x: 0, y: 140 })
    expect(moves.length).toBe(1)
  })

  /*
   * The silent failure this whole file exists for: with no measurement, `resolveSize` falls back
   * to the declared size, and every card being one width turns a right-align into a left-align
   * offset by a constant. Asserted so a caller that forgets to measure is visible here rather
   * than on somebody's canvas.
   */
  it('falls back to the declared size, and says so by putting every card on one edge', () => {
    const moves = alignNodes(nodes, undefined, 'right')
    const width = FALLBACK_NODE_SIZE.width
    expect(at(moves, 'a')?.x).toBe(1000 + width - width)
    expect(at(moves, 'b')?.x).toBe(1000)
  })

  it('does nothing at all with fewer than two cards', () => {
    expect(alignNodes([node('a', 0, 0)], wide, 'left')).toEqual([])
    expect(alignNodes([], wide, 'left')).toEqual([])
  })
})

describe('distribute', () => {
  /*
   * Equal *air* between neighbours, not equal centres. With these three the span is 0 → 1200,
   * the cards occupy 600, so each of the two gaps is 300: a ends at 100, b runs 400 → 700, c
   * starts at 1000.
   */
  it('evens the gaps and leaves the outermost pair where they are', () => {
    const moves = distributeNodes(nodes, wide, 'x')
    expect(moves.length).toBe(1)
    expect(at(moves, 'b')).toEqual({ x: 400, y: 40 })
  })

  it('orders by centre, so a wide card is not judged by its leading edge', () => {
    // b's left edge is left of c's, but b's *centre* is to the right of it.
    const overlapping = [node('a', 0, 0), node('b', 300, 0), node('c', 340, 0)]
    const sizes = new Map([
      ['a', { width: 100, height: 50 }],
      ['b', { width: 400, height: 50 }],
      ['c', { width: 100, height: 50 }],
    ])
    const moves = distributeNodes(overlapping, sizes, 'x')
    // The run is a … c … b: c is the middle card, so it is the one that moves.
    expect(moves.map((m) => m.id)).toEqual(['c'])
  })

  it('spreads down the other axis too', () => {
    const column = [node('a', 0, 0), node('b', 0, 200), node('c', 0, 1000)]
    const sizes = new Map([
      ['a', { width: 100, height: 100 }],
      ['b', { width: 100, height: 100 }],
      ['c', { width: 100, height: 100 }],
    ])
    // Span 0 → 1100, 300 occupied, two gaps of 400: b starts at 500.
    expect(distributeNodes(column, sizes, 'y')).toEqual([
      { id: 'b', position: { x: 0, y: 500 } },
    ])
  })

  it('is idempotent — running it twice moves nothing the second time', () => {
    const moves = distributeNodes(nodes, wide, 'x')
    const settled = nodes.map((n) => {
      const move = moves.find((m) => m.id === n.id)
      return move ? { ...n, position: move.position } : n
    })
    expect(distributeNodes(settled, wide, 'x')).toEqual([])
  })

  /*
   * Cards wider than the span they sit in were already overlapping, and nothing here can invent
   * the space — so the gap goes negative and they overlap *evenly*, rather than the operation
   * refusing. A guard rail warns; it does not refuse, and this one has nothing to warn about.
   */
  it('keeps going when there is no room, spacing the overlap evenly', () => {
    const cramped = [node('a', 0, 0), node('b', 10, 0), node('c', 100, 0)]
    const sizes = new Map([
      ['a', { width: 100, height: 50 }],
      ['b', { width: 100, height: 50 }],
      ['c', { width: 100, height: 50 }],
    ])
    // Span 0 → 200, 300 occupied: each gap is −50, so b starts at 50.
    expect(distributeNodes(cramped, sizes, 'x')).toEqual([
      { id: 'b', position: { x: 50, y: 0 } },
    ])
  })

  it('needs three cards — two are already evenly spaced', () => {
    expect(distributeNodes(nodes.slice(0, 2), wide, 'x')).toEqual([])
  })
})
