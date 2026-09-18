/**
 * Folding a synapse cloud into an edge list.
 *
 * `Synapses to Edges`' op, both halves of it — invariant 3's pair, in a sibling module rather
 * than in `tableOps.ts` because the vocabulary is the synapse's: what varies here is which end
 * of a connection a row is written from, which is a question no table op has any business
 * knowing about. The counting itself is `groupByTable`'s `count` and deliberately not a call to
 * it; the orientation pass below is the whole reason this is a node.
 *
 * ## Why a node rather than Group By
 *
 * `docs/nodes-morphology.md` carries the argument; the half this file has to state is the flip, because it
 * is what `EdgePlan.orientation` exists for. **`polarity` means two opposite things under one
 * name.** In `SYNAPSES_BETWEEN_SCHEMA` it is *the end the point was drawn at* — constant down the
 * column, set by that node's `Location` control — and `neuronId` is the presynaptic body in every
 * row whatever it says. In a plain `Synapses` cloud it is *the queried neuron's own role*, so a
 * `post` row means `partnerId → neuronId` and the column varies row by row. Counting the second
 * without flipping merges a neuron's inputs and its outputs into one edge list with half its
 * arrows backwards, and nothing about the result looks unusual.
 *
 * Chosen rather than detected, because nothing can detect it: both clouds carry `neuronId`,
 * `partnerId` and `polarity`, and a `Synapses Between` cloud whose `Location` is `post` reads
 * `post` in every row of the column that would drive the flip. The control is also the *second*
 * instance of one missing field rather than a fact about this node — the producer knows in both
 * cases and throws it away, and `data/synapseUnits.ts` records that a `PointsValue` carries no
 * unit either; `docs/nodes-morphology.md` says what a provenance block on the value would cost.
 *
 * ## The columns are `neuron.connectivity`'s
 *
 * `preId`, `preType`, `postId`, `postType`, `weight` — the names that node emits, so a result
 * from either is interchangeable to `Build Network`, `Compare Connectivity`, the heatmap and
 * every column picker downstream. The extra group columns sit **after** `weight`, which is
 * where `Split by region` puts `roi` on a Connectivity result: a per-region edge list from
 * either node then reads the same way across.
 */

import { idText } from '../../core/ids'
import type { ColumnSchema, TableSchema } from '../../core/types'
import { column, findColumn, pickColumns, tableSchema } from '../../core/types'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
import { KEY_SEPARATOR, rowKey } from './tableOps'
import { POST_ID, POST_TYPE, PRE_ID, PRE_TYPE, WEIGHT_COLUMN } from './connectivityOps'

/** Param ids, spelled once for the node and for `readPlan`. */
export const SOURCE_PARAM = 'source'
export const TARGET_PARAM = 'target'
export const SOURCE_TYPE_PARAM = 'sourceType'
export const TARGET_TYPE_PARAM = 'targetType'
export const ORIENTATION_PARAM = 'orientation'
export const POLARITY_PARAM = 'polarity'
export const GROUP_PARAM = 'by'

/**
 * How a row says which of its two ends is presynaptic.
 *
 * `fixed` is the default because it is what the *pickers themselves say*: the column labelled
 * Presynaptic holds the presynaptic body. `polarity` is the reading a query-relative cloud
 * needs, and it is opt-in rather than detected — see the module head.
 */
type Orientation = 'fixed' | 'polarity'

/**
 * Everything the fold reads, resolved once so the schema half and the value half cannot
 * disagree about which column is which.
 *
 * The type columns are optional in the `undefined` sense: a cloud carrying no types produces an
 * edge list with no `preType`, and the schema says so before anything runs.
 */
export interface EdgePlan {
  /** Presynaptic id column as the row carries it, before any flip. */
  source: string | undefined
  /** Postsynaptic id column as the row carries it, before any flip. */
  target: string | undefined
  sourceType?: string | undefined
  targetType?: string | undefined
  orientation: Orientation
  /** Only read when `orientation` is `polarity`. */
  polarity?: string | undefined
  /** Extra columns to split the edge list on — `roi` from `Points in Volumes` is the case. */
  by: readonly string[]
}

/**
 * The three things every reader of a plan has, and nothing else.
 *
 * `InferContext`, `EvalContext` and both emitters' `EmitContext` all carry `params`, `column`
 * and `columns`; naming the three is what lets `readPlan` be one function over all four rather
 * than an overload per context with a cast at three of the call sites.
 */
