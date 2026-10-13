/**
 * The Line Chart's data, as lines: which ones there are, the points on each, and what a pixel
 * column of each keeps when there are more samples than pixels. Headless, so the rules are tested
 * without a DOM; `LineChartViewer.tsx` draws what this returns.
 *
 * **A line is a (series value, Y column) pair.** A wide table — `t`, `soma`, `site 1`, … as
 * a table of voltage traces has them — is several Y columns and no series; a long one is one Y and a
 * Series column; both at once is every Y for every series, labelled `series · Y`. Nothing is
 * refused, so a table can be read either way without reshaping it first.
 *
 * The Y columns arrive resolved: empty means every numeric column but X and Series, which is
 * `nodes/lib/lineChart.ts`' rule, read there by the export plan too.
 *
 * **Joined by X, or in row order.** By X sorts each line's samples first, so an unsorted table
 * still draws a function of X; row order keeps the rows as they come, for a trajectory that
 * doubles back (a phase plot). Only an X-ordered line is decimated: a pixel column of a function
 * has a meaning, a pixel column of a loop does not.
 *
 * **Decimation keeps the extremes.** A 20,000-sample trace on a 600-pixel axis is drawn from at
 * most four samples per pixel column — the first, the lowest, the highest and the last (M4) — so
 * a spike one sample wide is still on the screen and in the exported SVG, where thinning by a
 * stride would step over it.
 */

import { idText } from '../../core/ids'
import { lowerBound } from '../../core/stats'
import { MISSING_LABEL } from '../../nodes/lib/chartSelection'
import type { TableValue } from '../../core/values'
import { getColumn } from '../../core/values'
import type { Domain, ScaleKind } from './scatterPlot'
import { cellNumber, extentOf, forward } from './scatterPlot'

export type LineOrder = 'x' | 'rows'

export interface Line {
  /** The legend's word for it. */
  readonly label: string
  /** X and Y in *transformed* space (`forward` of the axis scale), in the order they are joined. */
  readonly x: Float64Array
  readonly y: Float64Array
  /** Whether `x` ascends, so a window can be cut by bisection and a pixel column means something. */
  readonly sorted: boolean
}

export interface Lines {
  readonly lines: readonly Line[]
  /** Rows a line had to skip: no number in X or Y. */
  readonly missing: number
  /** Rows a log axis had no room for: zero or below. */
  readonly nonPositive: number
}

/**
 * One line per (series value, Y column), series in order of first appearance. X is read and, in
 * X order, sorted once per series; each Y column then takes its samples in that order.
 */
export function buildLines(
  table: TableValue,
  options: {
    readonly x: string
    readonly ys: readonly string[]
    readonly series?: string | undefined
    readonly order: LineOrder
    readonly xScale: ScaleKind
    readonly yScale: ScaleKind
  },
): Lines {
  const xs = getColumn(table, options.x)
  const seriesCells = options.series ? getColumn(table, options.series) : undefined
  // Rows by series value, each list in row order.
  const groups = new Map<string, number[]>()
  for (let row = 0; row < table.length; row++) {
    const key = seriesCells ? (idText(seriesCells[row]) ?? MISSING_LABEL) : ''
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }
  const yColumns = options.ys.map((name) => getColumn(table, name))

  let missing = 0
  let nonPositive = 0
  const lines: Line[] = []
  for (const [key, rows] of groups) {
    // X once per series: read and transformed, the rows with no X (or none a log axis can take)
    // counted, and the rest put in the order the lines are joined. Every Y column then shares this
    // one X array, and copies it only if it drops a sample of its own.
    let noX = 0
    let xNotPositive = 0
    const usable: number[] = []
    const tx = new Float64Array(rows.length)
    rows.forEach((row, k) => {
      const x = cellNumber(xs[row])
      tx[k] = forward(options.xScale, x)
      if (!Number.isFinite(x)) noX++
      else if (!Number.isFinite(tx[k]!)) xNotPositive++
      else usable.push(k)
    })
    let sorted = true
    for (let j = 1; j < usable.length && sorted; j++) {
      if (tx[usable[j]!]! < tx[usable[j - 1]!]!) sorted = false
    }
    if (options.order === 'x' && !sorted) {
      // Stable, so equal Xs keep their row order.
      usable.sort((a, b) => tx[a]! - tx[b]! || a - b)
      sorted = true
    }
    const sharedX = Float64Array.from(usable, (k) => tx[k]!)

    yColumns.forEach((ys, c) => {
      missing += noX
      nonPositive += xNotPositive
      const ly = new Float64Array(usable.length)
      let lx: Float64Array | undefined // only once this column drops a sample
      let n = 0
      for (let j = 0; j < usable.length; j++) {
        const y = cellNumber(ys[rows[usable[j]!]!])
        const ty = forward(options.yScale, y)
        if (!Number.isFinite(y) || !Number.isFinite(ty)) {
          if (Number.isFinite(y)) nonPositive++
          else missing++
          lx ??= sharedX.slice()
          continue
        }
        if (lx) lx[n] = sharedX[j]!
        ly[n] = ty
        n++
      }
      const yName = options.ys[c]!
      const label = !options.series
        ? yName
        : options.ys.length === 1
          ? key
          : `${key} · ${yName}`
      lines.push({
        label,
        x: lx ? lx.subarray(0, n) : sharedX,
        y: n === usable.length ? ly : ly.subarray(0, n),
        sorted,
      })
    })
  }
  return { lines, missing, nonPositive }
}

