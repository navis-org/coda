/**
 * Geometry for the scatter plot: scales, ticks, the point budget, projection, hit testing,
 * lasso containment and the least-squares trend.
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

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export type ScaleKind = 'linear' | 'log'

export type MarkerShape =
  | 'circle'
  | 'square'
  | 'triangle'
  | 'diamond'
  | 'cross'
  | 'plus'
  | 'dash'

/**
 * Shapes in assignment order, most distinguishable first.
 *
 * Six rather than eight, and deliberately fewer than the colour palette's slots: shape is a
 * coarser channel than hue at the sizes a point is drawn, and a seventh mark that reads as
 * "a slightly different blob" is worse than an honest fold.
 */
export const MARKER_SHAPES: readonly MarkerShape[] = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'cross',
  'plus',
]

export const MAX_SHAPES = MARKER_SHAPES.length

/**
 * The shape everything past the cap takes.
 *
 * A dash, chosen because it shares no silhouette with any of the six — folding into `circle`
 * would make the residual bucket indistinguishable from the most common category, which is
 * the same mistake as cycling a categorical hue.
 */
export const OTHER_SHAPE: MarkerShape = 'dash'

/** Default ceiling on drawn points. See `sampleRows` for what happens above it. */
export const DEFAULT_MAX_POINTS = 50_000

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

/**
 * A stable stride through the usable rows, capped at `maxPoints`.
 *
 * Deterministic on purpose — a random sample would reshuffle on every re-render, so panning
 * would make points flicker in and out and the picture would never be the same twice. The
 * stride is over the row order, which is arbitrary with respect to position, so it thins the
 * cloud evenly rather than clipping a corner of it.
 *
 * The *selection* is not sampled: a lasso is tested against every usable row, so it catches
 * what is inside it whether or not that point was drawn. See `rowsInPolygon`.
 */
export function sampleRows(rows: Int32Array, maxPoints: number): Int32Array {
  const cap = Math.max(1, Math.floor(maxPoints))
  if (rows.length <= cap) return rows
  const out = new Int32Array(cap)
  const stride = rows.length / cap
  for (let i = 0; i < cap; i++) out[i] = rows[Math.floor(i * stride)]!
  return out
}

