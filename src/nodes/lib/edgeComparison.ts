/**
 * Type-level edge comparison: the same connection, counted in two or more connectomes.
 *
 * cocoa's `Comparison`, and the payoff of the correspondence [typeMapping.ts](typeMapping.ts)
 * builds. Each dataset arrives as an edge list plus that dataset's labels; each edge list is
 * relabelled into the shared label space, summed per `(preLabel, postLabel)`, and the results
 * are put side by side. See [comparative.md](../../../docs/comparative.md) for the decisions.
 *
 * Headless, like every `nodes/lib` module: no ports, no context, no fetch. The node hands it
 * tables and reads tables back.
 *
 * ## Absent and unsampled are different answers, and that is the whole point
 *
 * An edge in A and not in B is **0** in B when both of its labels exist in B's label pool — a
 * real biological absence, and very often the interesting result. It is **null** when either
 * label is missing from B, because then nothing was asked and a zero would be a claim. cocoa
 * does neither: `Comparison.compile` intersects the labels present in all datasets and drops
 * the rest, which produces the cleanest possible table by discarding exactly the asymmetries
 * the comparison exists to find. Its own comment gives the reasoning — avoiding "50 synapses
 * here, 0 there" artefacts from unequal selection — and making the distinction a *column*
 * answers that without throwing rows away.
 *
 * So `present_<name>` is not decoration and not derivable from the weight: `weight` null with
 * `present` true cannot occur, `weight` 0 with `present` true is a real zero, and `present`
 * false is "this dataset was never in a position to say".
 *
 * ## Raw counts. Normalisation is composed downstream
 *
 * cocoa leaves `# TODO: normalised edge weights` in `Comparison.compile`, so there is nothing to
 * copy and no measured basis for picking one — and which normalisation is right is a question
 * about the two datasets in hand rather than a property of this operation. The answer is to
 * report raw sums and emit everything a normalisation *needs*, which is what `counts` is for.
 *
 * That leaves the trap decision 5 names: **a ratio computed from raw counts across two
 * connectomes of different completeness is meaningless and looks authoritative**, which is why
 * `totalsRatio` exists and the node warns on it.
 */

import type { Warner } from '../../core/limits'
import { SILENT } from '../../core/limits'
import { column, tableSchema } from '../../core/types'
import type { TableSchema } from '../../core/types'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
import { ID_COLUMN_NAME, idText } from '../../core/ids'
import type { NeuronId } from '../../core/ids'
import { labelsByNeuron } from './typeMapping'

/**
 * One dataset's contribution: its edges already relabelled, plus what it *could* have said.
 *
 * `pool` is every label the dataset's mapping carries, not just the labels its edges reached —
 * that difference is the whole absent-versus-unsampled distinction, and a pool derived from the
 * edges would make every absence unsampled by construction.
 */
export interface LabelledEdges {
  /** What the dataset is called in the output's column names. */
  name: string
  /** Summed weight per label pair, keyed by `pairKey`. */
  weights: ReadonlyMap<string, PairWeight>
  /** Every label this dataset has a correspondence for. */
  pool: ReadonlySet<string>
  /** Per label: the neurons seen carrying it, and the weight out of and into it. */
  labels: ReadonlyMap<string, LabelTotals>
}

/**
 * One label pair's summed weight, carrying the two labels it was keyed by.
 *
 * The labels ride along rather than being recovered from the key with a `slice`, which is what
 * keeps `PAIR_SEPARATOR` a write-only detail: nothing parses a key back, so the separator cannot
 * become a second, weaker `rowKey` that some future caller splits on.
 */
export interface PairWeight {
  pre: string
  post: string
  weight: number
}

export interface LabelTotals {
  /** Distinct neurons seen carrying this label **in the edge list**, not in the whole dataset. */
  neurons: number
  /** Summed weight of edges leaving this label, and of edges arriving at it. */
  out: number
  in: number
}

/**
 * The separator inside a pair key.
 *
 * `rowKey`'s own separator, written as the escape `\u0001` for that function's stated reason: a
 * literal control character is invisible to every reader and to `grep`. Written raw here first,
 * which made `file` report this module as `data` and made every `grep` for a symbol in it come
 * back empty — the same incident `uploads.ts` records, walked into while quoting the comment
 * that warns about it.
 *
 * It matters for `rowKey`'s other reason too: without a separator `["ab","c"]` and `["a","bc"]`
 * are one pair, and with the *empty* one — which is what stripping the raw character left behind
 * — every key parses back with an empty `pre`.
 */
