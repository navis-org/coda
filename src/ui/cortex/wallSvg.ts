/**
 * The Cortex gallery's wall as an SVG document — what its PNG and SVG downloads are made from.
 *
 * The wall on screen is canvases, so there is no DOM to clone; this synthesises the picture the
 * way `heatmapToSvg` does, on `svgElement.ts`' builders. It places everything through the canvas's
 * own geometry — `layoutWall`'s placements, `layerBands`, `cellMapping`, `cellInks` — so a figure
 * is the wall rather than a second drawing of it, and it draws the **whole** wall, every row,
 * where the screen shows the rows scrolled into view. The selection is not drawn: it is a state of
 * the card, not part of the figure.
 *
 * **Size is the cost of vectors.** A cell is its skeleton's every segment, so consecutive segments
 * of one branch are joined into one run of `L`s and coordinates round to a tenth of a pixel; a
 * wall of detailed reconstructions is still several megabytes. The PNG is rasterised from this.
 */

import type { CorticalFrame } from '../../packs/cortex/frames'
import type { Mode } from '../colors'
import { CHART_INK, chartSurface } from '../colors'
import { uiFontFamily } from '../viewers/canvas2d'
import { element, SVG_NS, svgRoot, textNode } from '../viewers/svgElement'
import type { CellGeometry, RowMetrics, RowScale, WallLayout } from './wall'
import { cellInks, cellMapping, INK_ORDER, layerBands, piaY, SOMA_RADIUS } from './wall'

/** One run of the legend: an optional heading, its keys, and how many keys it had no room for. */
export interface LegendGroup {
  title?: string
  entries: readonly { label: string; color: string }[]
  more?: number
}

/** What the figure says about itself — asked for only when somebody exports. */
export interface WallFigure {
  title: string
  legend: readonly LegendGroup[]
  /** A closing remark on the legend line — `colours repeat`. */
  note?: string
}

export interface WallPicture extends WallFigure {
  frame: CorticalFrame
  layout: WallLayout
  /** Per cell, in `layout.cells`' order: its stripe colours, the group's first. */
  stripes: readonly (readonly string[])[]
  geometries: readonly (CellGeometry | undefined)[]
  /** Per cell, the arbour's own width — its canvas — centred in its place, clipped to it. */
  drawn: readonly number[]
  scale: RowScale
  /** How a row stacks — the wall's own `rowMetrics`, so the figure and the screen agree. */
  metrics: RowMetrics
  width: number
  mode: Mode
}

/** One placed item of the legend: a swatch and its label, or bare text where `color` is empty. */
interface LegendItem {
  x: number
  text: string
  color: string
}

const FONT = 11
const LEGEND_ROW = 16
const SWATCH = 9
/** A character's advance at `FONT`, for wrapping the legend with nothing laid out to measure. */
const CHAR = FONT * 0.6

