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

/**
 * The hand-placement grid: what a column of the pipeline costs, and where the first node goes.
 *
 * Not what ELK uses — it computes its own spacing. This is for the places that lay a graph out
 * *without* running a layout pass, which have to agree with each other or the same canvas ends
 * up drawn on two grids: the bundled examples, and the assistant's applier, which must stay
 * synchronous and so cannot await the engine. Here because this module already owns the
 * arithmetic about where a block of nodes sits.
 */
/*
 * How far apart a hand-placed graph puts its columns.
 *
 * 288 was 232 (the default card) plus a 56px gap, and it stopped being enough the moment a node
 * brought its own body: `NODE_BODIES` sets 360 for Find Neurons and 320 for Rename Columns, so a
 * hand-placed graph drew the next column *underneath* the previous card. Measured in a browser on
 * the first starter graph, which jsdom cannot show: Find Neurons spanned 262→542 while
 * Connectivity began at 486.
 *
 * **A constant cannot be right for every graph, so what is checked is the graphs.** Node widths
 * are declared in two places — `NodeDefinition.defaultSize`, which `resolveSize` already reads,
 * and `NODE_BODIES[type].width`, which lives in `src/ui` where this module may not look — and the
 * widest of either (`out.rois` at 620, Explore at 520) exceeds this. Those do not overlap in the
 * bundled graphs, but only because a viewer ends a chain and Explore appears in none of them,
 * which is an accident of those graphs rather than a property of this number. So
 * `placeGuards.test.ts` asserts the thing that actually matters — that no bundled graph puts one
 * card on top of another — and this figure is what makes that true today.
 *
 * The fix that would retire the guesswork is one width declaration both layers can read: folding
 * `NODE_BODIES[type].width` onto the node definition would let `place` advance by each column's
 * real widest node. That is a change to the definition shape, and is left alone here.
 */
export const COL_WIDTH = 416
export const ROW_HEIGHT = 190
/** Where the first node of a hand-placed graph lands on an empty canvas. */
export const GRID_ORIGIN = { x: 60, y: 80 } as const

/**
 * The smallest rectangle containing all of these, or undefined for none.
 *
 * Exported because three surfaces want exactly this and had each written their own `Math.min`
 * over four extents: the arrange's own bounds, a group frame's box, and the mini-map a folded
 * group draws. Four hand-rolled reductions is how one of them comes to disagree about an empty
 * set — this one answers `undefined`, which every caller has to handle anyway.
 */
export function union(rects: readonly Rect[]): Rect | undefined {
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
  const { x: dx, y: dy } = anchorDelta(positions, sizes, anchor)
  const moved = translate(positions, dx, dy)
  for (const [id, position] of moved) {
    moved.set(id, { x: Math.round(position.x), y: Math.round(position.y) })
  }
  return moved
}

/**
 * The shift `anchorTo` applies, on its own.
 *
 * Exported because an arrangement is no longer only positions: ELK's edge routes are in the
 * same coordinate space and have to travel with them, and a route that stayed at the origin
 * while its nodes moved would be a wire drawn across the canvas to nowhere. Splitting the delta
 * out is what lets both be moved by *provably* the same amount — the alternative, a second
 * translate written beside this one, is exactly how the two would come to disagree.
 */
export function anchorDelta(
  positions: ReadonlyMap<string, XY>,
  sizes: ReadonlyMap<string, NodeSize>,
  anchor: XY,
): XY {
  const bounds = union(rectsFor(positions, sizes))
  if (!bounds) return { x: 0, y: 0 }
  return { x: anchor.x - bounds.x, y: anchor.y - bounds.y }
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
  const { y } = dodgeDelta(positions, sizes, obstacles)
  return y === 0 ? new Map(positions) : translate(positions, 0, y)
}

/**
 * The shift `dodge` applies, on its own — see `anchorDelta` for why the split exists.
 *
 * Accumulated rather than returned per pass, which is safe because every pass moves in the same
 * direction: the loop only ever adds downward travel, so the sum is the same arrival the
 * iteration reaches.
 */
