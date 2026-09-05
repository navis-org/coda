/**
 * Five-number summaries and violin curves, headless.
 *
 * Same standing as `histogramBins.ts` and `scatterPlot.ts`: jsdom has no layout, so arithmetic
 * left in the component is covered by nothing. Three decisions here are worth stating because
 * the obvious alternative is wrong rather than merely different.
 *
 * **Quantiles are computed in value space, and only the drawing knows about the log axis.** A
 * quantile is invariant under a monotone transform, so `median` is the same number either way
 * — but the Tukey fence is not, and computing fences in log space would silently reclassify
 * outliers the moment somebody flipped a switch that is supposed to change the axis. The
 * exception is the violin's kernel estimate, which *is* computed in the space the axis is drawn
 * in, because a density is a statement about area and a log axis redistributes it. Same rule
 * the scatter's trend line follows: fit in the space the picture is linear in.
 *
 * **Every violin is drawn to the same maximum width.** The alternative — width proportional to
 * group size — encodes `n` twice, since the box already carries it in the caption, and makes a
 * rare group's shape unreadable at exactly the moment somebody is looking at the shape. The
 * count is reported instead.
 *
 * **Both the kernel estimate and the drawn outliers are capped.** A group here can hold six
 * figures of rows; a Gaussian kernel over all of them at every grid point is minutes, and
 * forty thousand outlier dots is a filled rectangle. Both caps take a deterministic stride so
 * the picture is the same twice — the same choice, for the same reason, as the scatter's point
 * budget.
 */

import type { TableValue } from '../../core/values'
import { markLabel, numericCell } from '../../nodes/lib/chartSelection'
import { foldByRank } from '../colors'

export type WhiskerRule = 'tukey' | 'minmax' | 'p5p95'

export interface BoxStats {
  n: number
  min: number
  max: number
  q1: number
  median: number
  q3: number
  mean: number
  /** Whisker ends, by the chosen rule. Always within [min, max]. */
  lower: number
  upper: number
  /** Values outside the whiskers, thinned for drawing. */
  outliers: number[]
  /** How many there were before thinning. */
  outlierCount: number
}

/** One value-axis position of a violin's outline, in the space the axis is drawn in. */
export interface ViolinPoint {
  /** Transformed coordinate — `log10(value)` on a log axis, the value itself otherwise. */
  t: number
  /** Half-width, 0…1, normalised across all groups drawn together. */
  w: number
}

export interface GroupDistribution {
  label: string
  stats: BoxStats
  /** Empty unless a violin was asked for. */
  curve: ViolinPoint[]
  /** Ascending values to draw as a swarm. Empty unless one was asked for. */
  swarm: number[]
  colorIndex: number
}

export interface Distributions {
  groups: GroupDistribution[]
  /** Rows the value column could not place, or that a log axis had nothing to say about. */
  dropped: number
  /** Distinct groups in the data, whether or not they were kept. */
  groupCount: number
  /** Smallest and largest value drawn, in value space. */
  lo: number
  hi: number
}

/** Points sampled per violin outline. Enough for a bimodal shape, cheap enough for 24 groups. */
const VIOLIN_RESOLUTION = 64
/** Values fed to the kernel estimate per group; above this, a stable stride through them. */
const KDE_SAMPLE_CAP = 4000
/** Outlier marks drawn per group; above this, a stable stride and the caption says how many. */
export const OUTLIER_DRAW_CAP = 200

const EMPTY: Distributions = { groups: [], dropped: 0, groupCount: 0, lo: 0, hi: 0 }

/** What `groupValues` hands to `summarise`. */
export interface GroupedValues {
  /** Plottable values per group label, in row order — `summarise` sorts them in place. */
  byGroup: Map<string, number[]>
  dropped: number
  log: boolean
  /** False when there was no group column, i.e. one box over every row. */
  grouped: boolean
}

/**
 * Linear-interpolated quantile — the type-7 definition numpy and R default to.
 *
 * `ArrayLike` rather than `number[]`: it only indexes and reads `.length`, and `net.metrics`
 * sorts its degree and weight columns as `Float64Array`s. Converting a million weights to a
 * boxed array to satisfy a signature would be the tail wagging the dog — and the alternative,
 * a second median beside this one, is what `describeOps` reaches over here to avoid.
 */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]!
  const position = (n - 1) * Math.max(0, Math.min(1, p))
  const lower = Math.floor(position)
  const upper = Math.min(n - 1, lower + 1)
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

