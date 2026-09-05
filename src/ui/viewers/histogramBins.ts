/**
 * Binning, headless.
 *
 * Everything the histogram knows about numbers lives here rather than in the component, and
 * that is the standing rule for the chart viewers rather than tidiness: jsdom performs no
 * layout, so arithmetic left inside a `.tsx` is covered by roughly nothing. Same standing
 * `scatterPlot.ts` and `networkLayout.ts` have.
 *
 * Two things are worth knowing before changing any of it.
 *
 * **Edges are in value space, always.** A log axis bins in `log10` and converts back before
 * anything leaves this module, so a bar's `lo`/`hi` can be compared directly against the
 * column — which is what makes a stored selection (`chartSelection.ts`) mean the same thing
 * whether or not the axis was logarithmic when it was clicked.
 *
 * **A bar carries its raw count as well as its plotted height.** `percent` and `density`
 * rescale the drawing; a tooltip that then reported "0.004" for a bar holding 41 neurons would
 * be answering a question nobody asked. Both travel together so neither can be inferred wrong.
 */

import type { TableValue } from '../../core/values'
import { markLabel, numericCell } from '../../nodes/lib/chartSelection'
import type { ValueRange } from '../../nodes/lib/chartSelection'
import { foldByRank } from '../colors'
import { MAX_SERIES, OTHER_LABEL } from '../colors'
import { quantileSorted } from './boxStats'

export type Normalize = 'count' | 'percent' | 'density'

export interface HistogramOptions {
  /** `auto` applies the Freedman–Diaconis rule; `fixed` takes `bins` as given. */
  binMode?: 'auto' | 'fixed'
  bins?: number
  /** Bin in log10, dropping values at or below zero. */
  log?: boolean
  normalize?: Normalize
  cumulative?: boolean
}

export interface HistogramSegment {
  series: string
  /** Plotted height, after `normalize` and `cumulative`. */
  value: number
  /** Rows behind it, whatever the drawing is scaled to. */
  count: number
  colorIndex: number
}

export interface HistogramBar extends ValueRange {
  segments: HistogramSegment[]
  /** Plotted height of the whole bar. */
  total: number
  /** Rows in the bar. */
  count: number
}

export interface Histogram {
  bars: HistogramBar[]
  /** Legend order; empty when nothing is split out. */
  series: string[]
  /** Largest plotted bar, for the value axis. */
  max: number
  /** Rows the value column could not place. */
  dropped: number
  /** Rows that were binned. */
  used: number
  /** Smallest and largest value seen, in value space. */
  lo: number
  hi: number
}

/**
 * The most bins the automatic rule will ask for.
 *
 * Freedman–Diaconis on a heavy-tailed integer column — synapse counts, which is most of what
 * gets dropped on this node — asks for thousands of bins, most of them empty. A ceiling is not
 * a refusal of anything: the picture at 80 bins and the picture at 3,000 answer the same
 * question, and only one of them is a picture.
 */
export const MAX_AUTO_BINS = 80

/** Hard ceiling on a hand-set bin count, matching the node param's `max`. */
const MAX_BINS = 200

/** What `scanValues` hands to `binScan`. Opaque to callers; only the two halves read it. */
export interface ValueScan {
  /** Plottable values in transformed space — `log10(v)` under a log axis. */
  kept: number[]
  /** Series label per kept value, parallel to `kept`. Empty when nothing is split out. */
  keptSeries: string[]
  dropped: number
  loT: number
  hiT: number
  log: boolean
  hasSeries: boolean
}

const EMPTY_SCAN: ValueScan = {
  kept: [],
  keptSeries: [],
  dropped: 0,
  loT: 0,
  hiT: 0,
  log: false,
  hasSeries: false,
}

const EMPTY: Histogram = {
  bars: [],
  series: [],
  max: 0,
  dropped: 0,
  used: 0,
  lo: 0,
  hi: 0,
}

/**
 * Mean, median and the ends of one numeric column.
 *
 * Beside the binning because it is what a histogram is read *with*: a picture of a heavy-tailed
 * column says "most of them are small" and cannot say how small, and the three numbers cannot
 * say there is a tail. Both or neither.
 *
 * Only the column asked for. `describeTable` answers the same question and is memoised, but it
 * summarises **every** column — building a `Set` of distinct printed labels for each, which on a
 * million-link edge table is a million string allocations to read four numbers off one column.
 * The quantile is still `boxStats`', so this and a Describe node downstream cannot come to quote
 * two different medians of one column.
 *
 * Values in value space, always — the caller's log axis is a fact about the drawing, and a
 * geometric mean printed as `mean` would be a different statistic wearing the same word.
 */
