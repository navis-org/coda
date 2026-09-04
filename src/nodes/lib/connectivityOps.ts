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
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { makeTable, tableFromRows } from '../../core/values'
import { idColumn } from './tableOps'
import { ID_COLUMN_NAME, compareIds, idText } from '../../core/ids'
import type { NeuronId } from '../../core/ids'
import type { ConnectionDirection, SynapseTotalsBasis } from '../../data/source'
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

/** The name the `Neuron Set` port gives the type it carries over from the edge list. */
const ENDPOINT_TYPE_COLUMN = 'type'
/** The source-relative name `connectivityOutputSchema` renames to `preType`/`postType`. */
const SOURCE_TYPE_COLUMN = 'neuronType'

/**
 * The schema of the neurons an edge list is *about*: `neuronId` and `type`.
 *
 * Derived from the same source connectivity schema `connectivityOutputSchema` reads, and both
 * columns are carried over **whole** — dtype and unit included, renamed and nothing else. That is
 * what keeps a CAVE root id a `str` here exactly as it is in `preId`, and it is the reason this
 * takes the connectivity schema rather than the neuron one: the values this table holds are the
 * cells of `preId`/`postId`, so its declared dtype has to be theirs. Taking the dataset's own
 * `neurons` schema would declare an `i64` over cells that are text on half the backends.
 *
 * Two columns and no more. `hop` looks derivable and is not: `traverseConnectivity` records the
 * hop an *edge* was found at, and which of its two ends was the frontier is only knowable on the
 * first round — `partnerVectors.ts` records the same limit about `direction`. A per-neuron
 * distance column would be right at hop 1 and quietly wrong past it.
 */
export function endpointSchema(source: TableSchema | undefined): TableSchema {
  const columns = source?.columns ?? []
  const id = columns.find((c) => c.name === ID_COLUMN_NAME) ?? column(ID_COLUMN_NAME, 'i64')
  const type =
    columns.find((c) => c.name === SOURCE_TYPE_COLUMN) ?? column(ENDPOINT_TYPE_COLUMN, 'str')
  return tableSchema(id, { ...type, name: ENDPOINT_TYPE_COLUMN })
}

/**
 * The distinct neurons an edge list touches, seeds first, as a `Neurons` table.
 *
 * **The seeds are in it, and that is the half a downstream transform could not do.** Both ends of
 * a hop-1 edge list already cover every seed that had a partner above `minWeight`; a seed that had
 * none disappears from it entirely. Only this node holds both the seed set and the result, so only
 * here can the port mean "the neurons this result is about" rather than "the ones that turned out
 * to be wired". They come first, in the order they were asked about, and the partners follow in
 * first-appearance order — deterministic either way, which invariant 4 needs of anything that
 * reaches a provenance key.
 *
 * **Cells are copied, never rebuilt.** An id goes in as the very cell it came out of, so nothing
 * here parses, rounds or re-renders one — invariant 8's failure mode is a `Number()` on an
 * 18-digit root id, and the way to not have it is to not convert. `idText` is used for the
 * *key* only, which is what makes a seed table carrying `i64` cells match a `str` edge list.
 *
 * A neuron reached as both a pre and a post end gets **one** row. The first non-empty type wins,
 * `labelsByNeuron`'s rule: an edge list that disagrees with itself about a neuron's type is not
 * grounds to prefer whichever copy came last.
 */
export function endpointNeurons(
  connections: TableValue,
  schema: TableSchema,
  seeds?: TableValue,
): TableValue {
  const ids: ColumnData = []
  const types: ColumnData = []
  const rowOf = new Map<NeuronId, number>()

  const add = (cell: CellValue, type: CellValue) => {
    const id = idText(cell)
    if (id === null) return
    const row = rowOf.get(id)
    if (row === undefined) {
      rowOf.set(id, ids.length)
      ids.push(cell)
      types.push(type)
      return
    }
    const held = types[row]
    if (held === null || held === undefined || held === '') types[row] = type
  }

  if (seeds) {
    // Read off `data` rather than through `getColumn`, which throws: a seed table is whatever
    // somebody wired, and `Input IDs` unwired emits ids and no type at all.
    const seedIds = seeds.data[ID_COLUMN_NAME]
    const seedTypes = seeds.data[ENDPOINT_TYPE_COLUMN]
    if (seedIds) {
      for (let i = 0; i < seeds.length; i++) add(seedIds[i] ?? null, seedTypes?.[i] ?? null)
    }
  }

  const pre = connections.data[PRE_ID]
  const preType = connections.data[PRE_TYPE]
  const post = connections.data[POST_ID]
  const postType = connections.data[POST_TYPE]
  for (let i = 0; i < connections.length; i++) {
    if (pre) add(pre[i] ?? null, preType?.[i] ?? null)
    if (post) add(post[i] ?? null, postType?.[i] ?? null)
  }

  return makeTable(schema, { [ID_COLUMN_NAME]: ids, [ENDPOINT_TYPE_COLUMN]: types }, 'neurons')
}

