/**
 * The little inline pictures on an expanded row, and what decides them.
 *
 * Headless, so what a mark *means* is unit-testable where the SVG that draws it is not — the same
 * split `thumbnail.ts` uses, and for the same reason.
 *
 * **Three of these cost nothing, and that is why they are here rather than in a node.** Explore
 * downloads the whole neuron table once and searches it locally (see `docs/widgets.md`), so every
 * number below is already in memory: a balance is two columns divided, and a percentile is a
 * column sorted. Nothing else in Coda can show a neuron against its dataset's *own* distribution
 * without a query, because nothing else holds the column.
 *
 * What they add is the thing a figure cannot. `1,496` and `1,272` are two numbers a reader has to
 * hold and divide; one split bar is a shape, and a list of them is scannable in a way the digits
 * are not. `3.4M` says nothing about whether that is a big neuron here — a tick against the
 * dataset's spread does.
 */

import type { CellValue, TableValue } from '../../core/values'

/** Where a value sits in a column, 0 at the smallest and 1 at the largest. */
export interface Percentile {
  /** Position in the distribution, already clamped. */
  at: number
  /** The value itself, for the caption. */
  value: number
}

/**
 * The quantiles a percentile mark is read against, computed once per dataset.
 *
 * Sorted copies rather than an exact rank per row: a rank costs a scan per neuron, where one
 * sorted column answers every row by binary search. Sampled by stride for the same reason
 * `fillRate` is — a distribution's shape does not need all 165,122 points, and sorting that many
 * per column on a page turn would be felt.
 */
export interface Distributions {
  /** Column name to its sorted sample, ascending. */
  sorted: Map<string, Float64Array>
  /**
   * Column name to its largest value, over **every** row rather than the sample.
   *
   * What a bar's length is read against. The strided sample is fine for a rank, where one neuron
   * more or less moves nothing, and wrong for a maximum: the largest neuron in a dataset is one
   * row, which a stride of forty skips thirty-nine times in forty, and then every neuron larger
   * than the sample's top draws as a full bar. One pass over a column is a millisecond.
   */
  max: Map<string, number>
}

/** How many points a distribution is estimated from. */
const SAMPLE = 4000

/**
 * Each measured column's spread, once: a sorted sample for a rank, the whole column's maximum for a
 * bar — and only what each mark reads, since both are passes over every row of a table that runs to
 * 165,122 on male-CNS.
 *
 * Keyed on the table so a search does not recompute it: the distribution is a property of the
 * *dataset*, and re-deriving it per query would also make a neuron's percentile move as somebody
 * types, which is the opposite of what it is for.
 */
export function distributionsFor(
  table: TableValue | undefined,
  ranked: readonly string[],
  barred: readonly string[] = [],
): Distributions {
  const sorted = new Map<string, Float64Array>()
  const max = new Map<string, number>()
  if (!table) return { sorted, max }
  const stride = Math.max(1, Math.floor(table.length / SAMPLE))
  for (const name of ranked) {
    const column = table.data[name]
    if (!column) continue
    const values: number[] = []
    for (let row = 0; row < table.length; row += stride) {
      const value = column[row]
      if (typeof value === 'number' && Number.isFinite(value)) values.push(value)
    }
    if (values.length === 0) continue
    values.sort((a, b) => a - b)
    sorted.set(name, Float64Array.from(values))
  }
  for (const name of barred) {
    const column = table.data[name]
    if (!column) continue
    let largest = -Infinity
    for (let row = 0; row < table.length; row++) {
      const value = column[row]
      if (typeof value === 'number' && value > largest) largest = value
    }
    if (Number.isFinite(largest)) max.set(name, largest)
  }
  return { sorted, max }
}

/**
 * Where one value sits in its column's distribution.
 *
 * Binary search over the sorted sample. `null` where the column is absent, the cell is not a
 * number, or the dataset gave nothing to compare against — a mark with no distribution behind it
 * would be a tick at a position that means nothing.
 */
export function percentileOf(
  distributions: Distributions,
  name: string,
  cell: CellValue,
): Percentile | null {
  if (typeof cell !== 'number' || !Number.isFinite(cell)) return null
  const sample = distributions.sorted.get(name)
  if (!sample || sample.length === 0) return null
  let low = 0
  let high = sample.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (sample[mid]! < cell) low = mid + 1
    else high = mid
  }
  return { at: sample.length === 1 ? 0.5 : low / (sample.length - 1), value: cell }
}

/**
 * How long a bar is, 0 to 1, against the largest value in the dataset.
 *
 * `log` is `log1p(v) / log1p(max)` — the heatmap's own log, and for the same reason: a synapse
 * count spans four orders of magnitude, so on a linear bar all but the few largest neurons are a
 * pixel. A rank answers "where does it sit" without either problem; a bar is for when the
 * *quantity* is the point. Negative values draw as empty rather than backwards — nothing a neuron
 * table publishes is negative, and a bar pointing left would be a mark nobody could read in a list.
 */
