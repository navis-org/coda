/**
 * Where the arranged block lands. Pure arithmetic over rectangles.
 *
 * ELK answers "what shape is this graph"; it has no idea what else is on the canvas or where
 * the user was looking. That is this file's job: keep the result anchored where the work
 * already was, keep it off the text notes, and decide when auto mode should ask for a new one.
 */

import type { CodaGraph, GraphNode } from '../core/graph'
import { isAnnotation } from '../core/registry'
import type { MeasuredSizes, NodeSize } from './elkGraph'
import { resolveSize } from './elkGraph'

export interface XY {
  x: number
  y: number
}

export interface Rect extends XY {
  width: number
  height: number
}

/** Gap left between the arranged block and a note it had to dodge. */
export const DODGE_GAP = 48

function union(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

/** Where the given nodes currently sit, as rectangles. */
export function rectsOf(nodes: readonly GraphNode[], measured?: MeasuredSizes): Rect[] {
  return nodes.map((node) => {
    const size = resolveSize(node, measured)
    return { x: node.position.x, y: node.position.y, ...size }
  })
}

export function boundsOf(
  nodes: readonly GraphNode[],
  measured?: MeasuredSizes,
): Rect | undefined {
  return union(rectsOf(nodes, measured))
}

function rectsFor(
  positions: ReadonlyMap<string, XY>,
  sizes: ReadonlyMap<string, NodeSize>,
): Rect[] {
  const rects: Rect[] = []
  for (const [id, position] of positions) {
    const size = sizes.get(id)
    if (size) rects.push({ ...position, ...size })
  }
  return rects
}

function translate(
  positions: ReadonlyMap<string, XY>,
  dx: number,
  dy: number,
): Map<string, XY> {
  const moved = new Map<string, XY>()
  for (const [id, position] of positions)
    moved.set(id, { x: position.x + dx, y: position.y + dy })
  return moved
}

/**
 * Put the arranged block's top-left where the arranged set's top-left already was.
 *
 * ELK lays out from the origin, so without this every arrange would teleport the graph to
 * wherever (0,0) happens to be on screen — which, on a canvas panned away from it, reads as the
 * graph having been deleted. Rounded, because positions are serialised into the document and
 * sub-pixel coordinates in a saved file are noise nobody asked for.
 */
export function anchorTo(
  positions: ReadonlyMap<string, XY>,
  sizes: ReadonlyMap<string, NodeSize>,
  anchor: XY,
): Map<string, XY> {
  const bounds = union(rectsFor(positions, sizes))
  if (!bounds) return new Map(positions)
  const moved = translate(positions, anchor.x - bounds.x, anchor.y - bounds.y)
  for (const [id, position] of moved) {
    moved.set(id, { x: Math.round(position.x), y: Math.round(position.y) })
  }
  return moved
}

/**
 * Push the block clear of the text notes, downwards only.
 *
 * Notes never move — a note is somebody's sentence about a particular step, and relocating it
 * would break the thing it was written for. So the pipeline gives way instead.
 *
 * Downwards and not sideways because the flow is horizontal: the bundled examples place their
 * notes by *column*, above and below the chain, so a sideways shift would slide every note out
 * from over the step it describes while a vertical one keeps the correspondence.
 *
 * Resolved against each note in turn rather than against one union rectangle. An example with a
 * note above the chain and another below has a union spanning the whole canvas, and clearing
 * *that* would fling the graph hundreds of units down past empty space it never touched.
 */
export function dodge(
  positions: ReadonlyMap<string, XY>,
  sizes: ReadonlyMap<string, NodeSize>,
  obstacles: readonly Rect[],
): Map<string, XY> {
  let current = new Map(positions)
  if (obstacles.length === 0) return current

  // Bounded by the obstacle count: each pass clears at least the lowest one it collided with,
  // and only ever moves down, so nothing already cleared can come back.
  for (let pass = 0; pass <= obstacles.length; pass++) {
    const bounds = union(rectsFor(current, sizes))
    if (!bounds) return current
    const hit = obstacles.filter((o) => overlaps(bounds, o))
    if (hit.length === 0) return current
    const lowest = Math.max(...hit.map((o) => o.y + o.height))
    current = translate(current, 0, Math.round(lowest + DODGE_GAP - bounds.y))
  }
  return current
}

/** Rectangles for every annotation node — what `dodge` has to keep off. */
export function noteRects(graph: CodaGraph, measured?: MeasuredSizes): Rect[] {
  return rectsOf(
    graph.nodes.filter((node) => isAnnotation(node.type)),
    measured,
  )
}

/**
 * What auto mode watches.
 *
 * Node identity, type, collapse and *rendered size*, plus every edge's four endpoints. Not
 * positions and not params: an arrangement is a function of the boxes and the wires, so this is
 * exactly the set of things that can make the current one wrong.
 *
 * Params are the interesting omission. Editing one can change a card's height, which does change
 * the right answer — but only via the measured size, which is in here. So a param edit that
 * resizes a card still triggers and one that does not still costs nothing: "structural changes
 * only" arrived at through the measurement rather than through a hand-kept list of which params
 * are allowed to matter.
 */
export function structureKey(graph: CodaGraph, measured?: MeasuredSizes): string {
  const nodes = graph.nodes
    .map((node) => {
      const size = resolveSize(node, measured)
      return `${node.id}:${node.type}:${node.collapsed ? 1 : 0}:${size.width}x${size.height}`
    })
    .join(',')
  const edges = graph.edges
    .map((e) => `${e.source}.${e.sourceHandle}->${e.target}.${e.targetHandle}`)
    .join(',')
  return `${nodes}|${edges}`
}
