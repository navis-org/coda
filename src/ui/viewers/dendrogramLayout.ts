/**
 * A merge tree's geometry, in unit space.
 *
 * Headless and pure, for the reason `networkLayout.ts` and `scatterPlot.ts` are: jsdom
 * performs no layout and has no canvas, so anything left in the component is covered by
 * nothing at all. What stays in `DendrogramViewer` is the SVG and the pointer handling.
 *
 * Everything here is in **unit space** — `at` runs 0..1 along the leaf axis and `height` runs
 * 0..1 up the distance axis — so orientation is a projection at the end rather than two
 * layouts. That is what makes "leaves on the right" and "leaves at the bottom" the same
 * picture rather than two that can disagree.
 */

import type { LinkageValue } from '../../core/values'
import { labelStep } from '../format'

export type DendrogramOrientation = 'right' | 'down'

export interface DendrogramLeaf {
  label: string
  /** Index into `linkage.labels`, i.e. which observation this is. */
  observation: number
  /** Position along the leaf axis, 0..1. Slot centres, so the ends keep half a slot. */
  at: number
  /** 1-based cluster, or 0 where the tree has not been cut. */
  cluster: number
}

export interface DendrogramLink {
  /** Row in the linkage matrix. */
  merge: number
  /** The bracket, as a polyline: up one child, across, down the other. */
  points: Array<{ at: number; height: number }>
  /**
   * The leaves under this merge, as an inclusive range into the leaf order.
   *
   * A range rather than a list, and it is exact rather than an approximation: the leaf order
   * is a depth-first walk of the tree, so every subtree occupies a contiguous run of it. That
   * is what makes clicking a branch cheap — a click selects `order.slice(first, last + 1)`
   * however many thousand leaves are under it.
   */
  first: number
  last: number
  /** 1-based cluster where every leaf under this merge shares one, else 0. */
  cluster: number
  /** The merge height in the tree's own units, for a tooltip. */
  distance: number
}

export interface DendrogramShape {
  leaves: DendrogramLeaf[]
  links: DendrogramLink[]
  /** The tallest merge, i.e. what `height: 1` means. */
  maxHeight: number
}

/**
 * Lay a tree out.
 *
 * One pass over the merges in order, which is enough because a merge can only reference
 * clusters formed before it — SciPy's numbering guarantees that, and it is what makes this
 * `O(n)` rather than a recursive walk with a stack to keep.
 */
