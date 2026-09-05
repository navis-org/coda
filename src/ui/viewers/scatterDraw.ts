/**
 * Painting for the scatter plot: marker geometry, the canvas pass, and a standalone SVG of
 * the same view.
 *
 * Both consumers read one `ScatterSpec`, which is what makes the exported file the picture
 * on screen rather than a second drawing of the same data. The split follows `networkDraw`:
 * the screen is raster because fifty thousand DOM nodes is not a chart, and the export is
 * vector because an exported file outlives the browser that made it.
 *
 * Marker outlines are shared between the two through `markPath`, which emits an SVG path
 * `d`. Canvas takes the same string via `Path2D` only for the export preview; the hot path
 * traces directly, because a `Path2D` per point is fifty thousand allocations per frame.
 */

import type { MarkerShape } from '../encoding'
import { markVertices } from './markGeometry'
import { SVG_NS, element, round, svgRoot, textNode } from './svgElement'
import type { ScatterSpec } from './scatterPlot'
import { inverse } from './scatterPlot'
import { formatCompact } from '../format'

/** Height of the legend strip appended below an exported plot. */
const LEGEND_HEIGHT = 26

/** SVG path data for one mark. */
export function markPath(shape: MarkerShape, x: number, y: number, r: number): string {
  if (shape === 'circle') {
    // Two half-arcs: the only form that closes a full circle in a single subpath.
    return `M${round(x - r)},${round(y)}a${round(r)},${round(r)} 0 1,0 ${round(r * 2)},0a${round(r)},${round(r)} 0 1,0 ${round(-r * 2)},0Z`
  }
  const vertices = markVertices(shape)
  if (vertices.length === 0) return ''
  return `${vertices
    .map(
      ([vx, vy], index) =>
        `${index === 0 ? 'M' : 'L'}${round(x + vx! * r)},${round(y + vy! * r)}`,
    )
    .join('')}Z`
}

