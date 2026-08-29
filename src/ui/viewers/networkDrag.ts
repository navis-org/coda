/**
 * Moving nodes by hand in the network viewer.
 *
 * Split out for the reason `networkStyle.ts` was: jsdom has no WebGL, so sigma never exists
 * in a test and anything left inside the component is untestable by construction. What is
 * arithmetic here — which nodes a grab picks up, and where they end up — is the part that can
 * be got wrong quietly, so it lives where a test can reach it. The component keeps only the
 * event wiring.
 *
 * Two decisions are recorded in the shape of this module rather than in the component:
 *
 *  - **A grab on a selected node moves the whole selection.** Cytoscape and Gephi both do
 *    this, and it is what makes arranging a figure practical: a drag per node is a drag per
 *    node. Grabbing an *unselected* node moves only it, and does not disturb the selection —
 *    so the gesture never silently redefines what is selected.
 *  - **Positions are carried as a delta from where the drag began**, not by snapping each
 *    node onto the pointer. Snapping would jump the node so its centre met the cursor the
 *    instant you pressed, which is the difference between picking something up and having it
 *    teleport into your hand — and with a multi-node drag it would collapse the selection
 *    onto one point.
 */

import type { Positioned } from './networkLayout'
import { seedsFor } from './networkSelect'

/**
 * Pointer travel, in *viewport* pixels, below which a press is still a click.
 *
 * Sigma decides this for itself with `draggedEventsTolerance`, but only along the path we
 * take away from it: the mouse captor counts a dragged event **after** the
 * `sigmaDefaultPrevented` check, so a drag that suppresses camera panning — which is every
 * drag here — leaves that counter at zero and sigma emits a `click` at the end of it. Without
 * a tolerance of our own, dropping a node would toggle its selection every time.
 *
 * Viewport pixels rather than graph units, because it is a question about the hand: three
 * pixels of tremor is three pixels of tremor at any zoom.
 */
export const DRAG_SLOP = 3

export interface DragState {
  /**
   * Where each moving node sat when the drag began, in graph space.
   *
   * Held rather than re-read on each move so the arrangement cannot accumulate rounding: a
   * drag applies one delta to the original position, not a delta to the last one.
   */
  start: Map<string, Positioned>
  /** The pointer at the grab, in graph space — the origin of the delta. */
  fromGraph: Positioned
  /** The same instant in viewport pixels, which is where the slop is judged. */
  fromViewport: Positioned
  /** Whether the pointer has travelled past `DRAG_SLOP`; a press that has not is a click. */
  moved: boolean
}

/**
 * Begin a drag on `node`, given what is selected and where things are.
 *
 * `positionOf` returns undefined for an id the graph does not have, which is an ordinary
 * state rather than a fault: a selection outlives the nodes it named — a filter upstream, a
 * re-run — and those ids are simply not picked up. Returns null when the grabbed node itself
 * has no position, so a caller cannot start a drag that moves nothing.
 */
export function beginDrag(
  node: string,
  selection: ReadonlySet<string>,
  positionOf: (id: string) => Positioned | undefined,
  pointer: { graph: Positioned; viewport: Positioned },
): DragState | null {
  const at = positionOf(node)
  if (!at) return null

  // Only a grab *on* the selection takes the rest of it along; grabbing outside means "move
  // this one". `seedsFor` is that rule, shared with the context menu so a grab and a
  // right-click cannot come to mean different things.
  const start = new Map<string, Positioned>([[node, at]])
  for (const id of seedsFor(node, selection)) {
    if (start.has(id)) continue
    const other = positionOf(id)
    if (other) start.set(id, other)
  }
  return { start, fromGraph: pointer.graph, fromViewport: pointer.viewport, moved: false }
}

/** Has the pointer travelled far enough that this is a drag rather than a click? */
export function beyondSlop(state: DragState, viewport: Positioned): boolean {
  const dx = viewport.x - state.fromViewport.x
  const dy = viewport.y - state.fromViewport.y
  return dx * dx + dy * dy > DRAG_SLOP * DRAG_SLOP
}

/**
 * Where every node of the drag sits, given the pointer's current position in graph space.
 *
 * One delta over the positions recorded at the grab, so the grab offset survives — the node
 * keeps the place under the cursor that you took hold of — and every node of a multi-node
 * drag keeps its distance from the others.
 */
export function dragPositions(state: DragState, graph: Positioned): Map<string, Positioned> {
  const dx = graph.x - state.fromGraph.x
  const dy = graph.y - state.fromGraph.y
  const moved = new Map<string, Positioned>()
  for (const [id, at] of state.start) moved.set(id, { x: at.x + dx, y: at.y + dy })
  return moved
}
