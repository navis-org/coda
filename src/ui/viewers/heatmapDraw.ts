/**
 * Painting for the matrix heatmap: the canvas pass, and a standalone SVG of the same view.
 *
 * Both read one `HeatmapSpec`, which is what makes the exported file the picture on screen
 * rather than a second drawing of the same data — `scatterDraw`'s arrangement, for
 * `scatterDraw`'s reason.
 *
 * **The canvas is painted as an image, one pixel per grid cell, blitted up to the plot.** It
 * used to be rectangles batched by ramp bucket — one path and one fill per bucket, a bounded
 * number of fills for any number of cells — and the *recording* of that is cheap: 8 ms for
 * 160,000 cells, measured. What it hides is the raster. A 2D context records commands and
 * rasterises them at the frame, so 160,000 anti-aliased rectangle edges cost the frame ~250 ms
 * that no `performance.measure` around `fill()` could see. The fit pays that once and nobody
 * notices; a wheel zoom pays it per event, and on a 401 × 401 matrix the gesture was unusable
 * until the visible block fell below about 100 lines. Measured in a browser with marks around
 * every JavaScript stage: spec 3 ms, chrome 0 ms, paint 8 ms, frame 264 ms.
 *
 * So the grid goes into an `ImageData` — four byte writes a cell, alpha zero where nothing
 * finite landed so the surface shows through — onto a scratch canvas of the grid's own size,
 * and one `drawImage` with smoothing off scales it to the plot. Nearest-neighbour is exactly
 * the picture the rectangles drew: a grid cell is a block of the same colour, edges on pixels.
 * The 1px separator, where cells are big enough to earn one, is drawn *over* it as lines of
 * background — two per line of the grid, never one per cell.
 *
 * **The exported SVG keeps the batched paths**, which is what keeps it openable: at one grid
 * cell per pixel a full-width plot is ~285,000 cells, and 285,000 `<rect>` elements is a file
 * nothing opens where 285,000 subpaths inside 512 `<path>` elements opens anywhere. An image in
 * an SVG would be a raster in a vector file, which is the one thing the export exists not to be.
 */

import { axisMarks, clipZones, drawnCellSize, valueMarks } from './heatmapPlot'
import type { HeatmapSpec, TextMark } from './heatmapPlot'
import { parseHex } from '../colors'
import type { PlotInk } from './scatterDraw'
import { SVG_NS, element, round, svgRoot, textNode } from './svgElement'

/**
 * Every drawn cell's top-left corner, grouped by ramp bucket: `[x0, y0, x1, y1, …]` — the SVG
 * export's batching, one `<path>` per bucket.
 *
 * Flat numbers rather than a rectangle object per cell, and corners rather than rectangles,
 * because **every cell is the same size** — so width and height are read off the spec once
 * instead of being stored a million times: ~900,000 short-lived arrays per walk against none.
 * Memoised against the spec in a `WeakMap` rather than a field on it, so the painter's private
 * business stays out of the headless module and it is collected with the spec —
 * `rowFields.ts`'s `slotCache` idiom. It was the canvas's batching too, until the raster cost
 * of the rectangles was measured (see the module comment); the canvas now blits an image.
 */
const CORNERS = new WeakMap<HeatmapSpec, Map<number, number[]>>()

function cornersByBucket(spec: HeatmapSpec): Map<number, number[]> {
  const cached = CORNERS.get(spec)
  if (cached) return cached
  const buckets = new Map<number, number[]>()
  CORNERS.set(spec, buckets)
  const { width, height } = drawnCellSize(spec)
  if (width <= 0 || height <= 0) return buckets
  // Off the axis maps rather than the plot's corner: zoomed, the grid starts before the plot's
  // edge by the fraction of a line the window begins into, and the painter clips.
  for (let gy = 0; gy < spec.gridRows; gy++) {
    const y = spec.rowMap.origin + gy * spec.cellHeight
    const rowStart = gy * spec.gridCols
    for (let gx = 0; gx < spec.gridCols; gx++) {
      const bucket = spec.buckets[rowStart + gx]!
      // -1 is a block nothing finite landed in: the surface shows through, which says "not
      // recorded" rather than painting it as the bottom of the scale.
      if (bucket < 0) continue
      const corners = buckets.get(bucket)
      const x = spec.colMap.origin + gx * spec.cellWidth
      if (corners) corners.push(x, y)
      else buckets.set(bucket, [x, y])
    }
  }
  return buckets
}

