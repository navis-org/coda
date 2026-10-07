/**
 * Flat layouts of one neuron's arbour: the geometry the Neuron Dendrogram draws.
 *
 * Headless and pure, `dendrogramLayout.ts`' arrangement and for its reason — jsdom performs no
 * layout, so what is left in the component is checked by nothing. Every layout here works on the
 * **reduced tree** (`KeyTree`: the root, branch points and leaves), so a 140,000-node FlyWire
 * skeleton is a few thousand pieces, and on **one distance per landmark**, so geodesic and
 * electrotonic distance are the same code handed a different array.
 *
 * ## One shape for four layouts
 *
 * Each layout answers with a straight piece per segment — `start` to `end`, the segment from a
 * landmark's parent landmark down to it — plus the connectors a layout needs between pieces: the
 * vertical bar of a rectangular dendrogram, the arc of a radial one. A point part way down a
 * segment is then linear interpolation along its piece in every layout, which is what lets the
 * synapse ticks, the hit test and the distal highlight be written once.
 *
 * The four, and what each keeps of the distance:
 *
 * - **rectangular** — distance from the root *is* the x axis, leaves sit in evenly spaced slots on
 *   y. The only layout where distance can be read off an axis, hence the default. Its two axes are
 *   different quantities (`isotropic: false`), so the renderer scales them independently.
 * - **radial** — the same slots as angles and the same distance as radius.
 * - **subway** — navis's `plot_flat(layout='subway')`: the longest path straight along x, every
 *   other path leaving its attachment point at an angle. Lengths along every path are exact.
 * - **equalAngle** — every segment at its exact length, each subtree in an angular wedge sized by
 *   its leaves, then Felsenstein's daylight passes to even out the gaps. Lengths are exact and
 *   subtrees do not cross; it is the one that looks like the neuron rather than like a diagram.
 */

import type { Csr, KeyTree } from './arborOps'
import { keyChildren } from './arborOps'

export type ArborLayoutKind = 'rectangular' | 'radial' | 'subway' | 'equalAngle'

/**
 * How the slot layouts order a branch point's children.
 *
 * `balanced` keeps the heaviest subtree towards the middle of the leaf axis; `ladder` puts it
 * first, every time. Both are offered because a rendering of real neurons found each better at
 * something: ladder runs the trunk corner to corner as one staircase (a spiral, radially), while
 * balanced fixes that but draws a branchy proximal arbour as a band of long nested bars.
 */
export type ArborOrder = 'balanced' | 'ladder'

/** A connector between pieces: a rectangular dendrogram's bar, or a radial one's arc. */
export type ArborConnector =
  | {
      readonly kind: 'line'
      /** The branch point it joins the children of — what a per-landmark colour is read from. */
      readonly at: number
      readonly x: number
      readonly y0: number
      readonly y1: number
    }
  /** An arc about the origin at radius `r`, from angle `a0` to `a1` (radians, `a0 <= a1`). */
  | {
      readonly kind: 'arc'
      readonly at: number
      readonly r: number
      readonly a0: number
      readonly a1: number
    }

export interface ArborShape {
  readonly kind: ArborLayoutKind
  /**
   * Per landmark, the piece for the segment ending at it. The root's piece has zero length and
   * sits where the root is drawn.
   */
  readonly x0: Float64Array
  readonly y0: Float64Array
  readonly x1: Float64Array
  readonly y1: Float64Array
  readonly connectors: readonly ArborConnector[]
  /**
   * Whether x and y are the same quantity. Only the rectangular layout's are not — distance
   * across, leaf slots down — and a renderer that kept its aspect would draw a 500 µm neuron with
   * 1,400 leaves as a thin stripe.
   */
  readonly isotropic: boolean
  readonly bounds: { minX: number; maxX: number; minY: number; maxY: number }
}

/**
 * Each landmark's children ordered for drawing, by `ArborOrder`. Balanced puts the heaviest child
 * in the middle of three or more and, of two, on the side facing the parent's own centre, so the
 * trunk turns back inwards at each step. Ties fall to pre-order, so the order is deterministic.
 */
