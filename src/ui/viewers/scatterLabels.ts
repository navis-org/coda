/**
 * Text beside the points of a scatter, once few enough are in view to read — BigClust's labels,
 * placed the way it places them.
 *
 * **Greedy, in priority order, first free slot wins.** Each label tries eight boxes around its
 * point — right, then the four diagonals, then left, above, below; a reader scanning a plot reads
 * a name to the right of its dot first — and takes the first that overlaps no mark, no placed
 * label and stays inside the plot. No objective, no annealing: at the few hundred labels this ever
 * places, a deterministic pass is exact enough and costs a millisecond.
 *
 * Three things BigClust learned that are kept:
 *
 *  - **The previous slot is tried first** (`previous`), so a pan that changes nothing near a label
 *    does not flip it from right to left — a label that jumps is one the eye loses.
 *  - **Selected labels go first**, so the points somebody picked are the ones that get names.
 *  - **Every mark is an obstacle**, labelled or not, as a square of its radius: a name covering a
 *    neighbour's dot hides the data the name was meant to explain.
 *
 * One departure, on purpose: **sizes are screen pixels**, not data units. Coda's charts keep text
 * at one readable size, so a zoom re-solves rather than scaling the text, which at a few hundred
 * labels is cheap. A label that fits nowhere is hidden or dimmed (`unplaced`); a dimmed one sits
 * in the slot to the right, where a reader looks for it, under the others.
 *
 * Pure over numbers handed in — positions, radii, measured text — so jsdom, which lays out
 * nothing and measures no text, can test it. The overlap test is `layout/place.ts`' `overlaps`, the
 * one spelling of it. Named `placePointLabels` beside the Screen Map's `placeLabels`
 * (`ui/tour/mapLayout.ts`), which is the same first-free-candidate idea over a different candidate
 * set — rows down from a side — and deliberately not merged with this.
 */

import type { Rect } from '../../layout/place'
import { overlaps } from '../../layout/place'
import type { ScatterSpec } from './scatterPlot'

/** Right, the four diagonals, left, above, below: the order a slot is tried in. */
const SLOTS: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, -1],
  [1, 1],
  [-1, -1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [0, 1],
]
const DIAGONAL = Math.SQRT1_2

export interface LabelRequest {
  /** Position of the mark in the frame, which is what `previous` is keyed by. */
  index: number
  text: string
  /** The mark's centre and radius, in pixels. */
  x: number
  y: number
  r: number
  /** The text's measured box. */
  width: number
  height: number
  /** Placed earlier the lower it is: a selected mark's label before the rest. */
  priority: number
}

export interface PlacedLabel extends Rect {
  index: number
  text: string
  /** The slot it took, which the next solve tries first. Absent on a dimmed one. */
  slot?: number
  /** Drawn faint and under the rest: a label that fit nowhere, under `unplaced: 'dim'`. */
  dim?: boolean
  /** From the mark's edge to the nearest point of the box, where leader lines are on. */
  line?: readonly [number, number, number, number]
}

/** An obstacle: a mark in view, labelled or not. */
export interface LabelObstacle {
  index: number
  x: number
  y: number
  r: number
}

export interface PlacementOptions {
  bounds: Rect
  obstacles: readonly LabelObstacle[]
  leaders: boolean
  unplaced: 'hide' | 'dim'
  /** The last solve's labels, whose slots are tried first. */
  previous?: readonly PlacedLabel[] | undefined
}

/**
 * What a frame asks to have labelled, and what every label must keep clear of — built once, for
 * the viewer and for `probe-scatter-labels`, which places labels exactly as the card does only if
 * it builds them the same way.
 */
export function labelRequests(
  spec: ScatterSpec,
  textOf: (mark: number) => string,
  measure: (text: string) => { width: number; height: number },
  priorityOf: (mark: number) => number,
): { requests: LabelRequest[]; obstacles: LabelObstacle[] } {
  const { px, py, marks, visible } = spec
  const requests: LabelRequest[] = []
  const obstacles: LabelObstacle[] = []
  for (const index of visible) {
    const point = { index, x: px[index]!, y: py[index]!, r: marks.radius[index]! }
    obstacles.push(point)
    const text = textOf(index)
    if (text) requests.push({ ...point, text, ...measure(text), priority: priorityOf(index) })
  }
  return { requests, obstacles }
}

/**
 * A grid of boxes, so a collision test reads the few cells a candidate covers rather than every
 * box placed — BigClust's spatial hash, sized to a label's height. Numeric cell keys and plain
 * loops: string keys and a closure per cell were ~40% of a solve, measured.
 */