export function wallToSvg(picture: WallPicture): SVGSVGElement {
  const { layout, mode } = picture
  const { height, stride, head, labelHeight, stripe } = picture.metrics
  const ink = CHART_INK[mode]
  const body = layout.rows * stride
  const legend = legendRows(picture.legend, picture.note, picture.width)
  const svg = svgRoot({
    width: picture.width,
    height: body,
    strip: legend.length * LEGEND_ROW + 8,
    background: chartSurface(mode),
    title: picture.title,
  })
  // The live wall's face travels explicitly: a detached document resolves no CSS variable, and the
  // serializer would otherwise write `sans-serif` (`heatmapToSvg`'s rule).
  const style = document.createElementNS(SVG_NS, 'style')
  style.textContent = `text{font-family:${uiFontFamily()};}`
  svg.append(style)
  const defs = document.createElementNS(SVG_NS, 'defs')
  svg.append(defs)

  // Each row's bands under its cells, the layers named at its left.
  const bands = layerBands(picture.frame, picture.scale, height)
  layout.rulers.forEach((ruler, r) => {
    const id = `band-${r}`
    defs.append(clip(id, ruler.width, height))
    const row = element('g', {
      transform: `translate(${ruler.x} ${ruler.row * stride + head})`,
      'clip-path': `url(#${id})`,
    })
    for (const band of bands) {
      if (band.filled) {
        row.append(
          element('rect', {
            x: 0,
            y: band.from,
            width: ruler.width,
            height: band.to - band.from,
            fill: ink.grid,
          }),
        )
      }
      row.append(
        textNode(band.name, {
          x: 4,
          y: band.labelY,
          'font-size': 10,
          'dominant-baseline': 'middle',
          fill: ink.muted,
        }),
      )
    }
    const pia = piaY(picture.scale) + 0.5
    row.append(element('line', { x1: 0, y1: pia, x2: ruler.width, y2: pia, stroke: ink.axis }))
    svg.append(row)
  })

  for (const label of layout.labels) {
    svg.append(
      textNode(label.text, {
        x: label.x,
        y: label.row * stride + 12,
        'font-size': FONT,
        fill: ink.secondary,
      }),
    )
  }

  const inks = cellInks(mode)
  layout.cells.forEach((place, i) => {
    if (!place) return
    const top = place.row * stride
    picture.stripes[i]?.forEach((color, k) => {
      if (!color) return
      svg.append(
        element('rect', {
          x: place.x,
          y: top + labelHeight + k * stripe,
          width: place.width,
          height: stripe,
          fill: color,
        }),
      )
    })
    const geometry = picture.geometries[i]
    if (!geometry) return
    const drawn = picture.drawn[i]!
    const id = `cell-${i}`
    // Clipped to the column where the column is narrower than the arbour — even mode — as the
    // card's button clips its canvas; to the canvas's own box otherwise.
    const shown = Math.min(drawn, place.width)
    defs.append(clip(id, shown, height, (drawn - shown) / 2))
    const cell = element('g', {
      transform: `translate(${place.x + (place.width - drawn) / 2} ${top + head})`,
      'clip-path': `url(#${id})`,
    })
    const { x, y } = cellMapping(picture.scale, drawn)
    for (const which of INK_ORDER) {
      const d = segmentsPath(geometry.segments[which], x, y)
      if (!d) continue
      cell.append(
        element('path', {
          d,
          fill: 'none',
          stroke: inks[which],
          'stroke-width': 1,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      )
    }
    cell.append(
      element('circle', {
        cx: x(0),
        cy: y(geometry.somaDepth),
        r: SOMA_RADIUS,
        fill: inks.soma,
      }),
    )
    svg.append(cell)
  })

  legend.forEach((items, r) => {
    const baseline = body + 4 + r * LEGEND_ROW + LEGEND_ROW / 2
    for (const item of items) {
      if (item.color) {
        svg.append(
          element('rect', {
            x: item.x,
            y: baseline - SWATCH / 2,
            width: SWATCH,
            height: SWATCH,
            fill: item.color,
          }),
        )
      }
      svg.append(
        textNode(item.text, {
          x: item.x + (item.color ? SWATCH + 4 : 0),
          y: baseline,
          'font-size': FONT,
          'dominant-baseline': 'middle',
          fill: item.color ? ink.secondary : ink.muted,
        }),
      )
    }
  })
  return svg
}

function clip(id: string, width: number, height: number, x = 0): SVGClipPathElement {
  const path = element('clipPath', { id })
  path.append(element('rect', { x, y: 0, width, height }))
  return path
}

/**
 * A bucket of segments as one path: each segment is a child and its parent, and a branch walked
 * in order has each segment's parent at the previous one's child — so a run continues with `L`
 * rather than starting again with `M`, which is most of what keeps a skeleton's path small.
 */
function segmentsPath(
  segments: Float32Array,
  x: (lateral: number) => number,
  y: (depth: number) => number,
): string {
  const parts: string[] = []
  let lastX = NaN
  let lastY = NaN
  for (let o = 0; o < segments.length; o += 4) {
    const fromX = tenth(x(segments[o + 2]!))
    const fromY = tenth(y(segments[o + 3]!))
    const toX = tenth(x(segments[o]!))
    const toY = tenth(y(segments[o + 1]!))
    if (fromX !== lastX || fromY !== lastY) parts.push(`M${fromX} ${fromY}`)
    parts.push(`L${toX} ${toY}`)
    lastX = toX
    lastY = toY
  }
  return parts.join('')
}

const tenth = (value: number) => Math.round(value * 10) / 10

/** The legend's items placed into rows `width` wide, wrapped by an estimated text width. */
function legendRows(
  groups: readonly LegendGroup[],
  note: string | undefined,
  width: number,
): LegendItem[][] {
  const items: { text: string; color: string }[] = []
  for (const group of groups) {
    if (group.title) items.push({ text: group.title, color: '' })
    for (const entry of group.entries) items.push({ text: entry.label, color: entry.color })
    if (group.more) items.push({ text: `+${group.more} more`, color: '' })
  }
  if (note) items.push({ text: note, color: '' })
  const rows: LegendItem[][] = []
  let row: LegendItem[] = []
  let x = 0
  for (const item of items) {
    const advance = (item.color ? SWATCH + 4 : 0) + item.text.length * CHAR + 12
    if (row.length > 0 && x + advance > width) {
      rows.push(row)
      row = []
      x = 0
    }
    row.push({ x, ...item })
    x += advance
  }
  if (row.length > 0) rows.push(row)
  return rows
}