interface PlanContext {
  params: Readonly<Record<string, unknown>>
  column(paramId: string): string | undefined
  columns(paramId: string): string[]
}

/**
 * The plan as every surface reads it — infer, validate, evaluate and both emitters.
 *
 * Invariant 5's corollary for a node with five column params: a second spelling of this in an
 * emitter would put names in a notebook cell that the run never used.
 */
export function readPlan(ctx: PlanContext): EdgePlan {
  const orientation: Orientation =
    ctx.params[ORIENTATION_PARAM] === 'polarity' ? 'polarity' : 'fixed'
  return {
    source: ctx.column(SOURCE_PARAM),
    target: ctx.column(TARGET_PARAM),
    sourceType: ctx.column(SOURCE_TYPE_PARAM),
    targetType: ctx.column(TARGET_TYPE_PARAM),
    orientation,
    polarity: orientation === 'polarity' ? ctx.column(POLARITY_PARAM) : undefined,
    by: ctx.columns(GROUP_PARAM),
  }
}

/** Names the output owns, which a group column may therefore not take. */
const RESERVED: ReadonlySet<string> = new Set([
  PRE_ID,
  PRE_TYPE,
  POST_ID,
  POST_TYPE,
  WEIGHT_COLUMN,
])

/**
 * The group columns actually used, in the order picked.
 *
 * Two kinds are dropped. A name this node **owns** would appear twice in one schema — and a
 * CAVE synapse cloud really does carry a column called `weight` (the cleft score), so that is
 * the ordinary case rather than a contrived one. And a column already **spent** on an endpoint
 * — the two ids, their two types, and the polarity column where it is what decides the
 * orientation — would either repeat a column the output already carries or, in polarity's case,
 * split every pair in two by the very thing the fold has just used up.
 *
 * Dropped rather than refused, with the node saying so: a picker keeps what somebody chose
 * (`resolveColumns` filters only against the live schema), and emptying it on their behalf is
 * the substitution a column picker is not allowed to make.
 *
 * **This is a post-resolution filter, which `ColumnsParam.excludeIds` records as the wrong
 * shape** — its own note says the first version "left `neuronId` in the dropdown, let somebody
 * pick it and dropped it in silence; reaching the options is the whole point". Named here so the
 * two records point at each other. The mitigation is that `validate` says which names it
 * ignored; the fix is an `exclude` predicate reaching both the options *and* the message, which
 * `excludeIds` would fold into. Hiding them from this picker alone would be worse for the half
 * that is dynamic — a chip vanishing the moment somebody changes `Orientation` or `Presynaptic`,
 * with nothing said.
 */
export function groupColumns(plan: EdgePlan): string[] {
  const spent = new Set(
    [plan.source, plan.target, plan.sourceType, plan.targetType, polarityColumn(plan)].filter(
      (name): name is string => !!name,
    ),
  )
  // The dedupe `droppedGroupColumns` already spells, so the two share one rule rather than
  // agreeing by hand.
  return [...new Set(plan.by)].filter((name) => !RESERVED.has(name) && !spent.has(name))
}

/**
 * The polarity column where it is actually being read, and `undefined` otherwise.
 *
 * One expression, because "live only under the polarity orientation" was a conjunction written
 * out in the fold and again in `groupColumns` — and it is the rule a split column is spent by,
 * so the two disagreeing would silently split every pair in two.
 */
function polarityColumn(plan: EdgePlan): string | undefined {
  return plan.orientation === 'polarity' ? plan.polarity : undefined
}

/** The group columns this plan names that the fold will ignore, for the node's `validate`. */
export function droppedGroupColumns(plan: EdgePlan): string[] {
  const kept = new Set(groupColumns(plan))
  return [...new Set(plan.by)].filter((name) => !kept.has(name))
}

/**
 * The plan intersected with a schema that is actually here — the one line both halves read.
 *
 * A column param cannot hand either half a name the schema lacks (`resolveColumns` filters, and
 * `resolveColumn` answers *off* for an optional picker before it ever reaches rule 2), so this
 * is not defending against the node. It is what stops the two halves being able to disagree:
 * written out twice, the schema would drop an absent `partnerType` and the fold would ask
 * `getColumn` for it and throw, which is invariant 3's failure exactly.
 */
