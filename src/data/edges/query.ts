/**
 * Answering connectivity questions from a loaded edge set.
 *
 * Everything here is a walk over the CSR: a neuron's partners are a contiguous run, so a query
 * costs its own degree rather than a scan of the set. No network, no source, and nothing that
 * knows which backend the dataset came from — an edge list is an edge list.
 *
 * What it does **not** hold is cell types. Those come from the dataset's own neuron index, are
 * passed in, and are the one thing an edge set cannot supply: a file of `pre, post, weight` says
 * nothing about what either end is called. That split is deliberate rather than incidental — it
 * is what keeps `neuronType`/`partnerType` agreeing with the annotation chain, which is where
 * every other surface in Coda reads a type from.
 */

import type { NeuronId } from '../../core/ids'
import { ID_COLUMN_NAME } from '../../core/ids'
import type { CellValue, TableValue } from '../../core/values'
import { makeTable, tableFromRows } from '../../core/values'
import type { Edge } from '../connectivity'
import type {
  ConnectionDirection,
  GroupTotalsRequest,
  PathStepRequest,
  SynapseTotalsRequest,
} from '../source'
import { GROUP_TOTALS_SCHEMA, PATH_STEP_SCHEMA, SYNAPSE_TOTALS_SCHEMA } from '../source'
import type { EdgeCsr } from './encode'
import type { LoadedEdgeSet } from './store'

/**
 * Separates the two halves of a group key.
 *
 * Written as an escape rather than typed, for `rowKey`'s stated reason: a raw control character
 * in a source file is invisible to every reader and to `grep`.
 */
const KEY_SEPARATOR = '\u0001'

/** Ids as dictionary indices, dropping the ones this edge set has never heard of. */
function indicesOf(set: LoadedEdgeSet, ids: readonly NeuronId[]): number[] {
  const seen = new Set<number>()
  for (const id of ids) {
    const at = set.index.get(id)
    // A neuron the file does not mention has no edges. That is an answer — an unconnected
    // neuron — rather than a failure, and it is the same answer a backend would give.
    if (at !== undefined) seen.add(at)
  }
  return [...seen]
}

/** Every (partner index, weight) in one neuron's run. */
function walk(csr: EdgeCsr, at: number, visit: (target: number, weight: number) => void): void {
  for (let i = csr.offsets[at]!; i < csr.offsets[at + 1]!; i++) {
    visit(csr.targets[i]!, csr.weights[i]!)
  }
}

/**
 * The connections of `ids` in one direction, oriented presynaptic → postsynaptic.
 *
 * Oriented rather than query-relative, because that is the shape `matrixFromEdges` and
 * `CaveSource` both already speak. The query-relative flip `fetchConnectivity` promises is one
 * line at the funnel, where it sits next to the schema it has to agree with.
 */
export function edgesFrom(
  set: LoadedEdgeSet,
  ids: readonly NeuronId[],
  direction: ConnectionDirection,
  minWeight?: number,
): Edge[] {
  const outward = direction === 'outputs'
  const csr = sideOf(set, direction)
  // Filtered only where a threshold was actually asked for. Defaulting to 0 dropped every
  // *negative* weight — which `narrowWeights` deliberately preserves, because a user's edge list
  // may carry a signed score rather than a synapse count.
  const out: Edge[] = []
  for (const at of indicesOf(set, ids)) {
    const self = set.ids[at]!
    walk(csr, at, (target, weight) => {
      if (minWeight !== undefined && weight < minWeight) return
      const other = set.ids[target]!
      out.push(
        outward ? { pre: self, post: other, weight } : { pre: other, post: self, weight },
      )
    })
  }
  return out
}

/** Every connection from one set to another — the Adjacency node's question. */
export function edgesBetween(
  set: LoadedEdgeSet,
  sourceIds: readonly NeuronId[],
  targetIds: readonly NeuronId[],
): Edge[] {
  const wanted = new Set(indicesOf(set, targetIds))
  const out: Edge[] = []
  for (const at of indicesOf(set, sourceIds)) {
    const pre = set.ids[at]!
    walk(set.out, at, (target, weight) => {
      if (!wanted.has(target)) return
      out.push({ pre, post: set.ids[target]!, weight })
    })
  }
  return out
}

/**
 * Cell type to every neuron carrying it, memoised on the type map's identity.
 *
 * Needed only by the path step, and only in its collapsed mode: a frontier of *types* has to be
 * expanded into the neurons carrying them before any edge can be walked. `typesOf` hands back
 * one stable Map per neuron index, so this is built once per dataset per session rather than
 * once per hop — which on a three-hop both-directions traversal is six times.
 */
const membersCache = new WeakMap<Map<NeuronId, string>, Map<string, NeuronId[]>>()

function membersOf(types: Map<NeuronId, string>): Map<string, NeuronId[]> {
  const held = membersCache.get(types)
  if (held) return held
  const members = new Map<string, NeuronId[]>()
  for (const [id, type] of types) {
    const list = members.get(type)
    if (list) list.push(id)
    else members.set(type, [id])
  }
  membersCache.set(types, members)
  return members
}

