/**
 * A neuron's supervoxel graph inside a box, with each edge's affinity and contact area.
 *
 * `GET …/node/{root}/subgraph?bounds=` — `caveclient.chunkedgraph.get_subgraph`. On pychunkedgraph
 * 2.x it is **the same graph the server's split cuts** (`cutting.run_split_preview` and this route
 * both call `cg.get_subgraph`), so whatever a split would weigh, this reads. Measured 2026-11-22:
 * FANC (2.20), MICrONS and H01 (2.19–2.21) answer it; FlyWire production runs 1.27, whose route
 * answers `atomic_edges` only, with no weights — refused here by name rather than read as a graph
 * with no affinities.
 *
 * What the numbers are, read off the stored edges rather than assumed:
 *
 * - **`affinity` is a sum over the contact face**, not a mean. FANC's affinity ÷ area runs 0.09 to
 *   0.90 — a real mean affinity — where MICrONS' is 1.00 on 95% of edges, so there it says nothing
 *   beyond the contact's size.
 * - **An infinite affinity joins two pieces of one supervoxel cut by a chunk border.** The server
 *   writes it as a bare `Infinity`, which is not JSON; the shared CAVE parser (`json.ts`) reads it.
 * - **A proofreader's merge is a "fake edge"**: affinity float32's smallest normal value
 *   (1.18e-38) and area 0. A min-cut therefore takes it first.
 *
 * Ids are read exactly without asking for text: the shared parser (`parseCaveJson`) quotes any
 * integer too wide for a double before parsing, so an 18-digit supervoxel arrives as text and a
 * smaller id as a safe integer (`replyId`). `int64_as_str` is not asked for: it makes the server
 * answer slower (user, 2026-11-23), and buys nothing the parser does not already do.
 */

import type { CaveRequestOptions } from './client'
import { CaveError, caveGet } from './client'
import { inFlight } from '../concurrency'
import type { GrapheneSource } from './graphene'
import { tableUrl } from './graphene'
import { isNodeId, replyId } from './graphLayout'

/** One edge list, as parallel arrays: edge `i` joins `a[i]` and `b[i]`. */
export interface SupervoxelGraph {
  readonly a: readonly string[]
  readonly b: readonly string[]
  /** Summed affinity over the contact face; `Infinity` for two pieces of one supervoxel. */
  readonly affinity: Float64Array
  /** Contact area in voxel faces; 0 on a proofreader's merge. */
  readonly area: Float64Array
}

/** A box in the chunkedgraph's base voxels, `[lo, hi]` per axis — what `bounds` is written in. */
export type GraphBox = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
]

/**
 * `bounds` as the server parses it: `x0-x1_y0-y1_z0-z1`. A negative corner is clamped to 0 —
 * the server splits on `-`, so `-118-138` answers a 500 (measured on FANC).
 */
export function boundsParam(box: GraphBox): string {
  const [lo, hi] = box
  return [0, 1, 2]
    .map((axis) => `${Math.max(0, Math.floor(lo[axis]!))}-${Math.max(0, Math.ceil(hi[axis]!))}`)
    .join('_')
}

/** The reply's shape on 2.x, as far as this reads it. */
interface RawSubgraph {
  nodes?: unknown
  affinities?: unknown
  areas?: unknown
  atomic_edges?: unknown
}

/**
 * A chunkedgraph that publishes no affinities (pychunkedgraph 1.x): a fact about the server, not a
 * failed read, so a caller can stop asking it (`ui/seam/splitSession.ts`).
 */
export class NoAffinitiesError extends CaveError {}

/** The reply, checked: one affinity and one area per edge, ids as text. Throws where it is not. */
export function readSubgraphReply(raw: unknown): SupervoxelGraph {
  const reply = (raw ?? {}) as RawSubgraph
  if (reply.atomic_edges !== undefined && reply.affinities === undefined) {
    throw new NoAffinitiesError(
      'This chunkedgraph answers its subgraph without affinities (pychunkedgraph 1.x, as FlyWire ' +
        'runs), so there is nothing to weigh a cut by.',
    )
  }
  const nodes = reply.nodes
  const affinities = reply.affinities
  const areas = reply.areas
  if (!Array.isArray(nodes) || !Array.isArray(affinities) || !Array.isArray(areas)) {
    throw new CaveError('The chunkedgraph answered its subgraph in a shape this does not read.')
  }
  const n = nodes.length
  if (affinities.length !== n || areas.length !== n) {
    throw new CaveError(
      `The chunkedgraph answered ${n} edges with ${affinities.length} affinities and ` +
        `${areas.length} areas, so which weight belongs to which edge is unknown.`,
    )
  }
  const a: string[] = new Array<string>(n)
  const b: string[] = new Array<string>(n)
  const affinity = new Float64Array(n)
  const area = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const pair = nodes[i] as unknown
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new CaveError(`Edge ${i} of the chunkedgraph's subgraph is not a pair.`)
    }
    // Text, or a safe integer: a wide one arrives quoted by the parser; anything else is refused.
    const u = replyId(pair[0], isNodeId)
    const v = replyId(pair[1], isNodeId)
    if (u === undefined || v === undefined) {
      throw new CaveError(
        `Edge ${i} of the chunkedgraph's subgraph is not a pair of supervoxel ids.`,
      )
    }
    a[i] = u
    b[i] = v
    affinity[i] = affinities[i] === null ? Number.NaN : Number(affinities[i])
    // A missing value (`NaN`, which the parser reads as null) is NaN, never 0: an area of 0 is a
    // proofreader's merge (`edgeKind`), which a trusted policy merges first.
    area[i] = areas[i] === null ? Number.NaN : Number(areas[i])
  }
  return { a, b, affinity, area }
}

