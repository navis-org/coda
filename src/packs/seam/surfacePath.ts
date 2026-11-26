/**
 * Find path's route along the neuron's mesh surface (`docs/find-path-plan.md`), in place of the
 * straight lines between level-2 chunk points, which cut corners and leave the neuron at a bend.
 *
 * A shortest path over the mesh's edges (A*, edge length in nm, the straight distance to the end as
 * the estimate) from the vertex nearest the start to the vertex nearest the end, **kept to the
 * route**: only vertices in a grid cell the route passes through, and — where the chunks have their
 * own points (`SplitNeuron.placed`) — a vertex whose nearest chunk (`nearestChunks`, as the split
 * gallery colours) is off the route costs `OFF_ROUTE_COST` times its length, so the path does not
 * take a shorter way along another branch through the same cells. A cost, not a wall: near a chunk
 * border a vertex is often nearest another branch's chunk point, and forbidding those cut the
 * route's corridor apart on every live neuron tried (648518347493136877: 4,222 vertices reachable of
 * 37,815). Thinned to a point every `KEEP_NM`, each piece given the drawn step its chunk belongs to,
 * as `pathSteps` gives a join inside chunk `i` to step `i − 1`. Undefined where the mesh holds no
 * such path — a missing fragment, a route on chunks the reduced mesh lost — and the straight lines
 * stay.
 *
 * Two halves, so a caller trying several bridge widths (`BRIDGE_NM`) pays the per-vertex work once:
 * `prepareSurface` (the corridor, the end vertices, the mesh's own edges and pieces) and
 * `surfaceRoute` (the bridges at one width, the search, the thinning).
 *
 * It is a drawing only: the steps' strengths are the supervoxel graph's (`pathSteps`), whatever
 * the line runs along. And a surface path runs along one side of the neurite, not its middle.
 *
 * **The same search runs along a skeleton** (`RouteMesh.lines`: its parent links in place of
 * triangles), for the route down the neurite's middle that thickness is read along
 * (`skeletonThickness.ts`): a wavefront skeleton of a graphene mesh is in as many pieces as the mesh,
 * and wants the same corridor, bridges and thinning.
 */

import type { BoxableLayout } from '../../data/cave/graphLayout'
import { cellAt } from '../../data/cave/graphLayout'
import type { Triple } from '../../data/precomputed/volume'
// The grid key guarded against a double's precision (`GRID_SPREAD`, `keyBound` in its tests).
import { cellKey } from '../../nodes/lib/topologyOps'
import { findRoot, MaxHeap, unite } from './splitSites'
import type { SplitNeuron } from './splitGalleryRun'

/**
 * The least distance between two kept points of the drawn path, nm. A skeleton's route keeps every
 * node (`RouteMesh.lines`): its nodes are ~100 nm apart already, and a piece's thickness is read
 * from its nodes — a neck shorter than half a 250 nm piece would vanish in its median.
 */
const KEEP_NM = 250

/**
 * How far a bridge between two pieces of the mesh may reach, nm, tried in turn until the ends are
 * joined. The gaps the mesh's reduction leaves differ by neuron: measured on four Aedes neurons
 * (2026-11-24), 300 nm joined two, 600 a third, 1,200 the fourth. A bridge costs its length, so the
 * path still keeps to the surface where it can. Not wider: 2,400 nm took 7.9 s on the main thread
 * where 1,200 took 1.3 s, and no neuron needed it.
 */
export const BRIDGE_NM = [300, 600, 1200] as const
/** Bridges from one vertex: its nearest few in other pieces. */
const BRIDGES_PER_VERTEX = 3
/** A step onto a vertex whose nearest chunk is off the route costs this many times its length. */
const OFF_ROUTE_COST = 4

/** The mesh as the split gallery reads it: vertices, triangles, and each vertex's nearest chunk. */
export interface RouteMesh {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  /** `indices` holds line segments, two a piece — a skeleton's parent links — not triangles. */
  readonly lines?: boolean | undefined
  /** Each vertex's nearest chunk, as an index into `chunks`; −1 for none (`nearestChunks`). */
  readonly nearest: Int32Array
  /**
   * The chunks `nearest` indexes — the neuron read it was matched against, carried with it: a
   * neuron read again may list its chunks in another order.
   */
  readonly chunks: readonly string[]
}