/**
 * One aggregated row.
 *
 * A `type` rather than an `interface` so it is assignable to `tableFromRows`' row record:
 * TypeScript gives a type alias an implicit index signature and an interface none. The same
 * rule `src/pyodide/types.ts` records for a value crossing the Pyodide bridge, and it fails
 * with a message about the index signature rather than about the shape.
 */
type StepGroup = {
  source: string
  sourceType: string | null
  sourceId: NeuronId | null
  target: string
  targetType: string | null
  targetId: NeuronId | null
  weight: number
  pairs: number
  sourceNeurons: number
  targetNeurons: number
}

/**
 * One group mid-aggregation: the row, and the two sets a row cannot hold.
 *
 * Sets rather than counters because distinctness is the whole question — `pairs` already counts
 * connections, and 60 LC4s onto 8 PLP1s is the case where the two numbers come apart. They are
 * dropped the moment the row is written, so nothing past this function holds a member list.
 */
interface StepAccumulator {
  row: StepGroup
  pre: Set<NeuronId>
  post: Set<NeuronId>
}

/**
 * One hop, aggregated — the `fetchPathStep` contract, answered locally.
 *
 * A faithful port of `pathStepCypher` rather than an independent design, and the fidelity is the
 * point: the Paths node traverses whatever this returns, so a rule that differs here finds
 * different routes on an edge set than on the backend, with nothing to say so. Three of them are
 * worth naming because each reads as a detail:
 *
 *  - **The frontier is the union** of the requested types and the requested ids, not one or the
 *    other. A collapsed traversal sends types for the neurons that have one and ids for those
 *    that do not, in the same request.
 *  - **An untyped neuron is its own group**, keyed by its id — `coalesce(type, toString(bodyId))`
 *    exactly. Merging them into a "null" bucket puts a fictitious node in the middle of the
 *    graph and then routes through it.
 *  - **The weight cut is applied after the sum.** At type level the threshold is a statement
 *    about traffic between two populations, and cutting each pair first discards the many weak
 *    connections that are precisely what adds up to a strong pathway.
 *
 * The ids go out as **text**, which is what an edge set has always held: it is keyed by whatever
 * the file said, and an eighteen-digit id in an `i64` column is a different neuron. This used to
 * be the one caller asking `pathStepSchema` for the `str` reading while every other source took
 * `i64`; every source publishes text now, so the schema is a constant and this is simply it.
 */
export function pathStepFrom(
  set: LoadedEdgeSet,
  req: PathStepRequest,
  types: Map<NeuronId, string>,
): TableValue {
  const schema = PATH_STEP_SCHEMA
  const frontier: NeuronId[] = [...(req.neuronIds ?? [])]
  if (req.types?.length) {
    const members = membersOf(types)
    for (const type of req.types) frontier.push(...(members.get(type) ?? []))
  }
  if (frontier.length === 0) return tableFromRows(schema, [])

  const collapse = req.collapseTypes
  const keyOf = (id: NeuronId) => (collapse ? (types.get(id) ?? id) : id)
  // Present only where the key does not already identify one neuron: at neuron level every group
  // is one neuron, and collapsed it is the untyped ones that stand alone.
  const idOf = (id: NeuronId): NeuronId | null =>
    collapse ? (types.get(id) === undefined ? id : null) : id

  const groups = new Map<string, StepAccumulator>()
  for (const edge of edgesFrom(set, frontier, req.direction)) {
    const source = keyOf(edge.pre)
    const target = keyOf(edge.post)
    const at = `${source}${KEY_SEPARATOR}${target}`
    const held = groups.get(at)
    if (held) {
      held.row.weight += edge.weight
      held.row.pairs++
      held.pre.add(edge.pre)
      held.post.add(edge.post)
      continue
    }
    groups.set(at, {
      row: {
        source,
        sourceType: types.get(edge.pre) ?? null,
        sourceId: idOf(edge.pre),
        target,
        targetType: types.get(edge.post) ?? null,
        targetId: idOf(edge.post),
        weight: edge.weight,
        pairs: 1,
        // Filled from the sets below — written here only so the row is never a partial shape.
        sourceNeurons: 1,
        targetNeurons: 1,
      },
      pre: new Set([edge.pre]),
      post: new Set([edge.post]),
    })
  }

  const min = Math.max(1, Math.floor(req.minWeight ?? 1))
  const rows = [...groups.values()]
    .map((group) => {
      group.row.sourceNeurons = group.pre.size
      group.row.targetNeurons = group.post.size
      return group.row
    })
    .filter((row) => row.weight >= min)
    .sort((a, b) => b.weight - a.weight)
  return tableFromRows(schema, rows)
}

