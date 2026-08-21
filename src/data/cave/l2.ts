/**
 * Skeletons from the level-2 chunk graph.
 *
 * A CAVE segmentation is a chunkedgraph, and the level *above* supervoxels — level 2 — is a
 * coarse decomposition of every neuron into chunks. Two requests give a skeleton: the graph of
 * which chunks touch which, and a per-chunk representative coordinate. This is
 * `fafbseg.flywire.get_l2_skeleton()`'s method, transcribed.
 *
 * **Why not the skeleton service**, which several datastacks also publish: it *generates from
 * this same cache*, so it covers no datastack the L2 route does not — `flywire_fafb_public`
 * declares one and has no L2 cache, which is exactly why its skeleton cache was found empty.
 * Measured against it on one BANC neuron: 1.6 s here against 10–45 s for an uncached generate,
 * and 146 nodes here against 74 from the service. It is also the only route that reaches
 * `wclee_aedes_brain`, which has a populated cache and publishes no service at all.
 *
 * **The skeleton is coarse and says so.** One node per level-2 chunk is tens to a few hundred
 * nodes for a whole neuron, where a traced skeleton is thousands. It is the right shape for
 * NBLAST, for a 3D overview and for cable length; it is not a morphometric reconstruction.
 */

import type { NeuronId } from '../../core/ids'
import type { SkeletonGeometry } from '../../core/values'
import { caveGet, cavePost } from './client'
import type { CaveRequestOptions } from './client'

/**
 * How many neurons are built at once.
 *
 * The work is two small requests per neuron against a shared production chunkedgraph, so this is
 * a latency budget rather than a bandwidth one — the same shape as `FRAGMENT_CONCURRENCY`, at a
 * quieter number because these hit the graph service rather than an object store.
 */
export const L2_CONCURRENCY = 8

/**
 * The ceiling, enforced in the source because it is a fact about this route.
 *
 * Far above `MAX_MESH_NEURONS`, which is 20 because one graphene mesh is several hundred
 * requests; a skeleton is two. Far below the 500 a source publishing ready-made skeletons
 * allows, because those are one request each and served from a bucket.
 */
export const MAX_L2_SKELETON_NEURONS = 100

/** What the L2 cache is asked for: a position, and something to call a radius. */
const ATTRIBUTES = ['rep_coord_nm', 'max_dt_nm']

interface L2Entry {
  rep_coord_nm?: [number, number, number]
  max_dt_nm?: number
}

/**
 * Whether a chunkedgraph table has an L2 cache at all.
 *
 * `caveclient.l2cache.has_cache()`'s rule exactly: the table mapping lists the tables the cache
 * knows, and membership is the answer. Verified against the live behaviour rather than assumed —
 * `flywire_public` is absent from the mapping and the server refuses an attribute query for it
 * with "Dataset flywire_public does not have an L2 Cache", while `wclee_aedes_brain` is present
 * and answers with every chunk populated.
 *
 * One request per **server**, memoised, because the mapping covers every table that server
 * hosts. A 404 means the deployment runs no L2 cache service at all, which is a `false` rather
 * than an error — `caveclient` warns and returns false in the same case.
 */
const mappings = new Map<string, Promise<Record<string, unknown>>>()

export function l2TableMapping(
  server: string,
  options: CaveRequestOptions = {},
): Promise<Record<string, unknown>> {
  let pending = mappings.get(server)
  if (!pending) {
    pending = caveGet<Record<string, unknown>>(
      `${server}/l2cache/api/v1/table_mapping`,
      options,
    ).catch(() => ({}))
    mappings.set(server, pending)
  }
  return pending
}

/** Test seam, and what a changed global server drops. */
export function resetL2Cache(): void {
  mappings.clear()
}

/**
 * One neuron's skeleton, or undefined where it cannot be built.
 *
 * Undefined rather than an error for `readGrapheneMesh`'s reason: a segment made of a single
 * level-2 chunk has no edges and so no tree, which is an ordinary state for a small or
 * newly-edited body and must not fail the other neurons in the request.
 */