/**
 * The ramp as bytes, for the pixel writes: parsing 512 hex strings once per ramp rather than
 * once per cell. Keyed by the ramp array, which `rampColors` produces fresh only when the scale,
 * the mode or the palette changes.
 */
const RAMP_BYTES = new WeakMap<string[], Uint8ClampedArray>()

function rampBytes(ramp: string[]): Uint8ClampedArray {
  const cached = RAMP_BYTES.get(ramp)
  if (cached) return cached
  const bytes = new Uint8ClampedArray(ramp.length * 4)
  ramp.forEach((hex, i) => {
    const [r, g, b] = parseHex(hex)
    bytes[i * 4] = r
    bytes[i * 4 + 1] = g
    bytes[i * 4 + 2] = b
    bytes[i * 4 + 3] = 255
  })
  RAMP_BYTES.set(ramp, bytes)
  return bytes
}

/**
 * The grid as pixels, memoised against the spec *and* the ramp it was coloured with — a theme
 * flip changes the ramp and not the spec, and must repaint rather than serve the old colours.
 */
const PIXELS = new WeakMap<HeatmapSpec, { ramp: string[]; image: ImageData }>()

function gridImage(spec: HeatmapSpec, ramp: string[]): ImageData {
  const cached = PIXELS.get(spec)
  if (cached && cached.ramp === ramp) return cached.image
  // From an explicit buffer rather than `new ImageData(w, h)`: the same object in a browser,
  // and the one form the test double in `jsdomStubs.ts` constructs.
  const image = new ImageData(
    new Uint8ClampedArray(spec.gridCols * spec.gridRows * 4),
    spec.gridCols,
    spec.gridRows,
  )
  const bytes = rampBytes(ramp)
  const data = image.data
  const last = ramp.length - 1
  for (let i = 0; i < spec.buckets.length; i++) {
    const bucket = spec.buckets[i]!
    // -1 is a block nothing finite landed in: left transparent, the surface shows through,
    // which says "not recorded" rather than painting it as the bottom of the scale.
    if (bucket < 0) continue
    const b = Math.min(last, bucket) * 4
    const o = i * 4
    data[o] = bytes[b]!
    data[o + 1] = bytes[b + 1]!
    data[o + 2] = bytes[b + 2]!
    data[o + 3] = 255
  }
  PIXELS.set(spec, { ramp, image })
  return image
}

/** One scratch canvas the size of the grid, reused across paints; `width =` clears it. */
let scratch: HTMLCanvasElement | OffscreenCanvas | undefined

function scratchContext(
  width: number,
  height: number,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  if (!scratch) {
    scratch =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : document.createElement('canvas')
  }
  if (scratch.width !== width) scratch.width = width
  if (scratch.height !== height) scratch.height = height
  return scratch.getContext('2d') as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
}

export interface HeatmapCanvasOptions {
  spec: HeatmapSpec
  /** Hex per ramp bucket — `rampColors(scale, mode)`. */
  ramp: string[]
  background: string
  /** The canvas box in CSS pixels; the plot rect is inset within it. */
  width: number
  height: number
}

/**
 * Repaint the cells.
 *
 * Cells only: the axis labels, the printed values and the hover outline live in an SVG overlay
 * above this canvas. That split is deliberate and is not the scatter's — there the tick labels
 * are painted because a scatter's marks and its chrome are the same order of magnitude, where
 * here the cells are unbounded and the labels are bounded by *pixels*, since only so many 10px
 * names fit down an edge however large the matrix is. Keeping the bounded half in the DOM costs
 * nothing and buys real text: selectable, findable, read out by a screen reader, and laid out
 * by the browser rather than by `measureText`. It also keeps a hover free of a repaint.
 */
