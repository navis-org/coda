/**
 * A heavy-tailed measure read as a ranking: what the value is at each rank, and what share of
 * the total the ranking has accumulated by the time it gets there.
 *
 * Headless and separate from the viewer for `histogramBins.ts`' reason, which is the standing
 * one for every chart here: jsdom performs no layout, so arithmetic left inside a `.tsx` is
 * covered by roughly nothing. What is in this module is everything a reader could be misled
 * by; what is left in `RankViewer` is scales, pointer plumbing and the caption.
 *
 * ## The share is the half that can lie, and it is the half this refuses over
 *
 * A rank plot on its own is a picture of an ordering, and an ordering is not the question
 * people have. What makes it answer *is this driven by a handful of things or diffusely?* is
 * the cumulative share beside it — and a share of a total is only meaningful over a
 * **non-negative** measure. Ranked descending, a signed column's running sum climbs past the
 * total and comes back down, so the curve exceeds 1 and is not monotonic: something that looks
 * exactly like a Lorenz curve and is not one. `shareRefusal` withholds the panel and says why.
 *
 * The same argument is why the share is a share of the **values** and never of the rows. A CDF
 * over rows — which is what `out.histogram`'s `cumulative` already draws, correctly, for a
 * different question — says "90% of neurons score below 1e-4". It cannot say "the top 20 carry
 * 60%", and that second sentence is the one a concentration question is asking for.
 *
 * ## Flagged rows are ranked and not counted
 *
 * `Influence` keeps its seeds in the table and flags them, because a seed's score is its own
 * seed mass plus whatever came back to it round a loop — a real measurement about recurrence
 * rather than a row to drop. Left in the share they carry most of it and the curve says
 * nothing. So a flagged row is plotted, is ranked, and is excluded from **both** halves of the
 * share. Generic on purpose: the param is a column picker, and `isSeed` is one column that fits
 * it rather than the concept this module is built around.
 *
 * ## What is dropped is counted, by reason
 *
 * Two different things make a row undrawable and only one of them is about the data: a missing
 * or non-numeric value, and — under a log axis only — a value at or below zero, which has no
 * logarithm. Reported apart because the fix differs: the first is a column that is not what the
 * picker thinks it is, the second is a scale the reader chose.
 */

import type { TableValue } from '../../core/values'
import { numericCell } from '../../nodes/lib/chartSelection'
import type { ScaleKind } from './scatterPlot'

/** One row, at the rank its value earns. */
export interface RankPoint {
  /** Row in the source table — what every encoding and the tooltip resolve against. */
  row: number
  value: number
  /** 1-based position in the ordering. */
  rank: number
  /** Kept out of the share by the flag column. See the header. */
  flagged: boolean
}

export interface RankSeries {
  /** Drawable rows in rank order, rank 1 first. */
  points: readonly RankPoint[]
  /**
   * Share of the unflagged total accumulated through rank `i + 1`, or empty where the share
   * was refused. Flat across a flagged rank, since a flagged row adds to neither half.
   */
  share: Float64Array
  /** Sum of the unflagged values. */
  total: number
  /** Rows the flag column kept out of the share. */
  flagged: number
  /** Rows with no number in the value column. */
  missing: number
  /** Rows at or below zero, dropped only because the value axis is logarithmic. */
  nonPositive: number
  /**
   * Why there is no share curve, or undefined. A sentence rather than a boolean: the two
   * reasons are different facts about the column and a viewer has to say which.
   */
  shareRefusal?: string
}

export interface RankOptions {
  valueColumn: string | undefined
  /** Rows to ring and keep out of the share. Absent flags nothing. */
  flagColumn?: string | undefined
  /** Under `log`, values at or below zero are dropped — they have no position on the axis. */
  valueScale: ScaleKind
  /** Largest first. False ranks smallest first, which is right for a cost or a rank already. */
  descending?: boolean
}

/** An empty series, so every caller has one shape to read. */
const EMPTY: RankSeries = {
  points: [],
  share: new Float64Array(0),
  total: 0,
  flagged: 0,
  missing: 0,
  nonPositive: 0,
}

/**
 * Whether a cell means "flag this row".
 *
 * A `bool` arrives as a boolean and an `i64`/`f64` flag as 0 or 1, which is the whole of what the
 * picker admits — `dtypes` on `out.rank`'s `Flag column` says so, and that restriction is what
 * keeps this agreeing with `coda_rank`'s `astype(bool)` in Python and `as.logical` in R. It used
 * to accept `'yes'`/`'true'`/`'1'` as well, which those two read differently: pandas takes any
 * non-empty string as true, R answers `NA`.
 */
export function isFlagCell(cell: unknown): boolean {
  if (cell === true) return true
  return typeof cell === 'number' && cell !== 0 && Number.isFinite(cell)
}