function present(schema: TableSchema, plan: EdgePlan) {
  const has = (name: string | undefined) =>
    name && findColumn(schema, name) ? name : undefined
  return {
    sourceType: has(plan.sourceType),
    targetType: has(plan.targetType),
    // The columns rather than their names: the schema half spreads these straight in, and the
    // fold takes the names off them — picked once instead of picked, named, and picked again.
    by: pickColumns(schema, groupColumns(plan))?.columns ?? [],
  }
}

/**
 * The edge list's schema, from the cloud's attribute schema and the plan.
 *
 * Both id columns are `str` whatever the input said, which is `endpointSchema`'s clause
 * arriving here: these cells are `idText`'s output, and an `i64` declared over an
 * eighteen-digit root id is invariant 8's whole incident. A **type** column is carried whole —
 * dtype and unit — and so is a group column, because those cells are copied through unchanged.
 *
 * Undefined schema in, undefined out: `inferOutputs` may not invent a column list for a port
 * whose schema has not arrived, a picker pointing at a late schema reading exactly like a
 * picker pointing at nothing.
 */
export function synapseEdgesSchema(
  schema: TableSchema | undefined,
  plan: EdgePlan,
): TableSchema | undefined {
  if (!schema) return undefined
  const here = present(schema, plan)
  const carried = (name: string | undefined, as: string): ColumnSchema[] =>
    name ? [{ ...findColumn(schema, name)!, name: as }] : []
  return tableSchema(
    column(PRE_ID, 'str'),
    ...carried(here.sourceType, PRE_TYPE),
    column(POST_ID, 'str'),
    ...carried(here.targetType, POST_TYPE),
    column(WEIGHT_COLUMN, 'i64', 'synapses'),
    ...here.by,
  )
}

/** What the fold hands back beside the table, for the node to warn from. */
interface SynapseEdges {
  table: TableValue
  /** Rows whose presynaptic or postsynaptic cell held no usable id, and were not counted. */
  dropped: number
  /**
   * Rows whose polarity cell read neither `pre` nor `post`, under the polarity orientation.
   *
   * Counted rather than refused, and they are **not flipped** — which is the safe direction: an
   * unreadable cell leaves the row saying what the pickers say it says. Zero under the fixed
   * orientation, where nothing is read.
   */
  unoriented: number
}

/**
 * Why this plan describes no edge list, or `undefined`.
 *
 * **One sentence, four renderers** — `validate`, `evaluate` and both emitters —
 * `kindClashMessage`'s rule and `columnClash`'s after it: written out at each layer it drifts
 * immediately, and a reader who meets the card's wording and then the notebook's has no way to
 * tell they are one complaint. Written out four times here it had already drifted inside the
 * change that introduced it: three different remedies for one refusal, and the useful one — the
 * node that actually fixes it — on only one of them.
 *
 * `undefined` for an unwired card, and that falls out rather than being guarded: a required
 * picker whose schema has not arrived answers its declared default (`resolveColumn`'s last
 * clause), so the two ends read `neuronId` and `partnerId` and differ.
 */
const MISSING_ENDS = 'Pick the presynaptic and the postsynaptic id column.'

export function edgePlanRefusal(plan: EdgePlan): string | undefined {
  if (!plan.source || !plan.target) return MISSING_ENDS
  if (plan.source !== plan.target) return undefined
  return (
    `Presynaptic and postsynaptic both read "${plan.source}", so every edge would be a ` +
    'self-loop. A Synapses cloud from neuPrint or CATMAID carries no partner column at all; ' +
    'Synapses Between binds both ends at the server and does.'
  )
}

/**
 * A polarity cell as the fold reads it: `pre`, `post`, or `''` for one it cannot read.
 *
 * One normalisation, because the loop asks two questions of the same cell — *can* this be read,
 * and does it mean flip — and a predicate each trimmed and lowered it twice per row.
 */
function polarityOf(cell: CellValue | undefined): string {
  // The shape every source publishes, answered without touching the string.
  if (cell === 'pre' || cell === 'post') return cell
  return typeof cell === 'string' ? cell.trim().toLowerCase() : ''
}