function boxGrid(size: number) {
  const cells = new Map<number, Rect[]>()
  const cols = (box: Rect) => [Math.floor(box.x / size), Math.floor((box.x + box.width) / size)]
  const rows = (box: Rect) => [
    Math.floor(box.y / size),
    Math.floor((box.y + box.height) / size),
  ]
  // Cell coordinates are offset so a box at a small negative position keys distinctly.
  const key = (r: number, c: number) => (r + 1024) * 65_536 + (c + 1024)
  return {
    add(box: Rect): void {
      const [c0, c1] = cols(box)
      const [r0, r1] = rows(box)
      for (let r = r0!; r <= r1!; r++) {
        for (let c = c0!; c <= c1!; c++) {
          const cell = cells.get(key(r, c))
          if (cell) cell.push(box)
          else cells.set(key(r, c), [box])
        }
      }
    },
    /** Whether anything overlaps `box`, `ignore` aside (a label's own mark). */
    hits(box: Rect, ignore?: Rect): boolean {
      const [c0, c1] = cols(box)
      const [r0, r1] = rows(box)
      for (let r = r0!; r <= r1!; r++) {
        for (let c = c0!; c <= c1!; c++) {
          const cell = cells.get(key(r, c))
          if (!cell) continue
          for (const other of cell) if (other !== ignore && overlaps(box, other)) return true
        }
      }
      return false
    },
  }
}

/** The box a label takes in `slot`, `pad` clear of its mark. */
function slotBox(request: LabelRequest, slot: number, pad: number): Rect {
  const [dx, dy] = SLOTS[slot]!
  const reach = (request.r + pad) * (dx !== 0 && dy !== 0 ? DIAGONAL : 1)
  const cx = request.x + dx * reach
  const cy = request.y + dy * reach
  // Anchored by its near edge: a box to the right starts at the gap, one above ends at it.
  return {
    x: dx > 0 ? cx : dx < 0 ? cx - request.width : cx - request.width / 2,
    y: dy > 0 ? cy : dy < 0 ? cy - request.height : cy - request.height / 2,
    width: request.width,
    height: request.height,
  }
}

/** From the mark's edge toward the box, ending at the box's nearest point. */
function leader(request: LabelRequest, box: Rect): readonly [number, number, number, number] {
  const tx = Math.min(Math.max(request.x, box.x), box.x + box.width)
  const ty = Math.min(Math.max(request.y, box.y), box.y + box.height)
  const dx = tx - request.x
  const dy = ty - request.y
  const length = Math.hypot(dx, dy) || 1
  return [request.x + (dx / length) * request.r, request.y + (dy / length) * request.r, tx, ty]
}

/** Dimmed labels first, so whatever draws in order draws them under the placed ones. */
export function placePointLabels(
  requests: readonly LabelRequest[],
  options: PlacementOptions,
): PlacedLabel[] {
  const { bounds } = options
  const height = requests.length
    ? requests.reduce((sum, r) => sum + r.height, 0) / requests.length
    : 10
  // A leader line needs a gap to be seen in; without one the label sits close.
  const pad = height * (options.leaders ? 0.6 : 0.25)
  const grid = boxGrid(Math.max(4, height * 2))
  const markBox = new Map<number, Rect>()
  for (const o of options.obstacles) {
    const box = { x: o.x - o.r, y: o.y - o.r, width: 2 * o.r, height: 2 * o.r }
    grid.add(box)
    markBox.set(o.index, box)
  }
  const inside = (box: Rect) =>
    box.x >= bounds.x &&
    box.y >= bounds.y &&
    box.x + box.width <= bounds.x + bounds.width &&
    box.y + box.height <= bounds.y + bounds.height

  // Stable: equal priorities keep the order they arrived in, so a solve is deterministic.
  const order = [...requests].sort((a, b) => a.priority - b.priority)

  const previous = new Map<number, number>()
  for (const label of options.previous ?? []) {
    if (label.slot !== undefined) previous.set(label.index, label.slot)
  }
  const placed: PlacedLabel[] = []
  const dimmed: PlacedLabel[] = []
  for (const request of order) {
    const before = previous.get(request.index)
    const tries = before === undefined ? SLOTS.keys() : [before, ...SLOTS.keys()]
    let found = false
    for (const slot of tries) {
      const box = slotBox(request, slot, pad)
      // The label's own mark is beside it by construction; anything else is a collision.
      if (!inside(box) || grid.hits(box, markBox.get(request.index))) continue
      grid.add(box)
      placed.push({
        index: request.index,
        text: request.text,
        ...box,
        slot,
        ...(options.leaders ? { line: leader(request, box) } : {}),
      })
      found = true
      break
    }
    if (!found && options.unplaced === 'dim') {
      dimmed.push({
        index: request.index,
        text: request.text,
        ...slotBox(request, 0, pad),
        dim: true,
      })
    }
  }
  return [...dimmed, ...placed]
}