export function rankSeries(table: TableValue, options: RankOptions): RankSeries {
  const values = options.valueColumn ? table.data[options.valueColumn] : undefined
  if (!values) return EMPTY

  const flags = options.flagColumn ? table.data[options.flagColumn] : undefined
  const log = options.valueScale === 'log'
  const descending = options.descending !== false

  const points: RankPoint[] = []
  let missing = 0
  let nonPositive = 0

  for (let row = 0; row < table.length; row++) {
    const value = numericCell(values[row])
    if (value === undefined) {
      missing++
      continue
    }
    if (log && value <= 0) {
      nonPositive++
      continue
    }
    // `rank` is filled after the sort. Pushing the final shape here rather than a second array
    // of intermediates saves one object per row, which on the 165,122-row tables this chart is
    // built for is the difference between one allocation per row and two.
    points.push({ row, value, rank: 0, flagged: isFlagCell(flags?.[row]) })
  }

  if (points.length === 0) {
    return { ...EMPTY, missing, nonPositive }
  }

  /*
   * Ties break on the row, so two runs of one query rank the same neurons the same way —
   * invariant 4's requirement of anything that reaches a drawing, and the reason the comparator
   * cannot stop at the value.
   */
  points.sort((a, b) => (descending ? b.value - a.value : a.value - b.value) || a.row - b.row)
  for (let i = 0; i < points.length; i++) points[i]!.rank = i + 1

  let total = 0
  let flagged = 0
  let negative = false
  for (const point of points) {
    if (point.flagged) {
      flagged++
      continue
    }
    if (point.value < 0) negative = true
    total += point.value
  }

  /*
   * Three refusals, and the flagged one has to be asked *before* the total, or it answers in the
   * other one's words. A flag column excludes a row from both halves of the share, so a table
   * where everything is flagged has a total of zero for a reason that has nothing to do with the
   * values — which is not a rare shape: an Influence walk seeded with every neuron in a small
   * connectome flags all of them, and "every value is zero" then names a column that is full.
   */
  const shareRefusal = negative
    ? 'a share of a total means nothing over a column with negative values'
    : points.length > 0 && flagged === points.length
      ? 'every row is flagged, and a flagged row is left out of both halves of the share'
      : total <= 0
        ? 'every value is zero, so there is no total to take a share of'
        : undefined

  if (shareRefusal !== undefined) {
    return {
      points,
      share: new Float64Array(0),
      total,
      flagged,
      missing,
      nonPositive,
      shareRefusal,
    }
  }

  const share = new Float64Array(points.length)
  {
    let running = 0
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!
      if (!point.flagged) running += point.value
      share[i] = running / total
    }
  }

  return { points, share, total, flagged, missing, nonPositive }
}

/**
 * The lowest rank whose share reaches `fraction`, or null where none does.
 *
 * The headline the panel exists for — *half the drive comes from twelve of 3,847 neurons* —
 * and a function rather than a loop at the call site because the caption, the annotation on the
 * curve and the exporters all have to name the same rank.
 */
export function shareReaches(series: RankSeries, fraction: number): number | null {
  if (series.share.length === 0) return null
  for (let i = 0; i < series.share.length; i++) {
    if (series.share[i]! >= fraction) return i + 1
  }
  return null
}

/** The share accumulated by `rank`, clamped to the ends. 0 where there is no curve. */
export function shareAt(series: RankSeries, rank: number): number {
  if (series.share.length === 0) return 0
  const index = Math.max(0, Math.min(series.share.length - 1, Math.round(rank) - 1))
  return series.share[index]!
}

/**
 * Which ranks to actually draw.
 *
 * A rank plot is pointed at whatever a table holds, and the tables it is most useful on are the
 * big ones — an embedding of male-CNS is 165,122 rows, and a `<circle>` each is a hundred and
 * sixty thousand DOM nodes for a picture that is a line after the first screenful.
 *
 * Dense at the head and logarithmically spaced after it, which is the shape of the axis rather
 * than a compromise: on a log rank axis a uniform sample piles every point it takes into the
 * last decade and leaves the head — the part somebody is reading — described by nothing.
 *
 * One list serves the dots and the line, so the curve cannot pass through points the dots say
 * are somewhere else. A plain array rather than an `Int32Array`: it is at most `budget` entries,
 * and both readers were converting it straight back with `Array.from` to map over it.
 */
export function sampleRanks(count: number, budget: number, dense: number): number[] {
  if (count <= 0) return []
  if (count <= budget) {
    const all: number[] = []
    for (let i = 1; i <= count; i++) all.push(i)
    return all
  }

  const head = Math.max(0, Math.min(dense, count, budget))
  const out: number[] = []
  for (let r = 1; r <= head; r++) out.push(r)

  const remaining = budget - head
  if (remaining > 0 && count > head) {
    const from = Math.log(head + 1)
    const to = Math.log(count)
    let previous = head
    for (let i = 1; i <= remaining; i++) {
      const rank = Math.round(Math.exp(from + ((to - from) * i) / remaining))
      // Strictly increasing: the log steps round onto each other near the head, and a repeated
      // rank draws the same dot twice and gives the line a zero-length segment.
      if (rank > previous && rank <= count) {
        out.push(rank)
        previous = rank
      }
    }
    if (previous !== count) out.push(count)
  }

  return out
}
