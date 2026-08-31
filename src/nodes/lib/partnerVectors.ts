/**
 * A connectivity edge list, reshaped into one feature vector per query neuron.
 *
 * The step the raw workflow could not take. `neuron.connectivity` emits an **edge list** —
 * every row is `preId → postId`, oriented the way the synapse points — and `connectivityOps.ts`
 * argues that case at length: a `both` traversal mixes in-edges and out-edges, so a
 * query-relative orientation would have `Build Network` drawing half its arrows backwards.
 *
 * Comparing neurons by their connectivity wants the shape that module gave up. The query
 * neuron is in `preId` on a downstream row and in `postId` on an upstream one, so there is no
 * single column holding "the neuron this row is about", and assembling one out of the existing
 * table nodes takes a Rename, a Combine Columns and a Stack on each branch — six nodes of
 * plumbing before the first real question. This is that plumbing, with the aggregation folded
 * in, so what comes out goes straight into `Similarity Matrix`.
 *
 * ## Which end was the query
 *
 * Two answers, and the wired one wins. A `Neurons` table says so outright and works at any
 * hop count. Without one, the `direction` column is read instead — it records *how the
 * traversal found the edge*, which is exactly this question asked in the other direction:
 * `downstream` means the row came back from asking about `preId`, so `preId` is the query and
 * the connection is one of its outputs. `both` means both endpoints were at the same hop, i.e.
 * the edge is internal to the seed set, and it contributes to both.
 *
 * That reading only holds at **hop 1**, where the frontier still is the seed set, so the
 * derived route drops the rest and says how many. The wired route has no such limit.
 *
 * ## The feature, and why it is always prefixed
 *
 * `out:DA1_lPN` and `in:DA1_lPN` are two different features and would be one if the direction
 * were dropped — a neuron that receives from a type and one that projects to it are not alike
 * for it. The prefix is applied even when only one direction is present, so two of these
 * tables can be stacked and so a saved graph does not change meaning when a Connectivity node
 * upstream is switched from `outputs` to `both`. `direction` and `partner` ride along as their
 * own columns, so the composite can still be filtered on either half.
 *
 * ## A shared label space, and what it costs each neuron
 *
 * Two neurons in two connectomes are alike for touching *the same thing*, and `LC4` in one brain
 * is only the same thing as `LC4` in another because a mapping says so. So an optional `Labels`
 * map — `Match Cell Types`' output — replaces the partner's own type with the shared label.
 *
 * **It has to happen here rather than in a `Relabel` downstream**, and the reason is one line of
 * this file: the feature is `out:` + the partner, built after the partner is decided. A Relabel
 * on the finished `feature` column would have to see through that prefix, which means either
 * teaching a general table node about this node's composite or splitting and rejoining it. The
 * label is a fact about the *partner*, so it belongs where the partner is named.
 *
 * A partner the mapping does not cover is **dropped**, because a feature outside the shared
 * space cannot make two datasets alike or unalike — it can only exist in one of them. That is
 * cocoa's restriction, and it is also why the next section exists.
 *
 * ## `cnFrac`: how much of each neuron survived the restriction
 *
 * cocoa's `cn_frac_`, and it is not a diagnostic nicety. Dropping partners leaves every vector
 * shorter, but it does not leave them *equally* shorter: a neuron whose partners are mostly
 * unmapped ends up represented by a few percent of its connectivity, and clusters as noise with
 * nothing on screen to say why. So each row carries the fraction of that neuron's weight that
 * survived, and the worst case is warned about.
 *
 * It is emitted always, not only under a wired mapping, because `Untyped partners ▸ drop` is the
 * same subtraction by another route. Nothing dropped is `1`.
 *
 * ## Untyped partners
 *
 * The em-dash trap, met properly. `labelOf` pools every absent value into one label, which is
 * right for a pivot axis somebody can look at and wrong here: it would make two neurons alike
 * for both touching unnamed things. So an untyped partner falls back to **its own id** — still
 * a distinct partner, just unnamed — and dropping it is the other, explicit choice.
 */

import { refuseIfOverCrashFloor } from '../../core/limits'
import type { Warner } from '../../core/limits'
import { ID_COLUMN_NAME, idText } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { column, findColumn, tableSchema } from '../../core/types'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
import {
  DIRECTION_COLUMN,
  HOP_COLUMN,
  POST_ID,
  POST_TYPE,
  PRE_ID,
  PRE_TYPE,
} from './connectivityOps'

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** Which half of the pre/post pair names a partner. The only two `connectivityOutputSchema` makes. */
export type PartnerBy = 'type' | 'id'