/** The drawn path: its points, and for each piece `points[k]`→`points[k + 1]` its step. */
export interface SurfaceRoute {
  readonly points: Triple[]
  readonly steps: number[]
  /** For each piece, the mesh vertices of the path it covers: where its thickness is measured. */
  readonly vertices: number[][]
}

/** What does not depend on the bridge width: built once per route (`prepareSurface`). */
export interface PreparedSurface {
  readonly positions: Float32Array
  /** Each vertex's place on the route — its chunk's, else its cell's — or −1 off the route's cells. */
  readonly placeOf: Int32Array
  /** How much a step onto each vertex costs per nm. */
  readonly cost: Float32Array
  /** The vertices in the route's cells. */
  readonly allowed: Int32Array
  /** The mesh's own edges among them, compressed: `next[first[v] … first[v + 1]]`. */
  readonly first: Uint32Array
  readonly next: Uint32Array
  /** Each allowed vertex's piece of the mesh, as its root (`findRoot`, settled). */
  readonly piece: Int32Array
  readonly start: number
  readonly end: number
  readonly fromNm: Triple
  readonly toNm: Triple
  readonly stepCount: number
  /** The least distance between two kept points: `KEEP_NM`, or 0 along a skeleton. */
  readonly keepNm: number
}

export function prepareSurface(
  mesh: RouteMesh,
  neuron: SplitNeuron,
  layout: BoxableLayout,
  route: readonly string[],
  fromNm: Triple,
  toNm: Triple,
): PreparedSurface | undefined {
  const stepCount = route.length - 1
  if (stepCount < 1) return undefined
  const { positions, indices, nearest, chunks } = mesh
  const count = positions.length / 3

  // Where on the route each cell and each chunk is: the first time the route reaches it.
  const atChunk = new Map<string, number>()
  const atCell = new Map<number, number>()
  route.forEach((chunk, i) => {
    if (!atChunk.has(chunk)) atChunk.set(chunk, i)
    const cell = neuron.cells.get(chunk)
    if (cell && !atCell.has(cellKey(...cell))) atCell.set(cellKey(...cell), i)
  })
  const ownPoints = neuron.placed === 'l2cache'
  const placeOf = new Int32Array(count).fill(-1)
  const cost = new Float32Array(count).fill(1)
  const allowed: number[] = []
  let start = -1
  let end = -1
  let startD = Infinity
  let endD = Infinity
  for (let v = 0; v < count; v++) {
    const [x, y, z] = [positions[3 * v]!, positions[3 * v + 1]!, positions[3 * v + 2]!]
    const inCell = atCell.get(
      cellKey(cellAt(layout, x, 0), cellAt(layout, y, 1), cellAt(layout, z, 2)),
    )
    if (inCell === undefined) continue
    const chunk = ownPoints && nearest[v]! >= 0 ? chunks[nearest[v]!] : undefined
    const onRoute = chunk === undefined ? undefined : atChunk.get(chunk)
    placeOf[v] = onRoute ?? inCell
    if (ownPoints && onRoute === undefined) cost[v] = OFF_ROUTE_COST
    allowed.push(v)
    const toStart = (x - fromNm[0]) ** 2 + (y - fromNm[1]) ** 2 + (z - fromNm[2]) ** 2
    const toEnd = (x - toNm[0]) ** 2 + (y - toNm[1]) ** 2 + (z - toNm[2]) ** 2
    if (toStart < startD) [start, startD] = [v, toStart]
    if (toEnd < endD) [end, endD] = [v, toEnd]
  }
  if (start < 0 || end < 0) return undefined

  // The mesh's own edges among allowed vertices, both ways, compressed; and its pieces.
  const piece = new Int32Array(count)
  for (let v = 0; v < count; v++) piece[v] = v
  const first = new Uint32Array(count + 1)
  // A triangle's three sides, or a segment's one.
  const corners = mesh.lines ? 2 : 3
  const sides = mesh.lines ? 1 : 3
  const eachEdge = (visit: (p: number, q: number) => void) => {
    for (let t = 0; t < indices.length; t += corners) {
      for (let k = 0; k < sides; k++) {
        const p = indices[t + k]!
        const q = indices[t + ((k + 1) % corners)]!
        if (placeOf[p]! >= 0 && placeOf[q]! >= 0) {
          visit(p, q)
          visit(q, p)
        }
      }
    }
  }
  eachEdge((p, q) => {
    first[p + 1] = first[p + 1]! + 1
    unite(piece, p, q)
  })
  for (let v = 0; v < count; v++) first[v + 1] = first[v + 1]! + first[v]!
  const next = new Uint32Array(first[count]!)
  const fill = first.slice(0, count)
  eachEdge((p, q) => {
    next[fill[p]!] = q
    fill[p] = fill[p]! + 1
  })
  // Each vertex's piece, settled: the bridges and the joined-ends test read it per vertex.
  for (const v of allowed) piece[v] = findRoot(piece, v)
  return {
    positions,
    placeOf,
    cost,
    allowed: Int32Array.from(allowed),
    first,
    next,
    piece,
    start,
    end,
    fromNm,
    toNm,
    stepCount,
    keepNm: mesh.lines ? 0 : KEEP_NM,
  }
}

