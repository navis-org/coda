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
}

/** How many points a distribution is estimated from. */
const SAMPLE = 4000

/**
 * Sort a sample of each numeric column, once.
 *
 * Keyed on the table so a search does not recompute it: the distribution is a property of the
 * *dataset*, and re-deriving it per query would also make a neuron's percentile move as somebody
 * types, which is the opposite of what it is for.
 */
export function distributionsFor(
  table: TableValue | undefined,
  columns: readonly string[],
): Distributions {
  const sorted = new Map<string, Float64Array>()
  if (!table) return { sorted }
  const stride = Math.max(1, Math.floor(table.length / SAMPLE))
  for (const name of columns) {
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
  return { sorted }
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

/** A neuron's split between output and input sites. */
export interface Balance {
  /** Presynaptic share of the two, 0 to 1. */
  pre: number
  preCount: number
  postCount: number
}

/**
 * The pre/post split, or `null` where either half is missing.
 *
 * **Both or neither**, because a bar drawn from one is not a balance — a neuron with `pre` and no
 * `post` would draw as fully presynaptic, which is a claim the data did not make. A total of zero
 * is `null` for the same reason: an untraced neuron is not a 50/50 one.
 */
export function balanceOf(pre: CellValue, post: CellValue): Balance | null {
  if (typeof pre !== 'number' || typeof post !== 'number') return null
  if (!Number.isFinite(pre) || !Number.isFinite(post)) return null
  const total = pre + post
  if (total <= 0) return null
  return { pre: pre / total, preCount: pre, postCount: post }
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

/** What an expanded row can draw, decided once from the schema. */
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
 * The marks' own geometry, in one place because three files have to agree on it.
 *
 * The SVGs are drawn at `MARK_W`, the grid track is sized from it, and the header's labels are
 * laid out on the same pitch — `rowTemplate` hands the last two to CSS as custom properties, so a
 * stylesheet that cannot import a constant still reads the one that exists. Written out three
 * times it was convention held together by three comments saying so, and every way of getting it
 * wrong is browser-only: jsdom reports no layout, and the suite counts labels rather than
 * measuring them.
 */
export const MARK_W = 54
export const MARK_GAP = 6
export const MARK_PAD = 10

/** Which mark, so a row can draw the right one in the right slot. */
export type MarkKind = 'balance' | 'percentile' | 'regions' | 'confidence'

export interface MarkSlot {
  kind: MarkKind
  label: string
}

/**
 * The marks this dataset draws, in order, each with the name the header gives it.
 *
 * **One list, and that is the whole point.** The header lays its labels out on a fixed pitch and
 * the row lays its marks out on the same one, so label *i* names mark *i* by position — there is
 * nothing else tying them together. This was three parallel enumerations: a label list, a count
 * the grid track was sized from, and the order the row happened to render in. They agreed by
 * inspection.
 *
 * A row that has no *value* for a supported mark still occupies its slot — see `NeuronRow`. That
 * is not tidiness either: `regions` is absent for the first settle of every page and for good on
 * any neuron the query returned no rows for, so a row that simply dropped the child packed the
 * confidence bar left under the `regions` label on ordinary pages.
 */
export function markSlots(spec: PlotSpec): MarkSlot[] {
  const out: MarkSlot[] = []
  if (spec.balance) out.push({ kind: 'balance', label: 'pre/post' })
  // "rank", not the column's own name: the figure columns already carry `size`, and one word
  // labelling two different things a few tracks apart is worse than no label.
  if (spec.percentile) out.push({ kind: 'percentile', label: `${spec.percentile} rank` })
  if (spec.regions) out.push({ kind: 'regions', label: 'regions' })
  if (spec.confidence) out.push({ kind: 'confidence', label: 'nt conf.' })
  return out
}

/**
 * Which plots this dataset supports.
 *
 * Schema-driven exactly as `rowFields` is, so a dataset lacking the columns draws fewer marks
 * rather than empty frames — and so nothing here ever names a column that a backend must have.
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
