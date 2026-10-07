/**
 * The Neuron Dendrogram's drawing geometry: where things go on screen, and what a click meant.
 *
 * Headless and pure, `dendrogramLayout.ts`' arrangement — jsdom lays nothing out and has a stub
 * canvas, so whatever stays in the component is checked by nothing. What is here is the arithmetic
 * between the layout (`nodes/lib/arborLayout.ts`, in layout units) and the screen: the fit and the
 * zoom window, a mark for every synapse, the hit test, and turning a click on a drawn piece back
 * into a point on the skeleton that the distal query can answer for.
 */

import type { ArborShape } from '../../nodes/lib/arborLayout'
import type { Arbor, ArborPoint, KeyTree, Placement } from '../../nodes/lib/arborOps'
import { distanceAt } from '../../nodes/lib/arborOps'

/** Padding round the fitted drawing, in CSS pixels. */
export const PLOT_PAD = 16

/**
 * The part of the drawing on screen, as a centre in layout units and a magnification over the
 * fit. Absent means fitted. A window rather than a scaled picture so ticks and the scale bar stay
 * the size they are, `HeatmapWindow`'s reasoning.
 */
export interface ArborView {
  readonly cx: number
  readonly cy: number
  readonly zoom: number
}

/** Layout units to CSS pixels: `screen = (layout - centre) * scale + half the box`. */
export interface PlotTransform {
  readonly sx: number
  readonly sy: number
  readonly cx: number
  readonly cy: number
  readonly width: number
  readonly height: number
  /** The magnification over the fit this was built at; 1 is fitted. */
  readonly zoom: number
}

/**
 * The transform that fits `shape` into a box, through an optional zoom window.
 *
 * An isotropic shape keeps its aspect — one scale for both axes, or a radial arbour is drawn as an
 * ellipse. The rectangular layout's axes are distance and leaf slots, two different quantities,
 * so each is fitted to its own side of the box.
 */
export function fitTransform(
  shape: ArborShape,
  width: number,
  height: number,
  view?: ArborView,
): PlotTransform {
  const b = shape.bounds
  const spanX = Math.max(b.maxX - b.minX, 1e-9)
  const spanY = Math.max(b.maxY - b.minY, 1e-9)
  const innerW = Math.max(1, width - 2 * PLOT_PAD)
  const innerH = Math.max(1, height - 2 * PLOT_PAD)
  let sx = innerW / spanX
  let sy = innerH / spanY
  if (shape.isotropic) sx = sy = Math.min(sx, sy)
  const zoom = view?.zoom ?? 1
  return {
    sx: sx * zoom,
    sy: sy * zoom,
    cx: view?.cx ?? (b.minX + b.maxX) / 2,
    cy: view?.cy ?? (b.minY + b.maxY) / 2,
    width,
    height,
    zoom,
  }
}

export function toScreen(t: PlotTransform, x: number, y: number): [number, number] {
  return [(x - t.cx) * t.sx + t.width / 2, (y - t.cy) * t.sy + t.height / 2]
}

export function toLayout(t: PlotTransform, px: number, py: number): [number, number] {
  return [(px - t.width / 2) / t.sx + t.cx, (py - t.height / 2) / t.sy + t.cy]
}

/** The view after a wheel step of `factor` (above 1 zooms out) about a screen point. */
export function zoomAbout(t: PlotTransform, factor: number, px: number, py: number): ArborView {
  const [ax, ay] = toLayout(t, px, py)
  const zoom = Math.min(Math.max(t.zoom / factor, 1), 400)
  const ratio = t.zoom / zoom
  // Keep the layout point under the pointer where it is.
  return { cx: ax - (ax - t.cx) * ratio, cy: ay - (ay - t.cy) * ratio, zoom }
}

/** The view after a drag of `dx`, `dy` CSS pixels. */
export function panBy(t: PlotTransform, dx: number, dy: number): ArborView {
  return { cx: t.cx - dx / t.sx, cy: t.cy - dy / t.sy, zoom: t.zoom }
}

