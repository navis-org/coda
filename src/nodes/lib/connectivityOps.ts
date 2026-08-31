/**
 * Multi-hop connectivity traversal, and the pre→post reorientation that goes with it.
 *
 * `DataSource.fetchConnectivity` answers *query-relative*: `neuronId` is the neuron you asked
 * about and `partnerId` is whatever it is wired to, whichever way the arrow points. That is
 * the right shape for the Profile widget — "these are my upstream partners" — and
 * `profileStats.ts` reads it directly, which is why the source contract is left alone.
 *
 * It is the wrong shape for an *edge list*. A `both` result mixes in-edges and out-edges, so
 * `neuronId → partnerId` is no longer a consistent direction of travel and a network built from
 * it draws half its arrows backwards. And past one hop `neuronId` is not "the neuron you asked
 * about" at all — it is whatever the last hop reached.
 *
 * So the node emits `preId`/`postId`: every row is presynaptic → postsynaptic, always, and
 * `direction` records how the traversal found it rather than which way the synapse points.
 * `Build Network` with source `preId` and target `postId` is then correct with no thought,
 * for every combination of params.
 *
 * Headless: no source, no store, no fetch of its own. `traverseConnectivity` takes the
 * per-hop fetch as a callback, which is what makes the BFS testable without a network.
 */

import type { TableSchema } from '../../core/types'
import type { ParamValues } from '../../core/node'
import { column, tableSchema } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'
import { makeTable, tableFromRows } from '../../core/values'
import { idColumn } from './tableOps'
import { ID_COLUMN_NAME, compareIds, idText } from '../../core/ids'
import type { NeuronId } from '../../core/ids'
import type { ConnectionDirection } from '../../data/source'
import { CONNECTIVITY_ROI_COLUMN } from '../../data/source'

/** What the node's `direction` param can be. `both` is not a `ConnectionDirection`. */
export type TraversalDirection = ConnectionDirection | 'both'

/**
 * How the traversal reached an edge, in the `direction` column.
 *
 * `both` means *both endpoints were at the same distance* — reached from each end at the same
 * hop. On a seed set that is exactly the set of edges internal to it, which is the question
 * worth being able to ask. An edge re-found at a later hop keeps the direction it was given
 * when it was first discovered; otherwise the label would drift with traversal order rather
 * than saying anything about the graph.
 */
export type EdgeDirection = 'downstream' | 'upstream' | 'both'

export const PRE_ID = 'preId'
export const PRE_TYPE = 'preType'
export const POST_ID = 'postId'
export const POST_TYPE = 'postType'
export const HOP_COLUMN = 'hop'
export const DIRECTION_COLUMN = 'direction'
/** The fraction: `weight / weightTotal`, or null where the denominator is not known. */
const NORM_COLUMN = 'weightNorm'
/**
 * The denominator, carried per row.
 *
 * Emitted rather than left implicit because it is the whole of what makes a normalised weight
 * readable: the same 0.04 means "4% of what this neuron receives from anything" or "4% of what
 * it receives from reconstructed neurons" depending on a control several rows up the card, and
 * on male-cns those two denominators differ by a factor of two and a half. With the number in
 * the table the reading is checkable without knowing which switch was set.
 */
const NORM_TOTAL_COLUMN = 'weightTotal'

/** Source column → output column, for a row fetched `outputs`-wise (body is presynaptic). */
const DOWNSTREAM_NAMES: Record<string, string> = {
  neuronId: PRE_ID,
  neuronType: PRE_TYPE,
  partnerId: POST_ID,
  partnerType: POST_TYPE,
}

/** The same for an `inputs` row, where the body is the *post*synaptic end. */
const UPSTREAM_NAMES: Record<string, string> = {
  neuronId: POST_ID,
  neuronType: POST_TYPE,
  partnerId: PRE_ID,
  partnerType: PRE_TYPE,
}