/** Add one mark to the current canvas path. No fill or stroke — the caller batches those. */
export function traceMark(
  context: CanvasRenderingContext2D,
  shape: MarkerShape,
  x: number,
  y: number,
  r: number,
): void {
  if (shape === 'circle') {
    context.moveTo(x + r, y)
    context.arc(x, y, r, 0, Math.PI * 2)
    return
  }
  const vertices = markVertices(shape)
  if (vertices.length === 0) return
  context.moveTo(x + vertices[0]![0]! * r, y + vertices[0]![1]! * r)
  for (let i = 1; i < vertices.length; i++) {
    context.lineTo(x + vertices[i]![0]! * r, y + vertices[i]![1]! * r)
  }
  context.closePath()
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

export interface PlotInk {
  primary: string
  secondary: string
  muted: string
  grid: string
  axis: string
}

export interface CanvasDrawOptions {
  spec: ScatterSpec
  ink: PlotInk
  background: string
  opacity: number
  /** The canvas box in CSS pixels — the plot rect is inset within it. */
  width: number
  height: number
  xLabel: string
  yLabel: string
  /** Indices into the spec's arrays that carry a selection ring. */
  selected?: Set<number>
  /** Index of the hovered mark, drawn on top with a ring. */
  hovered?: number
  compact?: boolean
  /** Device pixel ratio the context has already been scaled by. */
  showAxisTitles?: boolean
}

/**
 * Repaint the whole canvas.
 *
 * Marks are batched by `colour|shape`, one path and one fill per bucket. With a categorical
 * encoding that is at most nine buckets for any number of points, which is the difference
 * between a redraw that keeps up with a pan and one that does not. A sequential ramp defeats
 * the batching by construction — every value is its own colour — and is left to do so rather
 * than quantised, because quantising here would put a colour on screen that `resolveColor`
 * never returned.
 */
export function drawScatter(
  context: CanvasRenderingContext2D,
  options: CanvasDrawOptions,
): void {
  const { spec, ink, background, opacity, width, height } = options
  const { plot } = spec

  context.clearRect(0, 0, width, height)
  context.fillStyle = background
  context.fillRect(0, 0, width, height)

  // --- grid + axes -------------------------------------------------------
  context.lineWidth = 1
  context.strokeStyle = ink.grid
  context.beginPath()
  for (const tick of spec.xTicks) {
    const x = Math.round(projectTickX(spec, tick)) + 0.5
    if (x < plot.x || x > plot.x + plot.width) continue
    context.moveTo(x, plot.y)
    context.lineTo(x, plot.y + plot.height)
  }
  for (const tick of spec.yTicks) {
    const y = Math.round(projectTickY(spec, tick)) + 0.5
    if (y < plot.y || y > plot.y + plot.height) continue
    context.moveTo(plot.x, y)
    context.lineTo(plot.x + plot.width, y)
  }
  context.stroke()

  context.strokeStyle = ink.axis
  context.beginPath()
  context.moveTo(Math.round(plot.x) + 0.5, plot.y)
  context.lineTo(Math.round(plot.x) + 0.5, Math.round(plot.y + plot.height) + 0.5)
  context.lineTo(plot.x + plot.width, Math.round(plot.y + plot.height) + 0.5)
  context.stroke()

  // --- marks -------------------------------------------------------------
  context.save()
  context.beginPath()
  context.rect(plot.x, plot.y, plot.width, plot.height)
  context.clip()
  context.globalAlpha = Math.max(0.02, Math.min(1, opacity))

  const buckets = new Map<string, number[]>()
  for (let i = 0; i < spec.drawn; i++) {
    const key = `${spec.colors[i]}|${spec.shapes[i]}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(i)
    else buckets.set(key, [i])
  }
  for (const [key, indices] of buckets) {
    context.fillStyle = key.slice(0, key.lastIndexOf('|'))
    const shape = key.slice(key.lastIndexOf('|') + 1) as MarkerShape
    context.beginPath()
    for (const i of indices)
      traceMark(context, shape, spec.px[i]!, spec.py[i]!, spec.radius[i]!)
    context.fill()
  }

  // --- trend -------------------------------------------------------------
  context.globalAlpha = 1
  context.lineWidth = 1.5
  for (const trend of spec.trends) {
    context.strokeStyle = trend.color
    context.beginPath()
    context.moveTo(projectTickX(spec, trend.x0), projectTickY(spec, trend.y0))
    context.lineTo(projectTickX(spec, trend.x1), projectTickY(spec, trend.y1))
    context.stroke()
  }

  // --- selection and hover ------------------------------------------------
  // Achromatic, and a ring rather than a recolour: `--accent` is byte-identical to
  // categorical slot 0, so an accent ring would be invisible on exactly the points it marks.
  // Same finding as the network viewer's selection ring.
  context.lineWidth = 1.5
  context.strokeStyle = ink.primary
  if (options.selected && options.selected.size > 0) {
    context.beginPath()
    for (const i of options.selected) {
      if (i < 0 || i >= spec.drawn) continue
      const r = spec.radius[i]! + 2.5
      context.moveTo(spec.px[i]! + r, spec.py[i]!)
      context.arc(spec.px[i]!, spec.py[i]!, r, 0, Math.PI * 2)
    }
    context.stroke()
  }
  if (options.hovered !== undefined && options.hovered >= 0 && options.hovered < spec.drawn) {
    const i = options.hovered
    const r = spec.radius[i]! + 3.5
    context.beginPath()
    context.moveTo(spec.px[i]! + r, spec.py[i]!)
    context.arc(spec.px[i]!, spec.py[i]!, r, 0, Math.PI * 2)
    context.stroke()
  }
  context.restore()

  // --- tick labels --------------------------------------------------------
  // Drawn in `compact` too — see `MARGIN_COMPACT`. An axis line with no numbers against it is
  // decoration, and the card is where the scale is least obvious.
  context.fillStyle = ink.muted
  context.font = `${options.compact ? 9 : 9.5}px system-ui, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'top'
  for (const tick of spec.xTicks) {
    const x = projectTickX(spec, tick)
    if (x < plot.x - 1 || x > plot.x + plot.width + 1) continue
    context.fillText(
      formatCompact(inverse(spec.xScale, tick)),
      x,
      plot.y + plot.height + (options.compact ? 3 : 5),
    )
  }
  context.textAlign = 'right'
  context.textBaseline = 'middle'
  for (const tick of spec.yTicks) {
    const y = projectTickY(spec, tick)
    if (y < plot.y - 1 || y > plot.y + plot.height + 1) continue
    context.fillText(
      formatCompact(inverse(spec.yScale, tick)),
      plot.x - (options.compact ? 3 : 5),
      y,
    )
  }

  // Titles only where there is room below the ticks for them; the card's caption names the
  // columns already.
  if (!options.compact && options.showAxisTitles !== false) {
    context.fillStyle = ink.secondary
    context.font = '10px system-ui, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'bottom'
    context.fillText(options.xLabel, plot.x + plot.width / 2, plot.y + plot.height + 32)
    context.save()
    context.translate(10, plot.y + plot.height / 2)
    context.rotate(-Math.PI / 2)
    context.textBaseline = 'top'
    context.fillText(options.yLabel, 0, 0)
    context.restore()
  }
}

function projectTickX(spec: ScatterSpec, t: number): number {
  const span = spec.view.x.max - spec.view.x.min || 1
  return spec.plot.x + ((t - spec.view.x.min) / span) * spec.plot.width
}

function projectTickY(spec: ScatterSpec, t: number): number {
  const span = spec.view.y.max - spec.view.y.min || 1
  return spec.plot.y + spec.plot.height - ((t - spec.view.y.min) / span) * spec.plot.height
}

// ---------------------------------------------------------------------------
// SVG export
// ---------------------------------------------------------------------------

export interface LegendItem {
  label: string
  color?: string
  shape?: MarkerShape
}

export interface ScatterSvgSpec {
  spec: ScatterSpec
  width: number
  height: number
  background: string
  ink: PlotInk
  font: string
  opacity: number
  xLabel: string
  yLabel: string
  title?: string
  legend?: LegendItem[]
  /** Colour-bar stops for a sequential encoding, drawn instead of swatches. */
  ramp?: { label: string; stops: string[]; low: string; high: string }
}

/**
 * A standalone `<svg>` of the current view — pan, zoom, filters and all.
 *
 * Rebuilt from the spec rather than read back off the canvas: a 2D context can be read back,
 * but the result is a raster of whatever pixel ratio the screen happened to have, and the
 * whole reason the charts compute colours as literal hex in JS is that vector export is then
 * nearly free. Same doctrine as `networkToSvg`.
 */
export function scatterToSvg(options: ScatterSvgSpec): SVGSVGElement {
  const { spec, ink } = options
  const { plot } = spec
  const legendItems = options.legend ?? []
  const legendHeight = legendItems.length > 0 || options.ramp ? LEGEND_HEIGHT : 0
  const width = Math.max(1, Math.round(options.width))
  const height = Math.max(1, Math.round(options.height))

  const svg = svgRoot({
    width,
    height,
    strip: legendHeight,
    background: options.background,
    ...(options.title ? { title: options.title } : {}),
  })
  // The font is a CSS variable on screen and has to travel explicitly; every colour is
  // already a literal hex, which is what keeps this cheap.
  const style = document.createElementNS(SVG_NS, 'style')
  style.textContent = `text{font-family:${options.font};}`
  svg.append(style)

  // --- grid and axes ------------------------------------------------------
  const grid = element('g', { stroke: ink.grid, 'stroke-width': 1 })
  for (const tick of spec.xTicks) {
    const x = projectTickX(spec, tick)
    if (x < plot.x || x > plot.x + plot.width) continue
    grid.append(element('line', { x1: x, x2: x, y1: plot.y, y2: plot.y + plot.height }))
  }
  for (const tick of spec.yTicks) {
    const y = projectTickY(spec, tick)
    if (y < plot.y || y > plot.y + plot.height) continue
    grid.append(element('line', { x1: plot.x, x2: plot.x + plot.width, y1: y, y2: y }))
  }
  svg.append(grid)

  svg.append(
    element('path', {
      d: `M${round(plot.x)},${round(plot.y)}V${round(plot.y + plot.height)}H${round(plot.x + plot.width)}`,
      fill: 'none',
      stroke: ink.axis,
      'stroke-width': 1,
    }),
  )

  // --- marks --------------------------------------------------------------
  const clip = document.createElementNS(SVG_NS, 'clipPath')
  clip.setAttribute('id', 'coda-scatter-plot')
  clip.append(element('rect', { x: plot.x, y: plot.y, width: plot.width, height: plot.height }))
  const defs = document.createElementNS(SVG_NS, 'defs')
  defs.append(clip)
  svg.append(defs)

  const marks = element('g', {
    'clip-path': 'url(#coda-scatter-plot)',
    'fill-opacity': Math.max(0.02, Math.min(1, options.opacity)),
  })
  // One `<path>` per colour+shape bucket rather than per point: an SVG with fifty thousand
  // elements opens in nothing, where fifty thousand subpaths in nine elements opens anywhere.
  const buckets = new Map<string, string[]>()
  for (let i = 0; i < spec.drawn; i++) {
    const key = `${spec.colors[i]}|${spec.shapes[i]}`
    const d = markPath(spec.shapes[i]!, spec.px[i]!, spec.py[i]!, spec.radius[i]!)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(d)
    else buckets.set(key, [d])
  }
  for (const [key, paths] of buckets) {
    marks.append(
      element('path', { d: paths.join(''), fill: key.slice(0, key.lastIndexOf('|')) }),
    )
  }

  for (const trend of spec.trends) {
    marks.append(
      element('line', {
        x1: projectTickX(spec, trend.x0),
        y1: projectTickY(spec, trend.y0),
        x2: projectTickX(spec, trend.x1),
        y2: projectTickY(spec, trend.y1),
        stroke: trend.color,
        'stroke-width': 1.5,
        'fill-opacity': 1,
      }),
    )
  }
  svg.append(marks)

  // --- tick labels and axis titles ----------------------------------------
  const ticks = element('g', { 'font-size': 9.5, fill: ink.muted })
  for (const tick of spec.xTicks) {
    const x = projectTickX(spec, tick)
    if (x < plot.x - 1 || x > plot.x + plot.width + 1) continue
    ticks.append(
      textNode(formatCompact(inverse(spec.xScale, tick)), {
        x,
        y: plot.y + plot.height + 13,
        'text-anchor': 'middle',
      }),
    )
  }
  for (const tick of spec.yTicks) {
    const y = projectTickY(spec, tick)
    if (y < plot.y - 1 || y > plot.y + plot.height + 1) continue
    ticks.append(
      textNode(formatCompact(inverse(spec.yScale, tick)), {
        x: plot.x - 5,
        y,
        'text-anchor': 'end',
        'dominant-baseline': 'central',
      }),
    )
  }
  svg.append(ticks)

  const titles = element('g', { 'font-size': 10, fill: ink.secondary })
  titles.append(
    textNode(options.xLabel, {
      x: plot.x + plot.width / 2,
      y: plot.y + plot.height + 30,
      'text-anchor': 'middle',
    }),
  )
  titles.append(
    textNode(options.yLabel, {
      x: 0,
      y: 0,
      'text-anchor': 'middle',
      transform: `translate(11 ${round(plot.y + plot.height / 2)}) rotate(-90)`,
    }),
  )
  svg.append(titles)

  // --- legend -------------------------------------------------------------
  if (legendHeight > 0) {
    const legend = element('g', { 'font-size': 10, fill: ink.secondary })
    let cursor = plot.x
    const baseline = height + LEGEND_HEIGHT / 2
    if (options.ramp) {
      const gradient = document.createElementNS(SVG_NS, 'linearGradient')
      gradient.setAttribute('id', 'coda-scatter-ramp')
      options.ramp.stops.forEach((stop, index) => {
        gradient.append(
          element('stop', {
            offset: `${(index / Math.max(1, options.ramp!.stops.length - 1)) * 100}%`,
            'stop-color': stop,
          }),
        )
      })
      defs.append(gradient)
      legend.append(
        textNode(options.ramp.label, {
          x: cursor,
          y: baseline,
          'dominant-baseline': 'central',
        }),
      )
      cursor += options.ramp.label.length * 5.6 + 8
      legend.append(
        textNode(options.ramp.low, { x: cursor, y: baseline, 'dominant-baseline': 'central' }),
      )
      cursor += options.ramp.low.length * 5.6 + 5
      legend.append(
        element('rect', {
          x: cursor,
          y: baseline - 4,
          width: 60,
          height: 8,
          fill: 'url(#coda-scatter-ramp)',
          rx: 2,
        }),
      )
      cursor += 66
      legend.append(
        textNode(options.ramp.high, { x: cursor, y: baseline, 'dominant-baseline': 'central' }),
      )
      cursor += options.ramp.high.length * 5.6 + 14
    }
    for (const item of legendItems) {
      if (item.shape) {
        legend.append(
          element('path', {
            d: markPath(item.shape, cursor + 4, baseline, 4),
            fill: item.color ?? ink.secondary,
          }),
        )
      } else {
        legend.append(
          element('rect', {
            x: cursor,
            y: baseline - 4,
            width: 8,
            height: 8,
            rx: 2,
            fill: item.color ?? ink.muted,
          }),
        )
      }
      legend.append(
        textNode(item.label, { x: cursor + 12, y: baseline, 'dominant-baseline': 'central' }),
      )
      cursor += 12 + item.label.length * 5.6 + 12
    }
    svg.append(legend)
  }

  return svg
}
