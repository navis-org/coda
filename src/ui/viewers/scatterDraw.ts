/**
 * Painting for the scatter plot: marker geometry, the canvas pass, and a standalone SVG of
 * the same view.
 *
 * Both consumers read one `ScatterSpec`, which is what makes the exported file the picture
 * on screen rather than a second drawing of the same data. The split follows `networkDraw`:
 * the screen is raster because fifty thousand DOM nodes is not a chart, and the export is
 * vector because an exported file outlives the browser that made it.
 *
 * Past `CIRCLES_MAX` visible marks both change hands: the canvas writes pixels
 * (`scatterRaster.ts`) rather than tracing paths, and the export carries the plot area as one
 * embedded image while axes, ticks, labels and legend stay vector — matplotlib's `rasterized=True`,
 * because a file of a hundred thousand vector marks opens in almost nothing. `vectorMarks`
 * opts back into every mark as a shape.
 *
 * Marker outlines are shared between the two through `markPath`, which emits an SVG path
 * `d`. Canvas takes the same string via `Path2D` only for the export preview; the hot path
 * traces directly, because a `Path2D` per point is fifty thousand allocations per frame.
 */

import type { MarkerShape } from '../encoding'
import { markVertices } from './markGeometry'
import { SVG_NS, XLINK_NS, element, round, svgRoot, textNode } from './svgElement'
import type { ScatterSpec } from './scatterPlot'
import {
  drawsPixels,
  inverse,
  markAlpha,
  projectX,
  projectY,
  reachesPlot,
  visibleBuckets,
} from './scatterPlot'
import { RING_GAP, RING_WIDTH, rasterBox, rasterizeMarks } from './scatterRaster'
import { drawMarksGl } from './scatterGl'
import { formatCompact } from '../format'

/** Height of the legend strip appended below an exported plot. */
const LEGEND_HEIGHT = 26

/** Gap between a hovered mark and its ring, wider than the selection's so both can show. */
const HOVER_GAP = 3.5

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
  /** Positions in `spec.marks` that carry a selection ring. */
  selected?: Set<number>
  /** Index of the hovered mark, drawn on top with a ring. */
  hovered?: number
  compact?: boolean
  showAxisTitles?: boolean
}

/**
 * Repaint the whole canvas.
 *
 * Marks are batched by `colour|shape`, one path and one fill per bucket. With a categorical
 * encoding that is at most nine buckets for any number of points, which is the difference
 * between a redraw that keeps up with a pan and one that does not. A sequential ramp batches
 * less well — up to `RAMP_STEPS` buckets, since `resolveColor` reads it from the shared lookup
 * table — and nothing here quantises further, because a coarser step would put a colour on
 * screen that `resolveColor` never returned.
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

  // --- grid ---------------------------------------------------------------
  const grid = gridLines(spec)
  context.lineWidth = 1
  context.strokeStyle = ink.grid
  context.beginPath()
  for (const x of grid.xs) {
    context.moveTo(x + 0.5, plot.y)
    context.lineTo(x + 0.5, plot.y + plot.height)
  }
  for (const y of grid.ys) {
    context.moveTo(plot.x, y + 0.5)
    context.lineTo(plot.x + plot.width, y + 0.5)
  }
  context.stroke()

  // --- marks -------------------------------------------------------------
  context.save()
  context.beginPath()
  context.rect(plot.x, plot.y, plot.width, plot.height)
  context.clip()

  const pixels = drawsPixels(spec)
  const rings = ringed(spec, options.selected)
  if (pixels) {
    drawPixels(context, spec, rings, options)
  } else {
    images.delete(context)
    context.globalAlpha = markAlpha(opacity)
    for (const bucket of visibleBuckets(spec)) {
      context.fillStyle = bucket.color
      context.beginPath()
      for (const i of bucket.indices)
        traceMark(context, bucket.shape, spec.px[i]!, spec.py[i]!, spec.marks.radius[i]!)
      context.fill()
    }
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
  // Same finding as the network viewer's selection ring. In the pixel pass the rings are
  // stamped with the marks, a selection there being as large as the cloud.
  context.lineWidth = RING_WIDTH
  context.strokeStyle = ink.primary
  if (!pixels && rings.length > 0) {
    context.beginPath()
    for (const i of rings) {
      const r = spec.marks.radius[i]! + RING_GAP
      context.moveTo(spec.px[i]! + r, spec.py[i]!)
      context.arc(spec.px[i]!, spec.py[i]!, r, 0, Math.PI * 2)
    }
    context.stroke()
  }
  if (
    options.hovered !== undefined &&
    options.hovered >= 0 &&
    options.hovered < spec.marks.rows.length
  ) {
    const i = options.hovered
    const r = spec.marks.radius[i]! + HOVER_GAP
    context.beginPath()
    context.moveTo(spec.px[i]! + r, spec.py[i]!)
    context.arc(spec.px[i]!, spec.py[i]!, r, 0, Math.PI * 2)
    context.stroke()
  }
  context.restore()

  // Over the marks, so a pass that replaces the plot's pixels cannot cover the axis line.
  strokeAxes(context, spec, ink)

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
      formatCompact(inverse(spec.marks.xScale, tick)),
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
      formatCompact(inverse(spec.marks.yScale, tick)),
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

/**
 * The selected marks whose ring reaches the plot — worked out once, for whichever painter draws
 * them. Zoomed in on a whole-cloud selection, everything else is off screen and would be work.
 */