/** What to do with a partner the dataset has not typed. */
export type UntypedPolicy = 'id' | 'drop'

/** Raw synapse counts, or each query's share of its own total in that direction. */
export type VectorWeighting = 'raw' | 'fraction'

export const PARTNER_BY_OPTIONS: Array<{ value: PartnerBy; label: string }> = [
  { value: 'type', label: 'Cell type' },
  { value: 'id', label: 'Neuron id' },
]

export const UNTYPED_OPTIONS: Array<{ value: UntypedPolicy; label: string }> = [
  { value: 'id', label: 'Use the partner’s id' },
  { value: 'drop', label: 'Drop the connection' },
]

export const WEIGHTING_OPTIONS: Array<{ value: VectorWeighting; label: string }> = [
  { value: 'raw', label: 'Synapse counts' },
  { value: 'fraction', label: 'Fraction of the query’s total' },
]

/** The `direction` values this emits, and the prefix each puts on a feature. */
const OUT = 'out'
const IN = 'in'

/**
 * The output columns.
 *
 * `DIRECTION_COLUMN` is the *same* name the edge list uses and is deliberately reused rather
 * than given a second spelling — but the two carry different vocabularies, and that is worth
 * knowing at a glance: on the way in it is `downstream`/`upstream`/`both`, recording how the
 * traversal found an edge, and on the way out it is `out`/`in`, recording which way the
 * connection points from the query. Same question, asked from the two ends.
 *
 * The id column is `ID_COLUMN_NAME` rather than a literal because the two are *required* to be
 * equal: this node reads its own Neurons input through `idColumn`, which defaults to that
 * constant, and everything downstream that treats a table as neuron-bearing keys on it.
 */
const PARTNER_COLUMN = 'partner'
const FEATURE_COLUMN = 'feature'
const WEIGHT_COLUMN = 'weight'
const CN_FRAC_COLUMN = 'cnFrac'

/**
 * Below this share of a neuron's connectivity surviving, say so.
 *
 * A judgement rather than a measurement, and the same one `UNMATCHED_WARN_FRACTION` makes one
 * node over: past half, the vector describes the minority of a neuron that happened to be
 * mappable, and every distance computed from it is about that minority. The two constants are
 * deliberately not shared — they happen to agree on a number and answer different questions, and
 * a single constant would tie a future adjustment of one to the other.
 */
export const CN_FRAC_WARN = 0.5

export interface PartnerVectorSpec {
  partnerBy: PartnerBy
  untyped: UntypedPolicy
  /** The edge weight to accumulate. Resolved through `ctx.column`, never read raw. */
  weightColumn: string
  weighting: VectorWeighting
  /**
   * Query ids from a wired `Neurons` table, as the decimal text `idText` produces.
   *
   * Undefined means "derive from `direction`", which is a different rule rather than a
   * degraded one — see the header. An *empty* set is not the same thing: it is a wired table
   * with no ids in it, and it correctly produces nothing.
   */
  queries?: ReadonlySet<string>
  /**
   * A partner id → shared label map, from `Match Cell Types`.
   *
   * Wired, it *replaces* `partnerBy` and `untyped`: the label is what names the partner, and a
   * partner the map does not cover is dropped rather than falling back to a type or an id —
   * either of which would be a feature only one dataset can have. Undefined leaves the existing
   * two rules exactly as they were.
   */
  labels?: ReadonlyMap<string, string>
}

// ---------------------------------------------------------------------------
// The schema half
// ---------------------------------------------------------------------------

/**
 * Five columns, and `neuronId` keeps whatever dtype the edge list held its ids in.
 *
 * Derived rather than declared `i64`, because an id's dtype is a fact about the backend —
 * CAVE's are eighteen digits and travel as text (invariant 8), neuPrint's are safe integers.
 * Restating it here is how a column comes to disagree with the value under it.
 *
 * The weight loses its unit under `fraction`: a share of a total is not synapses, which is the
 * call `groupBySchema` already makes about `join` producing text.
 */
export function partnerVectorSchema(
  input: TableSchema | undefined,
  options: { weighting: VectorWeighting; weightColumn?: string },
): TableSchema {
  const idDType = findColumn(input, PRE_ID)?.dtype ?? 'i64'
  const unit =
    options.weighting === 'fraction' || !options.weightColumn
      ? undefined
      : findColumn(input, options.weightColumn)?.unit
  return tableSchema(
    column(ID_COLUMN_NAME, idDType),
    column(DIRECTION_COLUMN, 'str'),
    column(PARTNER_COLUMN, 'str'),
    column(FEATURE_COLUMN, 'str'),
    column(WEIGHT_COLUMN, 'f64', unit),
    // Unconditional, so the schema does not change shape with whether an optional port is wired
    // — which would make every downstream picker empty on a graph reopened without it.
    column(CN_FRAC_COLUMN, 'f64'),
  )
}

