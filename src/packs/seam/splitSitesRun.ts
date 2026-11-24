/**
 * `splitSites` against a live chunkedgraph: from a neuron and two points to sites with positions.
 *
 * Two steps, so the reads are paid once however many cuts are tried on them:
 *
 * - **`readSplitGraph`** (reads only, view permission): the chunkedgraph's `info`; the root's
 *   level-2 chunk graph and the time it was made — a past root is read as it was (`--operation` in
 *   the probe uses one); the supervoxel volume under each point and those supervoxels' level-2
 *   parents, to name the supervoxel of *this* neuron nearest each point; `subgraph` over the chunks
 *   on the shortest level-2 path between the points; and each point's level-2 piece, as its seed.
 * - **`cutSplitGraph`**: the cut, the candidates and (experimental) the path scan, then their
 *   positions from the L2 cache (`placeCuts`).
 *
 * **Why a path and not CAVE's box.** A split preview reads the points' bounding box padded by
 * (240, 240, 24) voxels. Tested on nine FANC splits with points 15 µm from the cut, four were not
 * joined inside that box at all — the neurite between the points leaves it — and a box five times
 * wider took 19 s and still missed one. The path follows the neuron, so it holds the join by
 * construction.
 *
 * Pychunkedgraph 2.x only: 1.x (FlyWire) publishes no affinities, and `readSubgraph` refuses it by
 * name.
 */

import type { CaveRequestOptions } from '../../data/cave/client'
import type { GrapheneSource } from '../../data/cave/graphene'
import type { BoxableLayout, GraphLayout } from '../../data/cave/graphLayout'
import { cellBox, chunkOf, isBoxable } from '../../data/cave/graphLayout'
import { readL2Positions, readLevelTwoGraph } from '../../data/cave/l2'
import type { Instant } from '../../data/cave/rootIds'
import { chunkSupervoxels, levelTwoParents, rootTimestamps } from '../../data/cave/rootIds'
import type { GraphBox, SupervoxelGraph } from '../../data/cave/subgraph'
import { readSubgraphBoxes, subgraphWhere } from '../../data/cave/subgraph'
import { baseScale, findSupervoxels } from '../../data/cave/volumes'
import type { VolumeScale } from '../../data/precomputed/volume'
import { openVolume, readLabelBox } from '../../data/precomputed/volume'
import type {
  Candidate,
  CutEdge,
  PathCut,
  SplitSite,
  SplitSitesResult,
  UserMergePolicy,
} from './splitSites'
import { groupSites, pathCuts, splitSites } from './splitSites'

type Triple = readonly [number, number, number]

/** How far cut edges may lie apart and still be one site. */
export const SITE_RADIUS_NM = 2000

/** `subgraph` requests in flight at once. */
export const SUBGRAPH_CONCURRENCY = 4

/**
 * The widest a `subgraph` box along the path may grow, in chunk cells per axis. Three is what the
 * whole-neuron scan reads safely, where one request for a whole 2,800-chunk neuron was a 502.
 */
const MAX_RUN_CELLS = 3

/**
 * How far from a point to look for a voxel of the neuron, in base voxels. A point clicked in
 * neuroglancer is on the neuron; one typed or rounded may be a voxel or several off its surface.
 * Read once (about 21k voxels) and ranked nearest first.
 */
const LOOKUP_REACH: Triple = [24, 24, 4]

/** What a read needs: a neuron and the points on each side. */
export interface SplitGraphRequest {
  readonly datastack: string
  readonly root: string
  /** Points in nm that must end up on the source side. */
  readonly sources: readonly Triple[]
  /** Points in nm that must end up on the sink side. */
  readonly sinks: readonly Triple[]
  /** Chunks to add around the path on every side (0: the path's own chunks). */
  readonly padChunks?: number
}

/** What a cut is asked with: everything here is the pure step's, and costs no read. */
export interface SplitCutOptions {
  readonly userMerges?: UserMergePolicy
  readonly siteRadiusNm?: number
  readonly minPiece?: number
  readonly maxCandidates?: number
  /** Experimental: also cut every window of `2·pathScan + 1` chunks along the path (`pathCuts`). */
  readonly pathScan?: number
}

