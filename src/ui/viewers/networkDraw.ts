/**
 * Vector drawing for the network viewer: edge curvature, arrowheads, and a standalone SVG
 * of the current view.
 *
 * Sigma draws through WebGL, and a WebGL drawing buffer cannot be read back once it has
 * been presented unless `preserveDrawingBuffer` is on — which costs memory on every frame
 * for the sake of a button pressed occasionally. So export re-draws the same picture as
 * SVG from the same numbers sigma was handed, and PNG rasterises that. Two things fall out
 * of doing it this way: the export is genuinely vector, and every bit of this geometry is
 * testable without a GPU, which is otherwise impossible for this viewer.
 *
 * Coordinates arrive in *viewport* space (sigma's `graphToViewport`), so an export
 * reproduces the view on screen — pan and zoom included — rather than some canonical
 * framing the user never chose.
 */

import type { NetworkValue } from '../../core/values'
import { getColumn } from '../../core/values'
import type { Legend } from '../encoding'
import { formatNumber } from '../format'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * How far a reciprocal pair bows apart, as a fraction of the distance between its two
 * nodes. Same number, same meaning as `@sigma/edge-curve`'s `curvature` attribute, so the
 * exported arc matches the drawn one.
 */
export const RECIPROCAL_CURVATURE = 0.25

/** Height of the legend strip appended below the plot. */
const LEGEND_HEIGHT = 26

export interface Point {
  x: number
  y: number
}

/**
 * Curvature per edge row: 0 for a link that stands alone, `RECIPROCAL_CURVATURE` for one
 * whose reverse is also present.
 *
 * Both members of a reciprocal pair get the *same* value, which looks like a bug and isn't.
 * The control point is offset along the perpendicular of (target − source), and that
 * perpendicular flips with the direction of travel — so equal curvature bows A→B and B→A to
 * opposite sides. Giving them opposite curvatures would stack them back on top of each
 * other, which is the thing being fixed.
 *
 * Undirected networks get none: `BuildNetwork` canonicalises A–B and B–A into one link, so
 * there is nothing to separate.
 */
export function assignCurvatures(network: NetworkValue): number[] {
  const count = network.edges.length
  const curvatures = new Array<number>(count).fill(0)
  if (!network.directed || count === 0) return curvatures

  const sources = getColumn(network.edges, 'source')
  const targets = getColumn(network.edges, 'target')
  const present = new Set<string>()
  for (let i = 0; i < count; i++) {
    present.add(`${String(sources[i] ?? '')}\u0000${String(targets[i] ?? '')}`)
  }
  for (let i = 0; i < count; i++) {
    const source = String(sources[i] ?? '')
    const target = String(targets[i] ?? '')
    if (source === target) continue
    if (present.has(`${target}\u0000${source}`)) curvatures[i] = RECIPROCAL_CURVATURE
  }
  return curvatures
}

/**
 * Control point of the quadratic an edge is drawn as.
 *
 * Mirrors the construction in `@sigma/edge-curve`'s vertex shader — midpoint plus the
 * perpendicular of source→target, scaled by curvature — flipped for SVG's downward y so the
 * exported arc bends the way the on-screen one does.
 */
export function curveControlPoint(source: Point, target: Point, curvature: number): Point {
  const dx = target.x - source.x
  const dy = target.y - source.y
  return {
    x: (source.x + target.x) / 2 + dy * curvature,
    y: (source.y + target.y) / 2 - dx * curvature,
  }
}

/** Point on the edge at parameter `t`, used to place labels at the visual midpoint. */
export function curvePoint(source: Point, target: Point, curvature: number, t: number): Point {
  if (!curvature) {
    return { x: source.x + (target.x - source.x) * t, y: source.y + (target.y - source.y) * t }
  }
  const control = curveControlPoint(source, target, curvature)
  const inverse = 1 - t
  return {
    x: inverse * inverse * source.x + 2 * inverse * t * control.x + t * t * target.x,
    y: inverse * inverse * source.y + 2 * inverse * t * control.y + t * t * target.y,
  }
}

const round = (value: number) => Math.round(value * 100) / 100

/** `d` attribute for an edge: a straight line, or a quadratic when it has to bow aside. */
export function edgePath(source: Point, target: Point, curvature: number): string {
  const start = `M${round(source.x)},${round(source.y)}`
  if (!curvature) return `${start} L${round(target.x)},${round(target.y)}`
  const control = curveControlPoint(source, target, curvature)
  return `${start} Q${round(control.x)},${round(control.y)} ${round(target.x)},${round(target.y)}`
}