/** The columns this needs on its input, for a refusal that names them. */
export function partnerVectorIssues(
  input: TableSchema | undefined,
  partnerBy: PartnerBy,
  hasNeurons: boolean,
): string[] {
  if (!input) return []
  const missing = [PRE_ID, POST_ID].filter((name) => !findColumn(input, name))
  if (missing.length > 0) {
    return [
      `Needs ${missing.join(' and ')} — this is the shape Connectivity emits. Rename Columns ` +
        `will map an edge list that spells them differently`,
    ]
  }
  if (partnerBy === 'type') {
    const types = [PRE_TYPE, POST_TYPE].filter((name) => !findColumn(input, name))
    if (types.length > 0) {
      return [
        `Grouping partners by cell type needs ${types.join(' and ')}, which this table has no`,
      ]
    }
  }
  if (!hasNeurons && !findColumn(input, DIRECTION_COLUMN)) {
    return [
      `Wire the query neurons to the Neurons input — without a ${DIRECTION_COLUMN} column ` +
        `there is nothing to say which end of an edge was asked about`,
    ]
  }
  return []
}

// ---------------------------------------------------------------------------
// The value half
// ---------------------------------------------------------------------------

/**
 * One query neuron's whole vector: a map per direction, plus the total `fraction` divides by.
 *
 * **Two maps rather than one keyed by the composite.** The composite `out:DA1_lPN` is what the
 * output carries, but building it here meant allocating and hashing a fresh string per *edge*
 * — millions on a real connectivity fetch — to reach a map with far fewer keys in it, and then
 * storing the two halves again beside the weight so the emit loop could take them back apart.
 * Which map an entry is in *is* its direction; the key is the partner; the composite is built
 * once per output row, where it is actually needed.
 */
/** A neuron nothing was attributable to has kept all of nothing, which is 1 rather than 0/0. */
function cnFracOf(vector: Vector): number {
  return vector.seenTotal === 0 ? 1 : (vector.outTotal + vector.inTotal) / vector.seenTotal
}

interface Vector {
  /** The id cell exactly as the edge list held it — never re-parsed. Invariant 8. */
  cell: CellValue
  out: Map<string, number>
  in: Map<string, number>
  outTotal: number
  inTotal: number
  /**
   * Every gram of weight attributable to this neuron, before anything was dropped.
   *
   * Accumulated *before* the partner is resolved, which is the only place it can be: once a
   * connection has been dropped for want of a label there is nothing left to count it against.
   * `cnFrac` is `outTotal + inTotal` over this.
   */
  seenTotal: number
}

/**
 * The two orientations of an edge, and how wide a row of the output is.
 *
 * The column count is **derived**, not written down. It was a literal `5` and `cnFrac` made it a
 * six-column table without anyone noticing, which quietly shrank the crash-floor estimate below
 * by a sixth — a guard rail that under-counts is worse than none, because it reports a number
 * somebody trusts. A seventh column cannot repeat it.
 */
const SIDES = 2
const OUTPUT_COLUMNS = partnerVectorSchema(undefined, { weighting: 'raw' }).columns.length

/** One orientation of an edge list: which column is the query, and which describes the partner. */
interface Side {
  direction: string
  queryIds: ColumnData
  partnerIds: ColumnData
  partnerTypes: ColumnData | undefined
  /** The `direction` values on an input row that make this side the query's own. */
  found: readonly string[]
}