/** One read, to be cut any number of ways (`cutSplitGraph`). */
export interface SplitGraphRead {
  readonly graphene: GrapheneSource
  readonly layout: GraphLayout
  readonly graph: SupervoxelGraph
  /** Distinct supervoxels in `graph`. */
  readonly supervoxelCount: number
  /** The supervoxel each point resolved to, sources then sinks. */
  readonly supervoxels: {
    readonly sources: readonly string[]
    readonly sinks: readonly string[]
  }
  /** Supervoxels seeding each side: the points' level-2 pieces, or the points alone where shared. */
  readonly seeds: { readonly sources: readonly string[]; readonly sinks: readonly string[] }
  /** The first source's path, as chunk cells in order — the path scan's positions. */
  readonly path: readonly Triple[]
  /** When the root was made, epoch ms — the moment everything was read at. */
  readonly at: number
  /** Level-2 chunks on the paths, distinct chunk cells they sit in, and `subgraph` boxes read. */
  readonly chunks: { readonly path: number; readonly read: number; readonly boxes: number }
  readonly ms: { readonly path: number; readonly subgraph: number }
}

export interface PlacedCandidate {
  readonly candidate: Candidate
  readonly sites: readonly SplitSite[]
}

export interface PlacedPathCut {
  readonly pathCut: PathCut
  readonly sites: readonly SplitSite[]
}

/** What a cut adds to its read; the read itself (`SplitGraphRead`) says what was read and how long it took. */
export interface SplitSitesReport {
  readonly result: SplitSitesResult
  /** The constrained cut's sites, highest mean affinity first; empty on a refusal. */
  readonly sites: readonly SplitSite[]
  /** The plain agglomeration's candidate steps, weakest first, each with its sites. */
  readonly candidates: readonly PlacedCandidate[]
  /** With `pathScan`: the window cuts along the path, in path order, each with its sites. */
  readonly pathCuts: readonly PlacedPathCut[]
  readonly ms: { readonly cut: number; readonly place: number }
}