export async function readL2Skeleton(
  server: string,
  table: string,
  rootId: NeuronId,
  options: CaveRequestOptions = {},
): Promise<SkeletonGeometry | undefined> {
  const graph = await caveGet<{ edge_graph?: unknown } | unknown[]>(
    `${server}/segmentation/api/v1/table/${table}/node/${rootId}/lvl2_graph`,
    options,
  )
  const raw = Array.isArray(graph) ? graph : ((graph.edge_graph ?? []) as unknown[])
  const edges = raw
    .map((edge) => (Array.isArray(edge) ? [String(edge[0]), String(edge[1])] : undefined))
    .filter((edge): edge is [string, string] => edge !== undefined && edge[0] !== edge[1])
  if (edges.length === 0) return undefined

  const ids = [...new Set(edges.flat())].sort()
  const attributes = await cavePost<Record<string, L2Entry>>(
    `${server}/l2cache/api/v1/table/${table}/attributes`,
    { l2_ids: ids, attribute_names: ATTRIBUTES },
    options,
  )

  return skeletonFrom(rootId, ids, edges, attributes)
}

/**
 * The graph, as a tree.
 *
 * Three steps, and the middle one is the whole of it:
 *
 *  1. **Chunks with no cache entry are dropped.** `get_l2_skeleton`'s `drop_missing`, and its
 *     reasoning: a chunk absent from the cache has only its *chunk-grid* position, which is the
 *     corner of a box tens of microns across, so keeping it puts a node somewhere the neuron is
 *     not. Both datastacks sampled had every chunk populated, so this is the rare path.
 *  2. **A spanning forest, breadth-first.** The L2 graph is undirected and can hold cycles;
 *     a skeleton is a tree. BFS from an arbitrary node yields parents pointing back at a root,
 *     and every component gets its own root — a neuron split by an edit is two trees, not one
 *     tree with a fabricated join.
 *  3. Positions and radii come straight from the cache.
 *
 * Dropping happens *before* the walk rather than after, which is what keeps the tree connected:
 * removing a node from a finished tree orphans its children, where excluding it from the graph
 * lets the walk route around it through whatever else it touched. `navis.remove_nodes` reparents
 * for the same reason; doing it up front needs no reparenting at all.
 */
function skeletonFrom(
  rootId: NeuronId,
  ids: readonly string[],
  edges: ReadonlyArray<readonly [string, string]>,
  attributes: Readonly<Record<string, L2Entry>>,
): SkeletonGeometry | undefined {
  const kept: string[] = []
  const index = new Map<string, number>()
  for (const id of ids) {
    const at = attributes[id]?.rep_coord_nm
    if (!at || at.length < 3) continue
    index.set(id, kept.length)
    kept.push(id)
  }
  if (kept.length === 0) return undefined

  const neighbours: number[][] = kept.map(() => [])
  for (const [a, b] of edges) {
    const from = index.get(a)
    const to = index.get(b)
    if (from === undefined || to === undefined) continue
    neighbours[from]!.push(to)
    neighbours[to]!.push(from)
  }

  const parents = new Int32Array(kept.length).fill(-1)
  const seen = new Uint8Array(kept.length)
  for (let start = 0; start < kept.length; start++) {
    if (seen[start]) continue
    seen[start] = 1
    const queue = [start]
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head]!
      for (const next of neighbours[node]!) {
        if (seen[next]) continue
        seen[next] = 1
        parents[next] = node
        queue.push(next)
      }
    }
  }

  const positions = new Float32Array(kept.length * 3)
  const radii = new Float32Array(kept.length)
  for (let i = 0; i < kept.length; i++) {
    const entry = attributes[kept[i]!]!
    const at = entry.rep_coord_nm!
    positions[i * 3] = at[0]
    positions[i * 3 + 1] = at[1]
    positions[i * 3 + 2] = at[2]
    // `max_dt_nm` is the largest distance-transform value in the chunk, which is what
    // `get_l2_skeleton` uses as the radius. Absent on a very small chunk; 0 rather than a guess.
    radii[i] = entry.max_dt_nm ?? 0
  }

  return { id: String(rootId), positions, radii, parents }
}


