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
import { mapWithConcurrency } from '../concurrency'
import { caveGet, cavePost } from './client'
import type { GrapheneSource } from './graphene'
import type { CaveRequestOptions } from './client'

/**
 * How many neurons are built at once.
 *
 * Pure latency — two small requests per neuron — so this is the number that decides the wait.
 * Measured against BANC, 40 neurons: **14.5 s at 8, 4.6–6.0 s at 16, 3.9–4.9 s at 32, 5.2 s at
 * 48**. Three times faster at 16 and flat after it.
 *
 * **Past 16 the server starts dropping requests, and the loss is silent.** Two of three runs at
 * 32 returned 38 and 39 skeletons of 40 asked for, and one at 48 returned 39, where every run at
 * 8 and 16 returned all 40. `mapWithConcurrency` turns a failed neuron into an `undefined` that
 * is indistinguishable from a neuron that genuinely has no skeleton, so the missing ones do not
 * announce themselves — which is why the ceiling here is set by *correctness* rather than by the
 * point where the curve flattens.
 */
export const L2_CONCURRENCY = 16

/**
 * Where an L2 skeleton build starts saying how long it will be.
 *
 * Far above `MESH_WARN_NEURONS`, which is 20 because one graphene mesh is several hundred
 * requests; a skeleton is two. Far below what a source publishing ready-made skeletons has to
 * say about, because those are one request each and served from a bucket.
 *
 * A refusal at 100 until it stopped being one. Every FlyWire question of any size arrives here
 * — a cell type is often several hundred cells — so this route's cost is the cost of using
 * FlyWire at all, and refusing to pay it was refusing the dataset.
 */
