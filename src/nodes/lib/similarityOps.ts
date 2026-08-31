/**
 * Pairwise similarity over sparse feature vectors — the step between a connectivity table and
 * a tree.
 *
 * **There is no feature matrix, and that is the design.** The obvious route from "which
 * partners does each neuron touch" to "how alike are these neurons" is a Pivot: neurons down
 * one axis, partners across the other, then compare the rows. That matrix is the thing that
 * does not scale. A thousand neurons against their partner *ids* is 150 million cells before
 * anything is compared — past `CRASH_FLOOR_CELLS`, and past `MAX_PIVOT_COLUMNS` twice over —
 * while the connections that actually exist number about a million. The dense form is three
 * orders of magnitude of zeroes.
 *
 * A long table already **is** that matrix, in the coordinate form every sparse library starts
 * from: one row per non-zero, carrying its two coordinates and its value. So this module reads
 * the long table directly and the wide one is never built. What comes out — observations
 * against themselves — is genuinely dense and small, and is an ordinary `MatrixValue`.
 *
 * ## The one pass
 *
 * Every metric here is a function of three per-pair sums and three per-observation ones, and
 * only one per-pair sum is ever needed at a time:
 *
 * | metric | per pair | per observation |
 * |---|---|---|
 * | cosine, Euclidean | `Σ aᵢbᵢ` | `Σ aᵢ²` |
 * | Pearson | `Σ aᵢbᵢ` | `Σ aᵢ`, `Σ aᵢ²`, and the ambient `F` |
 * | Jaccard (presence) | `|A ∩ B|` | `|A|` |
 * | Jaccard (weighted) | `Σ min(aᵢ,bᵢ)` | `Σ aᵢ` |
 *
 * Which is why they cost one accumulator between them rather than five — `pivotTable`'s rule
 * about allocating per aggregation, and for the same reason: the array is `n²` floats and a
 * spare one is the whole matrix again.
 *
 * The sum is taken feature-first. Held column-major, a feature's entries are exactly the
 * observations carrying it, so every pair that shares it is one nested loop and every pair
 * that does not is never visited. Total work is `Σ_f |column f|²`, which for connectivity is
 * dominated by however many neurons share the busiest partner — `pairWork` computes it exactly
 * before anything is allocated, because that is the number worth saying out loud.
 *
 * ## What is deliberately not here
 *
 * The Jarrell/Schlegel vertex-similarity score, which the fly literature uses and which does
 * *not* reduce to the table above: `min − C₁·max·exp(−C₂·min)` has to be evaluated over the
 * **union** of two vectors rather than their intersection, so it is a per-pair merge rather
 * than a shared accumulation. It belongs here eventually; it is a second traversal, not a
 * sixth row of that table, and adding it does not change this module's shape.
 */

import { describeDuration, refuseIfOverCrashFloor, warnOverThreshold } from '../../core/limits'
import type { Warner } from '../../core/limits'
import type { MatrixValue, TableValue } from '../../core/values'
import { getColumn, makeMatrix } from '../../core/values'
import { labelOf, uniqueLabels } from './tableOps'

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

export type SimilarityMetric =
  'cosine' | 'jaccard' | 'jaccardWeighted' | 'euclidean' | 'pearson'

export type SimilarityOutput = 'similarity' | 'distance'

/** Which per-pair sum a metric needs. One of these, never two. */
type Accumulation = 'dot' | 'shared' | 'min'

/**
 * Everything that varies per metric, in one row each.
 *
 * `AGG_OPTIONS` one file over is the precedent, and so is the reason: `NUMERIC_AGG_OPTIONS` is
 * *derived* from a per-value fact rather than restated as a second list, so the two cannot
 * disagree about which aggregations are numeric.
 *
 * The fact that most wants a single home is `natural`. "Euclidean has no similarity form" was
 * written out four times — in `effectiveOutput`, in the value label, in the node's `visibleIf`,
 * and in the inversion at the end of `similarityMatrix` — and the last of those is load-bearing
 * rather than defensive: `effectiveOutput` has already answered `'distance'` for Euclidean, so
 * without a second test the finish pass would hand back `1 − distance`. That is a matrix which
 * clusters without complaining and is inside out. The module header promises a sixth metric;
 * the next one that is natively a distance should be one row here and nothing else.
 */
