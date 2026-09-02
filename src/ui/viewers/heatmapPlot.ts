/**
 * Geometry and aggregation for the matrix heatmap — everything about the picture that is
 * arithmetic rather than paint.
 *
 * Headless, and for `scatterPlot.ts`'s reason: jsdom has no canvas, so anything left in the
 * component is covered by nothing at all. The split is also what lets the screen and the
 * exported SVG draw *one* spec, so the file is the picture rather than a second drawing of
 * the same data.
 *
 * ## The decision the whole module rests on
 *
 * A heatmap used to be one `<rect>` per cell, with its own hover handlers, and was refused
 * above 20,000 cells because that is 40,000 DOM nodes and 40,000 listeners for one card. The
 * cap was a fact about SVG rather than about matrices — and it landed on exactly the pictures
 * this viewer exists for: an NBLAST score matrix at the Skeletons node's 500-neuron ceiling is
 * 250,000 cells, and `Linkage → Ordered → Heatmap` is *meant* to be looked at at that size,
 * where the structure reads as texture rather than as cells.
 *
 * So the cells are **downsampled to the plot** before anything is drawn. A grid cell smaller
 * than a pixel cannot be seen, so it is not drawn: the matrix is folded onto a grid of at most
 * one cell per CSS pixel, and everything downstream — the canvas pass, the SVG export, the hit
 * test — works on that grid. **The cost of drawing is then bounded by the plot area rather
 * than by the matrix**, which is the property that lets the ceiling move by two orders of
 * magnitude. The same insight as the scatter's point budget and the ROI outlines' three fixed
 * projections; only the passes that must touch every cell (the extent, the fold) stay O(n).
 *
 * **CSS pixels, not device pixels**, so the picture does not change between a retina screen and
 * a projector — and so the exported SVG, which draws the same grid, is the same file whoever
 * exported it. The detail given up is the sub-CSS-pixel half a 2× screen could have shown.
 *
 * ## What a fold keeps
 *
 * The strongest cell, never the mean. A connectivity matrix is sparse: averaging a single
 * strong connection across the hundred empty cells beside it puts it at 1% of the ramp, i.e.
 * off the picture — which is the one thing a heatmap is read for. "Strongest" is measured from
 * the scale's own neutral point (the low end for sequential, zero for diverging), so a
 * diverging fold keeps both tails rather than only the positive one. Same brightest-wins rule
 * as `raster.ts`, for the same reason.
 *
 * The *winning cell's index* is kept too, so a tooltip over a folded block names a real row,
 * column and value rather than an average of things nobody can point at.
 *
 * ## Zoom is a window, and the window is the fold's input
 *
 * A zoomed heatmap is not a scaled picture of the fitted one. `HeatmapWindow` says which part
 * of the matrix is on screen, in fractional rows and columns, and the spec is built for that
 * part alone: the visible lines are folded onto the plot's pixels, so zooming *in* on a
 * four-million-cell matrix folds fewer cells, not more, and past 1:1 the real cells appear with
 * their own labels and printed values. Scaling a canvas would have kept the fitted fold's blocks
 * and enlarged them — a picture claiming detail it does not have — and the labels would have
 * scaled with it, which is the one thing they must not do. The window is in matrix units rather
 * than pixels so a resize keeps the zoom rather than the pixels.
 *
 * Each axis is an `AxisMap`: which lines the grid covers, how many grid cells, the pitch, and
 * the pixel the grid starts at — *before* the plot's edge when the window starts mid-cell, with
 * the painter and the overlay clipping to the plot. One mapping (`gridIndexOf`) serves the
 * fold, the hover ring, the printed values and the hit test, so a zoomed cell cannot be drawn
 * in one place and hovered in another.
 */

import type { MatrixValue } from '../../core/values'
import { formatCompact, labelStep, truncateLabel } from '../format'
import type { Mode } from '../colors'
import { heatmapDivergingColor, heatmapSequentialColor, inkOn } from '../colors'
import type { ColorLimits, HeatmapPalette } from '../../nodes/lib/heatmapParams'
import { isDivergingPalette, isSequentialPalette } from '../../nodes/lib/heatmapParams'

