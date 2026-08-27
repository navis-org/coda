/**
 * Align and distribute: the arithmetic, headless.
 *
 * Both take the cards' *measured* sizes for the reason everything in this directory does — a
 * card's height comes from its param rows, its ports and whether it is collapsed, none of which
 * the document records, so aligning right edges against a declared 232 puts every wide card's
 * edge somewhere it is not. Only `left` and `top` could get away without a size, and having two
 * of the six work differently is how the other four would be got wrong.
 *
 * Both return **only the cards that actually move**. An align that changes nothing must not
 * reach `moveNodes`, which mints a fresh graph whatever it is handed and would leave an undo
 * step for a menu press that did nothing.
 *
 * Nothing here is React, and nothing here commits: the caller reads sizes, calls one of these,
 * and hands the result to `moveNodes(moves, true)` — the *drag* path, deliberately, not
 * `arrangeNodes`. An alignment is a position somebody chose, so it ends auto-layout and becomes
 * one undo step, exactly as dragging the cards there by hand would.
 */

import type { GraphNode } from '../core/graph'
import type { MeasuredSizes } from './elkGraph'
import { resolveSize } from './elkGraph'

/** Which edge (or centre line) the cards are brought onto. */
export type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'

export type Axis = 'x' | 'y'

export interface Move {
  id: string
  position: { x: number; y: number }
}

/** Two cards to align, three to distribute — below that both are no-ops. */
export const MIN_ALIGN = 2
export const MIN_DISTRIBUTE = 3

/** One card reduced to the axis in question: where it starts, and how far it reaches. */
interface Span {
  id: string
  node: GraphNode
  start: number
  size: number
}

function spans(nodes: readonly GraphNode[], measured: MeasuredSizes | undefined, axis: Axis) {
  return nodes.map((node): Span => {
    const size = resolveSize(node, measured)
    return {
      id: node.id,
      node,
      start: axis === 'x' ? node.position.x : node.position.y,
      size: axis === 'x' ? size.width : size.height,
    }
  })
}

/**
 * Positions rounded to whole flow units.
 *
 * A centre line lands on a half-pixel as often as not, and a document full of `412.5117` is
 * noise in a file people read and diff. Two cards of the same width still get *identical*
 * coordinates, since each is `round(centre - width / 2)` of one shared centre; two of different
 * widths can differ by half a unit, which is below what a canvas can draw.
 */
function place(span: Span, axis: Axis, start: number): Move | undefined {
  const value = Math.round(start)
  if (value === span.start) return undefined
  return {
    id: span.id,
    position:
      axis === 'x'
        ? { x: value, y: span.node.position.y }
        : { x: span.node.position.x, y: value },
  }
}

/**
 * Bring every card onto one edge of the selection's bounding box.
 *
 * The box is the *selection's*, not the first card's and not the last: aligning left moves
 * everything onto the leftmost edge in the set, which is the only choice that never moves a
 * card past one it was already outside. A centre align uses the box's centre for the same
 * reason — anchoring on one member would make the result depend on which card was clicked.
 */
export function alignNodes(
  nodes: readonly GraphNode[],
  measured: MeasuredSizes | undefined,
  edge: AlignEdge,
): Move[] {
  if (nodes.length < MIN_ALIGN) return []
  const axis: Axis = edge === 'left' || edge === 'centerX' || edge === 'right' ? 'x' : 'y'
  const items = spans(nodes, measured, axis)

  const min = Math.min(...items.map((s) => s.start))
  const max = Math.max(...items.map((s) => s.start + s.size))

  const moves: Move[] = []
  for (const item of items) {
    let start: number
    if (edge === 'left' || edge === 'top') start = min
    else if (edge === 'right' || edge === 'bottom') start = max - item.size
    else start = (min + max) / 2 - item.size / 2
    const move = place(item, axis, start)
    if (move) moves.push(move)
  }
  return moves
}

/**
 * Even the *gaps* between neighbouring cards, leaving the two outermost where they are.
 *
 * **Gaps rather than centres, and on a node canvas that is not a close call.** Coda's cards
 * range from a 232-wide transform to a 560-wide Neuron Profile, and equalising centres across
 * that spread puts a wide card's edge straight through its neighbour — evenly spaced centres
 * with uneven widths is exactly how you draw an overlap. What somebody distributing a row of
 * cards wants is the same amount of *air* between each pair, which is this.
 *
 * The outermost pair is the anchor, so the operation is idempotent and never grows the graph's
 * footprint. Where the cards are already wider than the span they sit in — which means they were
 * overlapping to begin with — the gap comes out negative and they stay overlapped, evenly. That
 * is the honest answer rather than a refusal: nothing here can invent the space, and ⌘Z is one
 * key away.
 */
export function distributeNodes(
  nodes: readonly GraphNode[],
  measured: MeasuredSizes | undefined,
  axis: Axis,
): Move[] {
  if (nodes.length < MIN_DISTRIBUTE) return []
  // By centre, not by leading edge: a wide card whose left edge is furthest left is not
  // necessarily the leftmost *card*, and ordering by edge makes distribute swap two neighbours.
  const items = spans(nodes, measured, axis).sort(
    (a, b) => a.start + a.size / 2 - (b.start + b.size / 2),
  )

  const first = items[0]!
  const last = items[items.length - 1]!
  const span = last.start + last.size - first.start
  const occupied = items.reduce((total, item) => total + item.size, 0)
  const gap = (span - occupied) / (items.length - 1)

  const moves: Move[] = []
  let cursor = first.start + first.size + gap
  for (const item of items.slice(1, -1)) {
    const move = place(item, axis, cursor)
    if (move) moves.push(move)
    cursor += item.size + gap
  }
  return moves
}