/** Everything a cut needs from the server. Reads only. */
export async function readSplitGraph(
  request: SplitGraphRequest,
  options: CaveRequestOptions,
): Promise<SplitGraphRead> {
  if (request.sources.length === 0 || request.sinks.length === 0) {
    throw new Error('A split needs at least one point on each side.')
  }
  const source = await findSupervoxels(request.datastack, options)
  const { layout, graphene } = source
  if (!isBoxable(layout)) {
    throw new Error(
      `${request.datastack}'s chunkedgraph publishes no chunk grid in its info, so the chunks ` +
        'between the points cannot be boxed.',
    )
  }
  const pad = request.padChunks ?? 0

  let t = performance.now()
  const bucket = options.signal ? { signal: options.signal } : {}
  const points = [...request.sources, ...request.sinks]
  // The labels under the points need only the volume; the neuron's chunks only decide, at the
  // end, which label is this neuron's. So the two reads run side by side.
  const [[made], levelTwo, nearby] = await Promise.all([
    rootTimestamps(graphene, [request.root], options),
    readLevelTwoGraph(graphene, request.root, options),
    openVolume(source.base, bucket).then((info) => {
      const scale = baseScale(request.datastack, info, layout)
      return Promise.all(points.map((point) => labelsNear(source.base, scale, point, bucket)))
    }),
  ])
  const at = made!
  const hits = await nearestOwnLabels(graphene, nearby, at, new Set(levelTwo.chunks), options)
  hits.forEach((h, i) => {
    if (!h) {
      throw new Error(
        `Point ${points[i]!.join(', ')} nm is not on neuron ${request.root} (no voxel of it ` +
          `within ${LOOKUP_REACH.join(' × ')} voxels).`,
      )
    }
  })
  const sourceHits = hits.slice(0, request.sources.length) as Hit[]
  const sinkHits = hits.slice(request.sources.length) as Hit[]
  const sourceChunks = sourceHits.map((h) => h.chunk)
  const sinkChunks = sinkHits.map((h) => h.chunk)
  const chunkGraph = adjacencyOf(levelTwo.edges)
  // A path from each source to its nearest sink, and from each sink no source path reached — a
  // sink off every path would otherwise sit in a piece of the graph no cut separates.
  const sourcePaths = chunkPaths(chunkGraph, sourceChunks, sinkChunks)
  const reached = new Set(sourcePaths.flat())
  const paths = [
    ...sourcePaths,
    ...chunkPaths(
      chunkGraph,
      sinkChunks.filter((c) => !reached.has(c)),
      sourceChunks,
    ),
  ]
  const pathMs = performance.now() - t

  t = performance.now()
  // A chunk holding points of both sides would seed both; such points seed with themselves.
  const shared = new Set(sinkChunks.filter((c) => sourceChunks.includes(c)))
  const unshared = [...new Set([...sourceChunks, ...sinkChunks])].filter((c) => !shared.has(c))
  const cellPaths = paths.map((path) =>
    path.map((chunk) => chunkOf(layout, BigInt(chunk))).filter((c) => c !== undefined),
  )
  const { boxes, cells } = boxesAlong(cellPaths, pad, layout)
  const [boxed, pieces] = await Promise.all([
    readSubgraphBoxes(graphene, request.root, boxes, SUBGRAPH_CONCURRENCY, options),
    chunkSupervoxels(graphene, unshared, options),
  ])
  const graph = withinCells(boxed, layout, cells)
  const subgraphMs = performance.now() - t

  const members = new Set<string>(graph.a)
  for (const sv of graph.b) members.add(sv)
  const seeds = (side: readonly Hit[]) => seedsOf(side, shared, pieces, members)
  return {
    graphene,
    layout,
    graph,
    supervoxelCount: members.size,
    supervoxels: {
      sources: sourceHits.map((h) => h.supervoxel),
      sinks: sinkHits.map((h) => h.supervoxel),
    },
    seeds: { sources: seeds(sourceHits), sinks: seeds(sinkHits) },
    path: cellPaths[0] ?? [],
    at,
    chunks: {
      path: new Set(paths.flat()).size,
      read: new Set(cellPaths.flat().map((c) => c.join(','))).size,
      boxes: boxes.length,
    },
    ms: { path: pathMs, subgraph: subgraphMs },
  }
}

/**
 * Seeds: each point's whole level-2 piece, not its one supervoxel. A point on a small piece
 * weakly attached to its own neuron otherwise starts a region of a few supervoxels, the two
 * neurons' bulk merges while neither holds a point, and that step is on neither point's way up
 * (FANC operation 158005: the source on 6 supervoxels, no candidate at all). A level-2 piece is
 * connected inside its chunk by construction.
 *
 * A point in a `shared` chunk (one holding points of both sides) seeds with its own supervoxel,
 * as does a point whose piece has nothing in the graph — so `splitSites` refuses that point by
 * name rather than saying no point was given.
 */
function seedsOf(
  hits: readonly Hit[],
  shared: ReadonlySet<string>,
  pieces: ReadonlyMap<string, readonly string[]>,
  members: ReadonlySet<string>,
): string[] {
  const seeds = new Set<string>()
  for (const h of hits) {
    const piece = shared.has(h.chunk)
      ? []
      : (pieces.get(h.chunk) ?? []).filter((sv) => members.has(sv))
    for (const sv of piece.length ? piece : [h.supervoxel]) seeds.add(sv)
  }
  return [...seeds]
}