export function dendrogramShape(linkage: LinkageValue): DendrogramShape {
  const n = linkage.labels.length
  const merges = linkage.merges.length / 4
  const total = n + merges

  // Where each node sits, and how far up. Observations first, then one entry per merge.
  const at = new Float64Array(total)
  const height = new Float64Array(total)
  const first = new Int32Array(total)
  const last = new Int32Array(total)
  const cluster = new Int32Array(total)

  linkage.order.forEach((observation, slot) => {
    // Slot centres rather than `slot / (n - 1)`: the ends then keep half a slot each, so a
    // leaf label at either extreme has room and a single-leaf tree is not a division by zero.
    at[observation] = n === 0 ? 0.5 : (slot + 0.5) / n
    first[observation] = slot
    last[observation] = slot
    cluster[observation] = linkage.clusters?.[observation] ?? 0
  })

  let maxHeight = 0
  for (let i = 0; i < merges; i++) {
    const a = linkage.merges[i * 4]!
    const b = linkage.merges[i * 4 + 1]!
    const distance = linkage.merges[i * 4 + 2]!
    const node = n + i
    at[node] = (at[a]! + at[b]!) / 2
    height[node] = distance
    first[node] = Math.min(first[a]!, first[b]!)
    last[node] = Math.max(last[a]!, last[b]!)
    // A branch belongs to a cluster only when everything under it does. Above the cut the two
    // children disagree and it is neutral — the same rule scipy's `dendrogram` colours by,
    // and the reason the picture reads as "these groups, joined by grey".
    cluster[node] = cluster[a] === cluster[b] ? cluster[a]! : 0
    maxHeight = Math.max(maxHeight, distance)
  }

  // A tree whose merges all sit at zero — every observation identical — would otherwise scale
  // by zero and collapse onto one line. Drawing it flat is honest; dividing by zero is not.
  const scale = maxHeight > 0 ? 1 / maxHeight : 0

  const links: DendrogramLink[] = []
  for (let i = 0; i < merges; i++) {
    const a = linkage.merges[i * 4]!
    const b = linkage.merges[i * 4 + 1]!
    const node = n + i
    const top = height[node]! * scale
    links.push({
      merge: i,
      points: [
        { at: at[a]!, height: height[a]! * scale },
        { at: at[a]!, height: top },
        { at: at[b]!, height: top },
        { at: at[b]!, height: height[b]! * scale },
      ],
      first: first[node]!,
      last: last[node]!,
      cluster: cluster[node]!,
      distance: height[node]!,
    })
  }

  const leaves: DendrogramLeaf[] = Array.from(linkage.order, (observation) => ({
    label: linkage.labels[observation]!,
    observation,
    at: at[observation]!,
    cluster: cluster[observation]!,
  }))

  return { leaves, links, maxHeight }
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * The part of the leaf axis on screen.
 *
 * `HeatmapWindow`'s idea, one viewer over, and the same argument for a sharper reason. There, a
 * zoom is not a scaled picture because the fold's blocks would be enlarged rather than resolved;
 * here it is not a scaled picture because **a scaled bracket takes its labels with it**, and
 * 10px leaf names blown up to 40px is the one thing a zoom must not do. So the window is an
 * input to the drawing: at ×8 an eighth of the leaves fill the axis and `visibleLeaves` re-thins
 * their names for the pitch that gives them, which is what "zoom in to read the labels" means.
 *
 * **One axis, and that is the departure from the heatmap.** A heatmap's two axes are the same
 * kind of thing — matrix lines — so one magnification over both is right, and stretching one
 * alone would make a block read as a different shape. A dendrogram's are not: the leaf axis is a
 * list of `n` slots and the **distance axis is the measurement**. It was built both ways first,
 * and the two-axis version is wrong in a way only a browser shows: zooming about a pointer part
 * way up the distance axis moves the window off the leaves, so ×8.7 on a real 398-leaf tree drew
 * a column of readable names beside two brackets and an acre of empty card. The merges that join
 * what you are reading are *below* the window, which is exactly what you zoomed in to look at.
 *
 * Holding the distance axis whole has a second payoff worth stating: a merge sits at the same
 * fraction of the plot at every zoom, so two zoom states are comparable and the spine of the
 * tree — the root's crossbar spans every leaf — is on screen whatever you are reading. The case
 * the other version would have served, a single-linkage tree with every merge crushed near zero,
 * wants a log height scale rather than a zoom, and that is a different control.
 *
 * Fractional, and for `HeatmapWindow`'s reason: a zoom lands about the pointer and a pan moves
 * by pixels, so snapping to leaf slots would make both gestures lurch.
 */
export interface DendrogramWindow {
  /** Leading edge along the leaf axis, 0..1. */
  at0: number
  /** How much of the leaf axis is on screen, 0..1. */
  atSpan: number
}

/** Everything: the state the viewer stores as "not zoomed". */
export const FULL_WINDOW: DendrogramWindow = { at0: 0, atSpan: 1 }

/**
 * The smallest span a zoom may reach: one leaf slot filling the plot.
 *
 * `MIN_SPAN`'s rule — one line filling the plot — in unit space, which ties the maximum
 * magnification to the leaf count. That is right rather than merely convenient: a four-leaf tree
 * has nothing to show at ×1000, and a four-thousand-leaf one has plenty.
 */
function minSpan(leafCount: number): number {
  return 1 / Math.max(1, leafCount)
}

export function isFullWindow(window: DendrogramWindow): boolean {
  return window.atSpan >= 1
}

/** How far in, as the caption says it. */
export function windowScale(window: DendrogramWindow): number {
  return 1 / window.atSpan
}

/** Keep a window inside the tree and above the one-leaf floor. */
export function clampWindow(window: DendrogramWindow, leafCount: number): DendrogramWindow {
  const atSpan = Math.min(1, Math.max(minSpan(leafCount), window.atSpan))
  return { atSpan, at0: Math.min(Math.max(0, window.at0), 1 - atSpan) }
}

/**
 * Zoom about a point of the leaf axis — the one that must not move — by a factor, where above 1
 * zooms out.
 */
export function zoomWindow(
  window: DendrogramWindow,
  anchor: number,
  factor: number,
  leafCount: number,
): DendrogramWindow {
  return clampWindow(
    { atSpan: window.atSpan * factor, at0: anchor - (anchor - window.at0) * factor },
    leafCount,
  )
}

/** Move along the leaf axis, staying inside the tree. */
export function panWindow(
  window: DendrogramWindow,
  at: number,
  leafCount: number,
): DendrogramWindow {
  return clampWindow({ ...window, at0: window.at0 + at }, leafCount)
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Unit space to pixels. Orientation and the window are the only two things that change it.
 *
 * The window is **required rather than defaulted**, which is a deliberate inconvenience at three
 * call sites: a forgotten one means "draw the whole tree", which is exactly what the picture
 * looked like before the zoom existed and is therefore the failure nobody would notice — the
 * brackets would ignore the gesture while the labels obeyed it, or the reverse.
 *
 * Note that only `at` is windowed. `height` maps 0..1 onto the plot at every zoom — see
 * `DendrogramWindow` for why that asymmetry is the design.
 */
export function projectPoint(
  point: { at: number; height: number },
  orientation: DendrogramOrientation,
  box: { width: number; height: number },
  window: DendrogramWindow,
): { x: number; y: number } {
  const u = (point.at - window.at0) / window.atSpan
  return orientation === 'right'
    ? // Leaves on the right: distance runs right-to-left, so the root is at x = 0 and the
      // leaves land against the label column.
      { x: (1 - point.height) * box.width, y: u * box.height }
    : { x: u * box.width, y: (1 - point.height) * box.height }
}

/** A plot pixel back to a point of the leaf axis, unclamped. The anchor a zoom is taken about. */
export function pointToUnit(
  x: number,
  y: number,
  orientation: DendrogramOrientation,
  box: { width: number; height: number },
  window: DendrogramWindow,
): number {
  const u = orientation === 'right' ? y / Math.max(1, box.height) : x / Math.max(1, box.width)
  return window.at0 + u * window.atSpan
}

/** The polyline for one bracket, as an SVG path. */
export function linkPath(
  link: DendrogramLink,
  orientation: DendrogramOrientation,
  box: { width: number; height: number },
  window: DendrogramWindow,
): string {
  return link.points
    .map((point, i) => {
      const { x, y } = projectPoint(point, orientation, box, window)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

// ---------------------------------------------------------------------------
// What the window leaves to draw
// ---------------------------------------------------------------------------

/**
 * The brackets that reach the window, which off it is every bracket.
 *
 * The heatmap zoomed cheaply because folding *fewer* cells is less work; an SVG tree gets the
 * same relief only by not building the paths. At ×20 on a four-thousand-leaf tree this is a few
 * hundred `<path>` pairs instead of eight thousand, and a pan is a re-render of the lot — the
 * cost `DendrogramLinks` is memoised against in the first place.
 *
 * **The same array back when nothing is zoomed**, by identity, so the memo downstream sees no
 * change on a render that has nothing to do with the window.
 *
 * A bracket is kept if its leaf extent *touches* the window, so the merges joining what is on
 * screen to the rest of the tree survive — the root's crossbar spans every leaf and is therefore
 * always drawn, which is what keeps a zoomed picture attached to the tree it came from.
 */
export function visibleLinks(
  shape: DendrogramShape,
  window: DendrogramWindow,
): DendrogramLink[] {
  if (isFullWindow(window)) return shape.links
  const atTo = window.at0 + window.atSpan
  return shape.links.filter((link) => {
    // A bracket has two distinct `at` values and `dendrogramShape` writes them in this order:
    // up one child, across, down the other. Reading the two ends is exactly what a min/max over
    // all four points computed, without the per-link iterator the loop allocated — 4,000 of
    // them per pan step on a large tree.
    const a = link.points[0]!.at
    const b = link.points[3]!.at
    return Math.min(a, b) <= atTo && Math.max(a, b) >= window.at0
  })
}

/**
 * Which leaves get a name, and whether any that wanted one did not.
 *
 * Both from one range because they are one decision: a leaf outside the window is not drawn at
 * all and is not a label the thinning dropped, so counting it would put a permanent
 * `labels thinned` on a card that is showing every name it has.
 */
export function visibleLeaves(
  shape: DendrogramShape,
  window: DendrogramWindow,
  room: number,
  pitch: number,
): { indices: number[]; thinned: boolean } {
  const n = shape.leaves.length
  /*
   * The visible run is arithmetic, not a scan. `dendrogramShape` builds `leaves` with
   * `Array.from(linkage.order, …)`, so index `i` *is* slot `i` and `at` is `(i + 0.5) / n` —
   * strictly increasing. Inverting that is two divisions where a filter over every leaf was
   * 20,000 comparisons and two arrays of that length, on a card drawing sixty names.
   */
  const lo = Math.max(0, Math.ceil(window.at0 * n - 0.5))
  const hi = Math.min(n - 1, Math.floor((window.at0 + window.atSpan) * n - 0.5))
  const step = labelStep(Math.max(0, hi - lo + 1), room, pitch)
  const indices: number[] = []
  // Stepped from the first multiple at or after `lo`, so the k-th leaf is picked by its **own**
  // index rather than by its distance from the first visible one — `labelTicks`' rule, learned
  // there: a pan moves `lo` continuously, and a modulus taken from it makes names blink.
  for (let i = Math.ceil(lo / step) * step; i <= hi; i += step) indices.push(i)
  return { indices, thinned: step > 1 }
}

/**
 * The observations a click on this branch selects.
 *
 * **Indices, not labels**, and that was got wrong first — see `out.dendrogram` for the reason.
 * A leaf's label is whatever named the matrix, and with `Label by` set to a cell type on an
 * NBLAST it repeats: fourteen neurons come back as five distinct names, so a selection held as
 * labels lights every branch whose leaves happen to share a name with the one that was picked.
 * An observation index is unique by construction.
 */
export function observationsUnder(shape: DendrogramShape, link: DendrogramLink): number[] {
  return shape.leaves.slice(link.first, link.last + 1).map((leaf) => leaf.observation)
}
