/**
 * Where a Sankey's columns, boxes and ribbons go.
 *
 * Pure over the extents handed in — `sankeyFlow.ts` decides what the nodes are and what they
 * carry; this decides where. Split for `flowChartLayout.ts`' reason, and the same one again: the
 * arithmetic is the part a test can hold, and jsdom lays nothing out.
 *
 * ## Columns are top-aligned, and that is the whole of how a loss is drawn
 *
 * Centring each column is the conventional choice and it hides the one thing this diagram exists
 * to show. A column that passes on less than it received is *shorter* than the one before it, and
 * top-aligned that difference collects at the foot of the column as a single visible notch —
 * which is where the caption's shortfall is. Centred, the same difference is split into two half
 * gaps at either end and reads as margin.
 *
 * ## One layout, two orientations
 *
 * Everything below is in **along/across** space — `along` runs across the columns in flow order,
 * `across` is the stacking axis — with the projection to `x`/`y` once at the end.
 * `flowChartLayout.ts`' arrangement and its reason: two orientations computed separately are two
 * pictures that can disagree. Unlike the flow chart there is no asymmetry to carry, because a
 * Sankey's node has no text inside it: the label sits beside the bar and the bar's extent along
 * the flow is a constant.
 */

import { barycentreOrder } from './barycentre'
import type { SankeyFlow } from './sankeyFlow'

export type SankeyDirection = 'lr' | 'tb'

export interface XY {
  x: number
  y: number
}

export interface SankeyBox {
  id: string
  label: string
  layer: number
  /** Top-left corner in screen space. */
  x: number
  y: number
  width: number
  height: number
  value: number
  /**
   * The far end of the bar that took drive in and passed none on, as a fraction of the bar.
   *
   * Drawn as the dimmed tail of the box rather than as a separate mark, because it is not a
   * separate thing: a node is as tall as the larger of what it received and what it sent, so the
   * remainder is already inside its own bar. A notch at the column's foot would add the same
   * quantity a second time — which is how this shipped wrong, and what a layout test caught.
   */
  stopped: number
  folded: readonly string[]
  row: number
}

export interface SankeyBand {
  /** Index into the flow's ribbons — unique per band, which is what a renderer keys on. */
  ribbon: number
  source: string
  target: string
  /** The filled outline, ready for a `d` attribute. */
  path: string
  value: number
  row: number
  merged: number
  /** Where a label on this band would sit. */
  at: XY
}

export interface SankeyShape {
  boxes: readonly SankeyBox[]
  bands: readonly SankeyBand[]
  /** The open edge of the first column — drive entering from outside the diagram. */
  inlet: { x: number; y: number; width: number; height: number } | undefined
  width: number
  height: number
  /** Pixels per unit of value, so a caller can report what a width means. */
  scale: number
}

export interface SankeyLayoutOptions {
  direction: SankeyDirection
  /** Extent across the flow available to the whole drawing. */
  across: number
  /** Extent along the flow. */
  along: number
  /** Thickness of a node bar, along the flow. */
  nodeWidth?: number
  /** Gap between two boxes in one column. */
  nodeGap?: number
}

const DEFAULT_NODE_WIDTH = 13
const DEFAULT_NODE_GAP = 5

/** Smallest a box may draw, so a trace of flow is still something a pointer can find. */
const MIN_BOX = 1.5

function project(direction: SankeyDirection, along: number, across: number): XY {
  return direction === 'lr' ? { x: along, y: across } : { x: across, y: along }
}

/**
 * Order each column, then stack it.
 *
 * The sweep is `barycentre.ts`', shared with the flow chart. What is here is turning ribbons into
 * the weighted neighbour lists it reads — weighted by the ribbon's own value, so the heaviest
 * stream is the one drawn straightest, which is the one a reader traces.
 */
