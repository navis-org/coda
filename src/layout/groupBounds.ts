/**
 * The box a group frame draws, derived from the cards inside it.
 *
 * **Derived, never stored.** A rectangle in the document would need somebody to keep it in step
 * with six things that move it — a card dragged, resized, collapsed, folded, added by an
 * assistant plan, or re-placed by an arrange — and every one of those is a path that would have
 * to remember. Deriving it means a frame cannot go stale, at the cost of one pass over the
 * members per render. See `GraphGroup` for the rest of that decision.
 *
 * In `src/layout` rather than in `src/ui` for the reason the rest of this directory is: it is
 * arithmetic over the document plus the canvas's measurements, with no React in it, and
 * `resolveSize` — which already answers "how big is this card, really" for ELK — is the half
 * that is easy to get wrong. A group whose members all fell back to 232×120 would draw a frame
 * that fits none of them, which is exactly the bug that cost auto-layout a release.
 */

import type { CodaGraph, GraphGroup } from '../core/graph'
import { loopsIn, nodesById } from '../core/graph'
import type { MeasuredSizes, NodeSize } from './elkGraph'
import { resolveSize } from './elkGraph'
import type { Rect, XY } from './place'
import { union } from './place'

/**
 * Space between the outermost card and the frame, in flow units.
 *
 * Enough that the frame reads as around the cards rather than as a border on the outermost one,
 * and enough for the invisible grab band (`GROUP_GRAB` in the canvas layer) to sit clear of a
 * card's own drag target — the two overlapping would make the top-left card ungrabbable.
 */
export const GROUP_PADDING = 24

/** Where one card is and how big it is — what a box is derived from. */
export interface NodeRect {
  position: XY
  size: NodeSize
}

export interface GroupBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * One frame's box, or undefined when nothing it names is on the canvas.
 *
 * Undefined rather than a zero-sized box at the flow origin, which is what a naive `min` over an
 * empty set produces: a frame parked at (0, 0) with nothing in it is the pathological case
 * (`pruneGroups` drops an emptied group) and drawing it would put a stray rectangle somewhere
 * nobody is looking.
 */
export function groupBox(
  group: GraphGroup,
  rectOf: (id: string) => NodeRect | undefined,
  padding = GROUP_PADDING,
): GroupBox | undefined {
  const rects: Rect[] = []
  for (const id of group.nodeIds) {
    const rect = rectOf(id)
    if (rect) rects.push({ ...rect.position, ...rect.size })
  }
  const bounds = union(rects)
  if (!bounds) return undefined
  return {
    id: group.id,
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  }
}

/**
 * Every frame's box, in document order, skipping any that has nothing to draw around.
 *
 * **A collapsed group has no frame**, and that is an absence rather than a hidden rectangle: it
 * draws a card instead (`layout/collapse.ts`), and a frame drawn around members nobody can see
 * would be an outline around empty canvas whose contents move when its box is dragged.
 */
export function groupBoxes(
  graph: CodaGraph,
  measured?: MeasuredSizes,
  padding = GROUP_PADDING,
): GroupBox[] {
  if (!graph.groups?.length) return []
  const rectOf = nodeRects(graph, measured)
  const boxes: GroupBox[] = []
  for (const group of graph.groups) {
    if (group.collapsed) continue
    const box = groupBox(group, rectOf, padding)
    if (box) boxes.push(box)
  }
  return boxes
}

/** Where each card is and how big it is, as one lookup — `groupBox`'s only argument. */
export function nodeRects(
  graph: CodaGraph,
  measured?: MeasuredSizes,
): (id: string) => NodeRect | undefined {
  const nodes = nodesById(graph)
  return (id) => {
    const node = nodes.get(id)
    return node ? { position: node.position, size: resolveSize(node, measured) } : undefined
  }
}

/**
 * The box around each `For Each` loop's region — what re-runs, drawn so it can be seen.
 *
 * `groupBox` unchanged, handed a pseudo-group, and that reuse is the point: a loop's frame and a
 * group's frame are the same rectangle around the same kind of set, and computing them two ways
 * is how they would come to disagree about a collapsed card or an unmeasured one. What differs
 * is only *which* nodes and how far out the line sits.
 *
 * **Derived per render, never stored**, for `groupBox`'s reason and one more: a loop's membership
 * is a fact about the *wires*, so it changes the moment somebody draws or cuts one. A stored
 * rectangle would be wrong before the pointer was up.
 *
 * A loop of one node draws nothing. The region always contains its own begin node, so a `For
 * Each` with nothing wired after it would otherwise wear a frame around itself — which reads as
 * a loop that is somehow running, rather than as one nobody has finished wiring.
 */
export function loopBoxes(
  graph: CodaGraph,
  measured?: MeasuredSizes,
  padding = LOOP_PADDING,
  substitute?: ReadonlyMap<string, NodeRect>,
): LoopBox[] {
  const loops = loopsIn(graph)
  if (loops.length === 0) return []
  const real = nodeRects(graph, measured)
  /*
   * A member standing in for another card is read from `substitute` and not from the document: a
   * loop crossing a collapsed group is drawn around the *box*, because a frame stretched to where
   * the hidden members really are is an outline reaching across empty canvas. Two nodes of a
   * region inside one box therefore resolve to the same rectangle, which is exactly right — the
   * box is where they are. One resolver, composed once: written as two parallel accessors the
   * fallback had to be spelled twice and could disagree about which card it was answering for.
   */
  const rectOf = substitute ? (id: string) => substitute.get(id) ?? real(id) : real
  const boxes: LoopBox[] = []
  for (const { beginId, region } of loops) {
    if (region.size < 2) continue
    const box = groupBox({ id: beginId, nodeIds: [...region] }, rectOf, padding)
    // The region rides along because `loopsIn` has already walked it. Without it the caller has
    // to call `loopRegion` again per box — a second edge index per frame memo, and a second
    // place that must keep agreeing on the "stop at `loop: 'end'`" rule.
    if (box) boxes.push({ ...box, region })
  }
  return boxes
}

/** A loop's frame, and the nodes it is drawn around. */
export interface LoopBox extends GroupBox {
  region: Set<string>
}

/**
 * How far a loop frame sits outside its cards, in flow units.
 *
 * Half `GROUP_PADDING`, deliberately: a loop inside a group is an ordinary arrangement — "these
 * six cards are the download step, and four of them are the loop" — and two frames at the same
 * offset would draw one line on top of the other, which reads as one frame with a doubled
 * stroke. Inside rather than outside because a loop is always a subset of whatever contains it.
 */
export const LOOP_PADDING = 12