/**
 * The endpoint list wearing the dataset's neuron columns — a **left** join, not a lookup result.
 *
 * `findNeurons` answers only about bodies the dataset calls a neuron, and a synaptic partner very
 * often is not one: on `male-cns:v1.0`, five LC4 neurons have 4,252 distinct downstream partners
 * of which 496 carry the `:Neuron` label. Returning what came back would make the `Neuron Set`
 * port a different length from the edge list it was derived from, which is the one property the
 * port exists to have — a set you can hand to `Adjacency` and get the graph among *these* neurons.
 *
 * So every derived row survives, in its order, and an unmatched one keeps the two things the edge
 * list already knew: its id, and whatever type the connection carried. The rest of the columns are
 * null, which is the honest answer — nobody published a status for a fragment. That is
 * `joinTables`' rule about the key column ("filled from whichever side had the row") applied to
 * one column more, because here the left side genuinely knows a second thing.
 *
 * The schema is the dataset's own rather than the fetched table's: `inferOutputs` promised that
 * one (invariant 3), and a source returning a column it did not advertise would otherwise land it
 * in a table nothing downstream can see.
 */
export function neuronRowsFor(
  derived: TableValue,
  rows: TableValue,
  schema: TableSchema,
): TableValue {
  const rowOf = new Map<NeuronId, number>()
  const fetchedIds = rows.data[ID_COLUMN_NAME]
  if (fetchedIds) {
    for (let i = 0; i < rows.length; i++) {
      const id = idText(fetchedIds[i] ?? null)
      // First wins, `firstByKey`'s rule — a lookup that answered twice for one id is not grounds
      // to prefer the later row.
      if (id !== null && !rowOf.has(id)) rowOf.set(id, i)
    }
  }

  const derivedIds = derived.data[ID_COLUMN_NAME] ?? []
  const derivedTypes = derived.data[ENDPOINT_TYPE_COLUMN]
  const data: Record<string, ColumnData> = {}
  /*
   * Source and destination resolved once per column rather than once per cell. The schema can be
   * fifty columns wide — that is measured, not hypothetical: `male-cns:v1.0` publishes fifty —
   * and the endpoint list runs to thousands, so the two `data[name]` lookups this removes were
   * being paid a hundred thousand times per run.
   */
  const plan = schema.columns.map((col) => {
    const out: ColumnData = []
    data[col.name] = out
    return {
      out,
      src: rows.data[col.name],
      /** The two the edge list already knew, so the join can fill them from the left. */
      known:
        col.name === ID_COLUMN_NAME ? 'id' : col.name === ENDPOINT_TYPE_COLUMN ? 'type' : '',
    }
  })

  for (let i = 0; i < derived.length; i++) {
    const at = rowOf.get(idText(derivedIds[i] ?? null) ?? '')
    for (const col of plan) {
      // `neuronId` unconditionally, so the id is never the cell the lookup failed to return;
      // `type` only where nothing came back, so a dataset publishing a better one still wins.
      if (col.known === 'id') {
        col.out.push(derivedIds[i] ?? null)
        continue
      }
      const cell: CellValue = at === undefined ? null : (col.src?.[at] ?? null)
      col.out.push(cell === null && col.known === 'type' ? (derivedTypes?.[i] ?? null) : cell)
    }
  }

  return makeTable(schema, data, 'neurons')
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
  /**
   * Which of the neurons a round reached the dataset actually **publishes**.
   *
   * Absent means every partner is kept, which is what this traversal did before the `Include
   * fragments` control existed and is still what that box ticked asks for.
   *
   * Present, it is asked once per hop with the ids that round reached for the first time, and its
   * answer decides two things at once: which edges survive, and what the next hop expands. That
   * pairing is the point. A connectivity query matches its far end as a bare node, so on
   * `male-cns:v1.0` five LC4 neurons reach 4,252 distinct downstream partners of which 496 are
   * published neurons — expanding the other 3,756 is a hop-2 frontier nine times larger than the
   * question deserves.
   *
   * **The seeds are exempt.** They were named explicitly, and dropping every edge of a body
   * somebody pasted in because the dataset does not publish it would be the same substitution
   * `Input IDs` refuses when it declines to apply a status filter.
   *
   * An edge survives only if **both** ends are kept. Either end alone leaves a row whose other
   * half is a body nothing downstream can look up — and with `direction: 'both'` an edge can
   * arrive from the unpublished side first, so testing only the far end is not the same rule.
   */
  published?: (ids: NeuronId[]) => Promise<Set<NeuronId>>
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
  /** Seeds, plus every id `published` has said yes to. Unread when there is no filter. */
  const kept = new Set<string>(opts.seeds)
  /*
   * "Unfiltered means everything is kept", said once. Written three times inline it was three
   * different spellings of one invariant — a `&&` short-circuit, a ternary, and an absence — and
   * the fourth use of `kept` would have had to rediscover which of them it meant.
   */
  const keep = opts.published ? (id: string) => kept.has(id) : () => true
  let frontier = [...new Set(opts.seeds)]

  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    opts.onHop?.(hop, hops, frontier.length)
    const next = new Set<string>()

    /*
     * The round is accumulated apart from `edges` and merged below, because the filter needs the
     * whole round before it can decide anything: an edge is kept only if both ends are, and with
     * two directions the far end of one is the near end of the other.
     *
     * Within the round the accumulator is the same `Map` the merged one is, so `collect`'s
     * `both`-at-the-same-hop rule still resolves against the other direction — it just resolves
     * inside the round rather than across the whole traversal, which is the only place that rule
     * was ever about.
     */
    const round = new Map<string, EdgeRow>()
    for (const direction of directions) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const table = await opts.fetch(frontier, direction)
      collect(table, direction, hop, round, edges, expanded, next)
    }

    if (opts.published && next.size > 0) {
      // `next` already excludes everything expanded, so nothing is asked about twice.
      for (const id of await opts.published([...next])) kept.add(id)
    }

    for (const [key, edge] of round) {
      if (!keep(edge.preId) || !keep(edge.postId)) continue
      edges.set(key, edge)
    }

    for (const id of next) expanded.add(id)
    // Only a kept neuron is worth expanding: an unpublished body's own partners cannot appear in
    // a result that has just dropped every edge touching it.
    frontier = [...next].filter(keep)
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