/** The route along the surface with bridges up to `bridgeNm`, or undefined where none joins it. */
export function surfaceRoute(
  prepared: PreparedSurface,
  bridgeNm: number,
): SurfaceRoute | undefined {
  const { positions, placeOf, stepCount, fromNm, toNm, piece, start, end } = prepared
  const bridges = bridgesOf(prepared, bridgeNm)
  // Joined at this width? Pieces united across the bridges: no search where they are not.
  const joined = piece.slice()
  for (const [v, list] of bridges) for (const w of list) unite(joined, v, w)
  if (findRoot(joined, start) !== findRoot(joined, end)) return undefined
  const path = shortestPath(prepared, bridges)
  if (!path) return undefined

  // Thinned: the start point, every vertex `keepNm` on from the last kept, the end point.
  const points: Triple[] = [fromNm]
  const steps: number[] = []
  const vertices: number[][] = []
  const stepOf = (v: number) => Math.min(Math.max(placeOf[v]! - 1, 0), stepCount - 1)
  let last: Triple = fromNm
  let run: number[] = []
  for (let k = 0; k < path.length; k++) {
    const v = path[k]!
    const at = vertexAt(positions, v)
    run.push(v)
    if (k < path.length - 1 && distance(at, last) < prepared.keepNm) continue
    points.push(at)
    steps.push(stepOf(v))
    vertices.push(run)
    run = [v]
    last = at
  }
  points.push(toNm)
  steps.push(stepCount - 1)
  vertices.push(run)
  return { points, steps, vertices }
}

/**
 * The route at each bridge width in turn (`BRIDGE_NM`), the first that joins it, or undefined.
 * `between` is awaited before each width — a pause for the browser, say — and stops the search
 * where it answers false.
 */
export async function bridgedRoute(
  prepared: PreparedSurface,
  between: () => Promise<boolean> = () => Promise.resolve(true),
): Promise<SurfaceRoute | undefined> {
  for (const bridgeNm of BRIDGE_NM) {
    if (!(await between())) return undefined
    const route = surfaceRoute(prepared, bridgeNm)
    if (route) return route
  }
  return undefined
}