/** Cut a read: the constrained cut, the candidates, the path scan, and where each one is. */
export async function cutSplitGraph(
  read: SplitGraphRead,
  cut: SplitCutOptions,
  options: CaveRequestOptions,
): Promise<SplitSitesReport> {
  let t = performance.now()
  const policy = cut.userMerges ?? 'trust'
  const result = splitSites({
    graph: read.graph,
    sources: read.seeds.sources,
    sinks: read.seeds.sinks,
    anchors: read.supervoxels,
    userMerges: policy,
    ...(cut.minPiece !== undefined ? { minPiece: cut.minPiece } : {}),
    ...(cut.maxCandidates !== undefined ? { maxCandidates: cut.maxCandidates } : {}),
  })
  let scanned: PathCut[] = []
  if (cut.pathScan !== undefined && result.ok) {
    // Each chunk cell's position along the first source's path; a supervoxel sits in its chunk's.
    const position = new Map<string, number>()
    for (const cell of read.path) {
      const key = cell.join(',')
      if (!position.has(key)) position.set(key, position.size)
    }
    scanned = pathCuts(
      read.graph,
      (sv) => {
        const cell = chunkOf(read.layout, BigInt(sv))
        return cell ? position.get(cell.join(',')) : undefined
      },
      cut.pathScan,
      policy,
    )
  }
  const cutMs = performance.now() - t

  t = performance.now()
  let sites: readonly SplitSite[] = []
  let candidates: PlacedCandidate[] = []
  let placedCuts: PlacedPathCut[] = []
  if (result.ok) {
    const placed = await placeCuts(
      read.graphene,
      [result.cut, ...result.candidates.map((c) => c.cut), ...scanned.map((c) => c.cut)],
      read.at,
      cut.siteRadiusNm ?? SITE_RADIUS_NM,
      options,
    )
    sites = placed[0]!
    candidates = result.candidates.map((candidate, i) => ({ candidate, sites: placed[1 + i]! }))
    placedCuts = scanned.map((pathCut, i) => ({
      pathCut,
      sites: placed[1 + result.candidates.length + i]!,
    }))
  }
  const placeMs = performance.now() - t

  return {
    result,
    sites,
    candidates,
    pathCuts: placedCuts,
    ms: { cut: cutMs, place: placeMs },
  }
}

/**
 * Cuts as sites: each cut supervoxel's level-2 chunk at `at` (a past root's chunks are its
 * parents at the root's own time — a later edit in the chunk renumbers them), the chunk's point
 * from the L2 cache, and `groupSites`. One parents request and one positions read for all cuts.
 */
export async function placeCuts(
  graphene: GrapheneSource,
  cuts: ReadonlyArray<readonly CutEdge[]>,
  at: Instant,
  radiusNm: number,
  options: CaveRequestOptions,
): Promise<SplitSite[][]> {
  const ends = [...new Set(cuts.flat().flatMap((edge) => [edge.source, edge.sink]))]
  const parents = await levelTwoParents(graphene, ends, at, options)
  const positions = await readL2Positions(
    graphene,
    parents.filter((p) => p !== '0'),
    options,
  )
  const parentOf = new Map(ends.map((sv, i) => [sv, parents[i]!]))
  return cuts.map((cut) =>
    groupSites(cut, (sv) => positions.get(parentOf.get(sv) ?? ''), radiusNm),
  )
}

/** Each chunk's neighbours, both ways, from a list of links (`chunkPaths`' graph). */
export function adjacencyOf(
  edges: ReadonlyArray<readonly [string, string]>,
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    const list = adjacency.get(a)
    if (list) list.push(b)
    else adjacency.set(a, [b])
  }
  for (const [a, b] of edges) {
    link(a, b)
    link(b, a)
  }
  return adjacency
}

/**
 * A shortest path of level-2 chunks from each source chunk to the nearest sink chunk, breadth
 * first, in order — one path per source. A source with no path to any sink gives the one-chunk
 * path of itself, and the cut then says `not-connected`, which is the true answer.
 */
export function chunkPaths(
  graph: ReadonlyMap<string, readonly string[]>,
  sources: readonly string[],
  sinks: readonly string[],
): string[][] {
  const targets = new Set(sinks)
  return sources.map((start) => {
    const cameFrom = new Map<string, string>([[start, start]])
    const queue = [start]
    let reached: string | undefined
    for (let head = 0; head < queue.length; head++) {
      const here = queue[head]!
      if (targets.has(here)) {
        reached = here
        break
      }
      for (const next of graph.get(here) ?? []) {
        if (cameFrom.has(next)) continue
        cameFrom.set(next, here)
        queue.push(next)
      }
    }
    if (reached === undefined) return [start]
    const path: string[] = []
    for (let here = reached; here !== start; here = cameFrom.get(here)!) path.push(here)
    path.push(start)
    return path.reverse()
  })
}

