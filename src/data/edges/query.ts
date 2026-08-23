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
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import type { Edge } from '../connectivity'
import type { ConnectionDirection, PathStepRequest } from '../source'
import { pathStepSchema } from '../source'
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
  const csr = outward ? set.out : set.in
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
 * The ids go out as **text**, which is why `pathStepSchema` takes a dtype: an edge set is keyed
 * by whatever the file said, and an eighteen-digit id in an `i64` column is a different neuron.
 */
export function pathStepFrom(
  set: LoadedEdgeSet,
  req: PathStepRequest,
  types: Map<NeuronId, string>,
): TableValue {
  const schema = pathStepSchema('str')
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

  const groups = new Map<string, StepGroup>()
  for (const edge of edgesFrom(set, frontier, req.direction)) {
    const source = keyOf(edge.pre)
    const target = keyOf(edge.post)
    const at = `${source}${KEY_SEPARATOR}${target}`
    const held = groups.get(at)
    if (held) {
      held.weight += edge.weight
      held.pairs++
      continue
    }
    groups.set(at, {
      source,
      sourceType: types.get(edge.pre) ?? null,
      sourceId: idOf(edge.pre),
      target,
      targetType: types.get(edge.post) ?? null,
      targetId: idOf(edge.post),
      weight: edge.weight,
      pairs: 1,
    })
  }

  const min = Math.max(1, Math.floor(req.minWeight ?? 1))
  const rows = [...groups.values()]
    .filter((group) => group.weight >= min)
    .sort((a, b) => b.weight - a.weight)
  return tableFromRows(schema, rows)
}
