/**
 * Where the boxes and the arrows of a flow chart go.
 *
 * Pure over the box sizes handed in — `mapLayout.ts`' arrangement and for its reason: jsdom lays
 * nothing out, so a layout left inside a component is covered by nothing, and a layout that
 * measures its own text can only be exercised in a browser. The viewer measures; this places.
 *
 * ## Why this is not ELK
 *
 * `layout/network.ts` already runs ELK layered over a `NetworkValue`, and `Paths` emits the
 * result of one. This does not use it, for four reasons that are each about this drawing rather
 * than about ELK:
 *
 *  - **The layering is already decided.** `flowChartOps.flowGraph` assigns it, from a column
 *    where one is picked. ELK layered assigns its own, and there is no way to hand it one —
 *    `elk.partitioning` *ignores* a column assignment fed back to it, which
 *    `docs/canvas.md` records from a sweep. Two layerers on one picture is one of them being
 *    silently overruled.
 *  - **Back edges have to keep their direction.** ELK breaks cycles by reversing edges
 *    internally and hands back a route for the reversed one, so a recurrent connection comes
 *    out indistinguishable from a feed-forward one. Telling feedback apart is most of what
 *    makes this node usable on a `Connectivity` fan rather than only on a `Paths` result.
 *  - **The box sizes are text**, so the layout cannot run until the labels are measured — which
 *    means it runs inside the viewer, where ELK's worker round trip buys nothing: this is a
 *    picture bounded at `FLOW_NODES_WARN` boxes, and the whole pass below is microseconds.
 *  - **Synchronous is worth a lot here.** Every other layout in the app is async and each one
 *    pays for it in a settle-on-mount effect and a frame of the wrong picture. At this size the
 *    layout can just be part of the render.
 *
 * What is *not* re-derived is the algorithm. This is ordinary Sugiyama with the layering step
 * removed: dummy nodes for edges that span more than one layer, barycentre sweeps to order
 * within a layer, then coordinates. The dummies are the load-bearing part and the thing a
 * hand-rolled layered drawing usually leaves out — without them a skip-layer arrow runs
 * straight through whatever boxes are between its ends, which is the single most obvious defect
 * in drawing a connectome this way. With them the arrow gets a corridor that the ordering step
 * keeps clear, because the corridor is a node as far as the ordering is concerned.
 *
 * ## One layout, two orientations
 *
 * Everything below is in **along/across** space — `along` runs in the flow direction and
 * `across` is the stacking axis — and the projection to `x`/`y` happens once at the end.
 * `dendrogramLayout.ts`' arrangement, for its reason: two orientations computed separately are
 * two pictures that can disagree. The one asymmetry is real and is not a projection: a box's
 * extent along the flow is its text *width* left-to-right and its text *height* top-to-bottom,
 * because text does not rotate with the diagram.
 */

import type { XY } from '../../layout/place'
import { roundedPath } from '../edgeRoute'
import { barycentreOrder } from './barycentre'
import type { FlowEdgeKind, FlowGraph } from '../../nodes/lib/flowChartOps'

export type FlowDirection = 'lr' | 'tb'

/*
 * The router takes `FlowDirection` directly, and there is deliberately no second `'x' | 'y'`
 * spelling of it: the rest of this module already branches on `direction === 'lr'` (`project`,
 * `buildSlots`), and an alias meant two names for one control threaded through six signatures
 * and two memoised prop lists. What the router genuinely cannot do is *derive* the axis from two
 * points — a steep connection's cross-axis span exceeds its flow-axis span, which is the case
 * that goes wrong — so it stays an argument.
 */

/** How the polyline between two boxes is drawn. See the node's `Arrows` control. */
export type FlowRouting = 'orthogonal' | 'curved' | 'straight'

/*
 * `layout/place.ts`' point, not a second declaration of it. `roundedPath` — which `drawn` calls —
 * already types its points as that one, so the two were being fed to each other and only passed
 * because they are structurally identical; a `z` on either side would have broken it silently.
 */
export type { XY }

/** What a box needs to hold its label. Measured by the caller. */
export interface BoxSize {
  width: number
  height: number
}

export interface FlowBox {
  id: string
  label: string
  layer: number
  /** Centre. */
  x: number
  y: number
  width: number
  height: number
  /** Row in the network's node attribute table, or `-1` for a folded box. */
  row: number
  folded: readonly string[]
}