function orderedChildren(tree: KeyTree, d: Float64Array, order: ArborOrder): Csr {
  const n = tree.nodes.length
  const children = keyChildren(tree)
  // Cable from each landmark's parent down through its subtree, summed in reverse pre-order: a
  // landmark's children all come after it, so its own total is complete when it is reached.
  const below = new Float64Array(n)
  for (let k = n - 1; k >= 1; k--) {
    const p = tree.parent[k]!
    below[k]! += d[k]! - d[p]!
    below[p]! += below[k]!
  }

  // Which side of its parent's centre each landmark was put on: -1 before, +1 after, 0 middle.
  const side = new Int8Array(n)
  for (let k = 0; k < n; k++) {
    const from = children.start[k]!
    const to = children.start[k + 1]!
    const run = children.list.subarray(from, to)
    const heaviest = Array.from(run).sort((a, b) => below[b]! - below[a]! || a - b)
    let arranged: number[]
    if (order === 'ladder') {
      arranged = heaviest
    } else if (heaviest.length === 2) {
      // The heavier one faces back towards the middle: after us if we sit before our parent's
      // centre, before us if after it.
      arranged = side[k]! < 0 ? [heaviest[1]!, heaviest[0]!] : heaviest
    } else {
      // Middle-out: heaviest in the centre, the rest alternately after and before it.
      arranged = []
      heaviest.forEach((c, i) => (i % 2 === 1 ? arranged.push(c) : arranged.unshift(c)))
    }
    run.set(arranged)
    const centre = (arranged.length - 1) / 2
    arranged.forEach((c, i) => (side[c] = i < centre ? -1 : i > centre ? 1 : 0))
  }
  return children
}

/** Every landmark in the order a depth-first walk over `children` visits it, root first. */
function walk(children: Csr, n: number): Int32Array {
  const out = new Int32Array(n)
  const stack = [0]
  let at = 0
  while (stack.length > 0) {
    const k = stack.pop()!
    out[at++] = k
    for (let c = children.start[k + 1]! - 1; c >= children.start[k]!; c--) {
      stack.push(children.list[c]!)
    }
  }
  return out
}

/**
 * Leaf slots, and each landmark's position along the slot axis: a leaf at its slot centre, an
 * inner landmark midway between its first and last child — the classic dendrogram rule, which
 * puts the bar's centre where the branch joins rather than at a weighted mean that drifts.
 */
function slotPositions(children: Csr, n: number): { at: Float64Array; leaves: number } {
  const at = new Float64Array(n)
  let leaves = 0
  // Leaves take slots in the drawing's own order, which the reordered children decide…
  for (const k of walk(children, n)) {
    if (children.start[k + 1] === children.start[k]) at[k] = leaves++ + 0.5
  }
  // …while inner landmarks only need their children placed first, which reverse index order
  // guarantees: in pre-order a landmark's children all come after it, however they are ordered.
  for (let k = n - 1; k >= 0; k--) {
    const s = children.start[k]!
    const e = children.start[k + 1]!
    if (e > s) at[k] = (at[children.list[s]!]! + at[children.list[e - 1]!]!) / 2
  }
  return { at, leaves }
}

function pieceBounds(
  x0: Float64Array,
  y0: Float64Array,
  x1: Float64Array,
  y1: Float64Array,
  extra: (grow: (x: number, y: number) => void) => void = () => {},
): ArborShape['bounds'] {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number): void => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  for (let k = 0; k < x0.length; k++) {
    grow(x0[k]!, y0[k]!)
    grow(x1[k]!, y1[k]!)
  }
  extra(grow)
  if (minX === Infinity) return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  return { minX, maxX, minY, maxY }
}

/* ------------------------------------------------------------------------------------------
 * Rectangular and radial: the two that share a leaf ordering.
 * ---------------------------------------------------------------------------------------- */

export function rectangularLayout(
  tree: KeyTree,
  d: Float64Array,
  order: ArborOrder = 'balanced',
): ArborShape {
  const n = tree.nodes.length
  const children = orderedChildren(tree, d, order)
  const { at } = slotPositions(children, n)
  const x0 = new Float64Array(n)
  const y0 = new Float64Array(n)
  const x1 = new Float64Array(n)
  const y1 = new Float64Array(n)
  const connectors: ArborConnector[] = []
  for (let k = 0; k < n; k++) {
    const p = tree.parent[k]!
    x0[k] = p < 0 ? d[k]! : d[p]!
    x1[k] = d[k]!
    y0[k] = at[k]!
    y1[k] = at[k]!
    const s = children.start[k]!
    const e = children.start[k + 1]!
    if (e - s >= 2) {
      const a = at[children.list[s]!]!
      const b = at[children.list[e - 1]!]!
      connectors.push({ kind: 'line', at: k, x: d[k]!, y0: Math.min(a, b), y1: Math.max(a, b) })
    }
  }
  return {
    kind: 'rectangular',
    x0,
    y0,
    x1,
    y1,
    connectors,
    isotropic: false,
    bounds: pieceBounds(x0, y0, x1, y1),
  }
}

