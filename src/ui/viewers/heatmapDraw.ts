/**
 * Painting for the matrix heatmap: the canvas pass, and a standalone SVG of the same view.
 *
 * Both read one `HeatmapSpec`, which is what makes the exported file the picture on screen
 * rather than a second drawing of the same data — `scatterDraw`'s arrangement, for
 * `scatterDraw`'s reason.
 *
 * **Cells are batched by ramp bucket, one path and one fill per bucket.** With at most
 * `RAMP_STEPS` buckets that is a bounded number of fills for any number of cells, and it is the
 * difference between a repaint that keeps up with a drag of the card's corner and one that does
 * not. A per-cell `fillStyle` assignment is a string write, which is the expensive half — the
 * same finding as the scatter's colour+shape batching, arrived at from the other direction:
 * there the sequential ramp defeats the batching, and here the ramp *is* the batching.
 *
 * The exported SVG follows the same rule, which is what keeps it openable: at one grid cell per
 * pixel a full-width plot is ~285,000 cells, and 285,000 `<rect>` elements is a file nothing
 * opens where 285,000 subpaths inside 512 `<path>` elements opens anywhere.
 */

import { axisMarks, drawnCellSize, valueMarks } from './heatmapPlot'
import type { HeatmapSpec, TextMark } from './heatmapPlot'
import type { PlotInk } from './scatterDraw'
import { SVG_NS, element, round, svgRoot, textNode } from './svgElement'

/**
 * Every drawn cell's top-left corner, grouped by ramp bucket: `[x0, y0, x1, y1, …]`.
 *
 * Flat numbers rather than a rectangle object per cell, and corners rather than rectangles,
 * because **every cell is the same size** — so width and height are read off the spec once
 * instead of being stored a million times. At a full-width plot that is the difference between
 * ~900,000 short-lived arrays per repaint and none: measured in a browser, it took a
 * four-million-cell repaint from 77 ms to 46 ms.
 *
 * **Memoised against the spec**, which took the same repaint to 27 ms — the grouping is a pure
 * function of a value that is itself behind a memo, so a theme flip was re-walking 900,000 grid
 * cells to change nothing but 512 `fillStyle` strings, and an export walked them a third time.
 * A `WeakMap` rather than a field on the spec so the painter's private business stays out of the
 * headless module, and so it is collected with the spec — `rowFields.ts`'s `slotCache` idiom.
 *
 * Shared by both back-ends, so a cell cannot be a pixel out between the screen and the file.
 */
const CORNERS = new WeakMap<HeatmapSpec, Map<number, number[]>>()

function cornersByBucket(spec: HeatmapSpec): Map<number, number[]> {
  const cached = CORNERS.get(spec)
  if (cached) return cached
  const buckets = new Map<number, number[]>()
  CORNERS.set(spec, buckets)
  const { width, height } = drawnCellSize(spec)
  if (width <= 0 || height <= 0) return buckets
  for (let gy = 0; gy < spec.gridRows; gy++) {
    const y = spec.plot.y + gy * spec.cellHeight
    const rowStart = gy * spec.gridCols
    for (let gx = 0; gx < spec.gridCols; gx++) {
      const bucket = spec.buckets[rowStart + gx]!
      // -1 is a block nothing finite landed in: the surface shows through, which says "not
      // recorded" rather than painting it as the bottom of the scale.
      if (bucket < 0) continue
      const corners = buckets.get(bucket)
      const x = spec.plot.x + gx * spec.cellWidth
      if (corners) corners.push(x, y)
      else buckets.set(bucket, [x, y])
    }
  }
  return buckets
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

  const { width: w, height: h } = drawnCellSize(spec)
  for (const [bucket, corners] of cornersByBucket(spec)) {
    context.fillStyle = ramp[bucket] ?? ramp[ramp.length - 1] ?? '#000000'
    context.beginPath()
    for (let i = 0; i < corners.length; i += 2) context.rect(corners[i]!, corners[i + 1]!, w, h)
    context.fill()
  }
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

  // --- cells --------------------------------------------------------------
  const cell = drawnCellSize(spec)
  const cellW = round(cell.width)
  const cellH = round(cell.height)
  for (const [bucket, corners] of cornersByBucket(spec)) {
    const parts: string[] = []
    for (let i = 0; i < corners.length; i += 2) {
      parts.push(`M${round(corners[i]!)},${round(corners[i + 1]!)}h${cellW}v${cellH}h-${cellW}Z`)
    }
    svg.append(element('path', { d: parts.join(''), fill: ramp[bucket] ?? '#000000' }))
  }

  // --- chrome -------------------------------------------------------------
  // The same placements the on-screen overlay maps to JSX, so the file and the card cannot
  // disagree about where a label goes or what ink a printed value takes.
  for (const mark of [
    ...(options.showValues ? valueMarks(spec, options.values, ramp) : []),
    ...axisMarks(spec, ink.secondary),
  ]) {
    svg.append(svgTextMark(mark))
  }

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