/** One neuron's whole weight in one direction — `walk`'s run, summed. */
function totalAt(csr: EdgeCsr, at: number): number {
  let sum = 0
  walk(csr, at, (_target, weight) => {
    sum += weight
  })
  return sum
}

/** Which CSR a `side` or a `direction` reads. One spelling, for `edgesFrom` and both totals. */
function sideOf(set: LoadedEdgeSet, side: ConnectionDirection): EdgeCsr {
  return side === 'outputs' ? set.out : set.in
}

/**
 * Per-neuron synapse totals, summed from the file rather than fetched — `SYNAPSE_TOTALS_SCHEMA`.
 *
 * **The point is that the denominator comes from the same place the numerator did.** A weight out
 * of this set divided by a total out of this set is one connectome throughout, which is the
 * property the funnel's old refusal existed to protect and was throwing the baby out with: it
 * refused the file's *own* sum because a file over the *backend's* published totals would have
 * been two connectomes in one fraction. Only the second of those is a mixture.
 *
 * Two departures from what a backend answers, both forced and neither hidden:
 *
 *  - **`basis` cannot be honoured, because an edge list has no notion of a partner being
 *    reconstructed.** `all` and `connected` are the same number here — the file's — and
 *    `basisOptions` says so on the control itself. Answering `connected` off the neuron index
 *    instead was considered and refused: that would make the denominator a fact about the
 *    backend's listing while the numerator stayed a fact about the file, which is the mixture
 *    again wearing a different hat.
 *  - **No weight threshold reaches here**, deliberately: neither totals request carries one
 *    where `ConnectivityRequest` does, so a total is the neuron's whole traffic whichever way
 *    the node that asked was cutting its own rows. That is what makes the drive below a
 *    threshold *lost* rather than quietly redistributed over the partners that survived.
 *
 * A neuron the file has never mentioned contributes **no row**, the schema's stated rule — read
 * as a lookup, an absence is "not known" without a sentinel that arithmetic would consume. A
 * neuron the file *does* hold with nothing on the asked side totals **0**, which is a measurement,
 * and every normaliser already turns a zero denominator into a null and counts it.
 *
 * Straight into two column arrays rather than through `tableFromRows`, whose own note says it is
 * not for hot paths — `NeuPrintSource.fetchSynapseTotals`' arrangement, for its reason: one hop
 * from a hundred neurons is tens of thousands of partners, and the row-object form allocates a
 * throwaway object each and then walks them all again.
 */
export function synapseTotalsFrom(set: LoadedEdgeSet, req: SynapseTotalsRequest): TableValue {
  const csr = sideOf(set, req.side)
  const ids: CellValue[] = []
  const totals: CellValue[] = []
  for (const at of indicesOf(set, req.neuronIds)) {
    ids.push(set.ids[at]!)
    totals.push(totalAt(csr, at))
  }
  return makeTable(SYNAPSE_TOTALS_SCHEMA, { [ID_COLUMN_NAME]: ids, total: totals })
}

/**
 * The same totals per group key — `GROUP_TOTALS_SCHEMA`, and `pathStepFrom`'s vocabulary.
 *
 * A type's total is every member's total added up, so it is the denominator the Paths node's
 * collapsed weights actually want: `LC4 -> PLP1` over everything every PLP1 neuron receives *in
 * this file*. Membership is the dataset's — `membersOf`, the map `pathStepFrom` already walks —
 * because an edge list names neither end; a member the file never mentions contributes nothing,
 * which is the file saying that neuron receives nothing rather than an omission.
 *
 * A group with no member in the file at all contributes **no row**, `synapseTotalsFrom`'s rule and
 * the seam's: the Paths node reads this as a lookup and leaves such a weight unnormalised rather
 * than dividing by a number nobody measured.
 *
 * The type arm walks `membersOf`'s list directly rather than through `indicesOf`, which the
 * neuron arm does use. The two lists differ in kind: a frontier of ids arrives from a caller and
 * may repeat, where a type's membership is built one entry per id out of a `Map` and cannot — so
 * `indicesOf` there would allocate a `Set` and an array per type, once per hop, to dedupe
 * something already unique.
 */
export function groupTotalsFrom(
  set: LoadedEdgeSet,
  req: GroupTotalsRequest,
  types: Map<NeuronId, string>,
): TableValue {
  const csr = sideOf(set, req.side)
  const keys: CellValue[] = []
  const totals: CellValue[] = []
  if (req.types?.length) {
    const members = membersOf(types)
    for (const type of req.types) {
      let sum = 0
      let held = false
      for (const id of members.get(type) ?? []) {
        const at = set.index.get(id)
        if (at === undefined) continue
        held = true
        sum += totalAt(csr, at)
      }
      if (!held) continue
      keys.push(type)
      totals.push(sum)
    }
  }
  for (const at of indicesOf(set, req.neuronIds ?? [])) {
    keys.push(set.ids[at]!)
    totals.push(totalAt(csr, at))
  }
  return makeTable(GROUP_TOTALS_SCHEMA, { key: keys, total: totals })
}