/**
 * How many cells this viewer will fold, above which it says so instead.
 *
 * The fold makes drawing cost independent of the matrix, so what this bounds is the two passes
 * that cannot be: the extent scan and the fold itself, one linear walk of a `Float64Array`
 * each. Measured in a browser against a 1400x700 plot, spec build then first paint:
 *
 * | cells     | drawn grid | fold | spec  | paint | repaint |
 * | --------- | ---------- | ---- | ----- | ----- | ------- |
 * |    90,000 |    300x300 | none | 1ms   | 5ms   | 3ms     |
 * |   250,000 |    500x500 | none | 3ms   | 14ms  | 8ms     |
 * | 1,000,000 |   666x1000 | 2:1  | 10ms  | 37ms  | 22ms    |
 * | 4,000,000 |   661x1358 | 4:1  | 23ms  | 41ms  | 27ms    |
 *
 * So the ceiling costs about 65 ms of one frame the first time it is laid out, and half that to
 * repaint — a theme flip, a scale change — because the grid's pixels are memoised against the
 * spec (`gridImage` in `heatmapDraw.ts`). On a resize and never on a hover, which is a stutter somebody notices once against a
 * viewer that used to refuse the second row of that table outright. Note what the middle column
 * says: paint tracks the *grid* rather than the matrix, which is the whole design.
 *
 * A resize is the one gesture that pays it per frame, because the grid is derived from the plot
 * and genuinely changes as the card moves. Folded, that is inherent rather than an oversight —
 * a fold to a grid nobody is looking at yet is the only way to avoid it.
 *
 * Two numbers now, because there turned out to be two questions. `HEATMAP_CELLS_WARN` is where
 * the caption starts saying that blocks stand for many cells — a fact about *reading* the
 * picture. Where there is no picture at all is `CRASH_FLOOR_CELLS` itself, read straight rather
 * than aliased here: this viewer draws anything a Pivot or an NBLAST can hand it and declines
 * only what could not have been built in the first place.
 *
 * The one at 4,000,000 used to be the refusal, and the table above is why moving it was safe:
 * paint tracks the **grid** rather than the matrix, so sixteen times the cells is sixteen times
 * one 23 ms fold — a stutter on first layout — and not sixteen times every frame.
 *
 * It is deliberately not tied to the pivot's thresholds. Those bound an allocation, checked
 * before a byte exists; this one bounds a drawing whose input is already in memory. Two
 * different questions that happen to be about the same shape.
 */
export const HEATMAP_CELLS_WARN = 4_000_000

/**
 * Steps the colour ramp is sampled into, shared by the fills and the caption's colour bar.
 *
 * A lookup table rather than a `sequentialColor` call per cell, and that is not a micro-
 * optimisation: each of those calls parses two hex strings and formats a third. Measured in a
 * browser, 285,000 of them — one grid cell per pixel of a full-width plot — cost **65 ms**
 * against **2 ms** through the table, and that is a cost the old code paid on every render
 * rather than every fold.
 *
 * **`ScatterViewer` declines to quantise a sequential ramp** — "quantising would put a colour
 * on screen that `resolveColor` never returned" — so this was checked rather than assumed, over
 * 200,000 samples of both scales in both modes. It does not, in any visible sense: the ramps
 * are piecewise-linear in RGB and the output is 8 bits a channel, so the whole of the blue ramp
 * is 453 distinct colours and the diverging scale 621–1,006. Against those, **512 steps is
 * within one channel value of exact for sequential and two for diverging** — 256 measures the
 * same, so this is headroom rather than the edge of it. The scatter's objection is real for a
 * *categorical* palette, where a substituted slot means a different category; here a colour is
 * a magnitude and the substitute is the same magnitude to within a rounding step.
 */
export const RAMP_STEPS = 512

/** Font size of the axis labels, and so the pitch a label needs to stay legible. */
const LABEL_FONT = 10
const LABEL_PITCH = LABEL_FONT + 1

const round = (value: number): number => Math.round(value * 100) / 100

export type HeatmapScale = 'sequential' | 'diverging'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where one axis label goes, and which label it is. */
export interface LabelTick {
  /** Index into the matrix's own label array. */
  index: number
  label: string
  /** Centre of the row or column, in plot coordinates. */
  center: number
}

export interface HeatmapExtent {
  min: number
  max: number
}

/**
 * The value range a fill is resolved against.
 *
 * `neutral` is the end of the scale that means "nothing here" — the low end for a sequential
 * ramp, zero for a diverging one — and is what makes "the strongest cell in this block" a
 * well-defined thing to keep when folding.
 */
export interface ColorDomain {
  lo: number
  hi: number
  neutral: number
  /**
   * Map a value to the ramp through `log(1 + v - lo)` rather than linearly.
   *
   * On the **colour only**: the printed cell values, the tooltip and the colour bar's two ends
   * are the numbers themselves, because a log axis is a way of *looking* at a distribution and
   * a relabelled cell is a way of misreading one. Connectivity is the case it exists for — a
   * handful of strong pairs and a long tail of ones, where a linear ramp paints the tail as
   * empty.
   *
   * Offered on a sequential scale alone (see `heatmapLogColor`), which is what makes the shift
   * by `lo` safe: `lo` is the bottom of the ramp, so `v - lo` is never negative and the
   * logarithm always exists. With the usual `lo` of 0 this is exactly `log10(1 + v)`, which is
   * the expression both exporters emit.
   */
  log?: boolean
}