interface MetricSpec {
  label: string
  /** The noun the value label is built from. */
  noun: string
  accumulation: Accumulation
  /** What the metric produces before any Output setting is applied. */
  natural: SimilarityOutput
  /** Whether a value below zero is meaningful — false for the two Jaccards, which refuse. */
  signed: boolean
}

const METRICS: Record<SimilarityMetric, MetricSpec> = {
  cosine: {
    label: 'Cosine',
    noun: 'cosine',
    accumulation: 'dot',
    natural: 'similarity',
    signed: true,
  },
  jaccard: {
    label: 'Jaccard (presence)',
    noun: 'Jaccard',
    accumulation: 'shared',
    natural: 'similarity',
    signed: false,
  },
  jaccardWeighted: {
    label: 'Jaccard (weighted)',
    noun: 'weighted Jaccard',
    accumulation: 'min',
    natural: 'similarity',
    signed: false,
  },
  euclidean: {
    label: 'Euclidean',
    noun: 'Euclidean',
    accumulation: 'dot',
    natural: 'distance',
    signed: true,
  },
  pearson: {
    label: 'Pearson',
    noun: 'Pearson r',
    accumulation: 'dot',
    natural: 'similarity',
    signed: true,
  },
}

export const SIMILARITY_METRIC_OPTIONS: Array<{ value: SimilarityMetric; label: string }> = (
  Object.keys(METRICS) as SimilarityMetric[]
).map((value) => ({ value, label: METRICS[value].label }))

export const SIMILARITY_OUTPUT_OPTIONS: Array<{ value: SimilarityOutput; label: string }> = [
  { value: 'similarity', label: 'Similarity' },
  { value: 'distance', label: 'Distance' },
]

/**
 * The two layouts a table can carry its features in.
 *
 * Exported with the rest of the vocabulary rather than kept local to the node, because the two
 * emitters branch on the same fact and were each testing `params.layout === 'wide'` with their
 * own literal — which is exactly the drift `core.groupBy`'s header records from the time its
 * value picker was two params made exclusive by `visibleIf`.
 */
export const SIMILARITY_LAYOUT_OPTIONS = [
  { value: 'long', label: 'Long (one row per pair)' },
  { value: 'wide', label: 'Wide (one column per feature)' },
]

/** Long is the default, so anything that is not `wide` is long. One reader of that rule. */
export function isLongLayout(params: Readonly<Record<string, unknown>>): boolean {
  return params.layout !== 'wide'
}

/**
 * A metric with no similarity form answers `distance` whatever the Output setting says.
 *
 * Its control is hidden by `visibleIf` in that case, and a hidden param is excluded from the
 * provenance key (invariant 4) — so `evaluate` has to reach the same answer without reading it.
 * The node, both emitters and the value label all come here rather than each testing the metric.
 */
export function effectiveOutput(
  metric: SimilarityMetric,
  requested: SimilarityOutput,
): SimilarityOutput {
  return METRICS[metric].natural === 'distance' ? 'distance' : requested
}

/** Whether the Output control means anything for this metric — the `visibleIf` the node uses. */
export function hasSimilarityForm(metric: SimilarityMetric): boolean {
  return METRICS[metric].natural === 'similarity'
}

/** What the cells are, for the heatmap legend and for `distanceLabelFor` on a Linkage. */
export function similarityValueLabel(
  metric: SimilarityMetric,
  output: SimilarityOutput,
): string {
  const { noun, natural } = METRICS[metric]
  if (natural === 'distance') return `${noun} distance`
  return output === 'distance' ? `1 − ${noun}` : `${noun} similarity`
}

// ---------------------------------------------------------------------------
// The sparse half
// ---------------------------------------------------------------------------

/**
 * Feature vectors held column-major (CSC), which is the layout the one pass reads.
 *
 * Row-major would be the natural way to *build* this and the wrong way to use it: comparing
 * every pair from row vectors means intersecting two sorted lists per pair, `n²` times, where
 * column-major visits only the pairs that share something. The transpose is two counting
 * sorts and is paid once.
 */