export interface FlowArrow {
  /**
   * Index into `graph.edges` — unique per arrow, which is what a renderer keys on.
   *
   * Not the route to the edge's attributes: `row` below is, because a merged arrow has no single
   * edge to point at. This is an identity and nothing more.
   */
  edge: number
  /**
   * Row in the network's edge attribute table, or `-1` where the edge was merged by a fold.
   *
   * Carried through rather than left to the caller to look up, so a renderer needs the shape and
   * not also the graph it came from — which is what keeps the arrow label, the tooltip and the
   * SVG export reading one object.
   */
  row: number
  source: string
  target: string
  kind: FlowEdgeKind
  /**
   * The route, from a point on the source box's border to one on the target's.
   *
   * Always at least two points, and in the edge's **own** direction — a `back` edge is laid out
   * reversed and flipped back here, so the last point is always where the arrowhead goes.
   */
  points: readonly XY[]
  weight: number | null
  merged: number
}

export interface FlowChartShape {
  boxes: readonly FlowBox[]
  arrows: readonly FlowArrow[]
  /** Extent of everything, with the origin at the top-left of the drawing. */
  width: number
  height: number
}

export interface FlowLayoutOptions {
  direction: FlowDirection
  /** Box extents by node id. A node with no entry gets `FALLBACK_BOX`. */
  sizes: ReadonlyMap<string, BoxSize>
  /** Gap between one layer band and the next, along the flow. */
  layerGap?: number
  /** Gap between two boxes in one layer, across the flow. */
  nodeGap?: number
}

/** What a box with no measurement gets. Only reachable if the caller forgot one. */
const FALLBACK_BOX: BoxSize = { width: 80, height: 28 }

const DEFAULT_LAYER_GAP = 72
const DEFAULT_NODE_GAP = 16

/**
 * The across-extent a routing corridor takes up.
 *
 * Not zero, which is the whole point of the dummies: a corridor of no width lets the barycentre
 * step put two boxes flush together with an arrow threading between them. Small enough that a
 * layer full of corridors does not dwarf the layer beside it.
 */
const CORRIDOR = 10

/** How far a same-layer arrow bulges out past the boxes it joins. */
const WITHIN_BULGE = 22

/** The loop an autapse draws, off the box's leading corner. */
const SELF_LOOP = 14

// ---------------------------------------------------------------------------
// The ordering graph: real boxes plus one corridor per skipped layer
// ---------------------------------------------------------------------------

interface Slot {
  /** Node id for a real box, or `undefined` for a corridor. */
  id: string | undefined
  layer: number
  /** Extent across the flow. */
  across: number
  /** Extent along the flow; zero for a corridor, which sits in the gap. */
  along: number
  /** Assigned in `placeSlots`: centre across the flow. */
  at: number
}

/** A laid-out edge: the slots its route passes through, and whether it was reversed. */
interface Chain {
  edge: number
  slots: number[]
  reversed: boolean
}

/**
 * Build the slot graph.
 *
 * Two things happen here and both are about keeping the *ordering* honest. A `back` edge is
 * **reversed** so that it constrains the ordering in the direction it is actually drawn between
 * layers — an unreversed back edge would pull its endpoints apart rather than together. And an
 * edge spanning more than one layer gets a corridor in each layer it crosses, which is what
 * gives it somewhere to go.
 *
 * `within` and `self` edges get no slots: they are drawn from their endpoints' final positions
 * and constrain nothing, a same-layer pair having no cross-layer relationship to express.
 */