/**
 * The part of the matrix on screen, in fractional rows and columns.
 *
 * `row0`/`col0` is the top-left corner and `rows`/`cols` the span; the whole matrix is
 * `fullWindow`. Fractional, because a zoom about the pointer lands wherever the pointer was and
 * a pan moves by pixels — snapping to whole cells would make both gestures lurch.
 */
export interface HeatmapWindow {
  row0: number
  col0: number
  rows: number
  cols: number
}

/**
 * One axis of the drawn grid: which matrix lines it covers and where they land in pixels.
 *
 * `folded` says whether a grid cell is one line or many. Unfolded, `pitch` is the pixels per
 * matrix line and `origin` may sit before the plot's edge by the fraction of a line the window
 * starts into; folded, the grid is one cell per pixel of the plot and `origin` is the plot's
 * edge. `start`/`span` restate the window along this axis, for the proportional mapping.
 */
export interface AxisMap {
  /** First matrix index the grid covers. */
  first: number
  /** How many matrix lines the grid covers, from `first`. */
  visible: number
  /** Grid cells along this axis. */
  count: number
  /** Pixels per grid cell. */
  pitch: number
  /** Pixel position of grid cell 0's leading edge. */
  origin: number
  folded: boolean
  start: number
  span: number
}

export interface HeatmapSpec {
  rows: number
  cols: number
  /** The plot rect, inside the label gutters, in CSS pixels. */
  plot: Rect
  /** What is on screen, clamped to the matrix. `fullWindow(matrix)` when nothing is zoomed. */
  window: HeatmapWindow
  rowMap: AxisMap
  colMap: AxisMap
  /** Columns and rows of the *drawn* grid — `colMap.count` and `rowMap.count`, restated. */
  gridCols: number
  gridRows: number
  /** `colMap.pitch` and `rowMap.pitch`, restated. */
  cellWidth: number
  cellHeight: number
  /**
   * The 1px inset between cells — the separator is negative space showing the surface, never a
   * stroke around each cell. Zero once cells are too small for it to read as a gap rather than
   * as half the picture missing.
   */
  gap: number
  /**
   * Ramp index per grid cell, row-major, `-1` where nothing finite landed there.
   *
   * Mode-independent on purpose: a theme flip re-resolves the ramp's hex values and repaints,
   * and must not re-fold a four-million-cell matrix to do it.
   */
  buckets: Int16Array
  /**
   * Index into `matrix.values` of the cell each grid cell is showing. Absent when the grid *is*
   * the visible block of the matrix, where it would be `(first + gy) * cols + first + gx`.
   */
  source?: Int32Array
  /** True when more than one cell landed on a grid cell, on either axis. */
  folded: boolean
  /** Visible cells per grid cell, for the caption's admission. 1 when nothing was folded. */
  foldFactor: number
  domain: ColorDomain
  rowTicks: LabelTick[]
  colTicks: LabelTick[]
  /** Axis labels that did not fit and were dropped, for the caption's admission. */
  rowLabelsThinned: number
  colLabelsThinned: number
  /** True when the cells are big enough to carry their own printed value. */
  labelsFit: boolean
}

/**
 * Lowest and highest finite cell.
 *
 * Non-finite cells are skipped rather than read as zero — `NaN` is a cell nobody recorded, and
 * folding it into the extent drags the whole ramp towards a value that is not in the data.
 */
export function matrixExtent(values: Float64Array): HeatmapExtent {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0 }
  return { min, max }
}

/**
 * What maps to each end of the ramp.
 *
 * Sequential runs from zero (or lower, where the data goes negative) to the maximum, so an
 * all-positive matrix reads against a baseline of nothing rather than against its own smallest
 * cell. Diverging is symmetric about zero, or the two arms would encode different magnitudes.
 *
 * **A manual limit replaces one end, and on a diverging scale there is only one to replace.**
 * The two arms of a diverging ramp have to stay the same length or the neutral colour stops
 * meaning zero, which is the one thing that ramp is read for — so `max` there is the magnitude
 * of both arms and `min` is not offered. Out-of-range cells clamp to the end they passed, as
 * they do in matplotlib; the viewer's caption admits it rather than letting them vanish.
 */
export function colorDomain(
  extent: HeatmapExtent,
  scale: HeatmapScale,
  options: { limits?: ColorLimits; log?: boolean } = {},
): ColorDomain {
  const { limits = {}, log } = options
  if (scale === 'diverging') {
    const magnitude =
      limits.max ?? (Math.max(Math.abs(extent.min), Math.abs(extent.max)) || 1)
    return { lo: -magnitude, hi: magnitude, neutral: 0 }
  }
  const lo = limits.min ?? Math.min(0, extent.min)
  const hi = limits.max ?? extent.max
  return { lo, hi, neutral: lo, ...(log ? { log: true } : {}) }
}

/**
 * Ramp position of a value in [0, 1], the one place the linear and log mappings both live.
 *
 * The log arm is `log1p` of the distance from the bottom over `log1p` of the span — natural
 * logs, because a ratio of two logs is the same in any base, so this and the exporters'
 * `log10` draw the same picture.
 */