export function barFraction(
  distributions: Distributions,
  name: string,
  cell: CellValue,
  log: boolean,
): number | null {
  if (typeof cell !== 'number' || !Number.isFinite(cell)) return null
  const max = distributions.max.get(name)
  if (max === undefined || max <= 0) return null
  const value = Math.max(cell, 0)
  const fraction = log ? Math.log1p(value) / Math.log1p(max) : value / max
  return Math.min(fraction, 1)
}

/** One field's part of a merged column. */
export interface Part {
  name: string
  count: number
  /** Share of the parts' own sum, 0 to 1. */
  share: number
}

/**
 * A neuron's split across several counts, as shares of **their own sum**.
 *
 * All or nothing, which is the pre/post rule generalised: a bar drawn from the parts that happen
 * to be present is not a split — a neuron with `pre` and no `post` would draw as entirely
 * presynaptic, a claim the data did not make. A total of zero is `null` for the same reason (an
 * untraced neuron is not an even one), and so is a negative part, which has no share.
 *
 * The denominator is the sum and never a column the parts are *supposed* to sum to. On
 * `neuprint-fish2` `axonIn + dendriteIn` equals `post` on every neuron sampled, but
 * `axonOut + dendriteOut` equals `pre` on only 722 of 2,000 — 100006807 has `pre` 86 and
 * `axonOut` 94 — so a share of `pre` would draw past the end of its own bar.
 */
export function sharesOf(names: readonly string[], cells: readonly CellValue[]): Part[] | null {
  let total = 0
  for (const cell of cells) {
    if (typeof cell !== 'number' || !Number.isFinite(cell) || cell < 0) return null
    total += cell
  }
  if (total <= 0) return null
  return names.map((name, i) => {
    const count = cells[i] as number
    return { name, count, share: count / total }
  })
}

/** Column pairs that make a balance, best first. Same "address by name" contract as `rowFields`. */
const BALANCE_PAIRS: Array<[string, string]> = [
  ['pre', 'post'],
  ['upstream', 'downstream'],
]

/** Which numeric column a percentile mark is drawn for, best first. */
const PERCENTILE_FIELDS = ['size', 'cableLength', 'synweight', 'nodes']

/**
 * A confidence value paired with the label it qualifies.
 *
 * Only where the dataset publishes both: a prediction with no confidence beside it is a fact as
 * far as anything here can tell, and drawing an empty gauge next to it would suggest otherwise.
 */
const CONFIDENCE_PAIRS: Array<[string, string]> = [
  ['predictedNt', 'celltypePredictedNtConfidence'],
  ['predictedNt', 'predictedNtProb'],
  ['consensusNt', 'celltypePredictedNtConfidence'],
  ['top_nt', 'top_nt_conf'],
]

/** What an expanded row draws by default, decided once from the schema. */
export interface PlotSpec {
  balance?: { pre: string; post: string }
  percentile?: string
  confidence?: { label: string; value: string }
  /**
   * Whether this dataset can answer a region breakdown at all.
   *
   * A capability rather than the data, and that distinction is load-bearing: the region bar
   * arrives a query *after* the row does, and a track that grew when it landed would shift every
   * figure on the page sideways as the fetch returned. Reserved on what the dataset can do, filled
   * in when it answers.
   */
  regions?: boolean
}

/**
 * The marks' width, in one place because three files have to agree on it.
 *
 * The SVGs are drawn at `MARK_W` and `rowTemplate` sizes a mark's grid track from it. Every mark
 * is its own track now, so the header's label for one is simply the cell above it — there is no
 * longer a pitch for a label row to match.
 */
export const MARK_W = 54

/**
 * Which marks this dataset draws by default.
 *
 * Schema-driven exactly as `rowFields` is, so a dataset lacking the columns draws fewer marks
 * rather than empty frames — and so nothing here ever names a column that a backend must have.
 * What each becomes as a column is `automaticColumns`'.
 */
export function plotSpec(has: (name: string) => boolean, regions = false): PlotSpec {
  const spec: PlotSpec = {}
  if (regions) spec.regions = true
  const pair = BALANCE_PAIRS.find(([a, b]) => has(a) && has(b))
  if (pair) spec.balance = { pre: pair[0], post: pair[1] }
  const percentile = PERCENTILE_FIELDS.find(has)
  if (percentile) spec.percentile = percentile
  const confidence = CONFIDENCE_PAIRS.find(([label, value]) => has(label) && has(value))
  if (confidence) spec.confidence = { label: confidence[0], value: confidence[1] }
  return spec
}