export function radialLayout(
  tree: KeyTree,
  d: Float64Array,
  order: ArborOrder = 'balanced',
): ArborShape {
  const n = tree.nodes.length
  const children = orderedChildren(tree, d, order)
  const { at, leaves } = slotPositions(children, n)
  const angle = (slot: number): number => (2 * Math.PI * slot) / Math.max(1, leaves)
  const x0 = new Float64Array(n)
  const y0 = new Float64Array(n)
  const x1 = new Float64Array(n)
  const y1 = new Float64Array(n)
  const connectors: ArborConnector[] = []
  for (let k = 0; k < n; k++) {
    const p = tree.parent[k]!
    const theta = angle(at[k]!)
    const r0 = p < 0 ? d[k]! : d[p]!
    x0[k] = r0 * Math.cos(theta)
    y0[k] = r0 * Math.sin(theta)
    x1[k] = d[k]! * Math.cos(theta)
    y1[k] = d[k]! * Math.sin(theta)
    const s = children.start[k]!
    const e = children.start[k + 1]!
    // An arc at radius zero is a point; the root's children all leave from the origin.
    if (e - s >= 2 && d[k]! > 0) {
      const a = angle(at[children.list[s]!]!)
      const b = angle(at[children.list[e - 1]!]!)
      connectors.push({ kind: 'arc', at: k, r: d[k]!, a0: Math.min(a, b), a1: Math.max(a, b) })
    }
  }
  return {
    kind: 'radial',
    x0,
    y0,
    x1,
    y1,
    connectors,
    isotropic: true,
    // A long arc bulges past its two ends, so the arcs grow the box at their quadrant crossings.
    bounds: pieceBounds(x0, y0, x1, y1, (grow) => {
      for (const c of connectors) {
        if (c.kind !== 'arc') continue
        for (let q = Math.ceil(c.a0 / (Math.PI / 2)); q * (Math.PI / 2) <= c.a1; q++) {
          const a = q * (Math.PI / 2)
          grow(c.r * Math.cos(a), c.r * Math.sin(a))
        }
      }
    }),
  }
}

/* ------------------------------------------------------------------------------------------
 * Subway: navis's layout, ported.
 * ---------------------------------------------------------------------------------------- */

export interface SubwayOptions {
  /** Angle between a branch and the path it leaves, in degrees. navis's `angle_change`. */
  readonly angleChange: number
  /** How much that angle shrinks per branch point above the attachment. navis's `angle_decrease`. */
  readonly angleDecrease: number
  /**
   * A branch shorter than this share of the longest path never has its angle flipped to the
   * other side. navis's `switch_dist`, which is in the neuron's own units there and so means
   * something different on every dataset; a share means the same on all of them.
   */
  readonly switchShare: number
}

export const SUBWAY_DEFAULTS: SubwayOptions = {
  angleChange: 45,
  angleDecrease: 0,
  switchShare: 0,
}

/**
 * navis's subway layout over the reduced tree.
 *
 * Paths are taken longest first, each drawn from where it meets the tree already drawn. The
 * first runs along x; every later one leaves its attachment at `angleChange` less `angleDecrease`
 * per branch point between the root and the attachment (floored at `angleDecrease`, as navis
 * does), flipped to the other side when that count is odd, and added to the angle of the path it
 * leaves. Angles therefore accumulate, so a deep branch can curl back across the drawing — navis
 * avoids no collisions and neither does this; the help says so.
 *
 * **One departure, and it is a fix.** navis zeroes the first distance of every new path
 * (`distances[0] = 0` in `_plot_subway`), which places a branch's first node on top of the branch
 * point and so shortens every branch by its first edge. On a densely traced skeleton that is a few
 * hundred nanometres; on a level-2 skeleton it is micrometres per branch, and a figure whose point
 * is distance should not have it. Here a new piece is exactly as long as its segment.
 */