function rampPosition(value: number, domain: ColorDomain): number {
  const span = domain.hi - domain.lo
  if (!(span > 0)) return 0
  const above = value - domain.lo
  if (above <= 0) return 0
  if (above >= span) return 1
  return domain.log ? Math.log1p(above) / Math.log1p(span) : above / span
}

/** Ramp position of a value, clamped to [0, 1]. */
export function normalize(value: number, domain: ColorDomain): number {
  return rampPosition(value, domain)
}

/** Ramp bucket of a value. */
export function bucketOf(value: number, domain: ColorDomain): number {
  return Math.round(normalize(value, domain) * (RAMP_STEPS - 1))
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/** The smallest span a zoom may reach on either axis: one line filling the plot. */
const MIN_SPAN = 1

export function fullWindow(matrix: Pick<MatrixValue, 'rowLabels' | 'colLabels'>): HeatmapWindow {
  return { row0: 0, col0: 0, rows: matrix.rowLabels.length, cols: matrix.colLabels.length }
}

/** Whether a window shows everything — the state the viewer stores as "not zoomed". */
export function isFullWindow(window: HeatmapWindow, full: HeatmapWindow): boolean {
  return window.rows >= full.rows && window.cols >= full.cols
}

/** How far in, as the caption says it: the larger of the two axes' magnifications. */
export function windowScale(window: HeatmapWindow, full: HeatmapWindow): number {
  return Math.max(full.rows / Math.max(MIN_SPAN, window.rows), full.cols / Math.max(MIN_SPAN, window.cols))
}

/** Keep a window inside the matrix and above the one-line floor, on both axes. */
export function clampWindow(window: HeatmapWindow, full: HeatmapWindow): HeatmapWindow {
  const rows = Math.min(full.rows, Math.max(MIN_SPAN, window.rows))
  const cols = Math.min(full.cols, Math.max(MIN_SPAN, window.cols))
  return {
    rows,
    cols,
    row0: Math.min(Math.max(0, window.row0), Math.max(0, full.rows - rows)),
    col0: Math.min(Math.max(0, window.col0), Math.max(0, full.cols - cols)),
  }
}

/**
 * Zoom about a point of the matrix — the one that must not move — by a factor, where above 1
 * zooms out. Both axes together: a heatmap's cells are not square, but its *magnification* is
 * one number, and stretching an axis alone would make a block read as a different shape.
 */
export function zoomWindow(
  window: HeatmapWindow,
  full: HeatmapWindow,
  anchor: { row: number; col: number },
  factor: number,
): HeatmapWindow {
  return clampWindow(
    {
      rows: window.rows * factor,
      cols: window.cols * factor,
      row0: anchor.row - (anchor.row - window.row0) * factor,
      col0: anchor.col - (anchor.col - window.col0) * factor,
    },
    full,
  )
}

/** Move by some rows and columns, staying inside the matrix. */
export function panWindow(
  window: HeatmapWindow,
  full: HeatmapWindow,
  rows: number,
  cols: number,
): HeatmapWindow {
  return clampWindow({ ...window, row0: window.row0 + rows, col0: window.col0 + cols }, full)
}

/** The matrix coordinate under a plot pixel, fractional and unclamped. */
export function pointToMatrix(spec: HeatmapSpec, x: number, y: number): { row: number; col: number } {
  const { plot, window } = spec
  return {
    row: window.row0 + ((y - plot.y) / Math.max(1, plot.height)) * window.rows,
    col: window.col0 + ((x - plot.x) / Math.max(1, plot.width)) * window.cols,
  }
}

/**
 * One axis of the grid for a window along it.
 *
 * Unfolded while the visible lines each have a pixel: then the pitch is the pixels per line and
 * the origin steps back before the plot's edge by the fraction of a line the window starts into.
 * Folded otherwise, at one grid cell per pixel, with the proportional mapping `gridIndexOf`
 * applies.
 */
export function axisMap(
  total: number,
  plotStart: number,
  plotSize: number,
  start: number,
  span: number,
): AxisMap {
  const first = Math.max(0, Math.min(total, Math.floor(start)))
  const last = Math.max(first, Math.min(total, Math.ceil(start + span)))
  const visible = last - first
  const pixels = Math.max(1, Math.floor(plotSize) || 1)
  if (visible <= pixels) {
    const pitch = plotSize / Math.max(MIN_SPAN, span)
    return {
      first,
      visible,
      count: Math.max(1, visible),
      pitch,
      origin: plotStart - (start - first) * pitch,
      folded: false,
      start,
      span,
    }
  }
  return {
    first,
    visible,
    count: pixels,
    pitch: plotSize / pixels,
    origin: plotStart,
    folded: true,
    start,
    span,
  }
}

/** Which grid cell a matrix line lands in — the one mapping the fold, the ring and the hit test share. */
export function gridIndexOf(map: AxisMap, index: number): number {
  if (!map.folded) return index - map.first
  const g = Math.floor(((index - map.start) * map.count) / Math.max(MIN_SPAN, map.span))
  return Math.min(map.count - 1, Math.max(0, g))
}

/**
 * The ramp, resolved to hex.
 *
 * One function for the cell fills and for the caption's colour bar, so the bar cannot come to
 * describe a scale the cells are not drawn in — the two were separate samplings of the same
 * ramp before, which is exactly how that drifts.
 */
export function rampColors(
  scale: HeatmapScale,
  mode: Mode,
  steps = RAMP_STEPS,
  palette: HeatmapPalette = 'coda',
): string[] {
  // A name from the other scale's list is not an error, just not an answer: Coda's own ramp
  // stands in, which is also what `heatmapPaletteOf` hands a caller reading the params.
  const sequential = isSequentialPalette(palette) ? palette : 'coda'
  const diverging = isDivergingPalette(palette) ? palette : 'coda'
  return Array.from({ length: steps }, (_, i) => {
    const t = steps === 1 ? 0 : i / (steps - 1)
    return scale === 'diverging'
      ? heatmapDivergingColor(t * 2 - 1, mode, diverging)
      : heatmapSequentialColor(t, mode, sequential)
  })
}

/**
 * The plot rect, inside label gutters sized to the content and capped so the plot keeps most of
 * the space.
 *
 * Module-private and returning only the rect: `left`/`top` are `plot.x`/`plot.y` restated, and
 * the caller already has `showLabels` in scope.
 */
function plotRect(
  width: number,
  height: number,
  matrix: MatrixValue,
  showLabels: boolean,
): Rect {
  const longestRow = matrix.rowLabels.reduce((m, l) => Math.max(m, l.length), 0)
  const longestCol = matrix.colLabels.reduce((m, l) => Math.max(m, l.length), 0)
  const left = showLabels ? Math.min(96, Math.max(28, longestRow * 6 + 8)) : 4
  const top = showLabels ? Math.min(72, Math.max(16, longestCol * 5.4 + 8)) : 4
  return {
    x: left,
    y: top,
    width: Math.max(0, width - left - 4),
    height: Math.max(0, height - top - 4),
  }
}

/**
 * Which axis labels to draw, and how many were dropped.
 *
 * Every k-th, k being whatever keeps them a legible pitch apart. Thinning rather than
 * shrinking: a label small enough to fit a 3px cell is not a label. The count that was dropped
 * comes back with them, because silent culling is what makes a viewer look broken — the same
 * admission `NetworkViewer` makes with `labels thinned`.
 */
export function labelTicks(
  labels: string[],
  axis: AxisMap,
  plotStart: number,
  plotSize: number,
): { ticks: LabelTick[]; thinned: number } {
  if (axis.visible === 0 || plotSize <= 0) return { ticks: [], thinned: 0 }
  // Pixels per *line*, which on a folded axis is less than a pixel and on an unfolded one is
  // the pitch — the window decides, not the grid.
  const line = plotSize / Math.max(MIN_SPAN, axis.span)
  const origin = plotStart - (axis.start - axis.first) * line
  const plotEnd = plotStart + plotSize
  const step = labelStep(axis.visible, plotSize, LABEL_PITCH)
  const ticks: LabelTick[] = []
  let nameable = 0
  const end = axis.first + axis.visible
  for (let i = axis.first; i < end; i++) {
    /*
     * Zoomed, the first and last lines are usually part way off the plot. A label sits over
     * the *visible* part of its line rather than the line's own centre — which at ×15 can be
     * in the next gutter, naming nothing anyone can see — and a line with less than a label's
     * pitch on screen is a sliver whose name would collide with its neighbour's, so it goes
     * unnamed and uncounted: it is not a label the thinning dropped.
     */
    const from = Math.max(plotStart, origin + (i - axis.first) * line)
    const to = Math.min(plotEnd, origin + (i - axis.first + 1) * line)
    // With a tolerance: for an interior line `to - from` and `line` are one number computed
    // two ways, and comparing them exactly dropped lines at random — 18 row labels of 47 on a
    // 401-line matrix, in a pattern that changed with every step of the wheel.
    if (to - from + 1e-6 < Math.min(line, LABEL_PITCH)) continue
    nameable++
    // Every k-th line by its *own* index, not by its distance from the first visible one: a
    // pan or a zoom moves `first` continuously, and a modulus taken from it re-picked which
    // lines were named on every step — labels blinking in and out under the pointer.
    if (i % step !== 0) continue
    ticks.push({ index: i, label: labels[i]!, center: (from + to) / 2 })
  }
  return { ticks, thinned: nameable - ticks.length }
}

export interface HeatmapSpecOptions {
  matrix: MatrixValue
  scale: HeatmapScale
  width: number
  height: number
  /** Hide the gutters entirely — a card too narrow to spend width on names. */
  showLabels: boolean
  /** What is on screen. Absent means all of it. */
  window?: HeatmapWindow
  /**
   * The colour range, when the caller already has it. The extent is one walk of every cell
   * and does not depend on the window, so a viewer that pans keeps it in a memo of its own
   * rather than rescanning four million cells per pointer step — and a zoom must not change
   * what a colour means, which is what handing it in guarantees.
   */
  domain?: ColorDomain
}

/**
 * Everything the two back-ends need, computed once.
 *
 * Expensive in exactly two places — the extent scan and the fold — so this belongs behind a
 * memo keyed on the matrix, the scale and the box, and nothing else. In particular not on the
 * theme: `buckets` is mode-independent so a theme flip is a repaint rather than a re-fold.
 */
export function buildHeatmapSpec(options: HeatmapSpecOptions): HeatmapSpec {
  const { matrix, scale } = options
  const rows = matrix.rowLabels.length
  const cols = matrix.colLabels.length
  const plot = plotRect(options.width, options.height, matrix, options.showLabels)

  const full = fullWindow(matrix)
  const window = clampWindow(options.window ?? full, full)
  const domain = options.domain ?? colorDomain(matrixExtent(matrix.values), scale)

  // At most one grid cell per CSS pixel. Anything finer cannot be seen, and drawing it is the
  // whole of what the old ceiling was protecting against. Per axis, over the window.
  const rowMap = axisMap(rows, plot.y, plot.height, window.row0, window.rows)
  const colMap = axisMap(cols, plot.x, plot.width, window.col0, window.cols)
  const gridCols = colMap.count
  const gridRows = rowMap.count
  const folded = rowMap.folded || colMap.folded

  const cellWidth = colMap.pitch
  const cellHeight = rowMap.pitch
  const gap = cellWidth > 6 && cellHeight > 6 ? 1 : 0

  const { buckets, source } = folded
    ? foldCells(matrix, domain, rowMap, colMap)
    : { buckets: bucketsOf(matrix, domain, rowMap, colMap), source: undefined }

  const rowAxis = options.showLabels
    ? labelTicks(matrix.rowLabels, rowMap, plot.y, plot.height)
    : { ticks: [], thinned: 0 }
  const colAxis = options.showLabels
    ? labelTicks(matrix.colLabels, colMap, plot.x, plot.width)
    : { ticks: [], thinned: 0 }

  return {
    rows,
    cols,
    plot,
    window,
    rowMap,
    colMap,
    gridCols,
    gridRows,
    cellWidth,
    cellHeight,
    gap,
    buckets,
    ...(source ? { source } : {}),
    folded,
    foldFactor: Math.max(
      1,
      Math.round((rowMap.visible * colMap.visible) / Math.max(1, gridRows * gridCols)),
    ),
    domain,
    rowTicks: rowAxis.ticks,
    colTicks: colAxis.ticks,
    rowLabelsThinned: rowAxis.thinned,
    colLabelsThinned: colAxis.thinned,
    /*
     * Whether a cell is big enough for the text, and *not* whether the user asked for it —
     * `Show values` is `&&`-ed in at render. Folding the param in here put a boolean in the
     * dependency list of a pass that walks every cell, so toggling it on a four-million-cell
     * matrix re-scanned the whole thing to compute `false`.
     */
    labelsFit:
      !folded && cellHeight >= 14 && cellWidth >= 26 && rowMap.visible * colMap.visible <= 400,
  }
}

/**
 * The value-to-bucket conversion with the division hoisted out.
 *
 * `bucketOf` is the readable single-value form and stays exported for callers holding one; this
 * is the same arithmetic for a loop that runs up to four million times, where recomputing
 * `hi - lo` and reloading three object properties per cell is most of the pass. The log arm
 * hoists `log1p(span)` for the same reason, and keeps `Math.log1p` per cell — there is no
 * algebraic way around one logarithm per cell, and it is ~8 ms at four million.
 */
function bucketScale(domain: ColorDomain): (value: number) => number {
  const lo = domain.lo
  const span = domain.hi - domain.lo
  const top = RAMP_STEPS - 1
  if (!(span > 0)) return () => 0
  if (domain.log) {
    const k = top / Math.log1p(span)
    return (value: number) => {
      const above = value - lo
      if (above <= 0) return 0
      if (above >= span) return top
      return Math.round(Math.log1p(above) * k)
    }
  }
  const k = top / span
  return (value: number) => {
    const t = (value - lo) * k
    return t < 0 ? 0 : t > top ? top : Math.round(t)
  }
}

/** One bucket per cell, for a grid that *is* the visible block of the matrix. */
function bucketsOf(
  matrix: MatrixValue,
  domain: ColorDomain,
  rowMap: AxisMap,
  colMap: AxisMap,
): Int16Array {
  const cols = matrix.colLabels.length
  const buckets = new Int16Array(rowMap.count * colMap.count).fill(-1)
  const bucket = bucketScale(domain)
  const values = matrix.values
  for (let gy = 0; gy < rowMap.visible; gy++) {
    const from = (rowMap.first + gy) * cols + colMap.first
    const to = gy * colMap.count
    for (let gx = 0; gx < colMap.visible; gx++) {
      const v = values[from + gx]!
      buckets[to + gx] = Number.isFinite(v) ? bucket(v) : -1
    }
  }
  return buckets
}

/**
 * Fold the matrix onto the grid, keeping the strongest cell in each block.
 *
 * Strength is distance from the scale's neutral end, so this is "the most positive" under a
 * sequential ramp and "the furthest from zero either way" under a diverging one. Keeping the
 * mean instead would erase a sparse matrix's structure, which is the only thing in it.
 */
function foldCells(
  matrix: MatrixValue,
  domain: ColorDomain,
  rowMap: AxisMap,
  colMap: AxisMap,
): { buckets: Int16Array; source: Int32Array } {
  const cols = matrix.colLabels.length
  const gridCols = colMap.count
  const size = rowMap.count * gridCols
  const buckets = new Int16Array(size).fill(-1)
  const source = new Int32Array(size).fill(-1)
  const strength = new Float64Array(size).fill(Number.NEGATIVE_INFINITY)
  const values = matrix.values
  const { neutral } = domain
  const bucket = bucketScale(domain)

  // The column mapping is hoisted: `gridIndexOf` inside the inner loop is a multiply, a divide
  // and a floor per cell, which at four million cells is the pass. Only the visible block is
  // walked, which is what makes zooming in cheaper than the fit rather than dearer.
  const colOf = new Int32Array(colMap.visible)
  for (let i = 0; i < colMap.visible; i++) colOf[i] = gridIndexOf(colMap, colMap.first + i)

  const rowEnd = rowMap.first + rowMap.visible
  for (let r = rowMap.first; r < rowEnd; r++) {
    const gridRowStart = gridIndexOf(rowMap, r) * gridCols
    const rowStart = r * cols
    for (let i = 0; i < colMap.visible; i++) {
      const c = colMap.first + i
      const v = values[rowStart + c]!
      if (!Number.isFinite(v)) continue
      const g = gridRowStart + colOf[i]!
      const s = Math.abs(v - neutral)
      if (s <= strength[g]!) continue
      strength[g] = s
      source[g] = rowStart + c
      buckets[g] = bucket(v)
    }
  }
  return { buckets, source }
}

export interface CellHit {
  /** Row and column in the *matrix*, not in the drawn grid. */
  row: number
  col: number
  /** Index into `matrix.values`, so the caller reads the cell rather than the spec carrying it. */
  index: number
}

/**
 * Which cell the pointer is over, in plot coordinates.
 *
 * Answers about the matrix rather than about the grid: on a folded picture the block under the
 * pointer stands for many cells, and the one it is *drawn as* is the strongest of them — so
 * that is the one named, with its own row, column and value. An average would be a number
 * nobody could go and look at.
 */
export function cellAt(spec: HeatmapSpec, x: number, y: number): CellHit | null {
  const { plot } = spec
  if (x < plot.x || y < plot.y || x >= plot.x + plot.width || y >= plot.y + plot.height) {
    return null
  }
  const gx = Math.floor((x - spec.colMap.origin) / spec.cellWidth)
  const gy = Math.floor((y - spec.rowMap.origin) / spec.cellHeight)
  if (gx < 0 || gy < 0 || gx >= spec.gridCols || gy >= spec.gridRows) return null
  const g = gy * spec.gridCols + gx
  const index = spec.source
    ? spec.source[g]!
    : (spec.rowMap.first + gy) * spec.cols + spec.colMap.first + gx
  if (index < 0 || index >= spec.rows * spec.cols) return null
  return { row: Math.floor(index / spec.cols), col: index % spec.cols, index }
}

/**
 * The size a cell is actually painted at — the grid pitch less the separator.
 *
 * One statement of the gap convention (an inset showing the surface, never a stroke around each
 * cell), because it was written out in four places across the spec and the painter, and the gap
 * is the thing this viewer is most likely to be asked to change.
 */
export function drawnCellSize(spec: HeatmapSpec): { width: number; height: number } {
  return {
    width: Math.max(0, spec.cellWidth - spec.gap),
    height: Math.max(0, spec.cellHeight - spec.gap),
  }
}

/**
 * Where a matrix cell is drawn, in plot coordinates — the top-left of the block it landed in.
 *
 * The hover ring and the printed values both need this, and on a folded picture it is the
 * *block* that is outlined rather than the cell, because the block is what is on screen.
 */
export function cellRect(spec: HeatmapSpec, row: number, col: number): Rect {
  const gx = gridIndexOf(spec.colMap, col)
  const gy = gridIndexOf(spec.rowMap, row)
  return {
    x: spec.colMap.origin + gx * spec.cellWidth,
    y: spec.rowMap.origin + gy * spec.cellHeight,
    ...drawnCellSize(spec),
  }
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/**
 * One piece of text to draw, positioned and coloured.
 *
 * The overlay maps these to JSX and the exporter to `<text>` nodes, which is what makes the
 * file the picture on screen for the *chrome* as well as for the cells. It was two independent
 * drawings for one afternoon and they had already parted company — a cell whose bucket is `-1`
 * took ramp-bottom ink on screen and black in the file — which is precisely the drift a shared
 * placement removes by construction rather than by matching magic numbers in two files.
 */
export interface TextMark {
  /** Stable across renders, so React can key on it. */
  key: string
  text: string
  x: number
  y: number
  fill: string
  size: number
  anchor: 'start' | 'middle' | 'end'
  /**
   * Absent means the alphabetic default, which is what a *rotated* label wants: `central`
   * shifts text perpendicular to its reading direction, so on a -90° column label it moves
   * sideways by half a cap height and the whole band drifts off its column.
   */
  baseline?: 'central'
  /** Composed here rather than in each renderer, so the two cannot rotate differently. */
  transform?: string
  /**
   * Which region clips it: the row gutter, the column gutter or the plot. Zoomed, a line half
   * scrolled off the plot has its value and its ring clipped with its cells, and a gutter's
   * labels never cross into the other gutter's corner. Both renderers clip by this.
   */
  zone: 'rows' | 'cols' | 'plot'
}

const AXIS_FONT = 10
const VALUE_FONT = 9.5

/**
 * The three regions a mark is clipped to: the plot, the row gutter beside it and the column
 * gutter above it.
 *
 * Here rather than in the painter because it is `plotRect` arithmetic and nothing else, and
 * because both back-ends clip by it — the overlay as `<clipPath>` elements and the export as
 * the same, so a zoomed file is the zoomed card.
 */
export function clipZones(spec: HeatmapSpec): Record<TextMark['zone'], Rect> {
  const { plot } = spec
  return {
    plot: { x: plot.x, y: plot.y, width: plot.width, height: plot.height },
    rows: { x: 0, y: plot.y, width: plot.x, height: plot.height },
    cols: { x: plot.x, y: 0, width: plot.width, height: plot.y },
  }
}

/** The row and column names, truncated to their gutters and thinned to what fits. */
export function axisMarks(spec: HeatmapSpec, ink: string): TextMark[] {
  const marks: TextMark[] = []
  for (const tick of spec.rowTicks) {
    marks.push({
      key: `r-${tick.index}`,
      text: truncateLabel(tick.label, spec.plot.x - 8),
      x: spec.plot.x - 5,
      y: tick.center,
      fill: ink,
      size: AXIS_FONT,
      anchor: 'end',
      baseline: 'central',
      zone: 'rows',
    })
  }
  for (const tick of spec.colTicks) {
    const x = tick.center
    const y = spec.plot.y - 5
    marks.push({
      key: `c-${tick.index}`,
      text: truncateLabel(tick.label, spec.plot.y - 8, 5.4),
      x,
      y,
      fill: ink,
      size: AXIS_FONT,
      anchor: 'start',
      // Rotated so long type names do not collide; -90 keeps reading order.
      transform: `rotate(-90 ${round(x)} ${round(y)})`,
      zone: 'cols',
    })
  }
  return marks
}

/**
 * The value printed inside each cell, where the cells are big enough to carry one.
 *
 * Zero is skipped rather than printed: a "0" in every empty pair is chart noise. `labelsFit`
 * already implies an unfolded grid — it caps at 400 visible cells of at least 26x14 px — so
 * the grid's stride indexes the buckets and the maps say which matrix cell each one is.
 */
export function valueMarks(
  spec: HeatmapSpec,
  values: Float64Array,
  ramp: string[],
): TextMark[] {
  if (!spec.labelsFit) return []
  const marks: TextMark[] = []
  for (let gy = 0; gy < spec.rowMap.visible; gy++) {
    const r = spec.rowMap.first + gy
    for (let gx = 0; gx < spec.colMap.visible; gx++) {
      const c = spec.colMap.first + gx
      const value = values[r * spec.cols + c]
      if (value === undefined || !Number.isFinite(value) || value === 0) continue
      const bucket = spec.buckets[gy * spec.gridCols + gx] ?? 0
      const box = cellRect(spec, r, c)
      marks.push({
        key: `v-${r}-${c}`,
        text: formatCompact(value),
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        // The one place text takes the fill it sits on, so it has to be resolved once.
        fill: inkOn(ramp[Math.max(0, bucket)] ?? ramp[0] ?? '#000000'),
        size: VALUE_FONT,
        anchor: 'middle',
        baseline: 'central',
        zone: 'plot',
      })
    }
  }
  return marks
}