export interface SparseFeatures {
  /** Observation labels, in matrix row and column order. */
  readonly labels: string[]
  /**
   * How many distinct features there are — the **ambient dimension**, and not decoration:
   * Pearson centres each vector over every feature including the ones an observation does not
   * have, so `F` changes the answer.
   *
   * A count rather than the labels, because nothing ever reads them. Column *order* does not
   * reach the result — `accumulate` sums over every column — so the features are interned in
   * first-appearance order rather than sorted, and their strings are not retained. Keeping them
   * meant a locale-aware sort of a list that can run to hundreds of thousands of partner ids,
   * and then holding that whole array alive behind a matrix that never looks at it. The
   * *observation* labels are a different matter: they are the matrix axis, so they stay sorted.
   */
  readonly featureCount: number
  /** Entries of feature `f` are `[colStart[f], colStart[f + 1])`. */
  readonly colStart: Int32Array
  /** Observation index per entry, **ascending within each feature**. The one pass relies on it. */
  readonly rowIndex: Int32Array
  readonly value: Float64Array
  readonly rowSum: Float64Array
  readonly rowSumSq: Float64Array
  /** How many features each observation has — `|A|`, for the presence Jaccard. */
  readonly rowNnz: Int32Array
  /** `(observation, feature)` pairs that appeared more than once and were summed. */
  readonly duplicates: number
  /** Entries below zero, which the two Jaccards cannot be defined over. */
  readonly negatives: number
}

/**
 * Triplets to CSC, summing repeats.
 *
 * The **coalescing is not tidying**. A long table straight out of Group By has one row per
 * (neuron, partner) pair, but nothing enforces that — an ungrouped connectivity table has one
 * row per *connection*, so a neuron with four synapses onto four cells of one type arrives as
 * four rows. Left alone, the presence Jaccard would count that type four times toward `|A|`
 * and the weighted one would take four separate minima. Summing here is the same answer Pivot
 * gives with `sum` picked, arrived at without building Pivot's matrix.
 *
 * Two counting sorts rather than one, and the second is what makes `rowIndex` ascend within a
 * column: bucketing by feature is stable, so walking the observations in order on the way in
 * puts them in order on the way out. Repeats of one pair land adjacent for the same reason,
 * which is what lets the merge below be a linear scan rather than a map.
 *
 * `binary` flattens what survives the merge to 1, and it is not the same as passing ones in.
 * Presence mode arrives here as a 1 per *row*, so an ungrouped table listing a pair four times
 * would sum to 4 — a connection count wearing presence's label, which every metric but the
 * presence Jaccard would then read as a magnitude. Found by running it: `probe-py-helpers.py`
 * had cosine answering 0.949 for two observations whose supports are identical.
 */