export function subwayLayout(
  tree: KeyTree,
  d: Float64Array,
  options: SubwayOptions = SUBWAY_DEFAULTS,
): ArborShape {
  const n = tree.nodes.length
  const children = keyChildren(tree)
  const isBranch = (k: number): boolean => children.start[k + 1]! - children.start[k]! > 1

  // Branch points from the root down to and including each landmark, in pre-order.
  const branchesAbove = new Int32Array(n)
  for (let k = 0; k < n; k++) {
    const p = tree.parent[k]!
    branchesAbove[k] = (p < 0 ? 0 : branchesAbove[p]!) + (isBranch(k) ? 1 : 0)
  }

  const leaves: number[] = []
  for (let k = 0; k < n; k++)
    if (k > 0 && children.start[k + 1] === children.start[k]) leaves.push(k)
  // Longest path first, ties by pre-order so the drawing is deterministic.
  leaves.sort((a, b) => d[b]! - d[a]! || a - b)
  const longest = leaves.length > 0 ? d[leaves[0]!]! : 0

  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const angleOf = new Float64Array(n)
  const seen = new Uint8Array(n)
  seen[0] = 1
  const rad = Math.PI / 180

  const path: number[] = []
  leaves.forEach((leaf, i) => {
    path.length = 0
    let k = leaf
    while (!seen[k]) {
      path.push(k)
      k = tree.parent[k]!
    }
    const attach = k
    const bp = branchesAbove[attach]!
    const reach = d[leaf]! - d[attach]!
    let angle =
      i === 0
        ? 0
        : Math.max(options.angleChange - options.angleDecrease * bp, options.angleDecrease)
    if (bp % 2 !== 0 && reach >= options.switchShare * longest) angle = -angle
    const theta = angle * rad + angleOf[attach]!
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    for (let j = path.length - 1; j >= 0; j--) {
      const m = path[j]!
      const along = d[m]! - d[attach]!
      x[m] = x[attach]! + along * cos
      y[m] = y[attach]! + along * sin
      angleOf[m] = theta
      seen[m] = 1
    }
  })

  return straightPieces('subway', tree, x, y)
}

/** Pieces from each landmark's parent position to its own, for the layouts drawn as positions. */
function straightPieces(
  kind: ArborLayoutKind,
  tree: KeyTree,
  x: Float64Array,
  y: Float64Array,
): ArborShape {
  const n = tree.nodes.length
  const x0 = new Float64Array(n)
  const y0 = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const p = tree.parent[k]!
    x0[k] = x[p < 0 ? k : p]!
    y0[k] = y[p < 0 ? k : p]!
  }
  return {
    kind,
    x0,
    y0,
    x1: x,
    y1: y,
    connectors: [],
    isotropic: true,
    bounds: pieceBounds(x0, y0, x, y),
  }
}

/* ------------------------------------------------------------------------------------------
 * Equal-angle, refined by daylight: exact lengths, drawn like the neuron rather than a diagram.
 * ---------------------------------------------------------------------------------------- */

/**
 * Daylight passes over the equal-angle drawing — two, measured rather than chosen. On male-CNS
 * neurons the first pass does nearly all the spreading; later ones do not converge but swing whole
 * subtrees back and forth (a third pass still moved landmarks by a fifth of the drawing's width on
 * average), changing the picture without improving it. Each pass costs ~75 ms on 2,900 landmarks
 * and ~170 ms on 4,400 — quadratic, every branch point measuring the whole tree around it — so the
 * card runs it off the main thread.
 */
export const DAYLIGHT_PASSES = 2

/**
 * The equal-angle layout (Felsenstein, *Inferring Phylogenies* ch. 34), then `daylight` passes.
 *
 * Every segment is drawn at its exact length, and each subtree owns a wedge of angle in
 * proportion to its leaves, centred on the edge into it — so subtrees cannot cross, and distance
 * along any path is the drawn length. Not stress (graphviz `neato`'s objective, which navis
 * offers): a branchy tree cannot keep its tree distances in a plane, and stress gives up the
 * segment lengths to save the long-range ones — 45% off on male-CNS 10003, with crossings.
 */