/** Below this, an affinity is float32's "nothing" — a proofreader's merge, never a contact. */
const USER_MERGE_AFFINITY = 1e-30

/**
 * What one edge of a subgraph is — the one place this is decided.
 *
 * - `piece`: two pieces of one supervoxel cut by a chunk border (infinite affinity). Never cut.
 * - `unread`: an affinity or area the server did not give (NaN). Treated as absent.
 * - `userMerge`: a proofreader's merge — no area, or float32's smallest affinity.
 * - `contact`: a measured contact, its affinity summed over `area` voxel faces.
 */
export type EdgeKind = 'piece' | 'unread' | 'userMerge' | 'contact'

export function edgeKind(affinity: number, area: number): EdgeKind {
  if (affinity === Infinity) return 'piece'
  if (Number.isNaN(affinity) || Number.isNaN(area)) return 'unread'
  if (!(area > 0) || affinity < USER_MERGE_AFFINITY) return 'userMerge'
  return 'contact'
}

/** The neuron's supervoxel graph inside `box`. One request; it can be several megabytes. */
export async function readSubgraph(
  graphene: GrapheneSource,
  root: string,
  box: GraphBox,
  options: CaveRequestOptions,
): Promise<SupervoxelGraph> {
  const url = tableUrl(graphene, `node/${root}/subgraph`) + `?bounds=${boundsParam(box)}`
  return readSubgraphReply(await caveGet<unknown>(url, options))
}

/**
 * The neuron's graph over several boxes, as one graph with each edge once.
 *
 * Pieces of one answer, so `inFlight`: the first box to fail stops the rest and its own error —
 * a 1.x refusal, a 429 — is the one thrown. **`subgraph` keeps only edges with both ends inside
 * its box** (`only_internal_edges`), so a caller tiling a region must overlap its boxes wherever
 * an edge may cross between them.
 */
export async function readSubgraphBoxes(
  graphene: GrapheneSource,
  root: string,
  boxes: readonly GraphBox[],
  concurrency: number,
  options: CaveRequestOptions,
): Promise<SupervoxelGraph> {
  const parts: SupervoxelGraph[] = new Array<SupervoxelGraph>(boxes.length)
  await inFlight(
    boxes.map((box, i) => ({ box, i })),
    concurrency,
    async ({ box, i }) => {
      parts[i] = await readSubgraph(graphene, root, box, options)
    },
  )
  return unionOf(parts)
}

/** Several graphs as one, each edge once (in either direction). */
export function unionOf(parts: readonly SupervoxelGraph[]): SupervoxelGraph {
  const seen = new Set<string>()
  const a: string[] = []
  const b: string[] = []
  const affinity: number[] = []
  const area: number[] = []
  for (const part of parts) {
    for (let i = 0; i < part.a.length; i++) {
      const u = part.a[i]!
      const v = part.b[i]!
      const key = u < v ? `${u}|${v}` : `${v}|${u}`
      if (seen.has(key)) continue
      seen.add(key)
      a.push(u)
      b.push(v)
      affinity.push(part.affinity[i]!)
      area.push(part.area[i]!)
    }
  }
  return { a, b, affinity: Float64Array.from(affinity), area: Float64Array.from(area) }
}

/** The edges of `graph` with both ends where `keep` says; `graph` itself where that is all of them. */
export function subgraphWhere(
  graph: SupervoxelGraph,
  keep: (supervoxel: string) => boolean,
): SupervoxelGraph {
  const at: number[] = []
  for (let i = 0; i < graph.a.length; i++)
    if (keep(graph.a[i]!) && keep(graph.b[i]!)) at.push(i)
  if (at.length === graph.a.length) return graph
  return {
    a: at.map((i) => graph.a[i]!),
    b: at.map((i) => graph.b[i]!),
    affinity: Float64Array.from(at, (i) => graph.affinity[i]!),
    area: Float64Array.from(at, (i) => graph.area[i]!),
  }
}