function buildFeatures(
  labels: string[],
  featureCount: number,
  obs: Int32Array,
  feature: Int32Array,
  value: Float64Array,
  count: number,
  binary = false,
): SparseFeatures {
  const n = labels.length

  /*
   * Pass 1 hands pass 2 a **permutation**, not a copy of the data. Bucketing the entry indices
   * by observation is all pass 2 needs — it reads `obs`/`feature`/`value` at those indices —
   * and it saves an `Int32Array` and a `Float64Array` the size of the whole input.
   */
  const rowStart = new Int32Array(n + 1)
  for (let i = 0; i < count; i++) rowStart[obs[i]! + 1] = rowStart[obs[i]! + 1]! + 1
  for (let r = 0; r < n; r++) rowStart[r + 1] = rowStart[r + 1]! + rowStart[r]!
  const byObservation = new Int32Array(count)
  {
    const cursor = rowStart.slice(0, n)
    for (let i = 0; i < count; i++) {
      const at = cursor[obs[i]!]!
      cursor[obs[i]!] = at + 1
      byObservation[at] = i
    }
  }

  // Pass 2: bucket by feature, walking observations in order so each column comes out sorted.
  const packed = new Int32Array(featureCount + 1)
  for (let i = 0; i < count; i++) packed[feature[i]! + 1] = packed[feature[i]! + 1]! + 1
  for (let c = 0; c < featureCount; c++) packed[c + 1] = packed[c + 1]! + packed[c]!
  const rowIndex = new Int32Array(count)
  const values = new Float64Array(count)
  {
    const cursor = packed.slice(0, featureCount)
    for (let k = 0; k < count; k++) {
      const i = byObservation[k]!
      const c = feature[i]!
      const at = cursor[c]!
      cursor[c] = at + 1
      rowIndex[at] = obs[i]!
      values[at] = value[i]!
    }
  }

  /*
   * Pass 3 merges repeats **in place**. `write` never runs ahead of the read cursor — a run is
   * fully consumed before its one output is written, and the output index is at most the run's
   * first index — so the two arrays pass 2 filled are also the two this returns.
   */
  const colStart = new Int32Array(featureCount + 1)
  let write = 0
  let duplicates = 0
  let negatives = 0
  for (let c = 0; c < featureCount; c++) {
    let i = packed[c]!
    const end = packed[c + 1]!
    colStart[c] = write
    while (i < end) {
      const r = rowIndex[i]!
      let sum = values[i]!
      i++
      while (i < end && rowIndex[i] === r) {
        sum += values[i]!
        i++
        duplicates++
      }
      if (sum === 0) continue
      if (sum < 0) negatives++
      rowIndex[write] = r
      values[write] = binary ? 1 : sum
      write++
    }
  }
  colStart[featureCount] = write

  const rowSum = new Float64Array(n)
  const rowSumSq = new Float64Array(n)
  const rowNnz = new Int32Array(n)
  for (let i = 0; i < write; i++) {
    const r = rowIndex[i]!
    const v = values[i]!
    rowSum[r] = rowSum[r]! + v
    rowSumSq[r] = rowSumSq[r]! + v * v
    rowNnz[r] = rowNnz[r]! + 1
  }

  return {
    labels,
    featureCount,
    colStart,
    // Trimmed only where something was actually dropped. A table with no repeats and no zeroes
    // is the ordinary case, and there the copy would be the whole input again for nothing.
    rowIndex: write === count ? rowIndex : rowIndex.slice(0, write),
    value: write === count ? values : values.slice(0, write),
    rowSum,
    rowSumSq,
    rowNnz,
    duplicates,
    negatives,
  }
}

/**
 * Long form: one row per non-zero, carrying its two coordinates and its value.
 *
 * An absent Value column means **presence**: the vector is 1 wherever the pair is listed at all,
 * however many times it is listed. That is what makes "these two neurons touch the same
 * partners" askable without a weight to hand, and it has to be applied *after* the repeats are
 * merged rather than by handing in a column of ones — see `buildFeatures`.
 *
 * The **observation** labels come from `uniqueLabels`, the same function a Pivot labels its
 * axes with, so a similarity matrix and a pivot over the same column name their observations
 * identically and can be joined back together. The features are interned in first-appearance
 * order instead: nothing downstream reads their order, and sorting them meant an Intl collator
 * comparison per pair over a list that on the headline case is every partner id in the dataset.
 */
export function featuresFromLong(
  table: TableValue,
  observationColumn: string,
  featureColumn: string,
  valueColumn: string | undefined,
): SparseFeatures {
  const obsData = getColumn(table, observationColumn)
  const featureData = getColumn(table, featureColumn)
  const valueData = valueColumn ? getColumn(table, valueColumn) : undefined

  const labels = uniqueLabels(obsData)
  const obsIndex = new Map<string, number>()
  labels.forEach((label, i) => obsIndex.set(label, i))
  const featureIndex = new Map<string, number>()

  const obs = new Int32Array(table.length)
  const feature = new Int32Array(table.length)
  const value = new Float64Array(table.length)
  let count = 0
  for (let i = 0; i < table.length; i++) {
    const v = valueData ? Number(valueData[i]) : 1
    if (!Number.isFinite(v) || v === 0) continue
    const r = obsIndex.get(labelOf(obsData[i]))
    if (r === undefined) continue
    const name = labelOf(featureData[i])
    let c = featureIndex.get(name)
    if (c === undefined) {
      c = featureIndex.size
      featureIndex.set(name, c)
    }
    obs[count] = r
    feature[count] = c
    value[count] = v
    count++
  }
  return buildFeatures(labels, featureIndex.size, obs, feature, value, count, !valueData)
}

/**
 * Wide form: one row per observation, one picked column per feature.
 *
 * The shape an uploaded embedding or a `Pivot → Table` arrives in, and the reason this node is
 * the general distances node rather than the connectivity one. A **zero reads as absent**,
 * which matters only to the presence Jaccard — every other metric here already treats a zero
 * as contributing nothing.
 *
 * A repeated id is summed rather than refused, which is `buildFeatures`' rule everywhere:
 * there is no reading of "the same observation twice" that a distance matrix can carry.
 */