/** Extent of the transformed coordinate over the given rows, or undefined when empty. */
export function extentOf(
  values: ColumnData,
  rows: Int32Array,
  kind: ScaleKind,
): Domain | undefined {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < rows.length; i++) {
    const t = forward(kind, cellNumber(values[rows[i]!]))
    if (!Number.isFinite(t)) continue
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
  const perPixel = Math.max((view.x.max - view.x.min) / width, (view.y.max - view.y.min) / height)
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
  const step = (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10) * magnitude
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

/** Transformed value → pixel x within the plot rect. */
export function projectX(t: number, view: Viewport, plot: Rect): number {
  const span = view.x.max - view.x.min || 1
  return plot.x + ((t - view.x.min) / span) * plot.width
}

/** Transformed value → pixel y. Flipped, because SVG and canvas both grow downwards. */
export function projectY(t: number, view: Viewport, plot: Rect): number {
  const span = view.y.max - view.y.min || 1
  return plot.y + plot.height - ((t - view.y.min) / span) * plot.height
}

export function unprojectX(px: number, view: Viewport, plot: Rect): number {
  const span = view.x.max - view.x.min || 1
  return view.x.min + ((px - plot.x) / Math.max(1, plot.width)) * span
}

export function unprojectY(px: number, view: Viewport, plot: Rect): number {
  const span = view.y.max - view.y.min || 1
  return view.y.min + ((plot.y + plot.height - px) / Math.max(1, plot.height)) * span
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

/**
 * Everything needed to paint one frame, in pixels, and nothing else.
 *
 * Parallel arrays rather than an array of point objects: at the default cap this is fifty
 * thousand marks, and fifty thousand small objects per re-render is real garbage for a
 * structure that is written once and read once.
 */
export interface ScatterSpec {
  plot: Rect
  view: Viewport
  xScale: ScaleKind
  yScale: ScaleKind
  /** Tick positions in transformed space. Label them through `inverse`. */
  xTicks: number[]
  yTicks: number[]
  /** Source row behind each drawn mark. */
  rows: Int32Array
  px: Float32Array
  py: Float32Array
  radius: Float32Array
  colors: string[]
  shapes: MarkerShape[]
  trends: TrendLine[]
  /** Marks painted. */
  drawn: number
  /**
   * Every row that could be drawn, before the point budget — which is a superset of `rows`.
   * Carried on the spec because the lasso is tested against it rather than against the
   * sample, and recomputing it per gesture would be a second pass that could disagree.
   */
  usableRows: Int32Array
  total: number
  /** Rows with a missing, non-numeric or (under a log axis) non-positive coordinate. */
  skipped: number
}

export interface BuildOptions {
  xValues: ColumnData
  yValues: ColumnData
  length: number
  xScale: ScaleKind
  yScale: ScaleKind
  plot: Rect
  /** Omit to frame the data; supply one to keep a pan/zoom the user set. */
  view?: Viewport
  aspect?: 'fit' | 'equal'
  maxPoints?: number
  style: MarkStyle
  /** Rows to fit trends over, grouped by the colour they resolved to. Empty for none. */
  trend?: 'none' | 'linear'
  trendPerGroup?: boolean
  trendColor: string
}

/**
 * Frame the data: the padded extent of both axes, equalised if asked.
 *
 * Exported because the viewer needs it twice — once to seed its viewport and once when Fit
 * is pressed — and because a fit computed differently in those two places is a Fit button
 * that moves the picture.
 */
export function fitView(options: {
  xValues: ColumnData
  yValues: ColumnData
  rows: Int32Array
  xScale: ScaleKind
  yScale: ScaleKind
  plot: Rect
  aspect?: 'fit' | 'equal'
}): Viewport | undefined {
  const x = extentOf(options.xValues, options.rows, options.xScale)
  const y = extentOf(options.yValues, options.rows, options.yScale)
  if (!x || !y) return undefined
  const view: Viewport = { x: padDomain(x), y: padDomain(y) }
  return options.aspect === 'equal' ? equaliseAspect(view, options.plot) : view
}

export function buildScatter(options: BuildOptions): ScatterSpec {
  const { xValues, yValues, length, xScale, yScale, plot, style } = options
  const { rows: usable, skipped } = usableRows(xValues, yValues, length, xScale, yScale)

  // The frame is computed over *every* usable row, not over the sample: an axis range that
  // moved when the point budget changed would make the cap look like a filter on the data.
  const view =
    options.view ??
    fitView({ xValues, yValues, rows: usable, xScale, yScale, plot, ...(options.aspect ? { aspect: options.aspect } : {}) }) ??
    { x: { min: 0, max: 1 }, y: { min: 0, max: 1 } }

  const drawn = sampleRows(usable, options.maxPoints ?? DEFAULT_MAX_POINTS)
  const count = drawn.length
  const px = new Float32Array(count)
  const py = new Float32Array(count)
  const radius = new Float32Array(count)
  const colors = new Array<string>(count)
  const shapes = new Array<MarkerShape>(count)

  for (let i = 0; i < count; i++) {
    const row = drawn[i]!
    px[i] = projectX(forward(xScale, cellNumber(xValues[row])), view, plot)
    py[i] = projectY(forward(yScale, cellNumber(yValues[row])), view, plot)
    radius[i] = style.radiusAt(row)
    colors[i] = style.colorAt(row)
    shapes[i] = style.shapeAt(row)
  }

  const trends =
    options.trend === 'linear'
      ? fitTrends({
          xValues,
          yValues,
          rows: usable,
          xScale,
          yScale,
          view,
          perGroup: options.trendPerGroup !== false,
          colorAt: style.colorAt,
          fallbackColor: options.trendColor,
        })
      : []

  return {
    plot,
    view,
    xScale,
    yScale,
    xTicks: axisTicks(view.x, xScale),
    yTicks: axisTicks(view.y, yScale),
    rows: drawn,
    px,
    py,
    radius,
    colors,
    shapes,
    trends,
    drawn: count,
    usableRows: usable,
    total: length,
    skipped,
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
 * One line overall, or one per colour group.
 *
 * Grouping is keyed on the *resolved colour* rather than on the raw column value, which is
 * what makes each line correspond exactly to a legend entry — the eight-slot cap and the
 * achromatic `Other` fold already happened, so a ninth category's line is drawn for the
 * bucket the legend actually names instead of for a group nothing on screen identifies.
 * A constant colour therefore collapses to a single line by construction.
 */
function fitTrends(options: {
  xValues: ColumnData
  yValues: ColumnData
  rows: Int32Array
  xScale: ScaleKind
  yScale: ScaleKind
  view: Viewport
  perGroup: boolean
  colorAt: (row: number) => string
  fallbackColor: string
}): TrendLine[] {
  const { xValues, yValues, rows, xScale, yScale, view, perGroup, colorAt } = options
  const groups = new Map<string, number[]>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const key = perGroup ? colorAt(row) : ''
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }

  const lines: TrendLine[] = []
  for (const [key, bucket] of groups) {
    const xs = new Float64Array(bucket.length)
    const ys = new Float64Array(bucket.length)
    for (let i = 0; i < bucket.length; i++) {
      xs[i] = forward(xScale, cellNumber(xValues[bucket[i]!]))
      ys[i] = forward(yScale, cellNumber(yValues[bucket[i]!]))
    }
    const fit = fitLine(xs, ys)
    if (!fit) continue
    lines.push({
      color: key || options.fallbackColor,
      x0: view.x.min,
      y0: fit.intercept + fit.slope * view.x.min,
      x1: view.x.max,
      y1: fit.intercept + fit.slope * view.x.max,
      r: fit.r,
      n: fit.n,
    })
  }
  return lines
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/**
 * Nearest-mark lookup over a uniform grid.
 *
 * A grid rather than a quadtree: the points are already projected into a bounded rect, the
 * query is always "what is under the pointer", and a flat array of buckets has no pointer
 * chasing. Rebuilt whenever the spec is, which is once per pan/zoom/restyle rather than once
 * per mouse move.
 */
export interface HitIndex {
  /** Index into the spec's parallel arrays, or -1. */
  nearest(x: number, y: number, maxDistance: number): number
}

export function buildHitIndex(spec: ScatterSpec, cellSize = 16): HitIndex {
  const { plot, px, py, drawn } = spec
  const cell = Math.max(4, cellSize)
  const cols = Math.max(1, Math.ceil(plot.width / cell))
  const rows = Math.max(1, Math.ceil(plot.height / cell))
  const buckets: number[][] = Array.from({ length: cols * rows }, () => [])

  const cellOf = (x: number, y: number): number => {
    const col = Math.min(cols - 1, Math.max(0, Math.floor((x - plot.x) / cell)))
    const row = Math.min(rows - 1, Math.max(0, Math.floor((y - plot.y) / cell)))
    return row * cols + col
  }

  for (let i = 0; i < drawn; i++) buckets[cellOf(px[i]!, py[i]!)]!.push(i)

  return {
    nearest(x, y, maxDistance) {
      // The search widens by whole cells until it has covered `maxDistance`, so a sparse
      // region costs the same handful of buckets as a dense one.
      const reach = Math.ceil(maxDistance / cell)
      const col = Math.min(cols - 1, Math.max(0, Math.floor((x - plot.x) / cell)))
      const row = Math.min(rows - 1, Math.max(0, Math.floor((y - plot.y) / cell)))
      let best = -1
      let bestDistance = maxDistance * maxDistance
      for (let r = Math.max(0, row - reach); r <= Math.min(rows - 1, row + reach); r++) {
        for (let c = Math.max(0, col - reach); c <= Math.min(cols - 1, col + reach); c++) {
          for (const i of buckets[r * cols + c]!) {
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
 * Every row whose position falls inside the polygon — tested against the *whole* table, not
 * against the sample that was drawn.
 *
 * That is the deliberate half. Above the point budget a lasso still catches what is inside
 * it, so `Selected` describes the region rather than the subset that happened to survive the
 * stride. The caption says how many points were drawn, which is what stops the difference
 * from being a surprise.
 */
export function rowsInPolygon(options: {
  xValues: ColumnData
  yValues: ColumnData
  rows: Int32Array
  xScale: ScaleKind
  yScale: ScaleKind
  view: Viewport
  plot: Rect
  polygon: number[]
}): number[] {
  const { xValues, yValues, rows, xScale, yScale, view, plot, polygon } = options
  if (polygon.length < 6) return []
  const hits: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const x = projectX(forward(xScale, cellNumber(xValues[row])), view, plot)
    const y = projectY(forward(yScale, cellNumber(yValues[row])), view, plot)
    if (pointInPolygon(x, y, polygon)) hits.push(row)
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
// Categorical shape assignment
// ---------------------------------------------------------------------------

export interface ShapeEncoding {
  shapeAt(row: number): MarkerShape
  /** Legend entries, in assignment order, with the fold last when there was one. */
  entries: Array<{ label: string; shape: MarkerShape }>
  column: string
  truncated: boolean
}

/**
 * Shape by category, ranked by frequency exactly as `resolveColor` ranks hue.
 *
 * Same rule, same reason: the most common values take the most distinguishable marks, and
 * the tail folds into one residual bucket rather than reusing a mark and implying two
 * categories are the same thing.
 */
export function resolveShape(
  values: ColumnData | undefined,
  column: string | undefined,
): ShapeEncoding | undefined {
  if (!values || !column) return undefined
  const counts = new Map<string, number>()
  for (const cell of values) {
    const key = cell === null || cell === undefined ? '—' : String(cell)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (counts.size <= 1) return undefined

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const kept = ranked.slice(0, MAX_SHAPES).map(([key]) => key)
  const slotOf = new Map(kept.map((key, index) => [key, index]))
  const truncated = ranked.length > MAX_SHAPES

  const entries = kept.map((label, index) => ({ label, shape: MARKER_SHAPES[index]! }))
  if (truncated) entries.push({ label: 'Other', shape: OTHER_SHAPE })

  return {
    column,
    truncated,
    entries,
    shapeAt: (row) => {
      const cell = values[row]
      const key = cell === null || cell === undefined ? '—' : String(cell)
      const slot = slotOf.get(key)
      return slot === undefined ? OTHER_SHAPE : MARKER_SHAPES[slot]!
    },
  }
}