const PAIR_SEPARATOR = '\u0001'

function pairKey(pre: string, post: string): string {
  return `${pre}${PAIR_SEPARATOR}${post}`
}

/**
 * Two connectomes' totals differing by more than this is worth saying out loud.
 *
 * **This number is conventional, not measured**, and that is stated rather than hidden: nobody
 * has run the comparison that would set it. What the warning is actually for is the *ratio it
 * prints* — a reader who sees "a factor of 3.9" knows not to divide one column by the other,
 * and that is true whatever the threshold was. The threshold only decides how often the sentence
 * appears, and the alternative of warning on every run is a line people learn to skip.
 *
 * Three rather than two because real pairs differ by about that much for uninteresting reasons:
 * hemibrain's volume truncates arbours that FlyWire follows whole, so a shared type can carry
 * substantially fewer synapses in one without either being wrong. A floor of two would fire
 * almost always. See [limits.md](../../../docs/limits.md) — a guard rail warns, it does not
 * refuse, and this one refuses nothing.
 */
export const EDGE_TOTAL_RATIO_WARN = 3

export interface EdgeColumns {
  pre: string
  post: string
  /** Empty counts each edge as 1, which is what an unweighted edge list means. */
  weight?: string
}

/**
 * One dataset's edges, relabelled and summed.
 *
 * Rows whose either end has no label are dropped — `relabelTable`'s `unmatched: 'drop'`, and the
 * same decision: an unlabelled neuron has no place in a label-level comparison, and keeping it
 * under its raw type name would mix two namespaces in one column.
 */
export function labelledEdgesFrom(
  name: string,
  edges: TableValue,
  labels: ReadonlyMap<NeuronId, string>,
  columns: EdgeColumns,
): LabelledEdges {
  const pre = getColumn(edges, columns.pre)
  const post = getColumn(edges, columns.post)
  const weight = columns.weight ? getColumn(edges, columns.weight) : undefined

  const weights = new Map<string, PairWeight>()
  /*
   * One accumulator rather than a totals map beside an ids map. Two maps keyed alike, written
   * together and reconciled afterwards, need "these have the same keys" to hold with nothing
   * enforcing it — and leave `neurons: 0` a lie until the reconciliation runs. `ids` is counted
   * per label because a neuron carrying a label is a neuron *this edge list actually covered*,
   * which is the distinction `counts` turns on.
   */
  const totals = new Map<string, { out: number; in: number; ids: Set<NeuronId> }>()

  const totalsFor = (label: string) => {
    let entry = totals.get(label)
    if (!entry) {
      entry = { out: 0, in: 0, ids: new Set() }
      totals.set(label, entry)
    }
    return entry
  }

  for (let row = 0; row < edges.length; row++) {
    const preId = idText(pre[row] ?? null)
    const postId = idText(post[row] ?? null)
    if (!preId || !postId) continue
    const preLabel = labels.get(preId)
    const postLabel = labels.get(postId)
    if (preLabel === undefined || postLabel === undefined) continue

    const w = weight ? Number(weight[row] ?? 0) : 1
    if (!Number.isFinite(w)) continue

    const key = pairKey(preLabel, postLabel)
    const pair = weights.get(key)
    if (pair) pair.weight += w
    else weights.set(key, { pre: preLabel, post: postLabel, weight: w })

    const from = totalsFor(preLabel)
    from.out += w
    from.ids.add(preId)
    const to = totalsFor(postLabel)
    to.in += w
    to.ids.add(postId)
  }

  return {
    name,
    weights,
    pool: new Set(labels.values()),
    // The public shape, built once per label — `ids` is an implementation detail of the count.
    labels: new Map(
      Array.from(totals, ([label, t]) => [label, { neurons: t.ids.size, out: t.out, in: t.in }]),
    ),
  }
}

export interface EdgeComparison {
  /** One row per surviving label pair, `comparisonSchema(names)` shaped. */
  comparison: TableValue
  /** Every dataset's summed weight over the pairs that survived, in input order. */
  totals: readonly number[]
}