export function featuresFromWide(
  table: TableValue,
  idColumn: string,
  featureColumns: readonly string[],
): SparseFeatures {
  const idData = getColumn(table, idColumn)
  const labels = uniqueLabels(idData)
  const obsIndex = new Map<string, number>()
  labels.forEach((label, i) => obsIndex.set(label, i))
  /*
   * Resolved once per **row**, not once per cell: the row an entry belongs to depends only on
   * `i`, and leaving the lookup in the inner loop ran a `String()` and a string-keyed hash for
   * every cell — two hundred times over on an embedding two hundred columns wide.
   */
  const rowOf = new Int32Array(table.length)
  for (let i = 0; i < table.length; i++) rowOf[i] = obsIndex.get(labelOf(idData[i])) ?? -1

  const size = table.length * featureColumns.length
  const obs = new Int32Array(size)
  const feature = new Int32Array(size)
  const value = new Float64Array(size)
  let count = 0
  featureColumns.forEach((name, c) => {
    const data = getColumn(table, name)
    for (let i = 0; i < table.length; i++) {
      const v = Number(data[i])
      if (!Number.isFinite(v) || v === 0) continue
      const r = rowOf[i]!
      if (r < 0) continue
      obs[count] = r
      feature[count] = c
      value[count] = v
      count++
    }
  })
  return buildFeatures(labels, featureColumns.length, obs, feature, value, count)
}

// ---------------------------------------------------------------------------
// Guard rails
// ---------------------------------------------------------------------------

/**
 * Exactly how many pair-contributions the one pass will make: `Σ_f |column f|(|column f|−1)/2`.
 *
 * Computed rather than guessed from `n`, because the two differ by orders of magnitude on real
 * data and it is the *feature* distribution that decides. A thousand neurons whose partners are
 * mostly private cost little; a thousand that all touch one hub pay a million for that feature
 * alone. Nothing `n`-sized has been allocated at the point this is called.
 *
 * `k−1` and not `k+1`, which is the diagonal: a feature only one observation carries produces
 * no *pair* at all, and the accumulator skips it. On connectivity keyed by partner id that is
 * most of the columns, so counting the self-pairs would have said there was work to do on an
 * input where there is none.
 */
export function pairWork(features: SparseFeatures): number {
  let work = 0
  for (let c = 0; c < features.featureCount; c++) {
    const k = features.colStart[c + 1]! - features.colStart[c]!
    work += (k * (k - 1)) / 2
  }
  return work
}

/**
 * Where this starts saying how long it will be.
 *
 * **Measured rather than picked.** Timed on an M-series laptop over four shapes crossed with
 * four metrics, chosen to span the two things that move the rate — how widely the writes
 * scatter over the `n²` accumulator, and which of the three inner loops runs. The sixteen
 * results run from **310M contributions per second** (2,000 observations over 400 features,
 * weighted Jaccard) to 924M (the same shape, cosine). Roughly 1.7 seconds here at the slow end,
 * which is where a tab that has stopped repainting needs to have been explained beforehand.
 *
 * It warns and does not refuse: the answer on the other side is a real one and the wait is the
 * user's to spend (`docs/limits.md`).
 *
 * Note what this does *not* bound — the `n²` finish pass, which is a call per cell whatever the
 * features look like. That one is bounded by `refuseIfOverCrashFloor` instead, at about 8,100
 * observations, and at that size it is a fraction of a second.
 */
export const SIMILARITY_WORK_WARN = 500_000_000

/**
 * Contributions per second, for turning `pairWork` into a sentence — the **slow** end of the
 * measured range above rather than its middle, so the estimate is never shorter than the wait.
 */
const CONTRIBUTIONS_PER_SECOND = 300_000_000

// ---------------------------------------------------------------------------
// The one pass
// ---------------------------------------------------------------------------