function renamesFor(direction: ConnectionDirection): Record<string, string> {
  return direction === 'outputs' ? DOWNSTREAM_NAMES : UPSTREAM_NAMES
}

/** What the optional columns depend on. Read identically by `inferOutputs` and `evaluate`. */
export interface OutputShape {
  /** One row per (pair, region), with `roi` naming it. */
  splitByRoi?: boolean
  /** Append `weightNorm` and the denominator it was computed against. */
  normalize?: boolean
}

/**
 * The node's output schema, derived from the source's connectivity schema.
 *
 * Derived rather than restated so a source carrying extra connectivity columns keeps them —
 * only the four query-relative names are renamed, and the traversal columns are appended.
 * Both `inferOutputs` and `evaluate` go through this, which is invariant 3: the schema half
 * and the value half of an op are written together or they drift.
 *
 * `hop` and `direction` are present whatever the params say. A schema that gained and lost
 * columns as Hops moved between 1 and 2 would silently clear every downstream column picker
 * pointing at them.
 *
 * **The three optional columns are the deliberate exception to that rule**, and the difference
 * is that each has a control of its own. `hop` is meaningful at one hop — it reads 1 — so there
 * was never a reason to drop it; `roi` on an unsplit result would be a column of nulls, and
 * `weightNorm` on an un-normalised one a column of nulls that a chart would happily plot as
 * zeroes. A picker clearing when somebody turns Split by region off is that switch doing what
 * it says, which is not the silent case the rule is about.
 */
export function connectivityOutputSchema(
  source: TableSchema | undefined,
  shape: OutputShape = {},
): TableSchema {
  const columns = (source?.columns ?? []).map((col) => {
    const renamed = DOWNSTREAM_NAMES[col.name]
    return renamed ? { ...col, name: renamed } : col
  })
  return tableSchema(
    ...columns,
    ...(shape.splitByRoi ? [column(CONNECTIVITY_ROI_COLUMN, 'str')] : []),
    column(HOP_COLUMN, 'i64'),
    column(DIRECTION_COLUMN, 'str'),
    ...(shape.normalize
      ? [column(NORM_COLUMN, 'f64'), column(NORM_TOTAL_COLUMN, 'i64', 'synapses')]
      : []),
  )
}

/** One hop's worth of fetching, in one direction. Injected so the BFS stays headless. */
export type HopFetch = (
  neuronIds: NeuronId[],
  direction: ConnectionDirection,
) => Promise<TableValue>

export interface TraverseOptions {
  /** Neuron ids to start from. Never re-expanded; an edge back into them is still reported. */
  seeds: readonly NeuronId[]
  direction: TraversalDirection
  /** ≥ 1. 1 is direct partners and issues exactly the queries this node always has. */
  hops: number
  /** Output schema, from `connectivityOutputSchema`. */
  schema: TableSchema
  fetch: HopFetch
  /** Called before each round, so a node can report progress that moves. */
  onHop?: (hop: number, hops: number, frontier: number) => void
  signal?: AbortSignal
}

interface EdgeRow {
  values: Record<string, CellValue>
  hop: number
  direction: EdgeDirection
  weight: number
  preId: string
  postId: string
  /** '' when the result is not split by region, which is also its position in the sort. */
  roi: string
}

/**
 * Breadth-first expansion over synaptic partners.
 *
 * Each round asks the source for the frontier's partners and keeps every edge that comes
 * back; the *neurons* on the far end become the next frontier unless they have been expanded
 * already. `minWeight` does the pruning, because it is applied by the source — an edge below
 * it is never returned, so it is neither a row nor a reason to expand. That is the only
 * throttle here: three hops at weight 1 is a genuinely large question and is asked as one.
 *
 * With `both`, every hop expands both ways from every neuron reached — the undirected ball,
 * not two independent cones. That is what finds the neurons sharing input with a seed (up
 * then down) and its co-inputs (down then up), which is usually the point of asking.
 *
 * Edges are deduplicated on (pre, post, region). They have to be: with `both`, an edge inside
 * the frontier comes back from each end, and `Build Network` sums the weight of every row
 * joining a pair — so a duplicate is not untidy, it is a doubled synapse count. The region is
 * part of the key rather than an afterthought: a split result holds several legitimate rows per
 * pair, and keying on the pair alone would keep whichever region arrived first and silently
 * discard the rest of the connection.
 */