/**
 * One pass: orient every row, then count rows per (pre, post, …extras).
 *
 * Insertion order out, which is `groupByTable`'s — first appearance of a pair, so a sorted
 * cloud produces a sorted edge list and nothing has to be sorted to be reproducible.
 *
 * A type is the **first non-null** seen for that pair, `labelsByNeuron`'s rule: the value is
 * functionally determined by the id on every cloud a source produces, so the only case this
 * decides is a body whose type is null in some rows and present in others, where carrying the
 * name beats carrying the absence.
 */
export function synapseEdgesTable(attributes: TableValue, plan: EdgePlan): SynapseEdges {
  // Said at both layers on purpose, and in one sentence: `validate` marks the card, and a graph
  // stored with this already set must not run and hand back a connectome of self-loops. The ends
  // are checked first because that is also the narrowing the reads below need — property
  // narrowing on a parameter survives the call between.
  if (!plan.source || !plan.target) throw new Error(MISSING_ENDS)
  const refusal = edgePlanRefusal(plan)
  if (refusal !== undefined) throw new Error(refusal)
  // `getColumn` throws naming the column and listing what the table has, which is
  // `resolveColumn`'s bargain: a loud failure about the column you picked.
  const sourceData = getColumn(attributes, plan.source)
  const targetData = getColumn(attributes, plan.target)
  const here = present(attributes.schema, plan)
  const sourceTypeData = here.sourceType ? getColumn(attributes, here.sourceType) : undefined
  const targetTypeData = here.targetType ? getColumn(attributes, here.targetType) : undefined
  // Names off the columns `present` picked, rather than a second pick by name.
  const byNames = here.by.map((col) => col.name)
  const byData = byNames.map((name) => getColumn(attributes, name))
  const reading = polarityColumn(plan)
  const polarityData = reading ? getColumn(attributes, reading) : undefined

  interface Bucket {
    pre: string
    post: string
    preType: CellValue
    postType: CellValue
    /** The row this pair first appeared in — every split column is constant across the group. */
    row: number
    weight: number
  }
  const buckets = new Map<string, Bucket>()
  let dropped = 0
  let unoriented = 0

  for (let i = 0; i < attributes.length; i++) {
    let flip = false
    if (polarityData) {
      const polarity = polarityOf(polarityData[i])
      if (polarity === 'pre' || polarity === 'post') flip = polarity === 'post'
      else unoriented += 1
    }
    const pre = idText(flip ? targetData[i] : sourceData[i])
    const post = idText(flip ? sourceData[i] : targetData[i])
    if (pre === null || post === null) {
      dropped += 1
      continue
    }
    // `rowKey`'s own separator, so the two ids cannot be read as one — `("1", "23")` and
    // `("12", "3")` stay two pairs. One form for both cases: `rowKey([], i)` is empty, so with no
    // split columns this is a constant trailing separator, which no pair can collide across.
    const key = `${pre}${KEY_SEPARATOR}${post}${KEY_SEPARATOR}${rowKey(byData, i)}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { pre, post, preType: null, postType: null, row: i, weight: 0 }
      buckets.set(key, bucket)
    }
    bucket.weight += 1
    if (sourceTypeData && bucket.preType === null) {
      bucket.preType = (flip ? targetTypeData : sourceTypeData)?.[i] ?? null
    }
    if (targetTypeData && bucket.postType === null) {
      bucket.postType = (flip ? sourceTypeData : targetTypeData)?.[i] ?? null
    }
  }

  // Non-null by construction: `attributes.schema` is a schema, which is the only thing
  // `synapseEdgesSchema` answers `undefined` for.
  const schema = synapseEdgesSchema(attributes.schema, plan)!
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []
  for (const bucket of buckets.values()) {
    data[PRE_ID]!.push(bucket.pre)
    // Asked of the same `present` result the schema half read, rather than of the columns it
    // produced: two readings of one fact is what `present` exists to prevent.
    if (sourceTypeData) data[PRE_TYPE]!.push(bucket.preType)
    data[POST_ID]!.push(bucket.post)
    if (targetTypeData) data[POST_TYPE]!.push(bucket.postType)
    data[WEIGHT_COLUMN]!.push(bucket.weight)
    for (let k = 0; k < byNames.length; k++) {
      data[byNames[k]!]!.push(byData[k]![bucket.row] ?? null)
    }
  }
  return { table: makeTable(schema, data), dropped, unoriented }
}