/**
 * Boxes in base voxels along the paths, and the chunk cells the graph is cut back to.
 *
 * The cells are the paths' own, grown by `pad` on every side. The boxes are runs of consecutive
 * path cells, each grown until it would pass `MAX_RUN_CELLS` on an axis, then by `pad` — and then
 * one more box for every two neighbouring cells no box yet holds together.
 *
 * **Every two cells that share a face must share a box**, because `subgraph` keeps only edges with
 * both ends inside its box (`only_internal_edges`), and supervoxels touch only across a face.
 * Boxes that merely tile the path drop every edge crossing from one to the next — all nine FANC
 * test splits read as not joined that way. A run starts on the cell the last one ended on, which
 * holds each step of the path; the extra pair boxes hold the rest (two paths side by side, a path
 * coming back beside itself, the padding). Runs, not a box per pair, so an inner cell is read once.
 */
export function boxesAlong(
  paths: ReadonlyArray<readonly Triple[]>,
  pad: number,
  layout: BoxableLayout,
): { boxes: GraphBox[]; cells: Set<string> } {
  const ranges: Array<{ lo: number[]; hi: number[] }> = []
  const seen = new Set<string>()
  const add = (cells: readonly (readonly number[])[], grow: number) => {
    const lo = [0, 1, 2].map((a) => Math.max(0, Math.min(...cells.map((c) => c[a]!)) - grow))
    const hi = [0, 1, 2].map((a) => Math.max(...cells.map((c) => c[a]!)) + grow)
    const key = `${lo.join(',')}:${hi.join(',')}`
    if (seen.has(key)) return
    seen.add(key)
    ranges.push({ lo, hi })
  }
  const fits = (cells: readonly Triple[]) =>
    [0, 1, 2].every(
      (a) =>
        Math.max(...cells.map((c) => c[a]!)) - Math.min(...cells.map((c) => c[a]!)) <
        MAX_RUN_CELLS,
    )
  for (const path of paths) {
    // Steps within one chunk cell are one cell.
    const cells = path.filter((c, i) => i === 0 || c.join(',') !== path[i - 1]!.join(','))
    if (cells.length === 0) continue
    let run: Triple[] = [cells[0]!]
    for (const cell of cells.slice(1)) {
      if (fits([...run, cell])) run.push(cell)
      else {
        add(run, pad)
        run = [run.at(-1)!, cell]
      }
    }
    add(run, pad)
  }

  const cells = nearPath(paths, pad)
  const holds = (r: { lo: number[]; hi: number[] }, c: readonly number[]) =>
    c.every((v, a) => v >= r.lo[a]! && v <= r.hi[a]!)
  for (const key of cells) {
    const cell = key.split(',').map(Number)
    for (let axis = 0; axis < 3; axis++) {
      const next = cell.map((v, a) => (a === axis ? v + 1 : v))
      if (!cells.has(next.join(','))) continue
      if (!ranges.some((r) => holds(r, cell) && holds(r, next))) add([cell, next], 0)
    }
  }
  return { boxes: ranges.map((r) => cellBox(layout, r.lo, r.hi)), cells }
}

/**
 * The chunk cells on the paths, grown by `pad` on every side — what the graph is cut over.
 *
 * A run box is wider than the path where the path turns, and the cells beside it change the
 * answer: with them, Aedes root 648518347672268769's weakest join (0.12) was routed around and the
 * candidates shifted. Every result in `docs/split-sites-plan.md` was measured on the path's own
 * cells, so the graph is cut back to them; the run boxes only save requests.
 */
