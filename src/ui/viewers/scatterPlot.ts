/**
 * Geometry for the scatter plot: scales, ticks, projection, culling, hit testing, lasso
 * containment and the least-squares trend.
 *
 * Headless and pure, with the same standing as `networkLayout.ts` and `networkDraw.ts`. The
 * viewer draws to a canvas and jsdom has no canvas, so everything decidable without pixels
 * is decided here, where a test can see it. The canvas painter and the SVG exporter both
 * consume what this returns, which is what keeps the exported file and the screen agreeing.
 *
 * Two coordinate spaces, and mixing them up is the trap:
 *
 *  - **value space** — what is in the column. What a tooltip prints.
 *  - **transformed space** — value space under the axis scale, i.e. `log10(value)` on a log
 *    axis and the value itself on a linear one. Domains, ticks, the viewport and the trend
 *    fit all live here, because that is the space the picture is *linear* in.
 *
 * `forward`/`inverse` are the only crossings. Everything named `*T` is transformed.
 */

import type { ColumnData } from '../../core/values'
import type { MarkerShape } from '../../nodes/lib/encodingParams'

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export type ScaleKind = 'linear' | 'log'

/**
 * Above this many marks inside the plot, the canvas pass draws pixels rather than tracing
 * antialiased paths (`scatterGl.ts`, `scatterRaster.ts`), and the SVG export embeds the marks as
 * one image. Asked through `drawsPixels`, so the screen and the export cannot disagree.
 *
 * Measured, not chosen (`pnpm probe:scatter-scale`, fish2's 129,325-point NBLAST embedding, M3
 * Max, devicePixelRatio 2): a path of 10,000 circles rasterises inside one 60 Hz frame, 50,000
 * took 117 ms and 129,325 took 420 ms — the cost is Skia's raster, ~3.4 µs a mark, not anything
 * this file computes. The pixel pass held 60 Hz at all 129,325. Counted over the *visible* marks,
 * so zooming in hands the picture back to real circles as soon as there are few enough to draw.
 */
export const CIRCLES_MAX = 10_000

/** Whether a spec is painted as pixels rather than paths — the one reading of `CIRCLES_MAX`. */
export function drawsPixels(spec: ScatterSpec): boolean {
  return spec.visible.length > CIRCLES_MAX
}

/**
 * Whether a frame is sparse enough to label — the one reading of `Label up to`, which the card's
 * caption and the placement both ask. Its ceiling (5,000) is under `CIRCLES_MAX`, so labels never
 * sit on the pixel pass.
 */
export function labelsApply(spec: ScatterSpec, limit: number): boolean {
  return spec.visible.length <= limit
}

/**
 * The opacity a mark is composited at. One function for every painter: the pixel passes have to
 * match the path pass exactly, or the cloud's density jumps as a zoom crosses `CIRCLES_MAX`.
 */
export function markAlpha(opacity: number): number {
  return Math.max(0.02, Math.min(1, opacity))
}

/**
 * Whether a mark of radius `r` at (`x`, `y`) touches the plot rect, `pad` pixels further out.
 * What fills `ScatterSpec.visible`, and what decides which selection rings are drawn.
 */