function ringed(spec: ScatterSpec, selected: Set<number> | undefined): number[] {
  const out: number[] = []
  if (!selected) return out
  for (const i of selected) {
    if (i < 0 || i >= spec.marks.rows.length) continue
    if (reachesPlot(spec.plot, spec.px[i]!, spec.py[i]!, spec.marks.radius[i]!, RING_GAP))
      out.push(i)
  }
  return out
}

/** Grid line positions inside the plot, in whole CSS pixels — one list for both passes. */
function gridLines(spec: ScatterSpec): { xs: number[]; ys: number[] } {
  const { plot } = spec
  const xs: number[] = []
  const ys: number[] = []
  for (const tick of spec.xTicks) {
    const x = Math.round(projectTickX(spec, tick))
    if (x + 0.5 >= plot.x && x + 0.5 <= plot.x + plot.width) xs.push(x)
  }
  for (const tick of spec.yTicks) {
    const y = Math.round(projectTickY(spec, tick))
    if (y + 0.5 >= plot.y && y + 0.5 <= plot.y + plot.height) ys.push(y)
  }
  return { xs, ys }
}

function strokeAxes(context: CanvasRenderingContext2D, spec: ScatterSpec, ink: PlotInk): void {
  const { plot } = spec
  context.lineWidth = 1
  context.strokeStyle = ink.axis
  context.beginPath()
  context.moveTo(Math.round(plot.x) + 0.5, plot.y)
  context.lineTo(Math.round(plot.x) + 0.5, Math.round(plot.y + plot.height) + 0.5)
  context.lineTo(plot.x + plot.width, Math.round(plot.y + plot.height) + 0.5)
  context.stroke()
}

/**
 * The `ImageData` each canvas's CPU pixel pass writes, kept between frames: a full viewer at 2×
 * is ~15 MB, and allocating it per pan step was garbage the collector then paused for. Dropped
 * when a frame goes back to paths.
 */
const images = new WeakMap<CanvasRenderingContext2D, ImageData>()

/** Run the CPU raster over the plot box into `image` — the one spelling for screen and export. */
function rasterInto(
  image: ImageData,
  box: ReturnType<typeof rasterBox>,
  ratio: number,
  spec: ScatterSpec,
  options: { opacity: number; background: string; ink: PlotInk },
  ring?: { indices: number[]; color: string },
): void {
  rasterizeMarks(
    { pixels: new Uint32Array(image.data.buffer), ...box },
    {
      spec,
      ratio,
      opacity: options.opacity,
      background: options.background,
      grid: { color: options.ink.grid, ...gridLines(spec) },
      ...(ring ? { ring } : {}),
    },
  )
}

/**
 * The pass past `CIRCLES_MAX`: the shared WebGL context where there is one (`scatterGl.ts`),
 * composited over the grid this canvas already drew; otherwise the CPU raster, which writes the
 * plot box whole — background, grid and marks — in one `putImageData`, a call that replaces
 * rather than composites and so has to carry the grid itself.
 */
function drawPixels(
  context: CanvasRenderingContext2D,
  spec: ScatterSpec,
  rings: number[],
  options: CanvasDrawOptions,
): void {
  // The transform `prepareCanvas` set is device ratio times any card zoom: the ratio this
  // buffer has to match to land one to one on the backing store.
  const ratio = typeof context.getTransform === 'function' ? context.getTransform().a || 1 : 1
  const box = rasterBox(spec.plot, ratio)
  const ring = rings.length > 0 ? { indices: rings, color: options.ink.primary } : undefined
  if (
    drawMarksGl(context, {
      spec,
      ratio,
      box,
      opacity: options.opacity,
      ...(ring ? { ring } : {}),
    })
  )
    return

  let image = images.get(context)
  if (!image || image.width !== box.width || image.height !== box.height) {
    image = context.createImageData(box.width, box.height)
    images.set(context, image)
  }
  rasterInto(image, box, ratio, spec, options, ring)
  // Device pixels, transform and clip both ignored.
  context.putImageData(image, box.originX, box.originY)
}