function buildSlots(
  graph: FlowGraph,
  sizes: FlowLayoutOptions['sizes'],
  direction: FlowDirection,
) {
  const slots: Slot[] = []
  const slotOf = new Map<string, number>()

  for (const node of graph.nodes) {
    const size = sizes.get(node.id) ?? FALLBACK_BOX
    // The one place the two orientations genuinely differ: text does not rotate, so which of
    // its two extents runs along the flow depends on the direction.
    const along = direction === 'lr' ? size.width : size.height
    const across = direction === 'lr' ? size.height : size.width
    slotOf.set(node.id, slots.length)
    slots.push({ id: node.id, layer: node.layer, across, along, at: 0 })
  }

  const chains: Chain[] = []
  for (let e = 0; e < graph.edges.length; e++) {
    const edge = graph.edges[e]!
    if (edge.kind === 'within' || edge.kind === 'self') continue
    const reversed = edge.kind === 'back'
    const fromId = reversed ? edge.target : edge.source
    const toId = reversed ? edge.source : edge.target
    const from = slotOf.get(fromId)
    const to = slotOf.get(toId)
    if (from === undefined || to === undefined) continue
    const fromLayer = slots[from]!.layer
    const toLayer = slots[to]!.layer
    const chain = [from]
    for (let layer = fromLayer + 1; layer < toLayer; layer++) {
      chain.push(slots.length)
      slots.push({ id: undefined, layer, across: CORRIDOR, along: 0, at: 0 })
    }
    chain.push(to)
    chains.push({ edge: e, slots: chain, reversed })
  }

  return { slots, slotOf, chains }
}

/**
 * Order the slots within each layer, so the chains between layers cross as little as possible.
 *
 * The sweep itself is `barycentre.ts`', shared with the Sankey — an ordering rule written twice
 * is an ordering rule that drifts, and the two viewers would still be expected to put the same
 * graph in the same order. What stays here is the part that is about *this* graph: turning
 * chains into the weighted neighbour lists the sweep reads.
 *
 * **Weighted by the edge's weight**, unlike the network viewer's version: the strongest
 * connection is the one a reader traces, so it is the one worth drawing straight. A null weight
 * counts as 1 rather than as 0 — see the shared module for why that is not a detail.
 */
function orderSlots(
  slots: Slot[],
  chains: readonly Chain[],
  graph: FlowGraph,
  byLayer: ReadonlyMap<number, number[]>,
  layers: readonly number[],
): void {
  /** Neighbours across a layer boundary, with a pull. Corridors included. */
  const up: Array<Array<[number, number]>> = slots.map(() => [])
  const down: Array<Array<[number, number]>> = slots.map(() => [])
  for (const chain of chains) {
    const pull = Math.max(1, Math.abs(graph.edges[chain.edge]!.weight ?? 1))
    for (let i = 0; i + 1 < chain.slots.length; i++) {
      const a = chain.slots[i]!
      const b = chain.slots[i + 1]!
      down[a]!.push([b, pull])
      up[b]!.push([a, pull])
    }
  }

  barycentreOrder({ buckets: byLayer, layers, up, down, count: slots.length })
}