export function equalAngleLayout(
  tree: KeyTree,
  d: Float64Array,
  passes: number = DAYLIGHT_PASSES,
): ArborShape {
  const n = tree.nodes.length
  const children = keyChildren(tree)
  // Leaves and landmarks below each landmark, summed in one reverse pre-order pass. With
  // pre-order, `k`'s subtree is the run `k .. k + size[k] - 1`, which daylight rotates.
  const leaves = new Float64Array(n)
  const size = new Int32Array(n).fill(1)
  for (let k = n - 1; k >= 0; k--) {
    if (children.start[k + 1] === children.start[k]) leaves[k] = 1
    const p = tree.parent[k]!
    if (p < 0) continue
    leaves[p]! += leaves[k]!
    size[p]! += size[k]!
  }

  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const from = new Float64Array(n)
  const span = new Float64Array(n)
  span[0] = 2 * Math.PI
  // Landmarks are in pre-order, so a parent's wedge is known before its children's.
  for (let k = 0; k < n; k++) {
    let a = from[k]!
    for (let c = children.start[k]!; c < children.start[k + 1]!; c++) {
      const m = children.list[c]!
      const w = (span[k]! * leaves[m]!) / leaves[k]!
      from[m] = a
      span[m] = w
      const mid = a + w / 2
      const len = d[m]! - d[k]!
      x[m] = x[k]! + len * Math.cos(mid)
      y[m] = y[k]! + len * Math.sin(mid)
      a += w
    }
  }

  for (let pass = 0; pass < passes; pass++) daylight(tree, children, size, x, y)
  return straightPieces('equalAngle', tree, x, y)
}

const TAU = 2 * Math.PI

/** An angle brought into (-π, π]. */
function wrapPi(a: number): number {
  return a - TAU * Math.round(a / TAU)
}

/**
 * One daylight pass: at every branch point, rotate the subtrees around it so the empty angle
 * between neighbouring subtrees — the daylight — is the same in every gap.
 *
 * The subtrees around a landmark `v` are its children's, plus everything else (the side towards
 * the root) for any `v` but the root. The side towards the root is held still and the children's
 * subtrees are rotated rigidly about `v` to sit one equal gap after another; a rigid rotation
 * keeps every length, which is the whole point of this layout. A landmark with a subtree that
 * wraps all the way round it has no daylight to share and is left alone, as `drawtree` does.
 */