/** How much finer than the screen an exported image of the marks is drawn. */
const EXPORT_RASTER_SCALE = 4

/**
 * The plot box as one PNG, for an export past `CIRCLES_MAX` — background and grid included, the
 * pixel pass being opaque. Undefined where the browser cannot encode one, jsdom among them, and
 * the export then falls back to vector marks rather than to none.
 */
function marksImage(
  spec: ScatterSpec,
  options: ScatterSvgSpec,
): { href: string; x: number; y: number; width: number; height: number } | undefined {
  try {
    const box = rasterBox(spec.plot, EXPORT_RASTER_SCALE)
    const canvas = document.createElement('canvas')
    canvas.width = box.width
    canvas.height = box.height
    const context = canvas.getContext('2d')
    if (!context) return undefined
    const image = context.createImageData(box.width, box.height)
    rasterInto(image, box, EXPORT_RASTER_SCALE, spec, options)
    context.putImageData(image, 0, 0)
    const href = canvas.toDataURL('image/png')
    if (typeof href !== 'string' || !href.startsWith('data:image/png')) return undefined
    return {
      href,
      x: box.originX / EXPORT_RASTER_SCALE,
      y: box.originY / EXPORT_RASTER_SCALE,
      width: box.width / EXPORT_RASTER_SCALE,
      height: box.height / EXPORT_RASTER_SCALE,
    }
  } catch {
    return undefined
  }
}

/** A tick or trend end in transformed space → pixels, through the one projection. */
function projectTickX(spec: ScatterSpec, t: number): number {
  return projectX(t, spec.view, spec.plot)
}

function projectTickY(spec: ScatterSpec, t: number): number {
  return projectY(t, spec.view, spec.plot)
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
  /** Every mark as a vector shape, even past `CIRCLES_MAX`. */
  vectorMarks?: boolean
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

  // Decided first: past `CIRCLES_MAX` the plot area is one opaque image carrying its own grid,
  // and a vector grid under it would be written into the file and never seen.
  const image =
    !options.vectorMarks && drawsPixels(spec) ? marksImage(spec, options) : undefined

  // --- grid ---------------------------------------------------------------
  if (!image) {
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
  }

  // --- marks --------------------------------------------------------------
  const clip = document.createElementNS(SVG_NS, 'clipPath')
  clip.setAttribute('id', 'coda-scatter-plot')
  clip.append(element('rect', { x: plot.x, y: plot.y, width: plot.width, height: plot.height }))
  const defs = document.createElementNS(SVG_NS, 'defs')
  defs.append(clip)
  svg.append(defs)

  const marks = element('g', {
    'clip-path': 'url(#coda-scatter-plot)',
    'fill-opacity': markAlpha(options.opacity),
  })
  if (image) {
    // The opacity is in the pixels already; the group's `fill-opacity` does not reach an image.
    // `xlink:href` beside `href`, the older spelling being the only one Illustrator reads.
    const { href, ...box } = image
    const node = element('image', { ...box, href, preserveAspectRatio: 'none' })
    node.setAttributeNS(XLINK_NS, 'xlink:href', href)
    marks.append(node)
  } else {
    // One `<path>` per colour+shape bucket rather than per point: an SVG with fifty thousand
    // elements opens in nothing, where fifty thousand subpaths in nine elements opens anywhere.
    for (const bucket of visibleBuckets(spec)) {
      const d = bucket.indices
        .map((i) => markPath(bucket.shape, spec.px[i]!, spec.py[i]!, spec.marks.radius[i]!))
        .join('')
      marks.append(element('path', { d, fill: bucket.color }))
    }
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

  // Over the marks, as on screen, so the image cannot cover the inner half of the axis line.
  svg.append(
    element('path', {
      d: `M${round(plot.x)},${round(plot.y)}V${round(plot.y + plot.height)}H${round(plot.x + plot.width)}`,
      fill: 'none',
      stroke: ink.axis,
      'stroke-width': 1,
    }),
  )

  // --- tick labels and axis titles ----------------------------------------
  const ticks = element('g', { 'font-size': 9.5, fill: ink.muted })
  for (const tick of spec.xTicks) {
    const x = projectTickX(spec, tick)
    if (x < plot.x - 1 || x > plot.x + plot.width + 1) continue
    ticks.append(
      textNode(formatCompact(inverse(spec.marks.xScale, tick)), {
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
      textNode(formatCompact(inverse(spec.marks.yScale, tick)), {
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