/** Stack each layer's slots across the flow, every layer centred on one midline. */
function placeSlots(
  slots: Slot[],
  byLayer: ReadonlyMap<number, number[]>,
  nodeGap: number,
): void {
  let widest = 0
  const extents = new Map<number, number>()
  for (const [layer, members] of byLayer) {
    let extent = 0
    for (const slot of members) extent += slots[slot]!.across
    extent += Math.max(0, members.length - 1) * nodeGap
    extents.set(layer, extent)
    if (extent > widest) widest = extent
  }
  for (const [layer, members] of byLayer) {
    // Centred rather than top-aligned: a chain of two boxes beside a layer of nine reads as a
    // chain through the middle of them, which is the shape the circuit actually has.
    let at = (widest - extents.get(layer)!) / 2
    for (const slot of members) {
      const size = slots[slot]!
      size.at = at + size.across / 2
      at += size.across + nodeGap
    }
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Spread the points where several arrows meet one box along its border.
 *
 * Without this every arrow at a hub leaves and arrives at the box's midpoint, so ten
 * connections overlap into one thick line and the arrowheads pile up on each other. Each side
 * of each box is handed its arrows sorted by where they are going, which is also what stops
 * them crossing each other in the gap.
 */
function fanPorts(toward: readonly number[], centre: number, extent: number): number[] {
  const n = toward.length
  if (n === 0) return []
  if (n === 1) return [centre]
  // Inset so the outermost port is not exactly on the box's corner, where an arrowhead would
  // read as attached to the border rather than to the box.
  const span = Math.max(0, extent - 6)
  const order = toward.map((at, i) => ({ i, at })).sort((a, b) => a.at - b.at || a.i - b.i)
  const out = new Array<number>(n)
  order.forEach((entry, rank) => {
    out[entry.i] = centre - span / 2 + (span * (rank + 0.5)) / n
  })
  return out
}

interface Placed {
  /** Centre along the flow. */
  along: number
  /** Centre across the flow. */
  across: number
  alongExtent: number
  acrossExtent: number
}

/** Project along/across back into screen space. */
function project(direction: FlowDirection, along: number, across: number): XY {
  return direction === 'lr' ? { x: along, y: across } : { x: across, y: along }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export function flowChartShape(graph: FlowGraph, options: FlowLayoutOptions): FlowChartShape {
  const { direction } = options
  const layerGap = options.layerGap ?? DEFAULT_LAYER_GAP
  const nodeGap = options.nodeGap ?? DEFAULT_NODE_GAP

  if (graph.nodes.length === 0) {
    return { boxes: [], arrows: [], width: 0, height: 0 }
  }

  const { slots, slotOf, chains } = buildSlots(graph, options.sizes, direction)

  const byLayer = new Map<number, number[]>()
  for (let i = 0; i < slots.length; i++) {
    const layer = slots[i]!.layer
    const bucket = byLayer.get(layer)
    if (bucket) bucket.push(i)
    else byLayer.set(layer, [i])
  }

  // Sorted once and handed down: `orderSlots` needs the same list, and two sorts of one Map's
  // keys is where two orderings come from.
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  orderSlots(slots, chains, graph, byLayer, layers)
  placeSlots(slots, byLayer, nodeGap)

  // Layer bands along the flow: each as deep as its deepest box, gap between.
  const bandOf = new Map<number, { start: number; end: number }>()
  let cursor = 0
  for (const layer of layers) {
    let depth = 0
    for (const slot of byLayer.get(layer)!) {
      const along = slots[slot]!.along
      if (along > depth) depth = along
    }
    bandOf.set(layer, { start: cursor, end: cursor + depth })
    cursor += depth + layerGap
  }

  const placed = new Map<string, Placed>()
  const boxes: FlowBox[] = []
  for (const node of graph.nodes) {
    const slot = slots[slotOf.get(node.id)!]!
    const band = bandOf.get(node.layer)!
    // Centred in its band, so a short box in a layer holding a tall one sits on the band's
    // midline rather than on its leading edge. What that buys is that an arrow between two
    // boxes of different heights leaves and arrives level.
    const along = (band.start + band.end) / 2
    const point = project(direction, along, slot.at)
    const width = direction === 'lr' ? slot.along : slot.across
    const height = direction === 'lr' ? slot.across : slot.along
    placed.set(node.id, {
      along,
      across: slot.at,
      alongExtent: slot.along,
      acrossExtent: slot.across,
    })
    boxes.push({
      id: node.id,
      label: node.label,
      layer: node.layer,
      x: point.x,
      y: point.y,
      width,
      height,
      row: node.row,
      folded: node.folded,
    })
  }

  // ---- Ports -------------------------------------------------------------
  //
  // Each box's leading and trailing faces, with the arrows that use them sorted by where they
  // are heading. Corridors are not fanned: an arrow through one passes through its centre,
  // which is exactly the corridor's job.

  /*
   * Which chains meet each box's two faces, as indices into `chains`.
   *
   * Indices rather than a record per chain: `chains` already holds everything a route needs, so
   * a parallel array was a third structure whose alignment with the fan results a reader had to
   * prove before trusting them. `toward` is the across-position of the next (or previous) slot,
   * which is only ever the sort key for the fan.
   */
  const trailing = new Map<string, Array<{ at: number; toward: number }>>()
  const leading = new Map<string, Array<{ at: number; toward: number }>>()

  chains.forEach((chain, at) => {
    const fromId = slots[chain.slots[0]!]!.id!
    const toId = slots[chain.slots[chain.slots.length - 1]!]!.id!
    const next = slots[chain.slots[1]!]!
    const previous = slots[chain.slots[chain.slots.length - 2]!]!
    const t = trailing.get(fromId) ?? []
    t.push({ at, toward: next.at })
    trailing.set(fromId, t)
    const l = leading.get(toId) ?? []
    l.push({ at, toward: previous.at })
    leading.set(toId, l)
  })

  // Dense over `chains`, so an array rather than a Map.
  const exitAt = new Array<number | undefined>(chains.length)
  const enterAt = new Array<number | undefined>(chains.length)
  const fan = (
    keys: ReadonlyArray<{ at: number; toward: number }>,
    id: string,
    into: Array<number | undefined>,
  ) => {
    const box = placed.get(id)!
    const ports = fanPorts(
      keys.map((key) => key.toward),
      box.across,
      box.acrossExtent,
    )
    keys.forEach((key, i) => (into[key.at] = ports[i]))
  }
  for (const [id, keys] of trailing) fan(keys, id, exitAt)
  for (const [id, keys] of leading) fan(keys, id, enterAt)

  // ---- Routes ------------------------------------------------------------

  const arrows: FlowArrow[] = []

  chains.forEach((chain, i) => {
    const edge = graph.edges[chain.edge]!
    const fromSlot = slots[chain.slots[0]!]!
    const toSlot = slots[chain.slots[chain.slots.length - 1]!]!

    /*
     * The two ends are the **boxes'** own faces, never their layer bands'.
     *
     * A band is as deep as the deepest box in its layer and every box is centred in it, so a box
     * narrower than its widest neighbour sits inset from both band edges. Ending a route at the
     * band leaves the arrowhead floating in the gap — about 40px on the demo graph, where
     * `AOTU008` sets its layer's depth and `Mi1` shares it. Invisible while every box is the same
     * width, which is every fixture, and invisible to the browser probe as well: an arrow that
     * stops short passes "no arrow passes through a box" more comfortably than one that arrives.
     * It took looking at the picture.
     *
     * The corridor points below stay on their band edges, which is right — a corridor has no
     * extent along the flow and *is* the layer as far as the route is concerned.
     */
    const fromBox = placed.get(fromSlot.id!)!
    const toBox = placed.get(toSlot.id!)!
    const fromFace = fromBox.along + fromBox.alongExtent / 2
    const toFace = toBox.along - toBox.alongExtent / 2

    const points: Array<{ along: number; across: number }> = []
    points.push({ along: fromFace, across: exitAt[i] ?? fromSlot.at })
    for (let k = 1; k < chain.slots.length - 1; k++) {
      const corridor = slots[chain.slots[k]!]!
      const band = bandOf.get(corridor.layer)!
      // Two points per corridor, at its band's two faces, so the polyline runs *through* the
      // layer rather than cornering inside it. One point makes a skip-layer arrow kink at every
      // layer it crosses, which reads as a series of bends nobody put there.
      points.push({ along: band.start, across: corridor.at })
      points.push({ along: band.end, across: corridor.at })
    }
    points.push({ along: toFace, across: enterAt[i] ?? toSlot.at })

    const projected = points.map((point) => project(direction, point.along, point.across))
    arrows.push({
      edge: chain.edge,
      row: edge.row,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      // A `back` edge was laid out from its target to its source, so the route is reversed to
      // put the arrowhead on the end the connection actually points at.
      points: chain.reversed ? projected.reverse() : projected,
      weight: edge.weight,
      merged: edge.merged,
    })
  })

  // Same-layer and self edges, drawn from the final positions.
  for (let e = 0; e < graph.edges.length; e++) {
    const edge = graph.edges[e]!
    if (edge.kind !== 'within' && edge.kind !== 'self') continue
    const from = placed.get(edge.source)
    const to = placed.get(edge.target)
    if (!from || !to) continue

    if (edge.kind === 'self') {
      // A loop off the trailing face, out and back. Four points, so every routing style has
      // something to bend through.
      const face = from.along + from.alongExtent / 2
      const side = from.across - from.acrossExtent / 2
      arrows.push({
        edge: e,
        row: edge.row,
        source: edge.source,
        target: edge.target,
        kind: 'self',
        points: [
          project(direction, face, from.across),
          project(direction, face + SELF_LOOP, from.across),
          project(direction, face + SELF_LOOP, side - SELF_LOOP),
          project(direction, from.along, side),
        ],
        weight: edge.weight,
        merged: edge.merged,
      })
      continue
    }

    // Within a layer: out of the trailing face of one, round, into the trailing face of the
    // other. Bulging off the *flow* axis rather than across it, so it cannot be mistaken for a
    // connection to the next layer.
    const bulge = Math.max(from.alongExtent, to.alongExtent) / 2 + WITHIN_BULGE
    const along = Math.max(from.along, to.along)
    arrows.push({
      edge: e,
      row: edge.row,
      source: edge.source,
      target: edge.target,
      kind: 'within',
      points: [
        project(direction, from.along + from.alongExtent / 2, from.across),
        project(direction, along + bulge, from.across),
        project(direction, along + bulge, to.across),
        project(direction, to.along + to.alongExtent / 2, to.across),
      ],
      weight: edge.weight,
      merged: edge.merged,
    })
  }

  return { boxes, arrows, ...shiftToOrigin(boxes, arrows) }
}

/**
 * Measure the drawing and move it to the origin, in place.
 *
 * Over the boxes **and** the routes: a within-layer bulge and a self loop both stick out past
 * every box, so a fit computed from the boxes alone clips them.
 *
 * In place on both: every one of these objects was allocated by the pass above and is shared
 * with nothing. Rebuilding the arrows — which is what this did — allocated a fresh object per
 * arrow and per point to move numbers nobody else can see, and left a reader to work out why one
 * half was safe to mutate and the other was not.
 *
 * Its own function because it shares no state with the pass: two arrays in, an extent out. That
 * makes it the one phase of `flowChartShape` whose extraction costs no parameters.
 */
function shiftToOrigin(
  boxes: readonly FlowBox[],
  arrows: readonly FlowArrow[],
): { width: number; height: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const box of boxes) {
    grow(box.x - box.width / 2, box.y - box.height / 2)
    grow(box.x + box.width / 2, box.y + box.height / 2)
  }
  for (const arrow of arrows) for (const point of arrow.points) grow(point.x, point.y)

  for (const box of boxes as FlowBox[]) {
    box.x -= minX
    box.y -= minY
  }
  for (const arrow of arrows) {
    for (const point of arrow.points as XY[]) {
      point.x -= minX
      point.y -= minY
    }
  }
  return { width: maxX - minX, height: maxY - minY }
}

// ---------------------------------------------------------------------------
// Turning a route into an SVG path
// ---------------------------------------------------------------------------

/** Corner radius on an orthogonal route. `roundedPath` clamps it per corner. */
const CORNER = 8

/**
 * The two control points of one curved segment, with tangents along its dominant axis.
 *
 * Exported-adjacent rather than inline because `arrowHead` needs the second of them: a curve
 * arrives at its endpoint along `c2 → b`, and a head aimed down the straight line `a → b`
 * instead points visibly off the stroke it terminates.
 */
function curveControls(a: XY, b: XY, flow: FlowDirection): [XY, XY] {
  // Along the **flow** axis, the same one `orthogonalCorners` turns on — which is what makes the
  // two routings bend in the same places and differ only in how sharply. Taken from whichever
  // axis happened to be longer, a steep connection left and arrived across the flow while its
  // right-angled twin left and arrived along it.
  if (flow === 'lr') {
    const dx = (b.x - a.x) / 2
    return [
      { x: a.x + dx, y: a.y },
      { x: b.x - dx, y: b.y },
    ]
  }
  const dy = (b.y - a.y) / 2
  return [
    { x: a.x, y: a.y + dy },
    { x: b.x, y: b.y - dy },
  ]
}

/**
 * A polyline with the right-angle legs inserted, so no segment runs diagonally.
 *
 * Its own exported function rather than a step inside `routePath`, because the property worth
 * pinning is about the *polyline* — every consecutive pair shares an axis — and asserting that
 * by re-parsing a `d` string means re-implementing an SVG path reader in the test, which is how
 * a test ends up passing for the wrong reason. Found exactly that way: the first version of the
 * check read the points either side of a rounded corner and reported a diagonal that is not in
 * the picture.
 */
export function orthogonalCorners(points: readonly XY[], flow: FlowDirection): XY[] {
  if (points.length === 0) return []
  const corners: XY[] = [points[0]!]
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    if (a.x !== b.x && a.y !== b.y) {
      /*
       * The bend goes half way along the **flow** axis, always — which is the inter-layer gap,
       * because consecutive route points are a box face and the next band's face.
       *
       * It used to turn on whichever axis was *longer*, so a steep connection turned early and
       * ran its long leg along the source box's own face — grazing every box below it in that
       * column. Measured in a browser at 3.4px into `T5d`'s border on the demo graph. The
       * dominant-axis rule reads as the natural one and is wrong here for the reason a flow
       * chart exists: the free space is between the layers, and only the flow axis says where
       * that is.
       */
      const mid = flow === 'lr' ? (a.x + b.x) / 2 : (a.y + b.y) / 2
      if (flow === 'lr') corners.push({ x: mid, y: a.y }, { x: mid, y: b.y })
      else corners.push({ x: a.x, y: mid }, { x: b.x, y: mid })
    }
    corners.push(b)
  }
  return corners
}

/**
 * The `d` of a route.
 *
 * Three styles over one polyline, which is why the routing choice costs nothing in the layout:
 * the corridor points are the same either way, and what differs is only how consecutive ones are
 * joined. `straight` drops the interior points entirely rather than joining them, which is what
 * makes it the Network Viewer's picture — an arrow between the two boxes and no claim about what
 * it passes.
 */
export function routePath(
  points: readonly XY[],
  routing: FlowRouting,
  flow: FlowDirection,
): string {
  return drawn(points, routing, flow).d
}

/**
 * What a routing actually draws: the path string, and the polyline a length can be walked along.
 *
 * **One walk per route, because four things read it.** The stroke needs the `d`, the hit area
 * needs the same `d`, the arrowhead needs the final tangent and the weight label needs the
 * halfway mark — and asked separately each of those rebuilt the geometry from the waypoints, so
 * an orthogonal arrow ran `orthogonalCorners` three times and a labelled one four. At the sizes
 * this draws (boxes are capped, arrows are not — a 600-box connectivity subgraph carries tens of
 * thousands of edges) that was thousands of corner arrays and path strings per render.
 *
 * `flat` is the *measurable* polyline and is not always what is stroked: a curve is stroked as
 * cubics and flattened into `CURVE_STEPS` chords a segment, since arc length along a cubic has no
 * closed form and at this size a sampled midpoint is within a pixel of the true one.
 */
function drawn(
  points: readonly XY[],
  routing: FlowRouting,
  flow: FlowDirection,
): { d: string; flat: XY[] } {
  if (points.length === 0) return { d: '', flat: [] }
  const first = points[0]!
  if (points.length === 1) return { d: `M${first.x} ${first.y}`, flat: [first] }

  if (routing === 'straight') {
    const last = points[points.length - 1]!
    return { d: `M${first.x} ${first.y}L${last.x} ${last.y}`, flat: [first, last] }
  }

  if (routing === 'curved') {
    /*
     * A cubic per segment with its tangents along the segment's flow axis — the same axis
     * `orthogonalCorners` turns on, so the two routings bend in the same places and differ only
     * in how sharply.
     *
     * **Not Catmull-Rom**, which is what this was and which drew nothing: with two points — every
     * arrow between adjacent layers, i.e. most of them — that spline's control points land
     * exactly on the straight line between them, so "curves" was a picture of straight lines.
     * Its stated virtue, passing *through* each corridor point, is kept here by construction:
     * each segment starts and ends on its own two points.
     *
     * A segment whose ends already share the cross axis stays straight, which is right: a
     * horizontal arrow is a horizontal arrow.
     */
    let d = `M${first.x} ${first.y}`
    const flat: XY[] = [first]
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!
      const b = points[i + 1]!
      const [c1, c2] = curveControls(a, b, flow)
      d += `C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`
      for (let step = 1; step <= CURVE_STEPS; step++) {
        flat.push(cubicAt(a, c1, c2, b, step / CURVE_STEPS))
      }
    }
    return { d, flat }
  }

  // `roundedPath` is the canvas wire builder, and the fillet rule is the same one: clamp the
  // radius to half of each adjacent leg, drop to a plain corner below half a unit. Its header
  // carries the incident that rule comes from — ELK bends ten units apart, where an unclamped
  // fillet on both ends eats the whole segment and the wire visibly doubles back — which is
  // exactly the case a corridor between two close boxes produces here.
  const corners = orthogonalCorners(points, flow)
  return { d: roundedPath(corners, CORNER), flat: corners }
}