function nearPath(paths: ReadonlyArray<readonly Triple[]>, pad: number): Set<string> {
  const keep = new Set<string>()
  for (const [x, y, z] of paths.flat()) {
    for (let dx = -pad; dx <= pad; dx++)
      for (let dy = -pad; dy <= pad; dy++)
        for (let dz = -pad; dz <= pad; dz++) keep.add(`${x + dx},${y + dy},${z + dz}`)
  }
  return keep
}

/** The edges whose two supervoxels both sit in one of `cells` (by the supervoxel's chunk). */
function withinCells(
  graph: SupervoxelGraph,
  layout: GraphLayout,
  cells: ReadonlySet<string>,
): SupervoxelGraph {
  const inside = new Map<string, boolean>()
  const isInside = (sv: string): boolean => {
    let known = inside.get(sv)
    if (known === undefined) {
      const cell = chunkOf(layout, BigInt(sv))
      known = cell !== undefined && cells.has(cell.join(','))
      inside.set(sv, known)
    }
    return known
  }
  return subgraphWhere(graph, isInside)
}

/** A point resolved: the supervoxel of this neuron nearest it, and that supervoxel's chunk. */
interface Hit {
  readonly supervoxel: string
  readonly chunk: string
}

/** Every label within `LOOKUP_REACH` of a point, nearest first (distance in nm). */
async function labelsNear(
  base: string,
  scale: VolumeScale,
  pointNm: Triple,
  bucket: { signal?: AbortSignal },
): Promise<string[]> {
  const voxel = pointNm.map((nm, axis) => nm / scale.resolution[axis]!) as unknown as Triple
  const lo = voxel.map((v, axis) =>
    Math.max(scale.voxelOffset[axis]!, Math.floor(v) - LOOKUP_REACH[axis]!),
  ) as unknown as [number, number, number]
  const hi = voxel.map((v, axis) =>
    Math.min(
      scale.voxelOffset[axis]! + scale.size[axis]!,
      Math.floor(v) + LOOKUP_REACH[axis]! + 1,
    ),
  ) as unknown as [number, number, number]
  if (lo.some((v, axis) => v >= hi[axis]!)) return []
  const box = await readLabelBox(base, scale, { lo, hi }, bucket)
  const nearest = new Map<number, number>()
  const [sx, sy] = box.size
  for (let i = 0; i < box.index.length; i++) {
    const slot = box.index[i]!
    if (box.labels[slot] === 0n) continue
    const x = lo[0] + (i % sx)
    const y = lo[1] + (Math.floor(i / sx) % sy)
    const z = lo[2] + Math.floor(i / (sx * sy))
    // Distance in nm, so an anisotropic voxel does not favour the coarse axis.
    const d =
      ((x + 0.5 - voxel[0]) * scale.resolution[0]) ** 2 +
      ((y + 0.5 - voxel[1]) * scale.resolution[1]) ** 2 +
      ((z + 0.5 - voxel[2]) * scale.resolution[2]) ** 2
    if (d < (nearest.get(slot) ?? Infinity)) nearest.set(slot, d)
  }
  return [...nearest.entries()]
    .sort((p, q) => p[1] - q[1])
    .map(([slot]) => String(box.labels[slot]))
}

/**
 * Per point, the nearest label whose level-2 chunk at the root's time is one of the neuron's — or
 * undefined. Every point's labels in one parents request. What the server's
 * `handle_supervoxel_id_lookup` does for a split, done here because the cut is ours.
 */
async function nearestOwnLabels(
  graphene: GrapheneSource,
  labelsPerPoint: readonly (readonly string[])[],
  at: number,
  ownChunks: ReadonlySet<string>,
  options: CaveRequestOptions,
): Promise<Array<Hit | undefined>> {
  const all = [...new Set(labelsPerPoint.flat())]
  const parents = await levelTwoParents(graphene, all, at, options)
  const chunkOfLabel = new Map(all.map((label, i) => [label, parents[i]!]))
  return labelsPerPoint.map((labels) => {
    const supervoxel = labels.find((label) => ownChunks.has(chunkOfLabel.get(label) ?? '0'))
    return supervoxel ? { supervoxel, chunk: chunkOfLabel.get(supervoxel)! } : undefined
  })
}