export interface ColumnStats {
  count: number
  min: number
  median: number
  mean: number
  max: number
}

export function columnStats(table: TableValue, valueColumn: string): ColumnStats | undefined {
  const data = table.data[valueColumn]
  if (!data) return undefined
  const numbers: number[] = []
  let sum = 0
  for (let row = 0; row < table.length; row++) {
    const value = numericCell(data[row])
    if (value === undefined) continue
    numbers.push(value)
    sum += value
  }
  if (numbers.length === 0) return undefined
  numbers.sort((a, b) => a - b)
  return {
    count: numbers.length,
    min: numbers[0]!,
    median: quantileSorted(numbers, 0.5),
    mean: sum / numbers.length,
    max: numbers[numbers.length - 1]!,
  }
}

/**
 * Freedman–Diaconis, with Sturges as the fallback it needs.
 *
 * FD sizes a bin from the interquartile range, so a column whose middle half is one value —
 * `pre` on a table that is mostly zero — gives a width of 0 and an infinite bin count. Sturges
 * answers from `n` alone and cannot, which is what makes it the fallback rather than a second
 * opinion.
 */
export function chooseBinCount(sorted: number[]): number {
  const n = sorted.length
  if (n < 2) return 1
  const lo = sorted[0]!
  const hi = sorted[n - 1]!
  if (!(hi > lo)) return 1

  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25)
  const width = iqr > 0 ? (2 * iqr) / Math.cbrt(n) : 0
  const fd = width > 0 ? Math.ceil((hi - lo) / width) : 0
  const sturges = Math.ceil(Math.log2(n)) + 1
  // No lower clamp: the early returns guarantee n >= 2 and hi > lo, so `sturges` is at
  // least 2 and the `fd > 0` ternary cannot yield less than 1.
  return Math.min(MAX_AUTO_BINS, fd > 0 ? fd : sturges)
}

/**
 * Bin a table's numeric column, optionally split into stacked series.
 *
 * The series fold is the bar chart's, deliberately: rank by size, keep eight, and put the tail
 * in one achromatic `Other` rather than reaching for a ninth hue that would repeat an earlier
 * one and imply two groups are the same thing.
 */
export function buildHistogram(
  table: TableValue,
  valueColumn: string,
  seriesColumn: string | undefined,
  options: HistogramOptions = {},
): Histogram {
  return binScan(scanValues(table, valueColumn, seriesColumn, options.log), options)
}

/**
 * The values a histogram will bin, and their extent — the only O(rows) half.
 *
 * Split from the shaping below because **nothing about a bin count, a scaling or a cumulative
 * toggle changes which rows are plottable.** The viewer keys this on the table and the columns
 * alone, so scrubbing `Bins` — which fires on every pointer-move, not on commit — reshapes ≤200
 * bars instead of re-walking 165,000 rows in each of up to three live viewers.
 */
export function scanValues(
  table: TableValue,
  valueColumn: string,
  seriesColumn: string | undefined,
  log = false,
): ValueScan {
  const values = table.data[valueColumn]
  if (!values) return EMPTY_SCAN
  const seriesData = seriesColumn ? table.data[seriesColumn] : undefined

  // Transformed space is what the bins are uniform in; value space is what a tooltip prints
  // and what a selection stores. `log` is the only thing that separates them.
  const kept: number[] = []
  const keptSeries: string[] = []
  let dropped = 0
  let loT = Infinity
  let hiT = -Infinity
  for (let row = 0; row < table.length; row++) {
    const value = numericCell(values[row])
    // A log axis has nothing to say about zero or a negative count, and the caption reports
    // how many went — nothing about flipping a switch suggests rows would leave the picture.
    if (value === undefined || (log && value <= 0)) {
      dropped++
      continue
    }
    const t = log ? Math.log10(value) : value
    kept.push(t)
    if (t < loT) loT = t
    if (t > hiT) hiT = t
    if (seriesData) keptSeries.push(markLabel(seriesData[row]))
  }
  return { kept, keptSeries, dropped, loT, hiT, log, hasSeries: !!seriesData }
}

/**
 * Shape a scan into bars. Cheap: everything here is per-bar or per-series.
 */