export async function traverseConnectivity(opts: TraverseOptions): Promise<TableValue> {
  const hops = Math.max(1, Math.floor(opts.hops))
  const directions: ConnectionDirection[] =
    opts.direction === 'both' ? ['outputs', 'inputs'] : [opts.direction]

  const edges = new Map<string, EdgeRow>()
  const expanded = new Set<string>(opts.seeds)
  let frontier = [...new Set(opts.seeds)]

  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    opts.onHop?.(hop, hops, frontier.length)
    const next = new Set<string>()

    for (const direction of directions) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const table = await opts.fetch(frontier, direction)
      collect(table, direction, hop, edges, expanded, next)
    }

    for (const id of next) expanded.add(id)
    frontier = [...next]
  }

  /*
   * Nearest first, then strongest. The source orders one hop by weight; merged rounds need an
   * order of their own, and hop-then-weight is what a reader of the table wants. Ids break the
   * tie so the row order is deterministic — the result is not in a cache key, but a table that
   * reshuffles between identical runs makes every downstream diff unreadable.
   */
  const sorted = [...edges.values()].sort(
    (a, b) =>
      a.hop - b.hop ||
      b.weight - a.weight ||
      compareIds(a.preId, b.preId) ||
      compareIds(a.postId, b.postId) ||
      // Region last, and only ever a tie-break: a split pair's rows are otherwise ordered by
      // their own weight like everything else, and two regions of equal weight on one pair
      // would leave the row order to `Map` insertion, which is the fetch order.
      a.roi.localeCompare(b.roi),
  )

  return tableFromRows(
    opts.schema,
    sorted.map((edge) => ({
      ...edge.values,
      [HOP_COLUMN]: edge.hop,
      [DIRECTION_COLUMN]: edge.direction,
    })),
  )
}