export function partnerVectorTable(
  table: TableValue,
  spec: PartnerVectorSpec,
  ctx: Warner,
): TableValue {
  /*
   * Refused up front rather than after the maps are full, which is the only moment it can do
   * any good — and stated in **cells**, the currency `CRASH_FLOOR_CELLS` exists to make every
   * ceiling comparable in.
   *
   * The bound is a ceiling on the *shape* rather than a size: an edge produces at most one row
   * per side (an edge internal to the seed set counts for both endpoints), and aggregation only
   * ever brings that down — usually by orders of magnitude, since the whole point is that many
   * partners share a type. So this refuses an input that could not fit rather than an output
   * that will not, which is the only claim available before the pass runs. It also understates:
   * a `ColumnData` slot is a tagged `CellValue`, not a float64.
   */
  refuseIfOverCrashFloor(
    `Partner vectors over ${table.length.toLocaleString()} edges`,
    table.length * SIDES * OUTPUT_COLUMNS * 8,
  )

  const preId = getColumn(table, PRE_ID)
  const postId = getColumn(table, POST_ID)
  const byType = spec.partnerBy === 'type'
  const weight = getColumn(table, spec.weightColumn)
  const direction = findColumn(table.schema, DIRECTION_COLUMN)
    ? getColumn(table, DIRECTION_COLUMN)
    : undefined
  const hop = findColumn(table.schema, HOP_COLUMN) ? getColumn(table, HOP_COLUMN) : undefined

  if (!spec.queries && !direction) {
    throw new Error(
      `Nothing says which end of an edge was the query. Wire the neurons you asked about to ` +
        `the Neurons input, or feed this a Connectivity result, which carries a ` +
        `"${DIRECTION_COLUMN}" column saying how each edge was found.`,
    )
  }

  /*
   * The two orientations, written once. Spelled out at each call instead — `add(preKey,
   * preId[i], OUT, postType[i], postId[i], w)` and its mirror, twice over for the two routes —
   * the pre/post swap was asserted in four places, each an independent chance to pair `postId`
   * with `preType`. It is also the shape the Python and R helpers this module is the reference
   * for already use.
   */
  const sides: readonly Side[] = [
    {
      direction: OUT,
      queryIds: preId,
      partnerIds: postId,
      partnerTypes: byType ? getColumn(table, POST_TYPE) : undefined,
      found: ['downstream', 'both'],
    },
    {
      direction: IN,
      queryIds: postId,
      partnerIds: preId,
      partnerTypes: byType ? getColumn(table, PRE_TYPE) : undefined,
      found: ['upstream', 'both'],
    },
  ]

  const vectors = new Map<string, Vector>()
  const counts = {
    untypedById: 0,
    untypedDropped: 0,
    pastFirstHop: 0,
    unusable: 0,
    unlabelled: 0,
  }

  /**
   * What names this partner, or null if nothing usable does.
   *
   * Guard clauses rather than a `let` reassigned across branches, so the two ways of answering
   * null — a typed partner deliberately dropped, and an id that is not one — stay apart. They
   * are counted separately and reported as different sentences.
   */
  const partnerLabel = (side: Side, i: number): string | null | undefined => {
    /*
     * The mapping first and last. A partner it does not cover is dropped rather than falling
     * back to a type or an id — either would be a feature only one dataset can have, which is
     * noise in a cross-dataset comparison and indistinguishable from signal once it is a column.
     */
    if (spec.labels) {
      const id = idText(side.partnerIds[i])
      if (id === null) return null
      const mapped = spec.labels.get(id)
      if (mapped === undefined) {
        counts.unlabelled++
        return undefined
      }
      return mapped
    }
    if (!byType) return idText(side.partnerIds[i])
    const cell = side.partnerTypes?.[i]
    const typed = cell === null || cell === undefined ? '' : String(cell).trim()
    if (typed) return typed
    if (spec.untyped === 'drop') {
      counts.untypedDropped++
      return undefined
    }
    counts.untypedById++
    return idText(side.partnerIds[i])
  }

  const add = (side: Side, i: number, queryKey: string, w: number): void => {
    /*
     * The vector exists before the partner is resolved, so `seenTotal` can count a connection
     * that is about to be dropped — which is the whole of `cnFrac`. It also means a neuron whose
     * every partner was dropped still appears in the totals, and correctly reports 0.
     */
    let vector = vectors.get(queryKey)
    if (!vector) {
      vector = {
        cell: side.queryIds[i]!,
        out: new Map(),
        in: new Map(),
        outTotal: 0,
        inTotal: 0,
        seenTotal: 0,
      }
      vectors.set(queryKey, vector)
    }
    vector.seenTotal += w

    const partner = partnerLabel(side, i)
    // `undefined` is a partner deliberately dropped and already counted; `null` is an id that
    // is not one. Two different sentences come out of them, so they are two different answers.
    if (partner === undefined) return
    if (partner === null) {
      counts.unusable++
      return
    }
    if (side.direction === OUT) {
      vector.out.set(partner, (vector.out.get(partner) ?? 0) + w)
      vector.outTotal += w
    } else {
      vector.in.set(partner, (vector.in.get(partner) ?? 0) + w)
      vector.inTotal += w
    }
  }

  for (let i = 0; i < table.length; i++) {
    const w = Number(weight[i])
    if (!Number.isFinite(w) || w === 0) {
      counts.unusable++
      continue
    }
    // The derived route. `direction` only means "which end was asked about" on the first hop.
    if (!spec.queries && hop && Number(hop[i]) !== 1) {
      counts.pastFirstHop++
      continue
    }
    const how = spec.queries ? undefined : String(direction![i] ?? '')
    for (const side of sides) {
      const key = idText(side.queryIds[i])
      if (key === null) continue
      const mine = how === undefined ? spec.queries!.has(key) : side.found.includes(how)
      if (mine) add(side, i, key, w)
    }
  }

  const { untypedById, untypedDropped, pastFirstHop, unusable, unlabelled } = counts
  if (pastFirstHop > 0) {
    ctx.warn(
      `${pastFirstHop.toLocaleString()} edges are past the first hop and were left out. The ` +
        `"${DIRECTION_COLUMN}" column says how the traversal reached an edge, which only names ` +
        `the neuron you asked about while the frontier still is the seed set. Wire those ` +
        `neurons to the Neurons input to use every hop.`,
    )
  }
  if (untypedById > 0) {
    ctx.warn(
      `${untypedById.toLocaleString()} connections are to partners this dataset has not typed, ` +
        `and each is standing in for itself under its own id. That is one feature per untyped ` +
        `partner rather than one shared "untyped" feature, which would make two neurons alike ` +
        `for touching unnamed things. Switch Untyped partners to drop them instead.`,
    )
  }
  if (untypedDropped > 0) {
    ctx.warn(
      `${untypedDropped.toLocaleString()} connections are to partners this dataset has not ` +
        `typed and were dropped, so the vectors do not account for all of their synapses.`,
    )
  }
  if (unusable > 0) {
    ctx.warn(
      `${unusable.toLocaleString()} rows carried no usable weight or no partner id and were ` +
        `skipped.`,
    )
  }
  if (unlabelled > 0) {
    ctx.warn(
      `${unlabelled.toLocaleString()} connections are to partners the mapping does not cover ` +
        `and were dropped. A partner outside the shared label space can only exist in one ` +
        `dataset, so it cannot make two neurons alike — read cnFrac to see how much of each ` +
        `neuron is left.`,
    )
  }

  /*
   * The worst case rather than the mean, and named. A mean over a thousand neurons hides exactly
   * the neuron this is about: the one represented by a few percent of itself, which will still
   * land in a cluster and still be read as a result.
   *
   * Through `cnFracOf` rather than the formula, so the neuron the warning names and the number
   * the column carries cannot come to disagree — including the 0/0 rule, which is the half a
   * second copy would get wrong.
   */
  let worst: { key: string; frac: number } | undefined
  for (const [key, vector] of vectors) {
    const frac = cnFracOf(vector)
    if (!worst || frac < worst.frac) worst = { key, frac }
  }
  if (worst && worst.frac < CN_FRAC_WARN) {
    ctx.warn(
      `Neuron ${worst.key} kept only ${(worst.frac * 100).toFixed(0)}% of its connectivity ` +
        `(cnFrac ${worst.frac.toFixed(2)}); the rest went to partners outside the features ` +
        `being compared. A vector built from a minority of a neuron describes that minority — ` +
        `filter on cnFrac before clustering if this matters.`,
    )
  }

  const fraction = spec.weighting === 'fraction'
  const ids: ColumnData = []
  const directions: ColumnData = []
  const partners: ColumnData = []
  const features: ColumnData = []
  const weights: ColumnData = []
  const fractions: ColumnData = []
  for (const vector of vectors.values()) {
    const cnFrac = cnFracOf(vector)
    for (const [direction, entries, total] of [
      [OUT, vector.out, vector.outTotal],
      [IN, vector.in, vector.inTotal],
    ] as const) {
      for (const [partner, w] of entries) {
        ids.push(vector.cell)
        directions.push(direction)
        partners.push(partner)
        // The composite, built once per output row rather than once per edge on the way in.
        features.push(`${direction}:${partner}`)
        weights.push(fraction ? (total === 0 ? 0 : w / total) : w)
        // Per neuron, repeated down its rows — the trade long form makes, and what turns "drop
        // the badly-covered neurons" into one Filter.
        fractions.push(cnFrac)
      }
    }
  }

  return makeTable(
    partnerVectorSchema(table.schema, {
      weighting: spec.weighting,
      weightColumn: spec.weightColumn,
    }),
    {
      [ID_COLUMN_NAME]: ids,
      [DIRECTION_COLUMN]: directions,
      [PARTNER_COLUMN]: partners,
      [FEATURE_COLUMN]: features,
      [WEIGHT_COLUMN]: weights,
      [CN_FRAC_COLUMN]: fractions,
    },
  )
}