/** The five-number summary plus whichever fence was asked for. `sorted` must be ascending. */
export function boxStats(sorted: number[], rule: WhiskerRule = 'tukey'): BoxStats {
  const n = sorted.length
  if (n === 0) {
    return {
      n: 0,
      min: NaN,
      max: NaN,
      q1: NaN,
      median: NaN,
      q3: NaN,
      mean: NaN,
      lower: NaN,
      upper: NaN,
      outliers: [],
      outlierCount: 0,
    }
  }
  const min = sorted[0]!
  const max = sorted[n - 1]!
  const q1 = quantileSorted(sorted, 0.25)
  const median = quantileSorted(sorted, 0.5)
  const q3 = quantileSorted(sorted, 0.75)
  let mean = 0
  for (const value of sorted) mean += value
  mean /= n

  let lower = min
  let upper = max
  if (rule === 'tukey') {
    const fence = 1.5 * (q3 - q1)
    /*
     * The whisker is the most extreme value still *inside* the fence, not the fence itself.
     * Drawing the fence would put the whisker end at a number no row holds, and would make it
     * stick out past the data whenever the tail is short.
     */
    const loFence = q1 - fence
    const hiFence = q3 + fence
    for (const value of sorted) {
      if (value >= loFence) {
        lower = value
        break
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      const value = sorted[i]!
      if (value <= hiFence) {
        upper = value
        break
      }
    }
  } else if (rule === 'p5p95') {
    lower = quantileSorted(sorted, 0.05)
    upper = quantileSorted(sorted, 0.95)
  }

  const beyond: number[] = []
  for (const value of sorted) if (value < lower || value > upper) beyond.push(value)

  return {
    n,
    min,
    max,
    q1,
    median,
    q3,
    mean,
    lower,
    upper,
    outliers: strideValues(beyond, OUTLIER_DRAW_CAP),
    outlierCount: beyond.length,
  }
}

/** Silverman's rule of thumb, with the IQR term dropped when the middle half is one value. */
export function silvermanBandwidth(sorted: number[]): number {
  const n = sorted.length
  if (n < 2) return 0
  let mean = 0
  for (const value of sorted) mean += value
  mean /= n
  let variance = 0
  for (const value of sorted) variance += (value - mean) ** 2
  const sd = Math.sqrt(variance / (n - 1))
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25)
  const spread = iqr > 0 ? Math.min(sd, iqr / 1.349) : sd
  return spread > 0 ? 0.9 * spread * n ** -0.2 : 0
}

/**
 * Gaussian kernel density at each grid point.
 *
 * Returns raw densities; the caller normalises. A bandwidth of zero — every value identical —
 * yields all zeros rather than a division by zero, and the viewer draws the box alone.
 */
export function kdeCurve(sorted: number[], grid: number[], bandwidth: number): number[] {
  if (!(bandwidth > 0) || sorted.length === 0) return grid.map(() => 0)
  const norm = 1 / (sorted.length * bandwidth * Math.sqrt(2 * Math.PI))
  const reach = 4 * bandwidth

  /*
   * Both inputs are ascending — `sorted` by name, `grid` by construction — so the window of
   * values within four bandwidths of `x` only ever moves forwards. Two pointers walk it once
   * across the whole grid.
   *
   * The obvious version tests every value at every grid point and skips the `Math.exp` outside
   * the window, which reads as the same optimisation and is not: the iteration, the subtraction
   * and the divide all remain. Measured over 24 groups × 64 points × 4,000 samples, 9.5 ms
   * against 5.3 ms, bit-identical output; at the 100-group ceiling it is ~40 ms against ~22,
   * paid per pointer-move while Max groups is dragged.
   */
  let from = 0
  let to = 0
  const out: number[] = []
  for (const x of grid) {
    while (from < sorted.length && sorted[from]! < x - reach) from++
    if (to < from) to = from
    while (to < sorted.length && sorted[to]! <= x + reach) to++
    let sum = 0
    for (let i = from; i < to; i++) {
      const z = (x - sorted[i]!) / bandwidth
      sum += Math.exp(-0.5 * z * z)
    }
    out.push(sum * norm)
  }
  return out
}

