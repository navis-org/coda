/**
 * Multi-hop connectivity traversal, and the pre→post reorientation that goes with it.
 *
 * `DataSource.fetchConnectivity` answers *query-relative*: `bodyId` is the neuron you asked
 * about and `partnerId` is whatever it is wired to, whichever way the arrow points. That is
 * the right shape for the Profile widget — "these are my upstream partners" — and
 * `profileStats.ts` reads it directly, which is why the source contract is left alone.
 *
 * It is the wrong shape for an *edge list*. A `both` result mixes in-edges and out-edges, so
 * `bodyId → partnerId` is no longer a consistent direction of travel and a network built from
 * it draws half its arrows backwards. And past one hop `bodyId` is not "the neuron you asked
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
import { column, tableSchema } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { compareIds, idText } from '../../core/ids'
import type { NeuronId } from '../../core/ids'
import type { ConnectionDirection } from '../../data/source'

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

/** Source column → output column, for a row fetched `outputs`-wise (body is presynaptic). */
const DOWNSTREAM_NAMES: Record<string, string> = {
  bodyId: PRE_ID,
  bodyType: PRE_TYPE,
  partnerId: POST_ID,
  partnerType: POST_TYPE,
}

/** The same for an `inputs` row, where the body is the *post*synaptic end. */
const UPSTREAM_NAMES: Record<string, string> = {
  bodyId: POST_ID,
  bodyType: POST_TYPE,
  partnerId: PRE_ID,
  partnerType: PRE_TYPE,
}

function renamesFor(direction: ConnectionDirection): Record<string, string> {
  return direction === 'outputs' ? DOWNSTREAM_NAMES : UPSTREAM_NAMES
}

/**
 * The node's output schema, derived from the source's connectivity schema.
 *
 * Derived rather than restated so a source carrying extra connectivity columns keeps them —
 * only the four query-relative names are renamed, and the two traversal columns are appended.
 * Both `inferOutputs` and `evaluate` go through this, which is invariant 3: the schema half
 * and the value half of an op are written together or they drift.
 *
 * `hop` and `direction` are present whatever the params say. A schema that gained and lost
 * columns as Hops moved between 1 and 2 would silently clear every downstream column picker
 * pointing at them.
 */
export function connectivityOutputSchema(source: TableSchema | undefined): TableSchema {
  const columns = (source?.columns ?? []).map((col) => {
    const renamed = DOWNSTREAM_NAMES[col.name]
    return renamed ? { ...col, name: renamed } : col
  })
  return tableSchema(...columns, column(HOP_COLUMN, 'i64'), column(DIRECTION_COLUMN, 'str'))
}

/** One hop's worth of fetching, in one direction. Injected so the BFS stays headless. */
export type HopFetch = (
  bodyIds: NeuronId[],
  direction: ConnectionDirection,
) => Promise<TableValue>

export interface TraverseOptions {
  /** Body ids to start from. Never re-expanded; an edge back into them is still reported. */
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
 * Edges are deduplicated on (pre, post). They have to be: with `both`, an edge inside the
 * frontier comes back from each end, and `Build Network` sums the weight of every row joining
 * a pair — so a duplicate is not untidy, it is a doubled synapse count.
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
      compareIds(a.postId, b.postId),
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
  const bodyIds = table.data['bodyId'] ?? []
  const partnerIds = table.data['partnerId'] ?? []
  const weights = table.data['weight'] ?? []
  const rows = bodyIds.length

  for (let row = 0; row < rows; row++) {
    const bodyId = idText(bodyIds[row])
    const partnerId = idText(partnerIds[row])
    if (bodyId === null || partnerId === null) continue

    const preId = direction === 'outputs' ? bodyId : partnerId
    const postId = direction === 'outputs' ? partnerId : bodyId
    const key = `${preId}\u0000${postId}`

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
      })
    }

    if (!expanded.has(partnerId)) next.add(partnerId)
  }
}
