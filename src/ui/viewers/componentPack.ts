/**
 * Packing separately-laid-out pieces into one picture.
 *
 * A force layout can only separate two nodes that are joined to something — the forces travel
 * along edges. Two *components* share no edge, so nothing decides where one sits relative to
 * the other, and every force layout answers that question by accident: ForceAtlas2's gravity
 * piles them on the origin, and prefuse's drag leaves them wherever the repulsion last pushed
 * them. Neither is a decision.
 *
 * So the decision is made here instead, the way Cytoscape's layouts make it: lay each
 * component out on its own, then arrange the results as boxes. This matters far more than the
 * choice of force law on a fragmented graph — see [docs/viewers.md](../../../docs/viewers.md)
 * for the measurement on a 36k-node correspondence graph, where it is worth 8× on
 * `neighbourPurity` and the force law is worth almost nothing without it.
 *
 * Headless arithmetic over boxes; nothing here knows what a node is.
 */

export interface Box {
  width: number
  height: number
}

export interface Placed {
  /** Offset of the box's top-left corner in the packed field. */
  x: number
  y: number
}

export interface Packing {
  at: Placed[]
  width: number
  height: number
}

/**
 * Shelf packing, largest first, aiming at a square field.
 *
 * Boxes are laid left to right in rows ("shelves") whose height is the tallest box in them,
 * wrapping at a target width. Sorting by height descending is what keeps a shelf from being
 * one tall box and a lot of air.
 *
 * Not optimal — bin packing is NP-hard and an optimal answer would look no different at this
 * scale, where 11,000 of the 12,000 boxes are near-identical small squares. What it does
 * guarantee is that boxes never overlap, which is the only property the picture depends on.
 *
 * The target aspect is square rather than the viewport's: a network viewer is resized and
 * zoomed constantly, so packing to whatever shape the panel happened to be at layout time
 * would be a decision that goes stale the moment somebody drags the splitter.
 */
export function shelfPack(boxes: readonly Box[], gap: number): Packing {
  const at: Placed[] = new Array<Placed>(boxes.length)
  if (boxes.length === 0) return { at, width: 0, height: 0 }

  let area = 0
  let widest = 0
  for (const box of boxes) {
    area += (box.width + gap) * (box.height + gap)
    if (box.width > widest) widest = box.width
  }
  // √area is the side of a square with no waste; the fudge covers the waste a shelf leaves at
  // the end of each row. A single box wider than that still gets its own shelf.
  const target = Math.max(widest, Math.sqrt(area) * 1.1)

  const order = boxes
    .map((_, i) => i)
    .sort((a, b) => {
      const byHeight = boxes[b]!.height - boxes[a]!.height
      if (byHeight !== 0) return byHeight
      const byWidth = boxes[b]!.width - boxes[a]!.width
      // Index last, so the packing cannot depend on anything but the boxes themselves.
      return byWidth !== 0 ? byWidth : a - b
    })

  let cursorX = 0
  let cursorY = 0
  let shelfHeight = 0
  let width = 0
  for (const i of order) {
    const box = boxes[i]!
    if (cursorX > 0 && cursorX + box.width > target) {
      cursorY += shelfHeight + gap
      cursorX = 0
      shelfHeight = 0
    }
    at[i] = { x: cursorX, y: cursorY }
    cursorX += box.width + gap
    if (cursorX > width) width = cursorX
    if (box.height > shelfHeight) shelfHeight = box.height
  }
  return { at, width: Math.max(0, width - gap), height: cursorY + shelfHeight }
}

/**
 * Split a node set into its components' index lists, largest first.
 *
 * Takes the labels `connectedComponents` produces — which are already ranked by size — and
 * turns them into the per-component index arrays a layout runs over. Membership order within
 * a component follows node order, so a component's own layout is deterministic.
 */
export function groupByComponent(labels: readonly number[]): number[][] {
  const groups = new Map<number, number[]>()
  labels.forEach((label, index) => {
    const list = groups.get(label)
    if (list) list.push(index)
    else groups.set(label, [index])
  })
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list)
}
