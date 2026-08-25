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
 */

import type { MatrixValue } from '../../core/values'
import { formatCompact, labelStep, truncateLabel } from '../format'
import type { Mode } from '../colors'
import { divergingColor, inkOn, sequentialColor } from '../colors'

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
 * repaint — a theme flip, a scale change — because `cornersByBucket` is memoised against the
 * spec. On a resize and never on a hover, which is a stutter somebody notices once against a
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
}

export interface HeatmapSpec {
  rows: number
  cols: number
  /** The plot rect, inside the label gutters, in CSS pixels. */
  plot: Rect
  /** Columns and rows of the *drawn* grid — at most one per CSS pixel of the plot. */
  gridCols: number
  gridRows: number
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
   * the matrix, where it would be the identity.
   */
  source?: Int32Array
  /** True when more than one cell landed on a grid cell. */
  folded: boolean
  /** Cells per grid cell, for the caption's admission. 1 when nothing was folded. */
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
 */
export function colorDomain(extent: HeatmapExtent, scale: HeatmapScale): ColorDomain {
  if (scale === 'diverging') {
    const magnitude = Math.max(Math.abs(extent.min), Math.abs(extent.max)) || 1
    return { lo: -magnitude, hi: magnitude, neutral: 0 }
  }
  const lo = Math.min(0, extent.min)
  return { lo, hi: extent.max, neutral: lo }
}

/** Ramp position of a value, clamped to [0, 1]. */
export function normalize(value: number, domain: ColorDomain): number {
  const span = domain.hi - domain.lo || 1
  const t = (value - domain.lo) / span
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/** Ramp bucket of a value. */
export function bucketOf(value: number, domain: ColorDomain): number {
  return Math.round(normalize(value, domain) * (RAMP_STEPS - 1))
}

/**
 * The ramp, resolved to hex.
 *
 * One function for the cell fills and for the caption's colour bar, so the bar cannot come to
 * describe a scale the cells are not drawn in — the two were separate samplings of the same
 * ramp before, which is exactly how that drifts.
 */
export function rampColors(scale: HeatmapScale, mode: Mode, steps = RAMP_STEPS): string[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = steps === 1 ? 0 : i / (steps - 1)
    return scale === 'diverging' ? divergingColor(t * 2 - 1, mode) : sequentialColor(t, mode)
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
  room: number,
  cellSize: number,
  origin: number,
): { ticks: LabelTick[]; thinned: number } {
  if (labels.length === 0 || cellSize <= 0) return { ticks: [], thinned: 0 }
  const step = labelStep(labels.length, room, LABEL_PITCH)
  const ticks: LabelTick[] = []
  for (let i = 0; i < labels.length; i += step) {
    ticks.push({ index: i, label: labels[i]!, center: origin + (i + 0.5) * cellSize })
  }
  return { ticks, thinned: labels.length - ticks.length }
}

export interface HeatmapSpecOptions {
  matrix: MatrixValue
  scale: HeatmapScale
  width: number
  height: number
  /** Hide the gutters entirely — a card too narrow to spend width on names. */
  showLabels: boolean
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

  const extent = matrixExtent(matrix.values)
  const domain = colorDomain(extent, scale)

  // At most one grid cell per CSS pixel. Anything finer cannot be seen, and drawing it is the
  // whole of what the old ceiling was protecting against.
  const gridCols = Math.max(1, Math.min(cols, Math.floor(plot.width) || 1))
  const gridRows = Math.max(1, Math.min(rows, Math.floor(plot.height) || 1))
  const folded = gridCols < cols || gridRows < rows

  const cellWidth = plot.width / gridCols
  const cellHeight = plot.height / gridRows
  const gap = cellWidth > 6 && cellHeight > 6 ? 1 : 0

  const { buckets, source } = folded
    ? foldCells(matrix, domain, rows, cols, gridRows, gridCols)
    : { buckets: bucketsOf(matrix.values, domain), source: undefined }

  const rowAxis = options.showLabels
    ? labelTicks(matrix.rowLabels, plot.height, plot.height / rows, plot.y)
    : { ticks: [], thinned: 0 }
  const colAxis = options.showLabels
    ? labelTicks(matrix.colLabels, plot.width, plot.width / cols, plot.x)
    : { ticks: [], thinned: 0 }

  return {
    rows,
    cols,
    plot,
    gridCols,
    gridRows,
    cellWidth,
    cellHeight,
    gap,
    buckets,
    ...(source ? { source } : {}),
    folded,
    foldFactor: Math.max(1, Math.round((rows * cols) / (gridRows * gridCols))),
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
    labelsFit: cellHeight >= 14 && cellWidth >= 26 && rows * cols <= 400,
  }
}

/**
 * The value-to-bucket conversion with the division hoisted out.
 *
 * `bucketOf` is the readable single-value form and stays exported for callers holding one; this
 * is the same arithmetic for a loop that runs up to four million times, where recomputing
 * `hi - lo` and reloading three object properties per cell is most of the pass.
 */
function bucketScale(domain: ColorDomain): (value: number) => number {
  const lo = domain.lo
  const k = (RAMP_STEPS - 1) / (domain.hi - domain.lo || 1)
  return (value: number) => {
    const t = (value - lo) * k
    return t < 0 ? 0 : t > RAMP_STEPS - 1 ? RAMP_STEPS - 1 : Math.round(t)
  }
}

/** One bucket per cell, for a grid that *is* the matrix. */
function bucketsOf(values: Float64Array, domain: ColorDomain): Int16Array {
  const buckets = new Int16Array(values.length)
  const bucket = bucketScale(domain)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    buckets[i] = Number.isFinite(v) ? bucket(v) : -1
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
  rows: number,
  cols: number,
  gridRows: number,
  gridCols: number,
): { buckets: Int16Array; source: Int32Array } {
  const size = gridRows * gridCols
  const buckets = new Int16Array(size).fill(-1)
  const source = new Int32Array(size).fill(-1)
  const strength = new Float64Array(size).fill(Number.NEGATIVE_INFINITY)
  const values = matrix.values
  const { neutral } = domain
  const bucket = bucketScale(domain)

  // Row and column mappings are hoisted: `Math.floor(c * gridCols / cols)` inside the inner
  // loop is one multiply and one floor per cell, which at four million cells is the pass.
  const colOf = new Int32Array(cols)
  for (let c = 0; c < cols; c++)
    colOf[c] = Math.min(gridCols - 1, Math.floor((c * gridCols) / cols))

  for (let r = 0; r < rows; r++) {
    const gr = Math.min(gridRows - 1, Math.floor((r * gridRows) / rows))
    const gridRowStart = gr * gridCols
    const rowStart = r * cols
    for (let c = 0; c < cols; c++) {
      const v = values[rowStart + c]!
      if (!Number.isFinite(v)) continue
      const g = gridRowStart + colOf[c]!
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
  const gx = Math.min(spec.gridCols - 1, Math.floor((x - plot.x) / spec.cellWidth))
  const gy = Math.min(spec.gridRows - 1, Math.floor((y - plot.y) / spec.cellHeight))
  const g = gy * spec.gridCols + gx
  const index = spec.source ? spec.source[g]! : g
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
  const gx = Math.min(spec.gridCols - 1, Math.floor((col * spec.gridCols) / spec.cols))
  const gy = Math.min(spec.gridRows - 1, Math.floor((row * spec.gridRows) / spec.rows))
  return {
    x: spec.plot.x + gx * spec.cellWidth,
    y: spec.plot.y + gy * spec.cellHeight,
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
}

const AXIS_FONT = 10
const VALUE_FONT = 9.5

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
    })
  }
  return marks
}

/**
 * The value printed inside each cell, where the cells are big enough to carry one.
 *
 * Zero is skipped rather than printed: a "0" in every empty pair is chart noise. `labelsFit`
 * already implies an unfolded grid — it caps at 400 cells on cells of at least 26x14 px — so
 * the matrix's own stride indexes the buckets.
 */
export function valueMarks(
  spec: HeatmapSpec,
  values: Float64Array,
  ramp: string[],
): TextMark[] {
  if (!spec.labelsFit) return []
  const marks: TextMark[] = []
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.cols; c++) {
      const value = values[r * spec.cols + c]
      if (value === undefined || !Number.isFinite(value) || value === 0) continue
      const bucket = spec.buckets[r * spec.cols + c] ?? 0
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
      })
    }
  }
  return marks
}
