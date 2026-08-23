/**
 * Shapes and rules shared by everything that builds a connectivity answer *locally*.
 *
 * `neuronFilter.ts`'s reason, one question over. That module exists because CAVE became the
 * second backend to filter neurons in the browser, and a second copy of "what does this pattern
 * mean" would have had one graph answer differently on two backends. This is the same seam for
 * connectivity: `CaveSource` counts synapses into an edge list and folds it into a matrix, and a
 * user-supplied edge set now does the same thing from a different starting point. The fold is
 * not obvious enough to write twice — an untyped neuron's bucket and a pair outside the
 * requested rows both produce a plausible wrong matrix rather than an error.
 */

import { ID_COLUMN_NAME, type NeuronId } from '../core/ids'
import type { MatrixValue, TableValue } from '../core/values'
import { makeMatrix } from '../core/values'

/** One connection, oriented presynaptic → postsynaptic whatever answered it. */
export interface Edge {
  pre: NeuronId
  post: NeuronId
  weight: number
}

/**
 * Neuron id to cell type, from a dataset's own neuron index.
 *
 * Memoised on the *table's identity*, which is safe rather than merely likely to hit:
 * `cacheGet` promotes a cached table into `cache.ts`'s module-level map and hands back the same
 * object, so repeat `neuronIndex` calls for one dataset return an identical `TableValue`. Worth
 * the memo because this is called once per hop per direction — `Hops: 3, Direction: both` built
 * the same 108,000-entry map six times in one Run before it existed. Same idiom as
 * `searchIndexFor`, `statsFor` and `cornersByBucket`.
 *
 * A neuron with no type is **absent** rather than mapped to null or to the empty string, so a
 * caller can tell "not typed" from "typed as nothing" with a single `Map.get`.
 */
const typeCache = new WeakMap<TableValue, Map<NeuronId, string>>()

export function typesOf(index: TableValue): Map<NeuronId, string> {
  const cached = typeCache.get(index)
  if (cached) return cached
  const lookup = new Map<NeuronId, string>()
  const ids = index.data[ID_COLUMN_NAME]
  const types = index.data.type
  if (ids && types) {
    for (let i = 0; i < index.length; i++) {
      const type = types[i]
      if (typeof type === 'string' && type) lookup.set(String(ids[i]), type)
    }
  }
  typeCache.set(index, lookup)
  return lookup
}

/**
 * Fold an edge list into the matrix an Adjacency node asked for.
 *
 * Two rules in here, and each produces a plausible wrong picture rather than an error:
 *
 *  - **An untyped neuron keeps its own id as its key** rather than joining a bucket called
 *    "null" — `profileStats`' rule, and for its reason: merging them puts a fictitious type at
 *    the top of the list. On male-CNS that bucket would be one of the largest rows in the matrix.
 *  - **A pair outside the requested rows or columns is dropped, not appended.** The axes are the
 *    ids that were *asked about*; a source free to add a row would answer a different question,
 *    and the caller has already sized its picture around the list it sent.
 */
export function matrixFromEdges(
  edges: readonly Edge[],
  sourceIds: readonly NeuronId[],
  targetIds: readonly NeuronId[],
  types?: Map<NeuronId, string>,
): MatrixValue {
  const key = (id: NeuronId) => types?.get(id) ?? id
  const rowKeys = [...new Set(sourceIds.map(key))]
  const colKeys = [...new Set(targetIds.map(key))]
  const rowAtKey = new Map(rowKeys.map((k, i) => [k, i]))
  const colAtKey = new Map(colKeys.map((k, i) => [k, i]))

  const values = new Float64Array(rowKeys.length * colKeys.length)
  for (const edge of edges) {
    const r = rowAtKey.get(key(edge.pre))
    const c = colAtKey.get(key(edge.post))
    if (r === undefined || c === undefined) continue
    const at = r * colKeys.length + c
    values[at] = (values[at] ?? 0) + edge.weight
  }
  return makeMatrix(rowKeys, colKeys, values, 'synapses', 'count')
}