export function drawHeatmap(
  context: CanvasRenderingContext2D,
  options: HeatmapCanvasOptions,
): void {
  const { spec, ramp, width, height } = options

  // No `clearRect`: the fill below is opaque and covers the same box, and at DPR 2 on a
  // 1400x700 plot each pass is 3.9 million pixels.
  context.fillStyle = options.background
  context.fillRect(0, 0, width, height)

  // Clipped to the plot: a zoomed window starts mid-cell, and the partial cell at each edge
  // would otherwise paint into the gutter under the labels.
  context.save()
  context.beginPath()
  context.rect(spec.plot.x, spec.plot.y, spec.plot.width, spec.plot.height)
  context.clip()

  const image = gridImage(spec, ramp)
  const source = scratchContext(spec.gridCols, spec.gridRows)
  if (source && scratch) {
    source.putImageData(image, 0, 0)
    // Nearest neighbour: a grid cell is a block of one colour with its edges on pixels, which
    // is the picture the rectangles drew and the opposite of what smoothing would make of it.
    context.imageSmoothingEnabled = false
    context.drawImage(
      scratch,
      0,
      0,
      spec.gridCols,
      spec.gridRows,
      spec.colMap.origin,
      spec.rowMap.origin,
      spec.gridCols * spec.cellWidth,
      spec.gridRows * spec.cellHeight,
    )
  }

  if (spec.gap > 0) {
    // The separator is negative space showing the surface — drawn over the image as one line
    // per grid line rather than an inset per cell, which is what keeps it two hundred fills
    // at most where the cells themselves may be forty thousand.
    context.fillStyle = options.background
    const gridWidth = spec.gridCols * spec.cellWidth
    const gridHeight = spec.gridRows * spec.cellHeight
    for (let gx = 1; gx <= spec.gridCols; gx++) {
      context.fillRect(
        spec.colMap.origin + gx * spec.cellWidth - spec.gap,
        spec.rowMap.origin,
        spec.gap,
        gridHeight,
      )
    }
    for (let gy = 1; gy <= spec.gridRows; gy++) {
      context.fillRect(
        spec.colMap.origin,
        spec.rowMap.origin + gy * spec.cellHeight - spec.gap,
        gridWidth,
        spec.gap,
      )
    }
  }
  context.restore()
}

// ---------------------------------------------------------------------------
// SVG export
// ---------------------------------------------------------------------------

/** Height of the colour bar strip appended below an exported heatmap. */
const BAR_HEIGHT = 30

export interface HeatmapSvgOptions extends HeatmapCanvasOptions {
  /** Only `secondary` and `muted` are read — the chrome here is labels, not axes. */
  ink: Pick<PlotInk, 'secondary' | 'muted'>
  /** Resolved `font-family`; every colour is already literal hex, which is what keeps this cheap. */
  font: string
  /** Read for the printed cell values, and only when the spec says they fit. */
  values: Float64Array
  /** Whether the user asked for cell values; `spec.labelsFit` says whether there is room. */
  showValues: boolean
  title: string
  valueLabel?: string
  /** Low and high ends of the scale, already formatted, for the colour bar. */
  barLow: string
  barHigh: string
}

/**
 * A standalone `<svg>` of the current view.
 *
 * Rebuilt from the spec rather than read back off the canvas — a 2D context can be read back,
 * but only as a raster at whatever pixel ratio the screen happened to have, and the whole
 * reason the charts compute colours as literal hex in JS is that vector export is then nearly
 * free. Same doctrine as `networkToSvg` and `scatterToSvg`.
 *
 * **A folded picture exports folded**, which is the honest file: the cells below a pixel were
 * not on screen and drawing them here would produce a document claiming detail nobody saw — and
 * one rect per cell of a four-million-cell matrix, which no reader opens. The caption says the
 * picture is folded; the file is that picture.
 */