/**
 * The three corners of an arrowhead, tip first.
 *
 * The tip sits on the target node's rim rather than at its centre, so the arrow reads as
 * pointing *at* the node instead of disappearing under it. Direction comes from the curve's
 * tangent at the target end — for a quadratic that is simply (target − control), which is
 * why a bowed edge's arrow stays tangent to its arc.
 */
export function arrowHead(
  source: Point,
  target: Point,
  curvature: number,
  targetRadius: number,
  width: number,
): [Point, Point, Point] {
  const from = curvature ? curveControlPoint(source, target, curvature) : source
  const dx = target.x - from.x
  const dy = target.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length

  const head = Math.max(6, width * 3)
  const half = Math.max(2.5, width * 1.6)
  const tip = { x: target.x - ux * targetRadius, y: target.y - uy * targetRadius }
  const base = { x: tip.x - ux * head, y: tip.y - uy * head }
  return [
    tip,
    { x: base.x - uy * half, y: base.y + ux * half },
    { x: base.x + uy * half, y: base.y - ux * half },
  ]
}

export interface SvgNode {
  id: string
  /** Viewport pixels. */
  x: number
  y: number
  radius: number
  color: string
  /** Outline thickness in viewport pixels; the outline eats inward, as the shader's does. */
  borderWidth?: number | undefined
  label?: string | undefined
}

/**
 * Split an `#rrggbbaa` colour into a plain colour and an opacity.
 *
 * Sigma takes one colour per mark, so a constant link opacity is folded into the hex. An
 * eight-digit hex is valid CSS Color 4 and most renderers accept it, but an exported file
 * outlives the browser that made it — `stroke` plus `stroke-opacity` is understood by
 * everything back to SVG 1.1, including the illustration tools these end up in.
 */
export function splitAlpha(color: string): { color: string; opacity: number | undefined } {
  if (!/^#[0-9a-f]{8}$/i.test(color)) return { color, opacity: undefined }
  const alpha = Number.parseInt(color.slice(7), 16) / 255
  return { color: color.slice(0, 7), opacity: Math.round(alpha * 1000) / 1000 }
}

export interface SvgEdge {
  /** Indices into `nodes`. */
  source: number
  target: number
  width: number
  color: string
  curvature: number
  label?: string | undefined
}

export interface NetworkSvgSpec {
  /** Plot area, in CSS pixels; a legend strip is appended below it. */
  width: number
  height: number
  nodes: SvgNode[]
  edges: SvgEdge[]
  /** Draw arrowheads at the target end. Off for undirected networks. */
  arrows: boolean
  background: string
  nodeLabelColor: string
  edgeLabelColor: string
  font: string
  labelSize?: number
  edgeLabelSize?: number
  /** Outline colour shared by every node; per-node thickness lives on the node. */
  nodeBorderColor?: string
  legend?: Legend
  /** Becomes the SVG's `<title>`, which is also its accessible name. */
  title?: string
}

function element<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, typeof value === 'number' ? String(round(value)) : value)
  }
  return node
}

function text(
  content: string,
  attributes: Record<string, string | number>,
  outline?: string,
): SVGTextElement {
  const node = element('text', attributes)
  if (outline) {
    // Halo rather than a backing rect: labels sit on top of links, and a rect per label
    // would occlude the very geometry the label is annotating.
    node.setAttribute('stroke', outline)
    node.setAttribute('stroke-width', '3')
    node.setAttribute('paint-order', 'stroke')
    node.setAttribute('stroke-linejoin', 'round')
  }
  node.textContent = content
  return node
}

/**
 * Build a standalone `<svg>` of a network view.
 *
 * Draw order is edges → arrowheads → nodes → labels, matching sigma: links pass behind the
 * discs they connect, and text is never buried under a mark.
 */