/** How finely a curved segment is chopped up when its length has to be measured. */
const CURVE_STEPS = 8

/** One point on a cubic. */
function cubicAt(a: XY, c1: XY, c2: XY, b: XY, t: number): XY {
  const u = 1 - t
  const w0 = u * u * u
  const w1 = 3 * u * u * t
  const w2 = 3 * u * t * t
  const w3 = t * t * t
  return {
    x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
    y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y,
  }
}

export interface RouteGeometry {
  /** The stroke, and the hit area laid over it. */
  d: string
  /** Where the arrowhead sits and which way it points; absent for a degenerate route. */
  head: { at: XY; angle: number } | undefined
  /** Halfway along the drawn stroke, for the weight label. */
  mid: XY | undefined
}

/** Everything a renderer needs for one arrow, off a single walk of its route. */
export function routeGeometry(
  points: readonly XY[],
  routing: FlowRouting,
  flow: FlowDirection,
): RouteGeometry {
  const { d, flat } = drawn(points, routing, flow)
  return { d, head: routeArrowHead(points, routing, flow), mid: midpointOf(flat) }
}

/**
 * Where an arrowhead sits and which way it points.
 *
 * Read from the route's last two points rather than from the two boxes, because those differ on
 * every route with a corridor in it — an arrow entering a box from a corridor arrives along the
 * flow, and one pointing at the box centre would sit at an angle to the line it terminates.
 *
 * **`routing` is what makes that true of the stroke rather than of the waypoints**, and leaving
 * it out was visible on every bend: `orthogonal` draws `orthogonalCorners(points)`, whose last
 * leg is axis-aligned, where the raw polyline's last leg is the diagonal that leg replaced — so
 * the head sat at an angle to the line it ends, pointing past its own box. `curved` arrives
 * along `c2 → b`, not along `a → b`.
 */