/** Fold one fetched table into the accumulator, reoriented pre→post. */
function collect(
  table: TableValue,
  direction: ConnectionDirection,
  hop: number,
  edges: Map<string, EdgeRow>,
  expanded: Set<string>,
  next: Set<string>,
): void {
  const names = renamesFor(direction)
  const found: EdgeDirection = direction === 'outputs' ? 'downstream' : 'upstream'
  const columns = table.schema.columns.map((col) => ({
    from: col.name,
    to: names[col.name] ?? col.name,
    data: table.data[col.name] ?? [],
  }))
  const neuronIds = table.data['neuronId'] ?? []
  const partnerIds = table.data['partnerId'] ?? []
  const weights = table.data['weight'] ?? []
  // Absent unless the source was asked to split, in which case it is present on every row —
  // `connectivitySchemaWithRoi` is what puts it there, so this is not a per-row question.
  const rois = table.data[CONNECTIVITY_ROI_COLUMN]
  const rows = neuronIds.length

  for (let row = 0; row < rows; row++) {
    const neuronId = idText(neuronIds[row])
    const partnerId = idText(partnerIds[row])
    if (neuronId === null || partnerId === null) continue

    const preId = direction === 'outputs' ? neuronId : partnerId
    const postId = direction === 'outputs' ? partnerId : neuronId
    const roi = rois ? String(rois[row] ?? '') : ''
    const key = `${preId}\u0000${postId}\u0000${roi}`

    const existing = edges.get(key)
    if (existing) {
      // Only an edge found both ways *at the same distance* is `both`; see EdgeDirection.
      if (existing.hop === hop && existing.direction !== found) existing.direction = 'both'
    } else {
      const values: Record<string, CellValue> = {}
      for (const col of columns) values[col.to] = col.data[row] ?? null
      const weight = Number(weights[row])
      edges.set(key, {
        values,
        hop,
        direction: found,
        weight: Number.isFinite(weight) ? weight : 0,
        preId,
        postId,
        roi,
      })
    }

    if (!expanded.has(partnerId)) next.add(partnerId)
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Which end of the edge the denominator belongs to.
 *
 * Named for the *neuron* rather than for the direction, because the direction word is already
 * spoken for twice on this node — `direction` is the traversal param and `EdgeDirection` is the
 * column — and a third reading of "inputs" would be a third thing it could mean.
 *
 * `postsynaptic` divides by everything the receiving neuron takes in, so the number answers
 * "how much of this neuron's input comes from that one". `presynaptic` divides by everything the
 * sending neuron puts out, answering "how much of this neuron's output goes there". They are not
 * two views of one quantity: on male-cns body 10005 the same connection is 1.2% of the target's
 * input and 0.7% of the source's output.
 */
export type NormalizeBy = 'postsynaptic' | 'presynaptic'

/** The id column a denominator is looked up by, for each end. */
function normalizeIdColumn(by: NormalizeBy): string {
  return by === 'postsynaptic' ? POST_ID : PRE_ID
}

/**
 * The distinct neurons a normalisation needs a total for.
 *
 * Taken from the *result* rather than from the seeds, and that is the whole reason this is a
 * separate step: past one hop the neuron on the relevant end of a row is generally not one of
 * the neurons anybody asked about, and at one hop with `direction: outputs` it is every partner
 * that came back. Distinct, in first-appearance order, so a batched fetch is reproducible.
 */
export function normalizeTargets(table: TableValue, by: NormalizeBy): NeuronId[] {
  // `new Set(idColumn(...))`, the idiom `partnerVectors` already uses: `idColumn` is the one
  // place that reads a cell as an id (invariant 8), and the Set is first-appearance order, so a
  // batched fetch is reproducible.
  return [...new Set(idColumn(table, normalizeIdColumn(by)))]
}

export interface NormalizeResult {
  table: TableValue
  /** Rows left with a null `weightNorm` because no denominator was found. */
  missingRows: number
  /** Distinct neurons behind `missingRows` — the number worth putting in a warning. */
  missingNeurons: number
}

/**
 * Append `weightNorm` and `weightTotal`, given the denominators.
 *
 * Takes the totals as a map rather than fetching them, which is what keeps this testable with no
 * source and no network — `traverseConnectivity`'s arrangement, one step along.
 *
 * **A missing or zero denominator produces null, never a number.** Both cases are real: a
 * partner the source has never heard of has no total at all, and a neuron with no synapses on
 * the relevant side totals zero. Substituting anything would be arithmetic on an unknown —
 * a zero denominator divides to `Infinity`, which every downstream chart renders as a bar off
 * the top of the axis, and a zero *result* would read as "this connection is a negligible
 * fraction" when what happened is that nothing was measured. The count comes back so the node
 * can say how many rows it happened to.
 *
 * **The fraction can exceed 1, legitimately.** Under the `connected` basis the denominator counts
 * only synapses onto partners the dataset calls neurons, while a row's weight is whatever the
 * connection carries — so a connection to a fragment is a numerator with no matching term below.
 * Clamping would hide exactly the case somebody normalising across datasets needs to see.
 */
export function normalizeConnectivity(
  table: TableValue,
  by: NormalizeBy,
  totals: ReadonlyMap<NeuronId, number>,
  schema: TableSchema,
): NormalizeResult {
  const ids = table.data[normalizeIdColumn(by)] ?? []
  const weights = table.data['weight'] ?? []
  const norm: CellValue[] = []
  const denominators: CellValue[] = []
  const missing = new Set<NeuronId>()
  let missingRows = 0

  for (let row = 0; row < table.length; row++) {
    const id = idText(ids[row])
    const total = id === null ? undefined : totals.get(id)
    if (total === undefined || !(total > 0)) {
      if (id !== null) missing.add(id)
      missingRows++
      norm.push(null)
      denominators.push(total ?? null)
      continue
    }
    const weight = Number(weights[row])
    norm.push(Number.isFinite(weight) ? weight / total : null)
    denominators.push(total)
  }

  return {
    // The existing column arrays are reused rather than copied: `traverseConnectivity` has just
    // built them and nothing else holds this table yet, so a second pass over every column would
    // be an allocation of the whole result to add two.
    table: makeTable(schema, {
      ...table.data,
      [NORM_COLUMN]: norm,
      [NORM_TOTAL_COLUMN]: denominators,
    }),
    missingRows,
    missingNeurons: missing.size,
  }
}

/**
 * The denominators, as a lookup keyed the way every id in this file is keyed.
 *
 * `idText` on both sides — invariant 8. The totals table publishes its ids in the *source's*
 * dtype, which is `i64` on neuPrint and `str` elsewhere, and a lookup that compared a number to
 * a string would miss every row while looking like a dataset with no totals.
 */
export function totalsLookup(table: TableValue): Map<NeuronId, number> {
  const ids = table.data[ID_COLUMN_NAME] ?? []
  const totals = table.data['total'] ?? []
  const lookup = new Map<NeuronId, number>()
  for (let row = 0; row < table.length; row++) {
    const id = idText(ids[row])
    const total = Number(totals[row])
    if (id !== null && Number.isFinite(total)) lookup.set(id, total)
  }
  return lookup
}

// ---------------------------------------------------------------------------
// Reading the region params
// ---------------------------------------------------------------------------

/**
 * The region controls, decoded once for everyone who asks.
 *
 * Five readers across three layers — the node's `evaluate`, two of its `visibleIf`s, its
 * `validate`, and both export emitters — and written per caller they had already disagreed:
 * the R emitter tested `rois.length > 0` without filtering empty strings, so a stored
 * `rois: ['']` refused there and was a no-op in the node and the notebook.
 *
 * `primaryOnly` is the reading that most needs one home. `!== false` is the node's claim about
 * what an **absent** key means on a stored document — the third state `ParamBase.absentMeans`
 * describes — and a second copy of it in a module nobody edits alongside the node is how that
 * claim comes apart.
 *
 * Headless and in `nodes/lib` rather than on the node, because the exporters import from here
 * and must not pull a node definition in; the same route `readUnpivotSpec` and `decodeRenames`
 * already take.
 */
export interface RegionOptions {
  /** Explicitly chosen regions. Empty means the node decides — see `evaluate`. */
  rois: string[]
  splitByRoi: boolean
  primaryOnly: boolean
  /** Whether any region control is doing something. Both idle is every pre-existing graph. */
  used: boolean
  /**
   * Whether the regions in play can contain one another, so a split repeats synapses rather
   * than taking a connection apart.
   *
   * One predicate rather than two: `validate` says it on the card and `evaluate` says it again
   * at run time, because it changes what the numbers mean and only one of those two surfaces is
   * seen by whoever pressed Run. Written per surface, the pair had already drifted — the card
   * warned about an explicitly picked nesting set and the run did not.
   */
  mayNest: boolean
}

export function regionOptions(params: ParamValues): RegionOptions {
  const rois = Array.isArray(params.rois)
    ? params.rois.filter((v): v is string => typeof v === 'string' && v !== '')
    : []
  const splitByRoi = params.splitByRoi === true
  const primaryOnly = params.primaryRoisOnly !== false
  return {
    rois,
    splitByRoi,
    primaryOnly,
    used: splitByRoi || rois.length > 0,
    mayNest: splitByRoi && !primaryOnly,
  }
}

/** `MultiEnumParam.visibleIf` and `BooleanParam.visibleIf` both want exactly this. */
export function usesRegions(params: ParamValues): boolean {
  return regionOptions(params).used
}