export function networkToSvg(spec: NetworkSvgSpec): SVGSVGElement {
  const labelSize = spec.labelSize ?? 11
  const edgeLabelSize = spec.edgeLabelSize ?? 10
  const legendHeight = spec.legend ? LEGEND_HEIGHT : 0
  const width = Math.max(1, Math.round(spec.width))
  const height = Math.max(1, Math.round(spec.height))
  const total = height + legendHeight

  const svg = element('svg', {
    xmlns: SVG_NS,
    width,
    height: total,
    viewBox: `0 0 ${width} ${total}`,
    role: 'img',
  })

  if (spec.title) {
    const title = document.createElementNS(SVG_NS, 'title')
    title.textContent = spec.title
    svg.append(title)
  }

  // The font is inherited from a CSS variable on screen and has to be carried explicitly
  // here; every colour is already a literal hex, which is what keeps this export cheap.
  const style = document.createElementNS(SVG_NS, 'style')
  style.textContent = `text{font-family:${spec.font};}`
  svg.append(style)

  svg.append(element('rect', { x: 0, y: 0, width, height: total, fill: spec.background }))

  const clip = document.createElementNS(SVG_NS, 'clipPath')
  clip.setAttribute('id', 'coda-network-plot')
  clip.append(element('rect', { x: 0, y: 0, width, height }))
  const defs = document.createElementNS(SVG_NS, 'defs')
  defs.append(clip)
  svg.append(defs)

  const plot = element('g', { 'clip-path': 'url(#coda-network-plot)' })
  svg.append(plot)

  const links = element('g', { fill: 'none', 'stroke-linecap': 'round' })
  const heads = element('g', { stroke: 'none' })
  const discs = element('g', { stroke: 'none' })
  const edgeText = element('g', {
    'font-size': edgeLabelSize,
    fill: spec.edgeLabelColor,
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
  })
  const nodeText = element('g', {
    'font-size': labelSize,
    fill: spec.nodeLabelColor,
    'dominant-baseline': 'central',
  })

  for (const edge of spec.edges) {
    const source = spec.nodes[edge.source]
    const target = spec.nodes[edge.target]
    if (!source || !target || source === target) continue

    const ink = splitAlpha(edge.color)
    links.append(
      element('path', {
        d: edgePath(source, target, edge.curvature),
        stroke: ink.color,
        'stroke-width': Math.max(0.5, edge.width),
        ...(ink.opacity === undefined ? {} : { 'stroke-opacity': ink.opacity }),
      }),
    )

    if (spec.arrows) {
      const corners = arrowHead(source, target, edge.curvature, target.radius, edge.width)
      heads.append(
        element('polygon', {
          points: corners.map((p) => `${round(p.x)},${round(p.y)}`).join(' '),
          fill: ink.color,
          ...(ink.opacity === undefined ? {} : { 'fill-opacity': ink.opacity }),
        }),
      )
    }

    if (edge.label) {
      const at = curvePoint(source, target, edge.curvature, 0.5)
      edgeText.append(text(edge.label, { x: at.x, y: at.y }, spec.background))
    }
  }

  for (const node of spec.nodes) {
    // The outline is centred on a circle one half-width inside the node's radius, which is
    // how it ends up eating inward exactly as `@sigma/node-border`'s shader does.
    const width = node.borderWidth ?? 0
    const border: Record<string, string | number> =
      width > 0 && spec.nodeBorderColor
        ? { stroke: spec.nodeBorderColor, 'stroke-width': width }
        : {}
    discs.append(
      element('circle', {
        cx: node.x,
        cy: node.y,
        r: Math.max(0.5, node.radius - width / 2),
        fill: node.color,
        ...border,
      }),
    )
    if (node.label) {
      nodeText.append(
        text(node.label, { x: node.x + node.radius + 3, y: node.y }, spec.background),
      )
    }
  }

  plot.append(links, heads, discs, edgeText, nodeText)
  if (spec.legend) svg.append(drawLegend(spec.legend, width, height, spec))
  return svg
}

/**
 * Legend strip below the plot.
 *
 * Not optional decoration: colour carrying a category with no key is colour as the sole
 * channel, and the exported file has no caption bar to lean on.
 */
function drawLegend(
  legend: NonNullable<Legend>,
  width: number,
  top: number,
  spec: NetworkSvgSpec,
): SVGGElement {
  const group = element('g', {
    'font-size': 10,
    fill: spec.nodeLabelColor,
    'dominant-baseline': 'central',
  })
  const y = top + LEGEND_HEIGHT / 2
  let x = 8

  if (legend.kind === 'categorical') {
    for (const entry of legend.entries) {
      if (x > width - 40) break
      group.append(element('rect', { x, y: y - 4, width: 8, height: 8, rx: 2, fill: entry.color }))
      const label = text(entry.label, { x: x + 12, y })
      group.append(label)
      // No text metrics without layout, so advance by an estimate; 5.6px per character at
      // 10px is close enough for a strip that only has to avoid collisions.
      x += 12 + entry.label.length * 5.6 + 12
    }
    return group
  }

  const barWidth = 90
  const step = barWidth / legend.stops.length
  legend.stops.forEach((color, index) => {
    group.append(element('rect', { x: x + index * step, y: y - 4, width: step + 0.5, height: 8, fill: color }))
  })
  group.append(text(formatNumber(legend.domain[0]), { x, y: y + 10, 'font-size': 9 }))
  group.append(
    text(formatNumber(legend.domain[1]), {
      x: x + barWidth,
      y: y + 10,
      'font-size': 9,
      'text-anchor': 'end',
    }),
  )
  group.append(text(legend.column, { x: x + barWidth + 10, y }))
  return group
}