function daylight(
  tree: KeyTree,
  children: Csr,
  size: Int32Array,
  x: Float64Array,
  y: Float64Array,
): void {
  const n = tree.nodes.length
  // Scratch for `wind`, reused across every landmark of the pass.
  const angle = new Float64Array(n)
  const winding = new Float64Array(n)
  const span: [number, number] = [0, 0]

  /*
   * Angles about `v`, unwound along the tree, for the landmarks in `[lo, hi)`: each one's winding
   * is its parent's plus the turn along the edge between them. Pre-order puts a parent before its
   * child, so one forward scan suffices; a run's first landmark, whose parent lies outside it, is
   * seeded by the caller. Leaves the run's min and max winding in `span`, starting from the two
   * passed in.
   *
   * **Unwound, not wrapped.** Each edge turns by under half a circle about `v`, because no edge
   * passes through `v` — the drawing has no crossings and `v` is a landmark — so the winding is
   * exact however far round `v` a subtree reaches. Wrapping every angle into ±π of the first edge
   * instead, which this did first, read a subtree reaching past π as narrower than it is, and the
   * rotations computed from that put branches across each other.
   */
  const wind = (v: number, lo: number, hi: number, min: number, max: number): void => {
    const vx = x[v]!
    const vy = y[v]!
    for (let j = lo; j < hi; j++) {
      const u = tree.parent[j]!
      const dx = x[j]! - vx
      const dy = y[j]! - vy
      // A point on `v` itself has no direction; it inherits its parent's.
      angle[j] = dx === 0 && dy === 0 ? angle[u]! : Math.atan2(dy, dx)
      winding[j] = winding[u]! + wrapPi(angle[j]! - angle[u]!)
      if (winding[j]! < min) min = winding[j]!
      if (winding[j]! > max) max = winding[j]!
    }
    span[0] = min
    span[1] = max
  }

  /** The arc of child `m`'s subtree about `v`: start angle and width in `span`; false if full. */
  const childArc = (v: number, m: number): boolean => {
    angle[m] = Math.atan2(y[m]! - y[v]!, x[m]! - x[v]!)
    winding[m] = 0
    wind(v, m + 1, m + size[m]!, 0, 0)
    const [min, max] = span
    span[0] = angle[m]! + min
    span[1] = max - min
    return span[1] < TAU
  }

  /*
   * The arc of everything outside `v`'s subtree, seen from `v`. Wound from the root rather than
   * from the parent `p`: the winding from `p` to any landmark out here is the difference of the two
   * windings from the root, since every path between them avoids `v` and a turn walked backwards
   * is the same turn negated. The two runs either side of `v`'s subtree are then one scan each.
   */
  const parentArc = (v: number, p: number): boolean => {
    angle[0] = Math.atan2(y[0]! - y[v]!, x[0]! - x[v]!)
    winding[0] = 0
    wind(v, 1, v, 0, 0)
    wind(v, v + size[v]!, n, span[0], span[1])
    const [min, max] = span
    span[0] = angle[p]! + (min - winding[p]!)
    span[1] = max - min
    return span[1] < TAU
  }

  outer: for (let v = 0; v < n; v++) {
    const s = children.start[v]!
    const e = children.start[v + 1]!
    const p = tree.parent[v]!
    // Daylight needs at least two neighbours to share it between.
    if (e - s + (p >= 0 ? 1 : 0) < 2) continue

    // Each subtree around v: its start angle and width. The side towards the root, which is held
    // still, goes first; it is also the expensive one, so the children are measured before it.
    const starts: number[] = []
    const widths: number[] = []
    const members: number[] = []
    for (let c = s; c < e; c++) {
      const m = children.list[c]!
      if (!childArc(v, m)) continue outer
      starts.push(span[0])
      widths.push(span[1])
      members.push(m)
    }
    if (p >= 0) {
      if (!parentArc(v, p)) continue
      starts.unshift(span[0])
      widths.unshift(span[1])
      members.unshift(-1)
    }

    const total = widths.reduce((a, b) => a + b, 0)
    if (total >= TAU) continue
    const gap = (TAU - total) / widths.length

    // Walk the subtrees in angular order from the first one, which stays put.
    const anchor = starts[0]!
    const around = (a: number): number => a - anchor - TAU * Math.floor((a - anchor) / TAU)
    const order = starts
      .map((_, i) => i)
      .sort((i, j) => around(starts[i]!) - around(starts[j]!))
    let next = anchor + widths[order[0]!]! + gap
    for (let o = 1; o < order.length; o++) {
      const i = order[o]!
      const turn = wrapPi(next - starts[i]!)
      next += widths[i]! + gap
      const m = members[i]!
      // `m < 0` is the side towards the root, which only a tie in the sort can move off first.
      if (m < 0 || turn === 0) continue
      const cos = Math.cos(turn)
      const sin = Math.sin(turn)
      for (let j = m; j < m + size[m]!; j++) {
        const dx = x[j]! - x[v]!
        const dy = y[j]! - y[v]!
        x[j] = x[v]! + dx * cos - dy * sin
        y[j] = y[v]! + dx * sin + dy * cos
      }
    }
  }
}

/** Any of the four, by name. */
export function arborLayout(
  kind: ArborLayoutKind,
  tree: KeyTree,
  d: Float64Array,
  options: { order?: ArborOrder; subway?: SubwayOptions } = {},
): ArborShape {
  switch (kind) {
    case 'rectangular':
      return rectangularLayout(tree, d, options.order)
    case 'radial':
      return radialLayout(tree, d, options.order)
    case 'subway':
      return subwayLayout(tree, d, options.subway)
    case 'equalAngle':
      return equalAngleLayout(tree, d)
  }
}

/* ------------------------------------------------------------------------------------------
 * Points on the shape.
 * ---------------------------------------------------------------------------------------- */

/**
 * Where a point at distance `distance` from the root sits on landmark `k`'s piece: linear along
 * it, by its share of the segment. A zero-length segment answers its end.
 */
export function pointOnPiece(
  shape: ArborShape,
  d: Float64Array,
  tree: KeyTree,
  k: number,
  distance: number,
): [number, number] {
  const p = tree.parent[k]!
  const span = p < 0 ? 0 : d[k]! - d[p]!
  const f = span > 0 ? Math.min(1, Math.max(0, (distance - d[p]!) / span)) : 1
  return [
    shape.x0[k]! + f * (shape.x1[k]! - shape.x0[k]!),
    shape.y0[k]! + f * (shape.y1[k]! - shape.y0[k]!),
  ]
}