/**
 * Fold one fetched table into this round's accumulator, reoriented pre→post.
 *
 * `committed` is what earlier hops already settled, and it is read-only here. An edge in it keeps
 * the hop and direction it was **first** given, so there is nothing for this round to decide about
 * it — which makes materialising its `values` record pure waste, and not a rare one: hop *N*
 * queries hop *N−1*'s partners, so the fetch hands back essentially all of the previous round's
 * edges again, and twice over under `direction: 'both'`.
 *
 * Skipping it cannot lose the `both` upgrade, because that fires only on `existing.hop === hop`
 * and a committed edge is by definition from an earlier one. Same-hop resolution still happens,
 * inside `round`.
 */
function collect(
  table: TableValue,
  direction: ConnectionDirection,
  hop: number,
  edges: Map<string, EdgeRow>,
  committed: ReadonlyMap<string, EdgeRow>,
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

    // Settled by an earlier hop: nothing to decide, and nothing to build. The `next.add` below
    // still runs — a committed edge's far end is still somewhere the walk can go on from.
    if (committed.has(key)) {
      if (!expanded.has(partnerId)) next.add(partnerId)
      continue
    }

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

/**
 * The two normalisation params, decoded once for everyone who asks.
 *
 * `regionOptions`' arrangement and its reason: three nodes read these now — `Connectivity`,
 * `Paths` and, for the vocabulary, the exporters' refusals — and a default written per caller is
 * how two cards come to mean different things by the same stored value. Both fall back rather
 * than throwing, because a stored graph may carry any string at all and neither question has an
 * "invalid" answer worth blocking a run over.
 */
export function readNormalizeBy(raw: unknown): NormalizeBy {
  return raw === 'presynaptic' ? 'presynaptic' : 'postsynaptic'
}

export function readBasis(raw: unknown): SynapseTotalsBasis {
  return raw === 'connected' ? 'connected' : 'all'
}

/** The side of a neuron a denominator counts, given which end it belongs to. */
export function normalizeSide(by: NormalizeBy): ConnectionDirection {
  // `postsynaptic` divides by what the receiving neuron takes *in*: the sides are opposite to
  // the words on the control, and writing that out once is what stops the flip.
  return by === 'postsynaptic' ? 'inputs' : 'outputs'
}

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