export function routeArrowHead(
  points: readonly XY[],
  routing: FlowRouting,
  flow: FlowDirection,
): { at: XY; angle: number } | undefined {
  /*
   * The curved arm stays analytic while the other two read the drawn polyline, and that is
   * measured rather than stylistic: `curveControls` puts `c2` on the flow axis through `b`, so
   * the exact tangent at the end is axis-aligned where the last *chord* of the sampled polyline
   * is not. On a 100x50 segment at `CURVE_STEPS = 8` that chord heads 7.4 degrees off — inside
   * `probe-flowchart-draw.mjs`' 8-degree tolerance, so collapsing all three arms would leave
   * every curved arrowhead one degree from failing its own check.
   */
  if (routing === 'curved') {
    const b = points[points.length - 1]
    const a = points[points.length - 2]
    if (!a || !b) return undefined
    return headOf([curveControls(a, b, flow)[1], b])
  }
  return headOf(drawn(points, routing, flow).flat)
}

function headOf(points: readonly XY[]): { at: XY; angle: number } | undefined {
  if (points.length < 2) return undefined
  const at = points[points.length - 1]!
  // The last point *distinct* from the tip: a zero-length final leg has no direction, and a
  // route whose last two points coincide is what a same-layer pair of touching boxes produces.
  for (let i = points.length - 2; i >= 0; i--) {
    const from = points[i]!
    const dx = at.x - from.x
    const dy = at.y - from.y
    if (Math.hypot(dx, dy) > 0.01) {
      return { at, angle: Math.atan2(dy, dx) }
    }
  }
  return undefined
}

/**
 * Midpoint of a route, for the weight label.
 *
 * **Of the stroke that is drawn, not of the waypoints** — which is why it takes the routing.
 * `orthogonal` replaces every diagonal with two axis-aligned legs and `straight` drops the
 * corridors entirely, so the three routings put their halfway marks in three different places
 * over one set of points. Read from the waypoints the labels did not move at all when the
 * control changed, which is what it was reported as.
 *
 */
export function routeMidpoint(
  points: readonly XY[],
  routing: FlowRouting,
  flow: FlowDirection,
): XY | undefined {
  return midpointOf(drawn(points, routing, flow).flat)
}

function midpointOf(points: readonly XY[]): XY | undefined {
  if (points.length === 0) return undefined
  if (points.length === 1) return points[0]!
  let total = 0
  for (let i = 0; i + 1 < points.length; i++) {
    total += Math.hypot(points[i + 1]!.x - points[i]!.x, points[i + 1]!.y - points[i]!.y)
  }
  let walked = 0
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (walked + length >= total / 2) {
      const t = length === 0 ? 0 : (total / 2 - walked) / length
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    walked += length
  }
  return points[points.length - 1]!
}