export function heatmapToSvg(options: HeatmapSvgOptions): SVGSVGElement {
  const { spec, ramp, ink } = options
  const width = Math.max(1, Math.round(options.width))
  const height = Math.max(1, Math.round(options.height))

  const svg = svgRoot({
    width,
    height,
    strip: BAR_HEIGHT,
    background: options.background,
    title: options.title,
  })
  // The font is a CSS variable on screen and has to travel explicitly.
  const style = document.createElementNS(SVG_NS, 'style')
  style.textContent = `text{font-family:${options.font};}`
  svg.append(style)

  // --- clips --------------------------------------------------------------
  // The same three regions the overlay clips to, so a zoomed export is the zoomed card: the
  // cells and the printed values to the plot, each gutter's labels to its own gutter.
  const defs = element('defs', {})
  const zones = clipZones(spec)
  for (const [zone, rect] of Object.entries(zones)) {
    const clip = element('clipPath', { id: `clip-${zone}` })
    clip.append(element('rect', { ...rect }))
    defs.append(clip)
  }
  svg.append(defs)

  // --- cells --------------------------------------------------------------
  const cell = drawnCellSize(spec)
  const cellW = round(cell.width)
  const cellH = round(cell.height)
  const cells = element('g', { 'clip-path': 'url(#clip-plot)' })
  for (const [bucket, corners] of cornersByBucket(spec)) {
    const parts: string[] = []
    for (let i = 0; i < corners.length; i += 2) {
      parts.push(
        `M${round(corners[i]!)},${round(corners[i + 1]!)}h${cellW}v${cellH}h-${cellW}Z`,
      )
    }
    cells.append(element('path', { d: parts.join(''), fill: ramp[bucket] ?? '#000000' }))
  }
  svg.append(cells)

  // --- chrome -------------------------------------------------------------
  // The same placements the on-screen overlay maps to JSX, so the file and the card cannot
  // disagree about where a label goes or what ink a printed value takes.
  const groups = {
    plot: element('g', { 'clip-path': 'url(#clip-plot)' }),
    rows: element('g', { 'clip-path': 'url(#clip-rows)' }),
    cols: element('g', { 'clip-path': 'url(#clip-cols)' }),
  }
  for (const mark of [
    ...(options.showValues ? valueMarks(spec, options.values, ramp) : []),
    ...axisMarks(spec, ink.secondary),
  ]) {
    groups[mark.zone].append(svgTextMark(mark))
  }
  for (const group of Object.values(groups)) svg.append(group)

  // --- colour bar ---------------------------------------------------------
  {
    const y = height + 8
    const barX = 60
    const barWidth = Math.max(0, width - barX - 60)
    // One rect per ramp step rather than a `<linearGradient>`: a gradient is a second way of
    // saying what the cells already say in flat fills, and readers disagree about how they
    // rasterise it. Stepped, the bar *is* the palette the cells were drawn from.
    const steps = Math.min(ramp.length, Math.max(1, Math.round(barWidth)))
    for (let i = 0; i < steps; i++) {
      const index = Math.round((i / Math.max(1, steps - 1)) * (ramp.length - 1))
      svg.append(
        element('rect', {
          x: barX + (i * barWidth) / steps,
          y,
          width: barWidth / steps + 0.5,
          height: 8,
          fill: ramp[index] ?? '#000000',
        }),
      )
    }
    svg.append(
      textNode(options.barLow!, {
        x: barX - 5,
        y: y + 4,
        fill: ink.muted,
        'font-size': 10,
        'text-anchor': 'end',
        'dominant-baseline': 'central',
      }),
    )
    svg.append(
      textNode(options.barHigh!, {
        x: barX + barWidth + 5,
        y: y + 4,
        fill: ink.muted,
        'font-size': 10,
        'dominant-baseline': 'central',
      }),
    )
    if (options.valueLabel) {
      svg.append(
        textNode(options.valueLabel, {
          x: 4,
          y: y + 20,
          fill: ink.muted,
          'font-size': 10,
        }),
      )
    }
  }

  return svg
}

/** One `TextMark` as an SVG `<text>`; `HeatmapViewer` renders the same mark as JSX. */
function svgTextMark(mark: TextMark): SVGTextElement {
  return textNode(mark.text, {
    x: mark.x,
    y: mark.y,
    fill: mark.fill,
    'font-size': mark.size,
    'text-anchor': mark.anchor,
    ...(mark.baseline ? { 'dominant-baseline': mark.baseline } : {}),
    ...(mark.transform ? { transform: mark.transform } : {}),
  })
}