export const L2_SKELETON_WARN = 100

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
 * How many chunk ids go in one attributes request.
 *
 * The call is keyed by **table**, not by root id, so every neuron in a request can share it —
 * which is the difference between two round trips per neuron and one per neuron plus a handful.
 * Measured: 1,177 chunks (twelve neurons' worth) answered in one 1.64 s request against roughly
 * 1.6 s for *each* of twelve, and 2,000 ids in 1.98 s. `caveclient.l2cache.get_l2data` chunks for
 * the same reason; 5,000 is comfortably inside what was measured to answer quickly.
 */
const ATTRIBUTE_BATCH = 5_000

/**
 * Skeletons for a set of neurons.
 *
 * **Two phases rather than two requests per neuron**, and that is the whole shape of this
 * function. The chunk graph is per neuron and has to be asked for one at a time; the attributes
 * are per *table*, so the union of every neuron's chunks goes in a handful of requests however
 * many neurons were asked for. A hundred neurons is a hundred graph reads plus about three
 * attribute reads, rather than two hundred round trips against a shared production chunkedgraph.
 *
 * The cost is that progress is reported in two phases rather than smoothly per neuron, which is
 * what the note argument is for.
 */
export async function readL2Skeletons(
  source: GrapheneSource,
  neuronIds: readonly NeuronId[],
  options: CaveRequestOptions = {},
  onProgress?: (fraction: number, note?: string) => void,
): Promise<SkeletonGeometry[]> {
  let read = 0
  const graphs = await mapWithConcurrency(neuronIds, L2_CONCURRENCY, async (neuronId) => {
    const edges = await readChunkGraph(source, neuronId, options)
    onProgress?.((++read / neuronIds.length) * 0.8, `${read}/${neuronIds.length} chunk graphs`)
    return { neuronId, edges }
  })

  const wanted = [...new Set(graphs.flatMap((g) => g?.edges.flat() ?? []))]
  onProgress?.(0.85, `${wanted.length} chunks`)
  const attributes = await readAttributes(source, wanted, options)

  onProgress?.(1)
  return graphs
    .map((g) =>
      g && g.edges.length > 0 ? skeletonFrom(g.neuronId, g.edges, attributes) : undefined,
    )
    .filter((s): s is SkeletonGeometry => s !== undefined)
}

/** One neuron's level-2 chunk graph, as deduplicated undirected edges. */
async function readChunkGraph(
  source: GrapheneSource,
  neuronId: NeuronId,
  options: CaveRequestOptions,
): Promise<Array<[string, string]>> {
  const graph = await caveGet<{ edge_graph?: unknown[] }>(
    `${source.server}/segmentation/api/v1/table/${source.table}/node/${neuronId}/lvl2_graph`,
    options,
  )
  return (graph.edge_graph ?? [])
    .map((edge) =>
      Array.isArray(edge) ? ([String(edge[0]), String(edge[1])] as const) : undefined,
    )
    .filter(
      (edge): edge is readonly [string, string] => edge !== undefined && edge[0] !== edge[1],
    )
    .map((edge) => [edge[0], edge[1]])
}

/** Every chunk's representative coordinate and radius, in as few requests as it takes. */
async function readAttributes(
  source: GrapheneSource,
  ids: readonly string[],
  options: CaveRequestOptions,
): Promise<Record<string, L2Entry>> {
  const batches: string[][] = []
  for (let at = 0; at < ids.length; at += ATTRIBUTE_BATCH) {
    batches.push(ids.slice(at, at + ATTRIBUTE_BATCH))
  }
  const answered = await mapWithConcurrency(batches, 4, (batch) =>
    cavePost<Record<string, L2Entry>>(
      `${source.server}/l2cache/api/v1/table/${source.table}/attributes`,
      { l2_ids: batch, attribute_names: ATTRIBUTES },
      options,
    ),
  )
  return Object.assign({}, ...answered.filter(Boolean)) as Record<string, L2Entry>
}

/**
 * The graph, as a tree.
 *
 * Four rules, each a wrong picture if lost:
 *
 *  1. **Chunks with no cache entry are dropped, before the walk rather than after.** That is
 *     `get_l2_skeleton`'s `drop_missing`, and its reasoning: a chunk absent from the cache has
 *     only its *chunk-grid* position, the corner of a box tens of microns across, so keeping it
 *     puts a node where the neuron is not. Dropping before the walk is what keeps the tree
 *     connected — removing a node from a finished tree orphans its children, where excluding it
 *     from the graph lets the walk route around through whatever else it touched.
 *     (`navis.remove_nodes` reparents for the same reason; doing it up front needs no
 *     reparenting at all.)
 *  2. **A spanning forest, breadth-first**, because the L2 graph is undirected and can hold
 *     cycles while a skeleton is a tree. A cycle surviving into `parents` makes every consumer
 *     that walks to a root loop forever.
 *  3. **Each component gets its own root**, so a neuron split by an edit is two trees rather
 *     than one with a fabricated join.
 *  4. **Points come out in visit order, so a parent always precedes its child.** That is the
 *     contract `SkeletonGeometry.parents` states and that `neuprint/decode.ts` does real work to
 *     honour; emitting in chunk-id order instead would satisfy the type and break every consumer
 *     written to walk the array once, the SWC writer included.
 */
function skeletonFrom(
  neuronId: NeuronId,
  edges: ReadonlyArray<readonly [string, string]>,
  attributes: Readonly<Record<string, L2Entry>>,
): SkeletonGeometry | undefined {
  const index = new Map<string, number>()
  const points: Array<{ at: readonly number[]; radius: number }> = []
  for (const id of new Set(edges.flat())) {
    const entry = attributes[id]
    const at = entry?.rep_coord_nm
    if (!at || at.length < 3) continue
    index.set(id, points.length)
    // `max_dt_nm` is the largest distance-transform value in the chunk, which is what
    // `get_l2_skeleton` uses as the radius. Absent on a very small chunk; 0 rather than a guess.
    points.push({ at, radius: entry.max_dt_nm ?? 0 })
  }
  if (points.length === 0) return undefined

  const neighbours: number[][] = points.map(() => [])
  for (const [a, b] of edges) {
    const from = index.get(a)
    const to = index.get(b)
    if (from === undefined || to === undefined) continue
    neighbours[from]!.push(to)
    neighbours[to]!.push(from)
  }

  // Visit order, and the slot each node takes in the emitted arrays. BFS reaches a parent before
  // its children, so slots increase down every branch — rule 4.
  const visited: number[] = []
  const slot = new Int32Array(points.length).fill(-1)
  const parents = new Int32Array(points.length).fill(-1)
  for (let start = 0; start < points.length; start++) {
    if (slot[start] !== -1) continue
    slot[start] = visited.length
    visited.push(start)
    for (let head = visited.length - 1; head < visited.length; head++) {
      const node = visited[head]!
      for (const next of neighbours[node]!) {
        if (slot[next] !== -1) continue
        slot[next] = visited.length
        visited.push(next)
        parents[slot[next]!] = slot[node]!
      }
    }
  }

  const positions = new Float32Array(points.length * 3)
  const radii = new Float32Array(points.length)
  for (let i = 0; i < visited.length; i++) {
    const point = points[visited[i]!]!
    positions[i * 3] = point.at[0]!
    positions[i * 3 + 1] = point.at[1]!
    positions[i * 3 + 2] = point.at[2]!
    radii[i] = point.radius
  }

  return { id: neuronId, positions, radii, parents }
}