/**
 * The upper triangle of the per-pair sum, in one feature-major pass.
 *
 * Three loops rather than one with a branch in it: the branch would be in the innermost
 * position of the only loop in this file whose cost is quadratic. `rowIndex` ascending within
 * a column is what makes `y` start after `x` correct — `a < b` for every pair visited, so
 * nothing writes below the diagonal and the mirror happens once, later.
 *
 * **Strictly above the diagonal**, which is not a micro-optimisation on this data: a feature
 * carried by exactly one observation contributes only its own self-pair, and on connectivity
 * keyed by partner id most partners are private, so the self-pairs were most of the work. The
 * diagonal is written outright at the end anyway — see `similarityMatrix`.
 */
function accumulate(features: SparseFeatures, kind: Accumulation): Float64Array {
  const n = features.labels.length
  const { colStart, rowIndex, value } = features
  const acc = new Float64Array(n * n)
  const f = features.featureCount

  for (let c = 0; c < f; c++) {
    const start = colStart[c]!
    const end = colStart[c + 1]!
    if (kind === 'dot') {
      for (let x = start; x < end; x++) {
        const base = rowIndex[x]! * n
        const av = value[x]!
        for (let y = x + 1; y < end; y++) {
          const at = base + rowIndex[y]!
          acc[at] = acc[at]! + av * value[y]!
        }
      }
    } else if (kind === 'shared') {
      for (let x = start; x < end; x++) {
        const base = rowIndex[x]! * n
        for (let y = x + 1; y < end; y++) {
          const at = base + rowIndex[y]!
          acc[at] = acc[at]! + 1
        }
      }
    } else {
      for (let x = start; x < end; x++) {
        const base = rowIndex[x]! * n
        const av = value[x]!
        for (let y = x + 1; y < end; y++) {
          const at = base + rowIndex[y]!
          const bv = value[y]!
          acc[at] = acc[at]! + (av < bv ? av : bv)
        }
      }
    }
  }
  return acc
}

/**
 * The per-pair sum turned into the metric — **curried by row**.
 *
 * `row(a)` is called `n` times and the function it returns is called `n/2` times each, so
 * everything about `a` — its norm, its mean, its feature count — is loaded once per row rather
 * than once per cell. At the crash-floor `n` that is 8,100 lookups instead of 33 million.
 * The per-row closure is the only allocation the shape costs, and there are `n` of them.
 */
function rowFunction(
  metric: SimilarityMetric,
  features: SparseFeatures,
): (a: number) => (b: number, sum: number) => number {
  const { rowSum, rowSumSq, rowNnz, featureCount } = features
  switch (metric) {
    case 'cosine': {
      const norm = Float64Array.from(rowSumSq, Math.sqrt)
      return (a) => {
        const na = norm[a]!
        return (b, dot) => {
          const d = na * norm[b]!
          return d === 0 ? 0 : dot / d
        }
      }
    }
    case 'euclidean':
      return (a) => {
        const sa = rowSumSq[a]!
        return (b, dot) => Math.sqrt(Math.max(0, sa + rowSumSq[b]! - 2 * dot))
      }
    case 'jaccard':
      return (a) => {
        const na = rowNnz[a]!
        return (b, shared) => {
          const union = na + rowNnz[b]! - shared
          return union === 0 ? 0 : shared / union
        }
      }
    case 'jaccardWeighted':
      /*
       * `Σ max = Σ a + Σ b − Σ min`, which holds for non-negative values and is why the
       * negatives are refused rather than warned about — the identity is silently wrong below
       * zero, and a Ruzicka index outside [0,1] reaches a Linkage as a negative distance.
       */
      return (a) => {
        const ta = rowSum[a]!
        return (b, min) => {
          const max = ta + rowSum[b]! - min
          return max === 0 ? 0 : min / max
        }
      }
    case 'pearson': {
      /*
       * Centred over the **ambient** feature space, not over the features an observation
       * happens to have: the mean of a sparse vector is `Σ a / F`, counting every absent
       * feature as the zero it is. Taking it over the present ones instead would make two
       * neurons with one partner each perfectly correlated.
       */
      const mean = Float64Array.from(rowSum, (sum) => sum / featureCount)
      const sd = Float64Array.from(rowSumSq, (ss, i) =>
        Math.sqrt(Math.max(0, ss / featureCount - mean[i]! * mean[i]!)),
      )
      return (a) => {
        const ma = mean[a]!
        const sa = sd[a]!
        return (b, dot) => {
          const d = sa * sd[b]!
          return d === 0 ? 0 : (dot / featureCount - ma * mean[b]!) / d
        }
      }
    }
  }
}