export function binScan(scan: ValueScan, options: HistogramOptions = {}): Histogram {
  const { binMode = 'auto', bins = 30, normalize = 'count', cumulative = false } = options
  const { kept, keptSeries, dropped, loT, hiT, log, hasSeries } = scan
  if (kept.length === 0) return { ...EMPTY, dropped }

  /*
   * The **sort is taken only when the automatic rule needs it** — Freedman–Diaconis wants
   * quartiles, a fixed bin count wants nothing, and the extent already came from the scan.
   * Measured on 165,122 heavy-tailed values: copy-and-sort 20.6 ms against 0.2 ms for the
   * min/max scan it replaced.
   */
  const count =
    binMode === 'fixed'
      ? Math.min(MAX_BINS, Math.max(1, Math.round(bins) || 1))
      : chooseBinCount([...kept].sort((a, b) => a - b))

  /*
   * A column with one distinct value is a single bar rather than an empty picture. `hiT === loT`
   * makes every width zero, so the scale below would divide by it; special-casing here keeps
   * every consumer downstream free of the check.
   */
  const spanT = hiT > loT ? hiT - loT : 0
  const widthT = spanT > 0 ? spanT / count : 0
  const barCount = spanT > 0 ? count : 1

  const back = (t: number): number => (log ? 10 ** t : t)
  const edges: number[] = []
  for (let i = 0; i <= barCount; i++) edges.push(back(loT + widthT * i))
  // The last edge is the maximum itself rather than an accumulation of `barCount` additions,
  // which would leave the largest value a hair outside the bar that counts it.
  edges[barCount] = back(hiT)

  const perBar: Map<string, number>[] = Array.from({ length: barCount }, () => new Map())
  const seriesTotals = new Map<string, number>()
  for (let i = 0; i < kept.length; i++) {
    const t = kept[i]!
    const index =
      widthT > 0 ? Math.min(barCount - 1, Math.max(0, Math.floor((t - loT) / widthT))) : 0
    const name = hasSeries ? keptSeries[i]! : ''
    const bucket = perBar[index]!
    bucket.set(name, (bucket.get(name) ?? 0) + 1)
    seriesTotals.set(name, (seriesTotals.get(name) ?? 0) + 1)
  }

  const fold = foldByRank(seriesTotals)

  // Cumulative runs per series, so a stack of running totals is still a stack of the same
  // series. Carried outside the bar loop because that is what makes it cumulative.
  const running = new Map<string, number>()

  const bars: HistogramBar[] = []
  for (let index = 0; index < barCount; index++) {
    const lo = edges[index]!
    const hi = edges[index + 1]!
    const closed = index === barCount - 1
    const width = hi - lo
    const bucket = perBar[index]!

    const raw: { series: string; count: number; colorIndex: number }[] = []
    for (const name of fold.kept) {
      const n = bucket.get(name) ?? 0
      if (n > 0 || cumulative)
        raw.push({ series: name, count: n, colorIndex: fold.slotOf(name) })
    }
    if (fold.folded) {
      let other = 0
      for (const name of fold.tail) other += bucket.get(name) ?? 0
      if (other > 0 || cumulative) {
        raw.push({ series: OTHER_LABEL, count: other, colorIndex: MAX_SERIES })
      }
    }

    const segments: HistogramSegment[] = []
    for (const entry of raw) {
      const cumulated = cumulative
        ? (running.get(entry.series) ?? 0) + entry.count
        : entry.count
      if (cumulative) running.set(entry.series, cumulated)
      if (cumulated === 0) continue
      segments.push({
        series: entry.series,
        count: cumulated,
        colorIndex: entry.colorIndex,
        value: scale(cumulated, normalize, kept.length, width),
      })
    }

    bars.push({
      lo,
      hi,
      ...(closed ? { closed: true } : {}),
      segments,
      count: segments.reduce((sum, s) => sum + s.count, 0),
      total: segments.reduce((sum, s) => sum + s.value, 0),
    })
  }

  return {
    bars,
    series: hasSeries ? fold.legend : [],
    max: bars.reduce((m, bar) => Math.max(m, bar.total), 0),
    dropped,
    used: kept.length,
    lo: back(loT),
    hi: back(hiT),
  }
}

/**
 * Height for a count.
 *
 * Density divides by the bar's *own* width, which is the only thing that makes the areas
 * comparable when a log axis makes the bars unequal — and is why a uniform divisor would be
 * quietly wrong exactly where density is most useful.
 */
function scale(count: number, normalize: Normalize, total: number, width: number): number {
  if (normalize === 'percent') return total > 0 ? (count / total) * 100 : 0
  if (normalize === 'density') return total > 0 && width > 0 ? count / (total * width) : 0
  return count
}

/** Axis label for the plotted quantity, so the caption and the tick labels cannot disagree. */
export function normalizeLabel(normalize: Normalize, cumulative: boolean): string {
  const base =
    normalize === 'percent' ? '% of rows' : normalize === 'density' ? 'density' : 'rows'
  return cumulative && normalize !== 'density' ? `cumulative ${base}` : base
}