/* ------------------------------------------------------------------------------------------
 * Synapses.
 * ---------------------------------------------------------------------------------------- */

/**
 * Each drawn piece's two ends on screen — the one geometry every mark is placed against.
 *
 * Synapse ticks, the per-node colouring and the clicked point are all a piece and a fraction along
 * it, never a position of their own. That is what lets the animation move only these four arrays:
 * everything on a piece follows it.
 */
export interface PieceGeometry {
  readonly ax: Float64Array
  readonly ay: Float64Array
  readonly bx: Float64Array
  readonly by: Float64Array
}

/** A layout's pieces through a screen transform. */
export function pieceGeometry(shape: ArborShape, t: PlotTransform): PieceGeometry {
  const n = shape.x0.length
  const ax = new Float64Array(n)
  const ay = new Float64Array(n)
  const bx = new Float64Array(n)
  const by = new Float64Array(n)
  const hx = t.width / 2
  const hy = t.height / 2
  for (let k = 0; k < n; k++) {
    ax[k] = (shape.x0[k]! - t.cx) * t.sx + hx
    ay[k] = (shape.y0[k]! - t.cy) * t.sy + hy
    bx[k] = (shape.x1[k]! - t.cx) * t.sx + hx
    by[k] = (shape.y1[k]! - t.cy) * t.sy + hy
  }
  return { ax, ay, bx, by }
}

/** How far along landmark `k`'s piece a distance from the root falls, 0 at its top and 1 at `k`. */
export function alongPiece(
  tree: KeyTree,
  landmarkD: Float64Array,
  k: number,
  d: number,
): number {
  const p = tree.parent[k]!
  const span = p < 0 ? 0 : landmarkD[k]! - landmarkD[p]!
  return span > 0 ? Math.min(1, Math.max(0, (d - landmarkD[p]!) / span)) : 1
}

/** Where each synapse is drawn — a piece and a share of it — and on which side of its branch. */
export interface SynapseMarks {
  /** The drawn landmark whose piece the synapse sits on, or -1 where it is not drawn. */
  readonly piece: Int32Array
  readonly along: Float32Array
  /** +1 for this neuron's outputs, -1 for its inputs: ticks go to opposite sides of the branch. */
  readonly side: Int8Array
  /** Synapses on a twig the drawing hides. Counted, never moved. */
  readonly onHiddenTwigs: number
}

/**
 * A mark for every placed synapse on the drawn tree.
 *
 * `tree` is the tree as drawn — pruned or not — and `landmarkD` its landmark distances under the
 * metric on screen; `nodeD` is the same metric per skeleton node, which places a synapse along its
 * edge. A synapse on a hidden twig gets no mark and is counted, because moving it to the branch
 * point would draw it somewhere it is not.
 */
export function synapseMarks(
  tree: KeyTree,
  landmarkD: Float64Array,
  arbor: Arbor,
  nodeD: Float64Array,
  placement: Placement,
  polarity: (synapse: number) => string,
): SynapseMarks {
  const count = placement.node.length
  const piece = new Int32Array(count).fill(-1)
  const along = new Float32Array(count)
  const side = new Int8Array(count)
  let onHiddenTwigs = 0
  for (let s = 0; s < count; s++) {
    const u = placement.node[s]!
    if (u < 0) continue
    const k = tree.segmentOf[u]!
    if (k < 0) {
      // On the root itself, which has no piece, or on a hidden twig.
      if (u !== arbor.root) onHiddenTwigs++
      continue
    }
    piece[s] = k
    along[s] = alongPiece(
      tree,
      landmarkD,
      k,
      distanceAt(arbor, nodeD, { node: u, t: placement.t[s]! }),
    )
    side[s] = polarity(s) === 'pre' ? 1 : -1
  }
  return { piece, along, side, onHiddenTwigs }
}

/**
 * Every skeleton edge as a stretch of its drawn piece: what a per-node colour or width is drawn
 * along. Edge `i` runs from `f0[i]` to `f1[i]` of piece `piece[i]` and belongs to skeleton node
 * `node[i]` (its child end). Edges on hidden twigs are left out.
 */