/** The one box a table with no group column gets. */
export const ALL_LABEL = 'All rows'
/** Boxes drawn before the tail is dropped. The viewer's default; the node param matches. */
export const MAX_GROUPS_DEFAULT = 24

/**
 * Marks drawn in a swarm before the tail is thinned; above this, a stable stride.
 *
 * A beeswarm is a plot of *every* observation, which is its whole point and also its ceiling:
 * the packing below is quadratic within a window, and a group of 165,000 would be a solid
 * lozenge that answers nothing a violin does not answer better. The caption says how many.
 */
export const SWARM_DRAW_CAP = 300

/**
 * Offsets that stop a swarm's marks overlapping.
 *
 * `positions` are pixel positions **along the value axis, ascending**; the answer is a pixel
 * offset across it for each, in the same order. Both spaces are the caller's — the packing is
 * a question about circles on screen, not about the data — which is what keeps it here, where
 * jsdom's lack of layout does not matter, rather than in the component.
 *
 * The rule is the standard one: walk in value order and give each mark the offset **nearest the
 * centre line** that clears everything already placed. A mark only has to clear those within
 * `2r` of it along the value axis, and since the input is sorted that window is a sliding pair
 * of indices rather than a scan.
 *
 * Candidates come from the neighbours themselves: for a placed mark at distance `d`, the two
 * offsets that just touch it are `its offset ± sqrt(4r² - d²)`. Trying a fixed ladder of
 * offsets instead — 0, ±r, ±2r — is what makes a swarm look like a bar chart of stacked dots;
 * this one interlocks, which is the shape that reads as a distribution.
 */
export function swarmOffsets(positions: readonly number[], radius: number): number[] {
  const offsets = new Array<number>(positions.length).fill(0)
  if (!(radius > 0)) return offsets
  const reach = 2 * radius
  let from = 0

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!
    while (from < i && positions[from]! < p - reach) from++

    // 0 first, so a mark with room stays on the centre line.
    const candidates = [0]
    for (let j = from; j < i; j++) {
      const d = p - positions[j]!
      const clearance = Math.sqrt(Math.max(0, reach * reach - d * d))
      candidates.push(offsets[j]! + clearance, offsets[j]! - clearance)
    }
    candidates.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)

    for (const candidate of candidates) {
      let clear = true
      for (let j = from; j < i; j++) {
        const dx = p - positions[j]!
        const dy = candidate - offsets[j]!
        // A hair under, so a candidate derived from a neighbour is not rejected by it.
        if (dx * dx + dy * dy < reach * reach - 1e-6) {
          clear = false
          break
        }
      }
      if (clear) {
        offsets[i] = candidate
        break
      }
    }
  }
  return offsets
}

/**
 * Split a table into per-group distributions.
 *
 * The group fold is the bar chart's — rank by size, keep `maxGroups`, and say in the caption
 * how many there were. Unlike a stacked bar there is no `Other` bucket: pooling fifty cell
 * types into one box makes a distribution that describes nothing. The tail is dropped and
 * counted instead, which is the honest version of the same cap.
 */
export interface DistributionOptions {
  log?: boolean
  whiskers?: WhiskerRule
  maxGroups?: number
  sortByMedian?: boolean
  violin?: boolean
  swarm?: boolean
}

export function buildDistributions(
  table: TableValue,
  valueColumn: string,
  groupColumn: string | undefined,
  options: DistributionOptions = {},
): Distributions {
  return summarise(groupValues(table, valueColumn, groupColumn, options.log), options)
}

/**
 * Bucket the rows by group — the only O(rows) half.
 *
 * Split from `summarise` because **none of the whisker rule, the group cap, the sort or the
 * violin toggle changes which rows are plottable or which group they belong to.** The viewer
 * keys this on the table, the columns and the log axis alone, so ticking *Sort by median* costs
 * a sort of ≤100 summaries rather than a fresh scan of 165,000 rows, a re-bucket, a re-sort of
 * every group and a full set of kernel estimates — measured at ~14 ms, in each of up to three
 * live viewers.
 */