/**
 * The comparison table, one row per label pair seen anywhere.
 *
 * **Columns are built directly rather than through a row-shaped intermediate.** The obvious
 * arrangement — a `ComparedEdge[]` that a second function transposes — allocates an object and
 * two arrays per pair, and a whole-brain comparison is millions of pairs: measured at +1.1 GB of
 * pure intermediate at 2M rows and +3.2 GB at 5.8M, allocated and immediately dropped, on a node
 * with no ceiling of its own. Building the columns in this loop costs 22–35% less wall clock and
 * none of that heap.
 *
 * `minWeight` drops a pair only where **no** dataset reaches it. That is the one reading that
 * leaves the `0`-versus-null rule above intact: thresholding per dataset would suppress a value
 * into a `0` that then means "below the threshold" as well as "really absent", and the column
 * would need a third state to stay honest. As written, a pair carrying 1 in A and 40 in B still
 * shows both numbers — which is exactly the asymmetry somebody set a threshold hoping to see
 * past, not the noise they meant to trim.
 */
export function compareEdges(
  datasets: readonly LabelledEdges[],
  names: readonly string[],
  minWeight = 0,
): EdgeComparison {
  // The union of pairs, in first-appearance order. The labels come off `PairWeight` rather than
  // out of the key, so nothing here parses a key back.
  const pairs = new Map<string, PairWeight>()
  for (const dataset of datasets) {
    for (const [key, pair] of dataset.weights) {
      if (!pairs.has(key)) pairs.set(key, pair)
    }
  }

  const preLabel: CellValue[] = []
  const postLabel: CellValue[] = []
  const weights = datasets.map(() => [] as CellValue[])
  const present = datasets.map(() => [] as CellValue[])
  const totals = datasets.map(() => 0)

  for (const [key, pair] of pairs) {
    let reached = false
    for (const dataset of datasets) {
      const found = dataset.weights.get(key)
      if (found && found.weight >= minWeight) {
        reached = true
        break
      }
    }
    if (!reached) continue

    preLabel.push(pair.pre)
    postLabel.push(pair.post)
    datasets.forEach((dataset, i) => {
      const seen = dataset.pool.has(pair.pre) && dataset.pool.has(pair.post)
      present[i]!.push(seen)
      /*
       * A weight exists only because both its labels came out of this dataset's own lookup, so
       * a found weight already implies `seen` — which is why there is no `seen ? … : weight`
       * arm here. Both labels in the pool and no edge is a real zero; anything else is unasked.
       */
      const found = dataset.weights.get(key)
      const value = found ? found.weight : seen ? 0 : null
      weights[i]!.push(value)
      totals[i] = totals[i]! + (value ?? 0)
    })
  }

  const data: Record<string, ColumnData> = { preLabel, postLabel }
  names.forEach((name, i) => {
    data[`weight_${name}`] = weights[i] ?? []
    data[`present_${name}`] = present[i] ?? []
  })
  return { comparison: makeTable(comparisonSchema(names), data), totals }
}

/**
 * The largest factor between any two datasets' totals, or 0 where one of them is empty.
 *
 * Every pair rather than first-against-rest: with three datasets the extreme pair is what a
 * reader has to know about, and it need not involve the first one.
 */
export function totalsRatio(totals: readonly number[]): number {
  if (totals.length < 2 || totals.some((total) => total <= 0)) return 0
  return Math.max(...totals) / Math.min(...totals)
}

/**
 * The comparison's columns, for a given set of dataset names.
 *
 * Both halves of invariant 3 come through here — `inferOutputs` publishes it and `comparisonTable`
 * builds from the same call — because unlike the mapper's report this schema is *not* a constant:
 * it is two columns per dataset, named after params. Long form would have made it constant, and
 * was declined here for the reason it was chosen there: a comparison is read side by side, and
 * "4 in A, 40 in B" on one row is the entire product.
 *
 * `weight` is `f64` rather than `i64`: it holds nulls, and it is a sum that a normalisation
 * downstream will divide.
 */
export function comparisonSchema(names: readonly string[]): TableSchema {
  return tableSchema(
    column('preLabel', 'str'),
    column('postLabel', 'str'),
    ...names.map((name) => column(`weight_${name}`, 'f64', 'synapses')),
    ...names.map((name) => column(`present_${name}`, 'bool')),
  )
}

/**
 * `counts`, and it is long where `comparison` is wide.
 *
 * The opposite choice to the table above, and for the opposite reason: nothing here is read side
 * by side — these are the divisors a normalisation reaches for by name — so a constant schema is
 * worth more than adjacency, and it is what lets this port publish its columns without knowing
 * the arity.
 *
 * **`outWeight` and `inWeight` rather than one `totalWeight`.** The design record said one
 * column; one column cannot express two of the three normalisations decision 5 names. Input
 * fraction needs the label's *incoming* total, and a single column summed over both ends
 * double-counts every edge, which breaks global scaling too. Two columns cost nothing — same
 * rows, still constant — and make all three a `Join` plus a `Combine Columns`, which is what
 * decision 5 promises.
 *
 * `nNeurons` counts neurons **this edge list covered**, not the dataset's whole annotation
 * table: a per-neuron mean over the selection is what somebody wants, and dividing by neurons
 * that contributed nothing to these edges is a different, smaller number that looks the same.
 */
