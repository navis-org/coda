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
import { loopsIn } from '../core/graph'
import type { MeasuredSizes } from './elkGraph'
import { resolveSize } from './elkGraph'

/**
 * Space between the outermost card and the frame, in flow units.
 *
 * Enough that the frame reads as around the cards rather than as a border on the outermost one,
 * and enough for the invisible grab band (`GROUP_GRAB` in the canvas layer) to sit clear of a
 * card's own drag target — the two overlapping would make the top-left card ungrabbable.
 */
export const GROUP_PADDING = 24

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
  nodes: ReadonlyMap<string, { position: { x: number; y: number } }>,
  sizeOf: (id: string) => { width: number; height: number } | undefined,
  padding = GROUP_PADDING,
): GroupBox | undefined {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity

  for (const id of group.nodeIds) {
    const node = nodes.get(id)
    if (!node) continue
    const size = sizeOf(id)
    if (!size) continue
    left = Math.min(left, node.position.x)
    top = Math.min(top, node.position.y)
    right = Math.max(right, node.position.x + size.width)
    bottom = Math.max(bottom, node.position.y + size.height)
  }

  if (left === Infinity) return undefined
  return {
    id: group.id,
    x: left - padding,
    y: top - padding,
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
  }
}

/** Every frame's box, in document order, skipping any that has nothing to draw around. */
export function groupBoxes(
  graph: CodaGraph,
  measured?: MeasuredSizes,
  padding = GROUP_PADDING,
): GroupBox[] {
  if (!graph.groups?.length) return []
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const boxes: GroupBox[] = []
  for (const group of graph.groups) {
    const box = groupBox(
      group,
      nodes,
      (id) => {
        const node = nodes.get(id)
        return node ? resolveSize(node, measured) : undefined
      },
      padding,
    )
    if (box) boxes.push(box)
  }
  return boxes
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
): LoopBox[] {
  const loops = loopsIn(graph)
  if (loops.length === 0) return []
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const boxes: LoopBox[] = []
  for (const { beginId, region } of loops) {
    if (region.size < 2) continue
    const box = groupBox(
      { id: beginId, nodeIds: [...region] },
      nodes,
      (id) => {
        const node = nodes.get(id)
        return node ? resolveSize(node, measured) : undefined
      },
      padding,
    )
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