export function groupValues(
  table: TableValue,
  valueColumn: string,
  groupColumn: string | undefined,
  log = false,
): GroupedValues {
  const values = table.data[valueColumn]
  if (!values) return { byGroup: new Map(), dropped: 0, log, grouped: false }
  const groupData = groupColumn ? table.data[groupColumn] : undefined

  const byGroup = new Map<string, number[]>()
  let dropped = 0
  for (let row = 0; row < table.length; row++) {
    const value = numericCell(values[row])
    if (value === undefined || (log && value <= 0)) {
      dropped++
      continue
    }
    const label = groupData ? markLabel(groupData[row]) : ALL_LABEL
    const bucket = byGroup.get(label)
    if (bucket) bucket.push(value)
    else byGroup.set(label, [value])
  }
  return { byGroup, dropped, log, grouped: !!groupData }
}

/** Rank, cap, summarise and (optionally) estimate. Cheap: everything here is per group. */
export function summarise(
  grouped: GroupedValues,
  options: DistributionOptions = {},
): Distributions {
  const {
    whiskers = 'tukey',
    maxGroups = MAX_GROUPS_DEFAULT,
    sortByMedian = true,
    violin = false,
    swarm = false,
  } = options
  const { byGroup, dropped, log } = grouped
  if (byGroup.size === 0) return { ...EMPTY, dropped }

  /*
   * The same rank-and-cap every other chart here uses, and the tail is simply not drawn —
   * `foldByRank`'s `tail`, dropped rather than summed, because pooling fifty distributions
   * describes nothing. Colour follows rank, so a group keeps its hue while the data does not
   * change; past the eighth it takes the achromatic residual colour rather than a ninth hue.
   */
  const fold = foldByRank(
    [...byGroup].map(([label, values]) => [label, values.length]),
    maxGroups,
  )
  const sorted = fold.kept.map((label) => byGroup.get(label)!.sort((a, b) => a - b))
  const groups: GroupDistribution[] = fold.kept.map((label, index) => ({
    label,
    stats: boxStats(sorted[index]!, whiskers),
    curve: [],
    swarm: swarm ? strideValues(sorted[index]!, SWARM_DRAW_CAP) : [],
    colorIndex: fold.slotOf(label),
  }))

  let lo = Infinity
  let hi = -Infinity
  for (const group of groups) {
    lo = Math.min(lo, group.stats.min)
    hi = Math.max(hi, group.stats.max)
  }

  if (violin && Number.isFinite(lo) && Number.isFinite(hi)) {
    const forward = (value: number): number => (log ? Math.log10(value) : value)
    const loT = forward(lo)
    const hiT = forward(hi)
    const span = hiT > loT ? hiT - loT : 1
    const grid = Array.from(
      { length: VIOLIN_RESOLUTION },
      (_, i) => loT + (span * i) / (VIOLIN_RESOLUTION - 1),
    )
    // One peak across every group, so the widths are comparable between violins rather than
    // each being rescaled to its own maximum — which would make a flat distribution and a
    // sharp one the same shape.
    let peak = 0
    const densities = groups.map((_, index) => {
      // `.map(forward)` only where `forward` is not the identity — otherwise it is a copy of
      // up to 4,000 numbers per group for nothing.
      const strided = strideValues(sorted[index]!, KDE_SAMPLE_CAP)
      const sample = log ? strided.map(forward) : strided
      const curve = kdeCurve(sample, grid, silvermanBandwidth(sample))
      for (const density of curve) peak = Math.max(peak, density)
      return curve
    })
    groups.forEach((group, index) => {
      const curve = densities[index]!
      group.curve = peak > 0 ? grid.map((t, i) => ({ t, w: curve[i]! / peak })) : []
    })
  }

  if (sortByMedian) {
    groups.sort((a, b) => b.stats.median - a.stats.median || a.label.localeCompare(b.label))
  } else {
    groups.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
  }

  return {
    groups,
    dropped,
    groupCount: byGroup.size,
    lo: Number.isFinite(lo) ? lo : 0,
    hi: Number.isFinite(hi) ? hi : 0,
  }
}

/**
 * Every `n`th element, keeping the first, when there are more than `cap` of them.
 *
 * A stable stride rather than a random sample: a random one reshuffles per render, so a
 * violin's shape and the outlier dots would move on every repaint and the picture would never
 * be the same twice. Same reasoning as the scatter's point budget.
 */
function strideValues(values: number[], cap: number): number[] {
  if (values.length <= cap) return values
  const step = values.length / cap
  const out: number[] = []
  for (let i = 0; i < cap; i++) {
    out.push(values[Math.min(values.length - 1, Math.floor(i * step))]!)
  }
  return out
}