function distance(a: Triple, b: Triple): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  const dz = a[2] - b[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function vertexAt(positions: Float32Array, v: number): Triple {
  return [positions[3 * v]!, positions[3 * v + 1]!, positions[3 * v + 2]!]
}

/** Squared distance between vertex `v` and a point, without building either as an array. */
function squaredTo(
  positions: Float32Array,
  v: number,
  x: number,
  y: number,
  z: number,
): number {
  const dx = positions[3 * v]! - x
  const dy = positions[3 * v + 1]! - y
  const dz = positions[3 * v + 2]! - z
  return dx * dx + dy * dy + dz * dz
}

/**
 * Bridges between the mesh's pieces: a graphene mesh is one piece per chunk fragment, meshed and
 * reduced apart, so no vertex is shared where two meet (648518347493136877: 507 pieces, not one
 * position in common). Each allowed vertex to its nearest `BRIDGES_PER_VERTEX` of *other* pieces
 * within `bridgeNm`, found on a grid of `bridgeNm` squares. From every allowed vertex, not only
 * those on an open edge: the pieces are closed where they meet (bridging from open edges joined one
 * of four live neurons).
 */
function bridgesOf(prepared: PreparedSurface, bridgeNm: number): Map<number, number[]> {
  const { positions, allowed, piece } = prepared
  const square = (v: number, a: number) => Math.floor(positions[3 * v + a]! / bridgeNm)
  const grid = new Map<number, number[]>()
  for (const v of allowed) {
    const key = cellKey(square(v, 0), square(v, 1), square(v, 2))
    const list = grid.get(key)
    if (list) list.push(v)
    else grid.set(key, [v])
  }
  const bridges = new Map<number, number[]>()
  const link = (a: number, b: number) => {
    const list = bridges.get(a)
    if (list) list.push(b)
    else bridges.set(a, [b])
  }
  const limit = bridgeNm * bridgeNm
  // The nearest few so far, kept sorted: [distance², vertex].
  const best: Array<[number, number]> = []
  for (const v of allowed) {
    const mine = piece[v]!
    const [x, y, z] = vertexAt(positions, v)
    const [sx, sy, sz] = [square(v, 0), square(v, 1), square(v, 2)]
    best.length = 0
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const cell = grid.get(cellKey(sx + dx, sy + dy, sz + dz))
          if (!cell) continue
          for (const w of cell) {
            if (piece[w] === mine) continue
            const d = squaredTo(positions, w, x, y, z)
            if (d > limit) continue
            if (best.length === BRIDGES_PER_VERTEX && d >= best[best.length - 1]![0]) continue
            let i = Math.min(best.length, BRIDGES_PER_VERTEX - 1)
            best[i] = [d, w]
            while (i > 0 && best[i - 1]![0] > d) {
              ;[best[i - 1], best[i]] = [best[i]!, best[i - 1]!]
              i--
            }
          }
        }
    for (const [, w] of best) {
      link(v, w)
      link(w, v)
    }
  }
  return bridges
}

/**
 * A* among allowed vertices over the mesh's edges and `bridges`, each step costing its length times
 * the cost of the vertex it reaches, the straight distance to the end as the estimate (never more
 * than the cost, every step costing at least its length): the vertices from start to end, or
 * undefined where none joins them.
 */
function shortestPath(
  prepared: PreparedSurface,
  bridges: ReadonlyMap<number, readonly number[]>,
): number[] | undefined {
  const { positions, cost, first, next, start, end } = prepared
  const count = cost.length
  const [gx, gy, gz] = vertexAt(positions, end)
  const estimate = (v: number) => Math.sqrt(squaredTo(positions, v, gx, gy, gz))
  const so = new Float64Array(count).fill(Infinity)
  const from = new Int32Array(count).fill(-1)
  // Each entry carries the cost it was pushed with: a stale one is told by that alone.
  const heap = new MaxHeap<{ score: number; v: number; so: number }>()
  so[start] = 0
  heap.push({ score: -estimate(start), v: start, so: 0 })
  const relax = (v: number, w: number) => {
    const [x, y, z] = [positions[3 * v]!, positions[3 * v + 1]!, positions[3 * v + 2]!]
    const d = so[v]! + cost[w]! * Math.sqrt(squaredTo(positions, w, x, y, z))
    if (d < so[w]!) {
      so[w] = d
      from[w] = v
      heap.push({ score: -(d + estimate(w)), v: w, so: d })
    }
  }
  for (let top = heap.pop(); top; top = heap.pop()) {
    const v = top.v
    if (v === end) break
    if (top.so > so[v]!) continue
    for (let i = first[v]!; i < first[v + 1]!; i++) relax(v, next[i]!)
    for (const w of bridges.get(v) ?? []) relax(v, w)
  }
  if (!Number.isFinite(so[end]!)) return undefined
  const path: number[] = []
  for (let v = end; v !== -1; v = from[v]!) path.push(v)
  return path.reverse()
}