function orderColumns(
  flow: SankeyFlow,
  slotOf: ReadonlyMap<string, number>,
  byLayer: ReadonlyMap<number, number[]>,
  layers: readonly number[],
): void {
  const up: Array<Array<[number, number]>> = flow.nodes.map(() => [])
  const down: Array<Array<[number, number]>> = flow.nodes.map(() => [])
  for (const ribbon of flow.ribbons) {
    const from = slotOf.get(ribbon.source)
    const to = slotOf.get(ribbon.target)
    if (from === undefined || to === undefined) continue
    const pull = Math.max(1e-9, ribbon.value)
    down[from]!.push([to, pull])
    up[to]!.push([from, pull])
  }
  barycentreOrder({ buckets: byLayer, layers, up, down, count: flow.nodes.length })
}

export function sankeyShape(flow: SankeyFlow, options: SankeyLayoutOptions): SankeyShape {
  const { direction } = options
  const nodeWidth = options.nodeWidth ?? DEFAULT_NODE_WIDTH
  const nodeGap = options.nodeGap ?? DEFAULT_NODE_GAP

  if (flow.nodes.length === 0 || flow.peak <= 0) {
    return { boxes: [], bands: [], inlet: undefined, width: 0, height: 0, scale: 0 }
  }

  const slotOf = new Map<string, number>()
  flow.nodes.forEach((node, index) => slotOf.set(node.id, index))

  const byLayer = new Map<number, number[]>()
  flow.nodes.forEach((node, index) => {
    const bucket = byLayer.get(node.layer)
    if (bucket) bucket.push(index)
    else byLayer.set(node.layer, [index])
  })
  // Sorted once and handed down: two sorts of one Map's keys is where two orderings come from.
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  orderColumns(flow, slotOf, byLayer, layers)

  /*
   * One scale for the whole drawing, fitted to the tallest column.
   *
   * Per column it would make every column the same height, which is exactly the information
   * top-aligning exists to preserve: a shorter column *is* the loss. So the scale is the peak's,
   * and every other column comes out proportionally shorter.
   */
  let mostBoxes = 0
  for (const members of byLayer.values())
    if (members.length > mostBoxes) mostBoxes = members.length
  const gaps = Math.max(0, mostBoxes - 1) * nodeGap
  const scale = Math.max(0, (options.across - gaps) / flow.peak)

  // Columns spread evenly along the flow, the first and last flush with the ends.
  const span = layers.length > 1 ? (options.along - nodeWidth) / (layers.length - 1) : 0
  // A map rather than `layers.indexOf(layer)`, which was a scan of the layer list per node.
  const alongAt = new Map(layers.map((layer, index) => [layer, index * span]))
  const alongOf = (layer: number) => alongAt.get(layer) ?? 0

  const boxes: SankeyBox[] = []
  const placed = new Map<string, { start: number; end: number; along: number }>()
  for (const layer of layers) {
    let at = 0
    for (const slot of byLayer.get(layer)!) {
      const node = flow.nodes[slot]!
      const extent = Math.max(MIN_BOX, node.size * scale)
      const along = alongOf(layer)
      placed.set(node.id, { start: at, end: at + extent, along })
      const corner = project(direction, along, at)
      boxes.push({
        id: node.id,
        label: node.label,
        layer: node.layer,
        x: corner.x,
        y: corner.y,
        width: direction === 'lr' ? nodeWidth : extent,
        height: direction === 'lr' ? extent : nodeWidth,
        value: node.size,
        stopped: node.stopped * scale,
        folded: node.folded,
        row: node.row,
      })
      at += extent + nodeGap
    }
  }

  /*
   * Ribbon endpoints, stacked on each node's two faces.
   *
   * Ordered by the *other* end's position, which is what stops two bands crossing inside the gap
   * when they need not. A node's outgoing stack starts at its own top edge, so a node that passes
   * on less than it received leaves its remainder at the bottom of its bar — which is the same
   * shortfall the column's notch reports, visible per node.
   */
  const outAt = new Map<string, number>()
  const inAt = new Map<string, number>()
  /*
   * Sort keys precomputed in the pass that already mints a wrapper per ribbon.
   *
   * Read inside the comparator these were four string-keyed `Map` lookups per comparison, three
   * of which the layer difference discards almost every time — `4 n log n` lookups where the
   * ribbon count is the flow table's row count, and it re-runs on every frame of a resize.
   */
  const order = flow.ribbons
    .map((ribbon, index) => ({
      ribbon,
      index,
      sourceAt: placed.get(ribbon.source)?.start ?? 0,
      targetAt: placed.get(ribbon.target)?.start ?? 0,
    }))
    .sort(
      (a, b) =>
        a.ribbon.layer - b.ribbon.layer || a.sourceAt - b.sourceAt || a.targetAt - b.targetAt,
    )

  const bands: SankeyBand[] = []
  for (const { ribbon, index } of order) {
    const source = placed.get(ribbon.source)
    const target = placed.get(ribbon.target)
    if (!source || !target) continue
    const thickness = Math.max(0.5, ribbon.value * scale)
    const from = outAt.get(ribbon.source) ?? source.start
    const to = inAt.get(ribbon.target) ?? target.start
    outAt.set(ribbon.source, from + thickness)
    inAt.set(ribbon.target, to + thickness)

    const a = source.along + nodeWidth
    const b = target.along
    const mid = (a + b) / 2
    const p = (along: number, across: number) => project(direction, along, across)
    const c1 = p(mid, from)
    const c2 = p(mid, to)
    const c3 = p(mid, to + thickness)
    const c4 = p(mid, from + thickness)
    const start = p(a, from)
    const end = p(b, to)
    const endLow = p(b, to + thickness)
    const startLow = p(a, from + thickness)

    bands.push({
      ribbon: index,
      source: ribbon.source,
      target: ribbon.target,
      // Two cubics and two straight edges: the band's own outline, filled rather than stroked,
      // which is what makes its width the quantity rather than a line thickness.
      path:
        `M${start.x} ${start.y}` +
        `C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}` +
        `L${endLow.x} ${endLow.y}` +
        `C${c3.x} ${c3.y} ${c4.x} ${c4.y} ${startLow.x} ${startLow.y}` +
        `Z`,
      value: ribbon.value,
      row: ribbon.row,
      merged: ribbon.merged,
      at: p(mid, (from + to + thickness) / 2),
    })
  }

  /*
   * The open edge of the first column, which is drive arriving from outside the diagram.
   *
   * Not a notch and not a node: the first column has no inflow *by construction*, so calling all
   * of it missing would be wrong in the way calling a sink a leak is. It is where the picture was
   * cut off, and the viewer draws it as a feathered edge rather than as a box.
   */
  const first = byLayer.get(layers[0]!) ?? []
  let firstFoot = 0
  for (const slot of first) {
    const entry = placed.get(flow.nodes[slot]!.id)
    if (entry && entry.end > firstFoot) firstFoot = entry.end
  }
  const inletCorner = project(direction, alongOf(layers[0]!), 0)
  const inlet =
    firstFoot > 0
      ? {
          x: inletCorner.x,
          y: inletCorner.y,
          width: direction === 'lr' ? 0 : firstFoot,
          height: direction === 'lr' ? firstFoot : 0,
        }
      : undefined

  return {
    boxes,
    bands,
    inlet,
    ...extentOf(boxes, direction, options),
    scale,
  }
}

/** The drawing's extent, which is the column span one way and the tallest stack the other. */
function extentOf(
  boxes: readonly SankeyBox[],
  direction: SankeyDirection,
  options: SankeyLayoutOptions,
): { width: number; height: number } {
  let far = 0
  for (const box of boxes) {
    const end = direction === 'lr' ? box.y + box.height : box.x + box.width
    if (end > far) far = end
  }
  return direction === 'lr'
    ? { width: options.along, height: far }
    : { width: far, height: options.along }
}

/** A node's share of the drawing's peak column, for the tooltip and the labels. */
export function shareOf(value: number, peak: number): number {
  return peak > 0 ? value / peak : 0
}
