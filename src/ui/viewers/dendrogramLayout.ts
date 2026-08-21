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

/** Unit space to pixels, which is the only thing orientation changes. */
export function projectPoint(
  point: { at: number; height: number },
  orientation: DendrogramOrientation,
  box: { width: number; height: number },
): { x: number; y: number } {
  return orientation === 'right'
    ? // Leaves on the right: distance runs right-to-left, so the root is at x = 0 and the
      // leaves land against the label column.
      { x: (1 - point.height) * box.width, y: point.at * box.height }
    : { x: point.at * box.width, y: (1 - point.height) * box.height }
}

/** The polyline for one bracket, as an SVG path. */
export function linkPath(
  link: DendrogramLink,
  orientation: DendrogramOrientation,
  box: { width: number; height: number },
): string {
  return link.points
    .map((point, i) => {
      const { x, y } = projectPoint(point, orientation, box)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
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