/**
 * Observations against themselves, as the matrix a Heatmap or a Linkage takes.
 *
 * `measure` is set rather than left blank, and that is what makes `Similarity → Linkage` work
 * with nothing to configure: Linkage inverts a similarity and leaves a distance alone, reading
 * exactly this field. Pivot cannot answer it — its cells are whatever aggregation was picked —
 * which is why the field is optional; here the metric decides, so it is never a guess.
 *
 * **The diagonal is written rather than computed.** Every metric here is 1 (or 0 for a
 * distance) between a vector and itself, except over an observation with no features at all,
 * where the ratio is 0/0. Leaving that as zero would give a neuron a non-zero distance to
 * itself, which is not a distance and which fastcore clusters without complaining. The empty
 * observations are counted and said out loud instead.
 */
export function similarityMatrix(
  features: SparseFeatures,
  metric: SimilarityMetric,
  output: SimilarityOutput,
  ctx: Warner,
): MatrixValue {
  const n = features.labels.length
  const resolved = effectiveOutput(metric, output)

  if (!METRICS[metric].signed && features.negatives > 0) {
    throw new Error(
      `A Jaccard index is not defined over negative values, and ${features.negatives.toLocaleString()} ` +
        `of these are below zero. Cosine, Euclidean and Pearson all take them; so does a Jaccard ` +
        `once the values are non-negative.`,
    )
  }

  // Refused before the `n²` accumulator is allocated — the sparse side is already built by
  // now, and is `nnz` rather than `n²`. Past the floor there is no matrix on the other side of
  // it to warn about, which is what makes this the one refusal rather than a warning.
  refuseIfOverCrashFloor(`A ${n.toLocaleString()} x ${n.toLocaleString()} matrix`, n * n * 8)

  const work = pairWork(features)
  if (work > SIMILARITY_WORK_WARN) {
    warnOverThreshold(ctx, {
      count: work,
      threshold: SIMILARITY_WORK_WARN,
      unit: 'pair comparisons',
      control: 'the size this stays interactive at',
      cost:
        `That is ${describeDuration(work / CONTRIBUTIONS_PER_SECOND)} of single-threaded work, ` +
        `and the tab does not repaint while it runs. What drives it is how many observations ` +
        `share their busiest feature, so filtering the common partners out upstream cuts it ` +
        `faster than dropping observations does.`,
    })
  }
  if (features.duplicates > 0) {
    ctx.warn(
      `${features.duplicates.toLocaleString()} rows repeated an observation/feature pair and ` +
        `were summed, exactly as a Pivot set to sum would. If they were meant to be separate ` +
        `features, they need something to tell them apart before they get here.`,
    )
  }

  const values = accumulate(features, METRICS[metric].accumulation)
  const row = rowFunction(metric, features)
  const distance = resolved === 'distance'
  /*
   * Hoisted, both of them. `invert` is a metric fact and was being re-derived per cell in the
   * one loop this module's header singles out as bounded only by the crash floor; and `b`
   * starts *past* the diagonal, since every diagonal cell is overwritten below.
   */
  const invert = distance && METRICS[metric].natural === 'similarity'
  for (let a = 0; a < n; a++) {
    const cell = row(a)
    for (let b = a + 1; b < n; b++) {
      const at = a * n + b
      const v = cell(b, values[at]!)
      const out = invert ? 1 - v : v
      values[at] = out
      values[b * n + a] = out
    }
  }

  let empty = 0
  const self = distance ? 0 : 1
  for (let a = 0; a < n; a++) {
    if (features.rowNnz[a] === 0) empty++
    values[a * n + a] = self
  }
  if (empty > 0) {
    ctx.warn(
      `${empty.toLocaleString()} of ${n.toLocaleString()} observations have no features at all, ` +
        `so they are ${distance ? 'at the far end of' : 'at zero to'} everything. They come from ` +
        `rows whose value was zero, empty or missing — filter them upstream if they are not ` +
        `meant to be compared.`,
    )
  }

  return makeMatrix(
    features.labels,
    features.labels.slice(),
    values,
    similarityValueLabel(metric, resolved),
    resolved,
  )
}