export interface SubSegments {
  readonly node: Int32Array
  readonly piece: Int32Array
  readonly f0: Float32Array
  readonly f1: Float32Array
}

export function subSegments(
  arbor: Arbor,
  tree: KeyTree,
  landmarkD: Float64Array,
  nodeD: Float64Array,
): SubSegments {
  const node: number[] = []
  const piece: number[] = []
  const f0: number[] = []
  const f1: number[] = []
  for (let k = 1; k < arbor.order.length; k++) {
    const v = arbor.order[k]!
    const segment = tree.segmentOf[v]!
    if (segment < 0) continue
    node.push(v)
    piece.push(segment)
    f0.push(alongPiece(tree, landmarkD, segment, nodeD[arbor.parent[v]!]!))
    f1.push(alongPiece(tree, landmarkD, segment, nodeD[v]!))
  }
  return {
    node: Int32Array.from(node),
    piece: Int32Array.from(piece),
    f0: Float32Array.from(f0),
    f1: Float32Array.from(f1),
  }
}

/* ------------------------------------------------------------------------------------------
 * Clicking.
 * ---------------------------------------------------------------------------------------- */

/** How close, in CSS pixels, a click must land to a piece to pick it. */
export const PICK_TOLERANCE = 8

/** The piece nearest a screen point, and how far along it, or undefined past the tolerance. */
export function pickPiece(
  pieces: PieceGeometry,
  px: number,
  py: number,
): { piece: number; along: number } | undefined {
  let best: { piece: number; along: number } | undefined
  let bestDist = PICK_TOLERANCE * PICK_TOLERANCE
  for (let k = 1; k < pieces.ax.length; k++) {
    const ax = pieces.ax[k]!
    const ay = pieces.ay[k]!
    const dx = pieces.bx[k]! - ax
    const dy = pieces.by[k]! - ay
    const len2 = dx * dx + dy * dy
    const along =
      len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 1
    const d = (px - (ax + along * dx)) ** 2 + (py - (ay + along * dy)) ** 2
    if (d <= bestDist) {
      bestDist = d
      best = { piece: k, along }
    }
  }
  return best
}

/**
 * The skeleton point a click on a drawn piece means: the point at that share of the piece's
 * distance, found on the skeleton path the piece stands for.
 *
 * A piece is the segment from its landmark up to the landmark above it, so the walk goes up the
 * re-rooted tree from the landmark until it reaches the edge whose two ends bracket the distance.
 * Linear in the segment's length, which is what one click can afford.
 */
export function arborPointAt(
  arbor: Arbor,
  tree: KeyTree,
  landmarkD: Float64Array,
  nodeD: Float64Array,
  piece: number,
  along: number,
): ArborPoint {
  const top = tree.parent[piece]!
  const d = landmarkD[top]! + along * (landmarkD[piece]! - landmarkD[top]!)
  let v = tree.nodes[piece]!
  for (;;) {
    const p = arbor.parent[v]!
    if (p < 0) return { node: v, t: 1 }
    if (nodeD[p]! <= d) {
      const span = nodeD[v]! - nodeD[p]!
      return { node: v, t: span > 0 ? Math.min(1, Math.max(0, (d - nodeD[p]!) / span)) : 1 }
    }
    v = p
  }
}

/** Where a skeleton point is drawn: a piece and a share of it. The root is the end of piece 0. */
export function placeOnPiece(
  tree: KeyTree,
  landmarkD: Float64Array,
  arbor: Arbor,
  nodeD: Float64Array,
  point: ArborPoint,
): { piece: number; along: number } | undefined {
  const k = tree.segmentOf[point.node]!
  if (k < 0) return point.node === arbor.root ? { piece: 0, along: 1 } : undefined
  return { piece: k, along: alongPiece(tree, landmarkD, k, distanceAt(arbor, nodeD, point)) }
}