/** Every line's X extent, transformed. */
export function xExtent(lines: readonly Line[]): Domain | undefined {
  let all: Domain | undefined
  for (const line of lines) {
    const e = extentOf(line.x)
    if (e) all = all ? { min: Math.min(all.min, e.min), max: Math.max(all.max, e.max) } : e
  }
  return all
}

/** The Y extent of a line's samples at `indices`, merged into `into`. */
export function yExtentOf(
  line: Line,
  indices: readonly number[],
  into: Domain | undefined,
): Domain | undefined {
  let min = into?.min ?? Infinity
  let max = into?.max ?? -Infinity
  for (const i of indices) {
    if (line.y[i]! < min) min = line.y[i]!
    if (line.y[i]! > max) max = line.y[i]!
  }
  return min <= max ? { min, max } : into
}

/**
 * The index range of a line worth drawing in a window: on a sorted line the samples inside it and
 * one either side, so the line runs to the plot's edge; on an unsorted one, all of them.
 */
export function indicesIn(line: Line, window: Domain): [number, number] {
  if (!line.sorted) return [0, line.x.length]
  const from = Math.max(0, lowerBound(line.x, window.min) - 1)
  const to = Math.min(line.x.length, lowerBound(line.x, window.max) + 1)
  return [from, to]
}

/**
 * The samples of a sorted line to draw across `columns` pixel columns of a window: per column the
 * first, the lowest, the highest and the last, in X order (M4). A line already sparser than that
 * comes back whole, as does an unsorted one, whose columns mean nothing.
 *
 * Because each column keeps its extremes, the Y extent over what this returns is the extent over
 * the window — what the axis refits to — without a second pass over every sample.
 */
export function decimate(line: Line, window: Domain, columns: number): number[] {
  const [from, to] = indicesIn(line, window)
  const span = window.max - window.min
  if (!line.sorted || to - from <= columns * 4 || columns < 1 || !(span > 0)) {
    return Array.from({ length: to - from }, (_, k) => from + k)
  }
  const keep: number[] = []
  let column = Number.NaN
  let first = -1
  let low = -1
  let high = -1
  let last = -1
  const push = (i: number) => {
    if (keep[keep.length - 1] !== i) keep.push(i)
  }
  const flush = () => {
    if (first < 0) return
    // The four in X order, each once: first and last bound the column, the extremes between.
    push(first)
    push(Math.min(low, high))
    push(Math.max(low, high))
    push(last)
  }
  for (let i = from; i < to; i++) {
    const c = Math.min(columns - 1, Math.floor(((line.x[i]! - window.min) / span) * columns))
    if (c !== column) {
      flush()
      column = c
      first = low = high = i
    }
    if (line.y[i]! < line.y[low]!) low = i
    if (line.y[i]! > line.y[high]!) high = i
    last = i
  }
  flush()
  return keep
}

/**
 * Each line's sample nearest `x` (transformed), for the crosshair: one reading per line at one
 * time point. Undefined for a line with no sample inside the window.
 */
export function valuesAt(
  lines: readonly Line[],
  x: number,
  window: Domain,
): ({ x: number; y: number } | undefined)[] {
  return lines.map((line) => {
    const [from, to] = indicesIn(line, window)
    let best = -1
    if (line.sorted) {
      const i = Math.min(to - 1, Math.max(from, lowerBound(line.x, x)))
      best = i
      if (i - 1 >= from && Math.abs(line.x[i - 1]! - x) <= Math.abs(line.x[i]! - x))
        best = i - 1
    } else {
      for (let i = from; i < to; i++) {
        if (best < 0 || Math.abs(line.x[i]! - x) < Math.abs(line.x[best]! - x)) best = i
      }
    }
    if (best < 0 || line.x[best]! < window.min || line.x[best]! > window.max) return undefined
    return { x: line.x[best]!, y: line.y[best]! }
  })
}

/**
 * A zoomed X window: `factor` above 1 zooms out, about the transformed X `at`; never wider than
 * the data, and undefined — the whole extent — once it reaches it.
 */
export function zoomWindow(
  window: Domain,
  full: Domain,
  factor: number,
  at: number,
): Domain | undefined {
  const min = at - (at - window.min) * factor
  const max = at + (window.max - at) * factor
  if (max - min >= full.max - full.min) return undefined
  return clampWindow({ min, max }, full)
}

/** A window moved by `delta` (transformed X), kept inside the data. */
export function panWindow(window: Domain, full: Domain, delta: number): Domain {
  return clampWindow({ min: window.min + delta, max: window.max + delta }, full)
}

function clampWindow(window: Domain, full: Domain): Domain {
  const span = window.max - window.min
  if (window.min < full.min) return { min: full.min, max: full.min + span }
  if (window.max > full.max) return { min: full.max - span, max: full.max }
  return window
}