export function reachesPlot(plot: Rect, x: number, y: number, r: number, pad = 0): boolean {
  const reach = r + pad
  return (
    x + reach >= plot.x &&
    x - reach <= plot.x + plot.width &&
    y + reach >= plot.y &&
    y - reach <= plot.y + plot.height
  )
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export interface Domain {
  /** Both in transformed space. */
  min: number
  max: number
}

export interface Viewport {
  x: Domain
  y: Domain
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Value space → transformed space. Non-positive values have no log and come back NaN. */
export function forward(kind: ScaleKind, value: number): number {
  return kind === 'log' ? (value > 0 ? Math.log10(value) : Number.NaN) : value
}

/** Transformed space → value space. */
export function inverse(kind: ScaleKind, t: number): number {
  return kind === 'log' ? 10 ** t : t
}

/**
 * Read a cell as a plottable number.
 *
 * `Number(null)` is 0 and `Number('')` is 0, so a plain conversion plots every missing
 * reading on the axis origin — a dense stripe of data that does not exist. Same trap
 * `numeric()` in `encoding.ts` exists for, and the same answer.
 */
export function cellNumber(cell: unknown): number {
  if (cell === null || cell === undefined || cell === '') return Number.NaN
  if (typeof cell === 'boolean') return cell ? 1 : 0
  const value = Number(cell)
  return Number.isFinite(value) ? value : Number.NaN
}

/**
 * The rows that can be drawn at all, and how many could not.
 *
 * A row is dropped when either coordinate is missing or non-numeric, and additionally when a
 * log axis is asked for a value that is zero or negative. The count comes back rather than
 * being swallowed: a log toggle that silently discards half the data is exactly the kind of
 * quiet subtraction the caption rules here exist to prevent.
 */
export function usableRows(
  xValues: ColumnData,
  yValues: ColumnData,
  length: number,
  xScale: ScaleKind,
  yScale: ScaleKind,
): { rows: Int32Array; skipped: number } {
  const kept = new Int32Array(length)
  let n = 0
  for (let row = 0; row < length; row++) {
    const x = forward(xScale, cellNumber(xValues[row]))
    if (!Number.isFinite(x)) continue
    const y = forward(yScale, cellNumber(yValues[row]))
    if (!Number.isFinite(y)) continue
    kept[n++] = row
  }
  return { rows: kept.subarray(0, n), skipped: length - n }
}

/** Extent of a transformed coordinate, or undefined when there is none. */
export function extentOf(values: Float64Array): Domain | undefined {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < values.length; i++) {
    const t = values[i]!
    if (t < min) min = t
    if (t > max) max = t
  }
  return Number.isFinite(min) ? { min, max } : undefined
}

/**
 * Breathing room around the data, and a domain for the degenerate case.
 *
 * A single distinct value has zero span, which would divide by zero on projection and put
 * every point on one edge. It gets a unit window centred on itself instead — one decade on a
 * log axis, which is the same statement in that space.
 */
export function padDomain(domain: Domain, fraction = 0.05): Domain {
  const span = domain.max - domain.min
  if (!(span > 0)) return { min: domain.min - 0.5, max: domain.max + 0.5 }
  const pad = span * fraction
  return { min: domain.min - pad, max: domain.max + pad }
}

/**
 * Equal value-per-pixel on both axes, by *widening* the tighter one.
 *
 * Widening rather than tightening, always: shrinking a domain to match would push data
 * outside the plot, and an aspect setting that hides points is not an aspect setting. The
 * axis that already has the coarser scale is left exactly as it was, so the framing only
 * ever loosens.
 */
export function equaliseAspect(view: Viewport, plot: Rect): Viewport {
  const width = Math.max(1, plot.width)
  const height = Math.max(1, plot.height)
  const perPixel = Math.max(
    (view.x.max - view.x.min) / width,
    (view.y.max - view.y.min) / height,
  )
  return {
    x: centredOn(view.x, perPixel * width),
    y: centredOn(view.y, perPixel * height),
  }
}

function centredOn(domain: Domain, span: number): Domain {
  const mid = (domain.min + domain.max) / 2
  return { min: mid - span / 2, max: mid + span / 2 }
}

// ---------------------------------------------------------------------------
// Ticks
// ---------------------------------------------------------------------------

const roundTick = (value: number) => Math.round(value * 1e9) / 1e9

/**
 * Tick positions in transformed space, covering the visible domain.
 *
 * `niceTicks` in `format.ts` answers a narrower question — it always starts at zero, because
 * a bar chart's baseline does. A scatter's axes are windows onto arbitrary ranges that
 * routinely exclude zero, and after a zoom almost always do.
 */
export function axisTicks(domain: Domain, kind: ScaleKind, count = 5): number[] {
  if (!(domain.max > domain.min)) return [domain.min]
  return kind === 'log' ? logTicks(domain, count) : linearTicks(domain, count)
}

function linearTicks(domain: Domain, count: number): number[] {
  const span = domain.max - domain.min
  const rawStep = span / Math.max(1, count)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalised = rawStep / magnitude
  const step =
    (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10) * magnitude
  const ticks: number[] = []
  const first = Math.ceil(domain.min / step - 1e-9) * step
  for (let t = first; t <= domain.max + step * 1e-9; t += step) ticks.push(roundTick(t))
  return ticks
}

/**
 * Decades, subdivided into 1/2/5 only while the window is narrow enough for them to be
 * readable. Past a handful of decades the stride widens rather than the labels colliding.
 */
function logTicks(domain: Domain, count: number): number[] {
  const low = Math.floor(domain.min)
  const high = Math.ceil(domain.max)
  const decades = high - low
  const multiples = decades <= 2 ? [1, 2, 5] : [1]
  const stride = decades > count ? Math.ceil(decades / count) : 1
  const ticks: number[] = []
  for (let decade = low; decade <= high; decade += stride) {
    for (const multiple of multiples) {
      const t = decade + Math.log10(multiple)
      if (t >= domain.min - 1e-9 && t <= domain.max + 1e-9) ticks.push(roundTick(t))
    }
  }
  return ticks.length > 0 ? ticks : [domain.min, domain.max]
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * The projection, as `pixel = t · scale + offset` per axis — y's scale negative, because SVG
 * and canvas both grow downwards.
 *
 * The one definition of where a transformed value lands. `projectX`/`projectY` and every frame
 * read it, and the GPU pass is handed its numbers as uniforms rather than re-deriving them in GLSL,
 * so the two passes either side of `CIRCLES_MAX` cannot disagree about a mark's position.
 */
export interface Affine {
  sx: number
  ox: number
  sy: number
  oy: number
}

export function viewAffine(view: Viewport, plot: Rect): Affine {
  // A zero span would divide by zero; one unit is as good a window as any for a single value.
  const sx = plot.width / (view.x.max - view.x.min || 1)
  const sy = -plot.height / (view.y.max - view.y.min || 1)
  return { sx, ox: plot.x - view.x.min * sx, sy, oy: plot.y + plot.height - view.y.min * sy }
}

/** Transformed value → pixel x within the plot rect. */
export function projectX(t: number, view: Viewport, plot: Rect): number {
  const a = viewAffine(view, plot)
  return t * a.sx + a.ox
}

/** Transformed value → pixel y. */
export function projectY(t: number, view: Viewport, plot: Rect): number {
  const a = viewAffine(view, plot)
  return t * a.sy + a.oy
}

/** Pixel x → transformed value: `viewAffine` inverted. A plot with no width maps to its edge. */
export function unprojectX(px: number, view: Viewport, plot: Rect): number {
  const a = viewAffine(view, plot)
  return a.sx ? (px - a.ox) / a.sx : view.x.min
}

/** Pixel y → transformed value. */
export function unprojectY(px: number, view: Viewport, plot: Rect): number {
  const a = viewAffine(view, plot)
  return a.sy ? (px - a.oy) / a.sy : view.y.min
}

// ---------------------------------------------------------------------------
// The drawable spec
// ---------------------------------------------------------------------------

/** How each row is marked. Supplied by the caller so colour mapping stays in `encoding.ts`. */
export interface MarkStyle {
  colorAt(row: number): string
  radiusAt(row: number): number
  shapeAt(row: number): MarkerShape
}

/**
 * A fitted straight line, in transformed space, with the correlation behind it.
 *
 * Transformed rather than value space because that is the space the axes are linear in, so
 * the line is straight on screen. On a log-log plot that makes it a power law and on a
 * semi-log an exponential, which is the reading anyone puts a log axis on to get.
 */
export interface TrendLine {
  color: string
  /** Endpoints in transformed space; the drawer projects and clips them. */
  x0: number
  y0: number
  x1: number
  y1: number
  /** Pearson correlation over the points fitted, in the same transformed space. */
  r: number
  n: number
}

/** A trend fitted once per marks, in transformed space; a frame only places its ends. */
export interface TrendFit {
  /** The group's colour; undefined for the one overall line, which takes the frame's ink. */
  color: string | undefined
  slope: number
  intercept: number
  r: number
  n: number
}

/**
 * Everything about the marks that a pan or a zoom does not change, built once per table,
 * columns, scales and encoding.
 *
 * The split from `ScatterSpec` is the whole of what makes a pan cheap at embedding scale. A frame
 * used to re-read every cell, re-resolve every colour, shape and radius through the encodings, and
 * regroup and re-upload all of it — for fish2's 129,325 marks, a 2.5 MB GPU upload and two
 * `Array(129325)` per pointer move, for values that cannot have changed. Now a frame projects the
 * transformed coordinates held here and does nothing else per mark; the GPU pass uploads these
 * arrays once and moves a uniform (`scatterGl.ts`); and selection indices, which are positions in
 * these arrays, survive every pan.
 *
 * Parallel arrays rather than an array of point objects, a hundred thousand small objects being
 * real garbage for a structure that is written once and read many times.
 */
export interface ScatterMarks {
  xScale: ScaleKind
  yScale: ScaleKind
  /**
   * Source row behind each mark: every usable row. Also what the lasso is tested against, so
   * the selection and the drawing are the same set of rows.
   */
  rows: Int32Array
  /** Coordinates in transformed space — what a frame projects. */
  xt: Float64Array
  yt: Float64Array
  radius: Float32Array
  colors: string[]
  shapes: MarkerShape[]
  /** Every mark grouped by colour and shape, in stacking order. See `markBuckets`. */
  buckets: MarkBucket[]
  /** Which of `buckets` each mark is in, so a frame can sort its visible marks in one pass. */
  bucketOf: Uint32Array
  /** What the GPU pass checks against the driver's largest point before it draws anything. */
  largestRadius: number
  /** Unpadded extent in transformed space; undefined with nothing to plot. */
  extent: Viewport | undefined
  fits: TrendFit[]
  /** Rows with a missing, non-numeric or (under a log axis) non-positive coordinate. */
  skipped: number
}

/**
 * One frame: the marks projected into the plot under a view, and nothing else.
 */
export interface ScatterSpec {
  marks: ScatterMarks
  plot: Rect
  view: Viewport
  /** Tick positions in transformed space. Label them through `inverse`. */
  xTicks: number[]
  yTicks: number[]
  /** Pixel position of every mark, indexed as the marks are. */
  px: Float32Array
  py: Float32Array
  trends: TrendLine[]
  /**
   * Indices of the marks that reach the plot rect, radius included.
   *
   * The culling every consumer shares: the canvas pass, the hit index and the export all walk
   * this, so a zoom into one cluster of a whole-dataset embedding costs what that cluster costs.
   * It is also what `CIRCLES_MAX` is counted against.
   */
  visible: Int32Array
}

export interface MarksOptions {
  xValues: ColumnData
  yValues: ColumnData
  length: number
  xScale: ScaleKind
  yScale: ScaleKind
  style: MarkStyle
  trend?: 'none' | 'linear'
  /** One fit per colour the marks resolved to, rather than one overall. */
  trendPerGroup?: boolean
}

export function buildMarks(options: MarksOptions): ScatterMarks {
  const { xValues, yValues, length, xScale, yScale, style } = options
  const { rows, skipped } = usableRows(xValues, yValues, length, xScale, yScale)
  const count = rows.length
  const xt = new Float64Array(count)
  const yt = new Float64Array(count)
  const radius = new Float32Array(count)
  const colors = new Array<string>(count)
  const shapes = new Array<MarkerShape>(count)
  let largestRadius = 0
  for (let i = 0; i < count; i++) {
    const row = rows[i]!
    xt[i] = forward(xScale, cellNumber(xValues[row]))
    yt[i] = forward(yScale, cellNumber(yValues[row]))
    const r = style.radiusAt(row)
    radius[i] = r
    if (r > largestRadius) largestRadius = r
    colors[i] = style.colorAt(row)
    shapes[i] = style.shapeAt(row)
  }
  const x = extentOf(xt)
  const y = extentOf(yt)
  return {
    xScale,
    yScale,
    rows,
    xt,
    yt,
    radius,
    colors,
    shapes,
    ...markBuckets(colors, shapes),
    largestRadius,
    extent: x && y ? { x, y } : undefined,
    fits:
      options.trend === 'linear'
        ? fitTrends(xt, yt, options.trendPerGroup !== false ? colors : undefined)
        : [],
    skipped,
  }
}

export interface BuildOptions {
  marks: ScatterMarks
  plot: Rect
  /** Omit to frame the data; supply one to keep a pan/zoom the user set. */
  view?: Viewport
  aspect?: 'fit' | 'equal'
  /**
   * The ink of a single overall trend line. A frame's rather than the marks', so a theme change
   * re-inks the line without rebuilding — and re-uploading — every mark.
   */
  trendColor: string
}

/**
 * Frame the data: the padded extent of both axes, equalised if asked.
 *
 * Exported because the viewer needs it twice — once to seed its viewport and once when Fit
 * is pressed — and because a fit computed differently in those two places is a Fit button
 * that moves the picture.
 */
export function fitView(
  marks: ScatterMarks,
  plot: Rect,
  aspect?: 'fit' | 'equal',
): Viewport | undefined {
  if (!marks.extent) return undefined
  const view: Viewport = { x: padDomain(marks.extent.x), y: padDomain(marks.extent.y) }
  return aspect === 'equal' ? equaliseAspect(view, plot) : view
}

export function buildScatter(options: BuildOptions): ScatterSpec {
  const { marks, plot } = options
  const view = options.view ??
    fitView(marks, plot, options.aspect) ?? { x: { min: 0, max: 1 }, y: { min: 0, max: 1 } }

  const count = marks.rows.length
  const px = new Float32Array(count)
  const py = new Float32Array(count)
  const visible = new Int32Array(count)
  const { sx, ox, sy, oy } = viewAffine(view, plot)
  let seen = 0
  for (let i = 0; i < count; i++) {
    const x = marks.xt[i]! * sx + ox
    const y = marks.yt[i]! * sy + oy
    px[i] = x
    py[i] = y
    if (reachesPlot(plot, x, y, marks.radius[i]!)) visible[seen++] = i
  }

  return {
    marks,
    plot,
    view,
    xTicks: axisTicks(view.x, marks.xScale),
    yTicks: axisTicks(view.y, marks.yScale),
    px,
    py,
    trends: marks.fits.map((fit) => ({
      color: fit.color ?? options.trendColor,
      x0: view.x.min,
      y0: fit.intercept + fit.slope * view.x.min,
      x1: view.x.max,
      y1: fit.intercept + fit.slope * view.x.max,
      r: fit.r,
      n: fit.n,
    })),
    visible: visible.subarray(0, seen),
  }
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/**
 * Ordinary least squares plus Pearson's r, over transformed coordinates.
 *
 * Returns nothing rather than a line when there is nothing to fit: fewer than two points, or
 * a vertical cloud where the slope is infinite. A line drawn through one point is a claim
 * about a relationship that has not been observed.
 */
export function fitLine(
  xs: Float64Array,
  ys: Float64Array,
): { slope: number; intercept: number; r: number; n: number } | undefined {
  const n = xs.length
  if (n < 2) return undefined
  let sumX = 0
  let sumY = 0
  for (let i = 0; i < n; i++) {
    sumX += xs[i]!
    sumY += ys[i]!
  }
  const meanX = sumX / n
  const meanY = sumY / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX
    const dy = ys[i]! - meanY
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (!(sxx > 0)) return undefined
  const slope = sxy / sxx
  const denominator = Math.sqrt(sxx * syy)
  return {
    slope,
    intercept: meanY - slope * meanX,
    // A flat cloud has no correlation to report rather than a division by zero.
    r: denominator > 0 ? sxy / denominator : 0,
    n,
  }
}

/**
 * One fit overall (`colors` undefined), or one per colour group, over transformed space.
 *
 * Grouping is keyed on the *resolved colour* rather than on the raw column value, which is
 * what makes each line correspond exactly to a legend entry — the eight-slot cap and the
 * achromatic `Other` fold already happened, so a ninth category's line is drawn for the
 * bucket the legend actually names instead of for a group nothing on screen identifies.
 * A constant colour therefore collapses to a single line by construction.
 */
function fitTrends(
  xt: Float64Array,
  yt: Float64Array,
  colors: string[] | undefined,
): TrendFit[] {
  const groups = new Map<string, number[]>()
  for (let i = 0; i < xt.length; i++) {
    const key = colors ? colors[i]! : ''
    const bucket = groups.get(key)
    if (bucket) bucket.push(i)
    else groups.set(key, [i])
  }
  const fits: TrendFit[] = []
  for (const [key, members] of groups) {
    const fit = fitLine(
      Float64Array.from(members, (i) => xt[i]!),
      Float64Array.from(members, (i) => yt[i]!),
    )
    if (fit) fits.push({ color: colors ? key : undefined, ...fit })
  }
  return fits
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/**
 * Nearest-mark lookup over a uniform grid.
 *
 * A grid rather than a quadtree: the points are already projected into a bounded rect, the
 * query is always "what is under the pointer", and a flat array of buckets has no pointer
 * chasing.
 */
export interface HitIndex {
  /** Position of the nearest mark in `spec.marks`, or -1. */
  nearest(x: number, y: number, maxDistance: number): number
}

/**
 * Over the visible marks only. An off-screen mark cannot be under the pointer, and `cellOf`
 * clamps to the border cells — so indexing every mark piled a zoomed-out remainder of a
 * 100k-point embedding into the cells along the edge, and hovering there walked all of it.
 *
 * Built on the first query rather than with the spec. A pan makes a spec per pointer move and
 * hovers none of them — the pointer is dragging — so an eager index was a grid of a hundred
 * thousand entries built and thrown away every frame.
 */
export function buildHitIndex(spec: ScatterSpec, cellSize = 16): HitIndex {
  const { plot, px, py, visible } = spec
  const cell = Math.max(4, cellSize)
  const cols = Math.max(1, Math.ceil(plot.width / cell))
  const rows = Math.max(1, Math.ceil(plot.height / cell))
  let buckets: number[][] | undefined

  // Clamped, so a position off the plot reads as the border cell.
  const colOf = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - plot.x) / cell)))
  const rowOf = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - plot.y) / cell)))

  const index = (): number[][] => {
    if (buckets) return buckets
    buckets = Array.from({ length: cols * rows }, () => [])
    for (const i of visible) buckets[rowOf(py[i]!) * cols + colOf(px[i]!)]!.push(i)
    return buckets
  }

  return {
    nearest(x, y, maxDistance) {
      const grid = index()
      // The search widens by whole cells until it has covered `maxDistance`, so a sparse
      // region costs the same handful of buckets as a dense one.
      const reach = Math.ceil(maxDistance / cell)
      const col = colOf(x)
      const row = rowOf(y)
      let best = -1
      let bestDistance = maxDistance * maxDistance
      for (let r = Math.max(0, row - reach); r <= Math.min(rows - 1, row + reach); r++) {
        for (let c = Math.max(0, col - reach); c <= Math.min(cols - 1, col + reach); c++) {
          for (const i of grid[r * cols + c]!) {
            const dx = px[i]! - x
            const dy = py[i]! - y
            const distance = dx * dx + dy * dy
            if (distance <= bestDistance) {
              bestDistance = distance
              best = i
            }
          }
        }
      }
      return best
    },
  }
}