export function dodgeDelta(
  positions: ReadonlyMap<string, XY>,
  sizes: ReadonlyMap<string, NodeSize>,
  obstacles: readonly Rect[],
): XY {
  if (obstacles.length === 0) return { x: 0, y: 0 }
  let current = new Map(positions)
  let total = 0

  // Bounded by the obstacle count: each pass clears at least the lowest one it collided with,
  // and only ever moves down, so nothing already cleared can come back.
  for (let pass = 0; pass <= obstacles.length; pass++) {
    const bounds = union(rectsFor(current, sizes))
    if (!bounds) break
    const hit = obstacles.filter((o) => overlaps(bounds, o))
    if (hit.length === 0) break
    const lowest = Math.max(...hit.map((o) => o.y + o.height))
    const step = Math.round(lowest + DODGE_GAP - bounds.y)
    total += step
    current = translate(current, 0, step)
  }
  return { x: 0, y: total }
}

/**
 * Move a set of edge routes by the deltas `anchorDelta` and `dodgeDelta` returned.
 *
 * **Unrounded, unlike `anchorTo`.** Positions round because they are serialised into the
 * document and sub-pixel coordinates in a saved file are noise; a route is never written
 * anywhere, so rounding it buys nothing and costs accuracy at both ends — a socket sits at its
 * card's rounded position plus a *fractional* offset, so a rounded waypoint disagrees with it
 * by that fraction and the wire leaves at a slight angle before its first turn. Measured at
 * 0.39 units on a real graph: invisible, and there is no reason to introduce it.
 *
 * A residual of up to half a unit survives regardless, because the *nodes* are rounded and a
 * route spans two of them with independent roundings — no single delta makes both ends exact.
 * It costs nothing: `CodaEdge` anchors the path on React Flow's socket coordinates and lets only
 * the middle be ELK's, so a wire is attached to its sockets whatever the waypoints say.
 */
export function translateRoutes(
  routes: ReadonlyMap<string, readonly XY[]>,
  dx: number,
  dy: number,
): Map<string, XY[]> {
  const moved = new Map<string, XY[]>()
  for (const [id, points] of routes) {
    moved.set(
      id,
      points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
    )
  }
  return moved
}

/** Rectangles for every annotation node — what `dodge` has to keep off. */
export function noteRects(
  graph: CodaGraph,
  measured?: MeasuredSizes,
  hidden?: ReadonlySet<string>,
): Rect[] {
  return rectsOf(
    // A note inside a collapsed group is not on the canvas, so it is not in the way of anything.
    // Left in, it reserves a rectangle of empty space wherever its card used to be.
    graph.nodes.filter((node) => isAnnotation(node.type) && !hidden?.has(node.id)),
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
  /*
   * **Only the folded frames, and everything about them that changes the box.** A collapsed group
   * is a single node as far as the layout is concerned, so folding one, unfolding it, or changing
   * who is inside it changes the arrangement's right answer as much as adding a card does — and
   * so does promoting a param onto it, because `boxSize` makes the box wider and a row taller,
   * which is a size no `measured` entry can carry (the box is not a card in the document).
   *
   * An *expanded* frame contributes nothing, and that absence is the point: ⌘G changes no input
   * the layout has, so grouping four cards under auto mode must not re-arrange the graph — the
   * same cost this key rejects for a frame's title and colour.
   */
  const folded = (graph.groups ?? [])
    .filter((g) => g.collapsed)
    .map((g) => `${g.id}:${g.nodeIds.join('+')}:${g.exposed?.length ?? 0}`)
    .join(',')
  return `${nodes}|${edges}|${folded}`
}

/**
 * What a set of edge routes still describes.
 *
 * `structureKey` plus every node's **position**, which is the whole difference and the whole
 * point. An arrangement's positions can be edited without its structure changing — that is what
 * dragging a card is — and positions are deliberately outside `structureKey` so a drag does not
 * ask auto-layout for a new arrangement. But a route *is* a path through particular gaps between
 * particular cards, so the moment one moves the waypoints describe a picture that is no longer
 * on screen: a wire heading confidently into empty space, which reads far worse than the bezier
 * it replaced. Nothing recomputes them, because recomputing means an ELK pass per pointer move.
 *
 * So routes are held against this key and dropped the instant it stops matching, which returns
 * every wire to the curve. Same rule as `ui/viewers/layoutMemo.ts` — a settled layout is
 * returned only while it still describes the graph — and the same reason for preferring it to a
 * subscription: there is no single event meaning "the arrangement is stale", only many that are.
 */
export function routeKey(graph: CodaGraph, measured?: MeasuredSizes): string {
  const positions = graph.nodes
    .map((node) => `${node.id}@${Math.round(node.position.x)},${Math.round(node.position.y)}`)
    .join(',')
  return `${structureKey(graph, measured)}|${positions}`
}