export const COUNTS_SCHEMA: TableSchema = tableSchema(
  column('label', 'str'),
  column('dataset', 'str'),
  column('nNeurons', 'i64'),
  column('outWeight', 'f64', 'synapses'),
  column('inWeight', 'f64', 'synapses'),
)

export function countsTable(datasets: readonly LabelledEdges[]): TableValue {
  const label: CellValue[] = []
  const dataset: CellValue[] = []
  const neurons: CellValue[] = []
  const out: CellValue[] = []
  const into: CellValue[] = []
  for (const source of datasets) {
    for (const [name, totals] of source.labels) {
      label.push(name)
      dataset.push(source.name)
      neurons.push(totals.neurons)
      out.push(totals.out)
      into.push(totals.in)
    }
  }
  return makeTable(COUNTS_SCHEMA, {
    label,
    dataset,
    nNeurons: neurons,
    outWeight: out,
    inWeight: into,
  })
}

/**
 * The whole operation, from tables to tables.
 *
 * One entry point so the node stays a wiring layer and the tests can drive the algorithm without
 * a graph — `matchCellTypes`' arrangement one node over.
 */
export interface CompareInput {
  name: string
  edges: TableValue
  labels: TableValue
  columns: EdgeColumns
  idColumn?: string
  labelColumn?: string
}

/**
 * The node's params as this module's arguments, read once.
 *
 * `matchParamsFrom` / `meshCleanParamsFrom`'s shape, and here for their stated reason: `evaluate`
 * and **both** emitters need the same answer, and three transcriptions is three chances for the
 * notebook to compute a different table than the canvas. Two of the rules it carries are
 * silent-wrong-answer rules — an empty weight picker means "one per row", and `minWeight` is
 * clamped at zero — so a drift is a number, not an error.
 *
 * Structurally typed on the context so a `NodeDefinition`'s `evaluate` and an `EmitContext` both
 * satisfy it without either importing the other.
 */
export interface CompareParamsContext {
  params: Readonly<Record<string, unknown>>
  column: (id: string) => string | undefined
}

export interface CompareParams {
  /** One per dataset, in port order, deduplicated. */
  names: readonly string[]
  /** The three column pickers per dataset, in the same order. `weight` empty is one per row. */
  columns: readonly EdgeColumns[]
  idColumn: string
  labelColumn: string
  minWeight: number
}

export function compareParamsFrom(
  ctx: CompareParamsContext,
  names: readonly string[],
  at: (base: string, index: number) => string,
): CompareParams {
  return {
    names,
    columns: names.map((_, i) => {
      const index = i + 1
      return {
        pre: ctx.column(at('pre', index)) ?? '',
        post: ctx.column(at('post', index)) ?? '',
        weight: ctx.column(at('weight', index)),
      }
    }),
    idColumn: ctx.column('idColumn') ?? ID_COLUMN_NAME,
    labelColumn: ctx.column('labelColumn') ?? 'label',
    minWeight: Math.max(0, Number(ctx.params.minWeight ?? 0)),
  }
}

export function compareConnectivity(
  inputs: readonly CompareInput[],
  options: { minWeight?: number; warn?: Warner } = {},
): { comparison: TableValue; counts: TableValue } {
  const warn = options.warn ?? SILENT
  const datasets = inputs.map((input) =>
    labelledEdgesFrom(
      input.name,
      input.edges,
      labelsByNeuron(input.labels, input.idColumn, input.labelColumn),
      input.columns,
    ),
  )
  const names = datasets.map((dataset) => dataset.name)
  const compared = compareEdges(datasets, names, options.minWeight ?? 0)

  const ratio = totalsRatio(compared.totals)
  if (ratio > EDGE_TOTAL_RATIO_WARN) {
    const spread = datasets
      .map((dataset, i) => `${dataset.name} ${Math.round(compared.totals[i]!).toLocaleString()}`)
      .join(', ')
    warn.warn(
      `Totals over the shared labels differ by a factor of ${ratio.toFixed(1)} (${spread}). ` +
        `A ratio between these columns is a ratio between two datasets' completeness as much as ` +
        `between two brains — normalise before comparing them.`,
    )
  }

  return { comparison: compared.comparison, counts: countsTable(datasets) }
}