// ---------------------------------------------------------------------------
// Lasso
// ---------------------------------------------------------------------------

/** Ray-crossing test against a flat `[x0, y0, x1, y1, …]` polygon. */
export function pointInPolygon(x: number, y: number, polygon: number[]): boolean {
  let inside = false
  const count = polygon.length / 2
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = polygon[i * 2]!
    const yi = polygon[i * 2 + 1]!
    const xj = polygon[j * 2]!
    const yj = polygon[j * 2 + 1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Every source row whose mark falls inside the polygon — every mark, on screen or not, tested at
 * the frame's own projection, so the answer does not depend on which renderer drew them.
 */
export function rowsInPolygon(spec: ScatterSpec, polygon: number[]): number[] {
  if (polygon.length < 6) return []
  const { px, py, marks } = spec
  const hits: number[] = []
  for (let i = 0; i < marks.rows.length; i++) {
    if (pointInPolygon(px[i]!, py[i]!, polygon)) hits.push(marks.rows[i]!)
  }
  return hits
}

/** A rectangle expressed as a polygon, so box and lasso share one containment test. */
export function rectPolygon(x0: number, y0: number, x1: number, y1: number): number[] {
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)
  return [left, top, right, top, right, bottom, left, bottom]
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

export interface MarkBucket {
  color: string
  shape: MarkerShape
  /** Indices of the marks in this bucket, in mark order. */
  indices: number[]
}

/**
 * The marks grouped by colour and shape, buckets in order of first appearance, and which bucket
 * each mark went to.
 *
 * One grouping for every painter — the canvas path, the pixel raster, the GPU pass and the SVG —
 * because the bucket order *is* the stacking order: a later bucket is drawn over an earlier one.
 * Two painters batching their own way would stack one category over another on screen and the
 * other way round past `CIRCLES_MAX`, and the cloud would visibly change as a zoom crossed it.
 * Built once per marks; a frame takes its subset through `visibleBuckets`, which keeps the order.
 */
function markBuckets(
  colors: string[],
  shapes: MarkerShape[],
): { buckets: MarkBucket[]; bucketOf: Uint32Array } {
  const buckets: MarkBucket[] = []
  const bucketOf = new Uint32Array(colors.length)
  const byColor = new Map<string, Map<MarkerShape, number>>()
  for (let i = 0; i < colors.length; i++) {
    const color = colors[i]!
    const shape = shapes[i]!
    let byShape = byColor.get(color)
    if (!byShape) byColor.set(color, (byShape = new Map()))
    let at = byShape.get(shape)
    if (at === undefined) {
      at = buckets.length
      byShape.set(shape, at)
      buckets.push({ color, shape, indices: [] })
    }
    buckets[at]!.indices.push(i)
    bucketOf[i] = at
  }
  return { buckets, bucketOf }
}

/** Kept per spec: a hover or a selection change repaints the same frame. */
const visibleCache = new WeakMap<ScatterSpec, MarkBucket[]>()

/**
 * A frame's visible marks, in the marks' own buckets and their order — one pass over `visible`,
 * which is ascending, so each bucket keeps its marks in mark order too.
 */
export function visibleBuckets(spec: ScatterSpec): MarkBucket[] {
  const { buckets, bucketOf, rows } = spec.marks
  if (spec.visible.length === rows.length) return buckets
  let kept = visibleCache.get(spec)
  if (kept) return kept
  const indices: number[][] = buckets.map(() => [])
  for (const i of spec.visible) indices[bucketOf[i]!]!.push(i)
  kept = []
  for (let b = 0; b < buckets.length; b++) {
    if (indices[b]!.length > 0) kept.push({ ...buckets[b]!, indices: indices[b]! })
  }
  visibleCache.set(spec, kept)
  return kept
}
