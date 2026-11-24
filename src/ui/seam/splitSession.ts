/**
 * The split gallery's session: the split key (`K`) over a segment in a Neuroglancer card asks for
 * the splits near that point (`docs/split-gallery-plan.md`). One for the whole app, like Submit's
 * merge session, so the overlay (`SplitGalleryHost`) outlives the card that opened it.
 *
 * **What it reads, and when.** Per neuron, its level-2 graph and chunk points (`readSplitNeuron`)
 * and its mesh; per point, one box (`readSplitBox`). A few of each are kept, so a second press near
 * the first reads nothing. **Once the key has been used** — never before, so somebody who never
 * splits puts no load on a shared server — the pointer resting on a segment in a card that can
 * split reads ahead (`splitPointer`, fed by `splitKey.ts`): the neuron, its mesh, and the box
 * under the pointer, one box read in flight at a time. The box read is most of the wait (median
 * 2.4 s), so reading ahead is what makes the gallery quick.
 *
 * **A shared read carries nobody's signal** (CLAUDE.md, backends): the session closing does not
 * cancel a read another press may want; a read nobody wants any more just lands in the cache.
 *
 * The candidates are computed on the main thread a slice at a time (`splitCandidates` yields
 * between joins), each shown as it comes.
 */

import { LruMap } from '../../core/lruMap'
import { errorMessage } from '../../core/errors'
import { SLICE_MS, yieldToBrowser } from '../../core/slice'
import type { CaveRequestOptions } from '../../data/cave/client'
import { datastackRecord } from '../../data/cave/datastack'
import type { GrapheneSource } from '../../data/cave/graphene'
import type { GrapheneMeshSource } from '../../data/cave/meshes'
import type { Reduction } from '../../data/meshDecimate'
import {
  fragmentConcurrencyFor,
  openGrapheneMeshes,
  readGrapheneMesh,
} from '../../data/cave/meshes'
import type { CaveScope } from '../../nodes/lib/caveParams'
import { chunkSupervoxels } from '../../data/cave/rootIds'
import { NoAffinitiesError } from '../../data/cave/subgraph'
import { findSupervoxels } from '../../data/cave/volumes'
import { channel } from '../../data/channel'
import { memoPromise } from '../../data/memoPromise'
import type { MeshArrays } from '../../data/meshParts'
import type { Triple, VolumeInfo } from '../../data/precomputed/volume'
import { openVolume, readLabelBox, scaleNear } from '../../data/precomputed/volume'
import type { ExactVertices, PlacedLabels } from '../../packs/seam/splitColours'
import { nearestChunksOf, supervoxelsAtVertices } from '../../packs/seam/splitColours'
import type {
  SplitCandidate,
  SplitGalleryInput,
  SplitSide,
} from '../../packs/seam/splitGallery'
import { chunkOfMembers, splitCandidates } from '../../packs/seam/splitGallery'
import type { BoxableLayout } from '../../data/cave/graphLayout'
import { cellBox, isBoxable } from '../../data/cave/graphLayout'
import type { SplitNeuron } from '../../packs/seam/splitGalleryRun'
import type { RouteMesh } from '../../packs/seam/surfacePath'
import { readSplitBox, readSplitNeuron, splitBoxCells } from '../../packs/seam/splitGalleryRun'
import { useGraphStore } from '../../store/graphStore'
import { isTourActive } from '../tour/tourState'
import { REST_MS } from '../viewers/segmentHover'

/** Where a card's neurons live: a CAVE Dataset's deployment and datastack (`caveScopeOf`). */
export type SplitTarget = CaveScope

/** A Neuroglancer card, by the document it is in and its node: node ids repeat across documents. */
export interface SplitCard {
  readonly docId: string
  readonly nodeId: string
}

/** The neuron and the point the key was pressed over. */
export interface SplitRequest extends SplitTarget {
  readonly root: string
  readonly pointNm: Triple
  /**
   * The card the key was pressed over, by document and node: where a split's new roots are shown
   * (`splitAccept.ts`). Absent where the card cannot write its neurons.
   */
  readonly card?: SplitCard | undefined
}

export type SplitSession =
  | { readonly phase: 'reading'; readonly request: SplitRequest }
  | {
      readonly phase: 'computing' | 'ready'
      readonly request: SplitRequest
      readonly candidates: readonly SplitCandidate[]
      /**
       * The box the candidates were found in — the neuron's level-2 chunks and their points for
       * the tiles, and what Accept writes from (`splitAccept.ts`) — and its chunkedgraph.
       */
      readonly input: SplitGalleryInput
      readonly graphene: GrapheneSource
      /** Which set of splits this is: 1 for the press's, one more for each Regenerate. */
      readonly round: number
      /** A Regenerate found nothing more: these are the last splits there are near the point. */
      readonly exhausted?: boolean
      /** A Regenerate is looking for the next set; the set on show stays meanwhile. */
      readonly regenerating?: boolean
    }
  | { readonly phase: 'failed'; readonly request: SplitRequest; readonly message: string }

export interface Chunkedgraph {
  readonly graphene: GrapheneSource
  readonly layout: BoxableLayout
  /** The supervoxel volume's base URL, for the labels under a cut (`labels`). */
  readonly base: string
}

/** The reads and the clock, injected in tests. */
export interface SplitServices {
  chunkedgraph(target: SplitTarget, options: CaveRequestOptions): Promise<Chunkedgraph>
  neuron(graph: Chunkedgraph, root: string, options: CaveRequestOptions): Promise<SplitNeuron>
  box(
    graph: Chunkedgraph,
    neuron: SplitNeuron,
    pointNm: Triple,
    options: CaveRequestOptions,
  ): Promise<SplitGalleryInput>
  /** The neuron's mesh, reduced for tiles. */
  mesh(target: SplitTarget, root: string): Promise<MeshArrays>
  /** The segmentation over one grid cell, for the vertices there (`supervoxelsAtVertices`). */
  labels(graph: Chunkedgraph, cell: Triple): Promise<PlacedLabels>
  /** Each level-2 chunk's supervoxels (`leaves_many`), for chunks outside the press's box. */
  chunkSupervoxels(
    graph: Chunkedgraph,
    chunks: readonly string[],
    options: CaveRequestOptions,
  ): Promise<Map<string, string[]>>
  pause(): Promise<void>
  now(): number
}

/** The neuron's mesh for the tiles, each vertex with the level-2 chunk it takes its side from. */
export type SplitMesh = RouteMesh

export type SplitMeshState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly mesh: SplitMesh }
  | { readonly status: 'failed'; readonly message: string }

/**
 * Triangles a tile's mesh keeps. Six tiles draw it at once, each with its own colours; past this a
 * thumbnail spends the frame on detail too small to see.
 */
export const TILE_TRIANGLES = 400_000

/** Mesh fragments fetched at once: one neuron, so the whole budget (`fragmentConcurrencyFor`). */
const MESH_FRAGMENTS_IN_FLIGHT = fragmentConcurrencyFor(1)

/** The segmentation scale the labels under a cut are read at, nm. */
const LABEL_NM = 32
/** Each supervoxel volume's `info`, opened once. */
const volumes = new Map<string, Promise<VolumeInfo>>()

export const targetKey = (t: SplitTarget) => `${t.deployment}|${t.datastack}`
export const optionsOf = (target: SplitTarget): CaveRequestOptions => ({
  deployment: target.deployment,
})

/** Where a datastack's meshes are, found once per datastack (`openGrapheneMeshes` reads `info`). */
const meshSources = new Map<string, Promise<GrapheneMeshSource | undefined>>()

/**
 * A neuron's mesh from the chunkedgraph's own mesh service, as the split's reads are: any CAVE
 * datastack with a chunkedgraph has one, wired into Coda's Dataset table (`spec.ts`) or not.
 * Reduced to `reduction`, or at full resolution without one.
 */
async function readMesh(
  target: SplitTarget,
  root: string,
  reduction: Reduction | undefined,
): Promise<MeshArrays> {
  const options = optionsOf(target)
  const source = await memoPromise(
    meshSources,
    targetKey(target),
    async () => {
      const segmentation = (await datastackRecord(target.datastack, options))
        .segmentation_source
      return segmentation ? openGrapheneMeshes(segmentation, options) : undefined
    },
    { keep: 'resolved' },
  )
  if (!source) throw new Error(`${target.datastack} publishes no meshes.`)
  const { mesh } = await readGrapheneMesh(
    source,
    root,
    reduction,
    MESH_FRAGMENTS_IN_FLIGHT,
    options,
  )
  if (!mesh) throw new Error(`${root} has no mesh.`)
  return mesh
}

/**
 * A neuron's mesh at full resolution — for measuring its thickness (find path's skeleton), where
 * the tiles' reduction (`TILE_TRIANGLES`, vertex clustering on a grid) would merge a thin neck's
 * walls. Not kept: what is built from it is (a big one is many times the tiles' size), and its
 * buffers are the caller's to hand over.
 */
export function fullMeshOf(target: SplitTarget, root: string): Promise<MeshArrays> {
  return readMesh(target, root, undefined)
}

const LIVE: SplitServices = {
  async chunkedgraph(target, options) {
    const { graphene, layout, base } = await findSupervoxels(target.datastack, options)
    if (!isBoxable(layout)) {
      throw new Error(
        `${target.datastack}'s chunkedgraph publishes no chunk grid, so there is no box to read ` +
          'around a point.',
      )
    }
    return { graphene, layout, base }
  },
  async labels(graph, cell) {
    // The segmentation at ~32 nm over one grid cell: fine enough to tell supervoxels apart at a
    // vertex, a tenth of the base scale's voxels on Aedes (16 nm).
    const volume = await memoPromise(volumes, graph.base, () => openVolume(graph.base), {
      keep: 'resolved',
    })
    const scale = scaleNear(volume, LABEL_NM)
    const [vlo, vhi] = cellBox(graph.layout, cell, cell)
    const nm = (voxel: Triple, end: 0 | 1) =>
      voxel.map((v, a) => (v + end) * graph.layout.baseResolutionNm[a]!)
    const lo = nm(vlo, 0).map((v, a) =>
      Math.max(scale.voxelOffset[a]!, Math.floor(v / scale.resolution[a]!)),
    ) as unknown as Triple
    const hi = nm(vhi, 1).map((v, a) =>
      Math.min(scale.voxelOffset[a]! + scale.size[a]!, Math.ceil(v / scale.resolution[a]!)),
    ) as unknown as Triple
    const box = await readLabelBox(graph.base, scale, { lo, hi })
    return { box, lo, resolution: scale.resolution }
  },
  chunkSupervoxels: (graph, chunks, options) =>
    chunkSupervoxels(graph.graphene, chunks, options),
  neuron: (graph, root, options) =>
    readSplitNeuron(graph.graphene, graph.layout, root, options),
  box: (graph, neuron, pointNm, options) =>
    readSplitBox(graph.graphene, graph.layout, neuron, pointNm, options),
  mesh: (target, root) => readMesh(target, root, { targetTriangles: TILE_TRIANGLES }),
  pause: yieldToBrowser,
  now: () => performance.now(),
}

let services = LIVE
let session: SplitSession | undefined
/** The current press's mesh, apart from the session: it lands on its own clock. */
let meshState: SplitMeshState | undefined
/** The current press's vertices placed exactly, once its candidates and mesh are both in. */
let exactState: ExactVertices | undefined
/** The press the session belongs to; an older press's late answer is dropped. */
let press: object | undefined
/** Whether the key has been used: reading ahead waits for it. */
let armed = false
const changed = channel()

/** Datastacks whose chunkedgraph publishes no affinities (pychunkedgraph 1.x), and what it said. */
const refused = new Map<string, string>()
const graphs = new Map<string, Promise<Chunkedgraph>>()
// A handful of each: neurons and boxes are a few MB, a mesh up to `TILE_TRIANGLES`.
const neurons = new LruMap<string, Promise<SplitNeuron>>(4)
const boxes = new LruMap<string, Promise<SplitGalleryInput>>(3)
const meshes = new LruMap<string, Promise<SplitMesh>>(2)
let readingAhead = false

/**
 * A datastack's chunkedgraph, read once — shared with the find-path key (`findPathSession.ts`), so
 * F and K pressed over one neuron read it once between them.
 */
export function graphOf(target: SplitTarget): Promise<Chunkedgraph> {
  return memoPromise(
    graphs,
    targetKey(target),
    () => services.chunkedgraph(target, optionsOf(target)),
    { keep: 'resolved' },
  )
}

/** A neuron's level-2 graph and points, kept for the last few (`neurons`); shared as `graphOf` is. */
export async function neuronOf(target: SplitTarget, root: string): Promise<SplitNeuron> {
  const graph = await graphOf(target)
  return memoPromise(
    neurons,
    `${targetKey(target)}|${root}`,
    () => services.neuron(graph, root, optionsOf(target)),
    { keep: 'resolved' },
  )
}

async function boxOf(request: SplitRequest): Promise<SplitGalleryInput> {
  const graph = await graphOf(request)
  const neuron = await neuronOf(request, request.root)
  // Keyed by the box's cells, so any point inside one box reuses it — but the point the
  // candidates walk out from is this request's, not the one the box was first read for.
  const cells = splitBoxCells(graph.layout, request.pointNm).wide.flat().join(',')
  const box = await memoPromise(
    boxes,
    `${targetKey(request)}|${request.root}|${cells}`,
    () => services.box(graph, neuron, request.pointNm, optionsOf(request)),
    { keep: 'resolved' },
  )
  return { ...box, click: request.pointNm }
}

/**
 * A neuron's reduced mesh, each vertex with its nearest chunk — kept for the last two, and shared
 * as `graphOf` is: find path runs its route along it (`findPathSession.ts`).
 */
export function meshOf(target: SplitTarget, root: string): Promise<SplitMesh> {
  return memoPromise(
    meshes,
    `${targetKey(target)}|${root}`,
    async () => {
      const [mesh, neuron, graph] = await Promise.all([
        services.mesh(target, root),
        neuronOf(target, root),
        graphOf(target),
      ])
      // Each vertex's nearest chunk among those in its own grid cell (`nearestChunks`).
      return {
        ...mesh,
        chunks: neuron.chunks,
        nearest: nearestChunksOf(mesh.positions, neuron, graph.layout),
      }
    },
    { keep: 'resolved' },
  )
}

/** Remember a chunkedgraph that refuses (1.x), so the key says so at once and nothing reads ahead. */
function noteRefusal(target: SplitTarget, error: unknown): void {
  if (error instanceof NoAffinitiesError) refused.set(targetKey(target), errorMessage(error))
}

function set(next: SplitSession | undefined): void {
  session = next
  changed.notify()
}

/**
 * Why the gallery may not move on from the press it shows — a split being written or undone from
 * it (`splitAccept.ts`) — or undefined. Held, a press says so and Close does nothing: the write's
 * answer is drawn over the press it was made from.
 */
let hold: string | undefined

export function holdSplit(reason: string | undefined): void {
  hold = reason
}

/** The split key over `request`'s point: read, then offer the candidates as they come. */
export function startSplit(request: SplitRequest): void {
  if (isTourActive()) {
    useGraphStore.getState().setNotice('The split gallery waits until the tour is over.')
    return
  }
  if (hold) {
    useGraphStore.getState().setNotice(hold)
    return
  }
  armed = true
  const mine = {}
  press = mine
  forgetPress()
  const known = refused.get(targetKey(request))
  if (known) {
    meshState = undefined
    set({ phase: 'failed', request, message: known })
    return
  }
  set({ phase: 'reading', request })
  meshState = { status: 'loading' }
  meshOf(request, request.root)
    .then(
      (mesh): SplitMeshState => ({ status: 'ready', mesh }),
      (error: unknown): SplitMeshState => ({ status: 'failed', message: errorMessage(error) }),
    )
    .then((state) => {
      if (press !== mine) return
      meshState = state
      changed.notify()
      refine(mine)
    })
  void (async () => {
    try {
      const [input, graph] = await Promise.all([boxOf(request), graphOf(request)])
      if (press !== mine) return
      const candidates: SplitCandidate[] = []
      const offer = (phase: 'computing' | 'ready') =>
        set({
          phase,
          request,
          candidates: [...candidates],
          input,
          graphene: graph.graphene,
          round: 1,
        })
      offer('computing')
      const walked = await walk(mine, input, [], (candidate) => {
        candidates.push(candidate)
        offer('computing')
      })
      if (!walked) return
      offer('ready')
      refine(mine)
    } catch (error) {
      noteRefusal(request, error)
      if (press !== mine) return
      // Nothing to draw a mesh on: say nothing about it.
      meshState = undefined
      set({ phase: 'failed', request, message: errorMessage(error) })
    }
  })()
}

/**
 * Every split offered for the current press before the set on show — what Regenerate passes over,
 * with the set on show, so a new set holds none of them (`SplitGalleryOptions.exclude`).
 */
let shownBefore: SplitCandidate[] = []

/**
 * The gallery's walk out from the point (`splitCandidates`), on the main thread a slice at a time,
 * handing each candidate to `found` as it comes. False where another press took over meanwhile.
 */
async function walk(
  mine: object,
  input: SplitGalleryInput,
  exclude: readonly SplitCandidate[],
  found: (candidate: SplitCandidate) => void,
): Promise<boolean> {
  let slice = services.now()
  for (const candidate of splitCandidates(input, { exclude })) {
    if (press !== mine) return false
    if (candidate) found(candidate)
    if (services.now() - slice > SLICE_MS) {
      await services.pause()
      slice = services.now()
    }
  }
  return press === mine
}

/**
 * Regenerate: the next set of splits near the same point — the walk again, nearest first, passing
 * over every split offered for this press so far. Nothing is read again (the box is held). The set
 * on show stays until the new one is complete; where nothing more is found, it stays, marked
 * `exhausted`. Not while a split is being written, nor once one may have been (the neuron is no
 * longer what was read; the gallery's Accept is off then too).
 */
export function regenerateSplit(): void {
  const current = session
  if (current?.phase !== 'ready' || current.exhausted || hold) return
  const mine = press
  if (!mine) return
  const exclude = [...shownBefore, ...current.candidates]
  set({ ...current, phase: 'computing', regenerating: true })
  void (async () => {
    const candidates: SplitCandidate[] = []
    if (!(await walk(mine, current.input, exclude, (one) => candidates.push(one)))) return
    if (candidates.length === 0) {
      set({ ...current, exhausted: true })
      useGraphStore
        .getState()
        .setNotice('No other splits near the point: these are the last found.')
      // The mesh may have landed during the walk, when there was nothing ready to place it for.
      refine(mine)
      return
    }
    shownBefore = exclude
    // The placement so far holds for any cut; the new ones may need other cells read.
    set({ ...current, candidates, round: current.round + 1 })
    refine(mine)
  })()
}

/** Grid cells whose segmentation is read at once while placing vertices exactly (~1.3 s each). */
const LABEL_CELLS_IN_FLIGHT = 3

/** The candidates the exact placement was last started for, so it is not started twice. */
let placing: readonly SplitCandidate[] | undefined

/**
 * What the press's exact placement has found so far. Which supervoxel lies under a vertex does
 * not depend on the cuts on show, so it is kept for the whole press: a Regenerate reads only the
 * cells its new cuts add.
 */
interface Placement {
  /** Grid cells taken for reading (`x,y,z`); a cell whose read failed is let go again. */
  readonly cells: Set<string>
  /** Chunks outside the press's box whose supervoxels were asked for. */
  readonly asked: Set<string>
  readonly supervoxelOf: Map<number, string>
  readonly chunkOf: Map<string, string>
}
let placement: Placement | undefined

/** Forget the exact placement and the splits offered: a new press, or none. */
function forgetPress(): void {
  exactState = undefined
  placement = undefined
  placing = undefined
  shownBefore = []
}

/**
 * Place the vertices exactly wherever a vertex's nearest chunk could be on the wrong side: once
 * the press's candidates and mesh are both in, the segmentation over **every grid cell where some
 * tile has chunks of both sides** — the cells the cuts run through, and the cells two branches
 * share, where a vertex nearer the other chunk's one point would be drawn as an island (measured
 * on 648518347493136877, 2026-11-23: every candidate had several such cells, none of them cut).
 * Each vertex there is given the supervoxel under it, and so its own chunk's side. The first
 * tile's cells first, a few at once, the tiles redrawn after each; until then they colour by the
 * nearest chunk in the vertex's cell. Chunks outside the box read for the press have their
 * supervoxels asked once (`leaves_many`), alongside the first reads; where that fails, the
 * vertices on them keep their chunk-level colours.
 */
function refine(mine: object): void {
  const current = session
  const mesh = meshState?.status === 'ready' ? meshState.mesh : undefined
  if (press !== mine || current?.phase !== 'ready' || !mesh || placing === current.candidates) {
    return
  }
  placing = current.candidates
  const request = current.request
  const box = current.input.members
  const placed = (placement ??= {
    cells: new Set(),
    asked: new Set(),
    supervoxelOf: new Map(),
    chunkOf: new Map(chunkOfMembers(box)),
  })
  // Still the set it was worked out for: after a Regenerate, the new set's pass reads on.
  const onShow = () =>
    press === mine &&
    session !== undefined &&
    'candidates' in session &&
    session.candidates === current.candidates
  void (async () => {
    try {
      const [graph, neuron] = await Promise.all([
        graphOf(request),
        neuronOf(request, request.root),
      ])
      const cells = new Map<string, Triple>()
      for (const candidate of current.candidates) {
        const sides = new Map<string, Set<SplitSide>>()
        for (const [chunk, side] of candidate.chunkSides) {
          const cell = neuron.cells.get(chunk)
          if (!cell) continue
          const key = cell.join(',')
          const here = sides.get(key) ?? new Set<SplitSide>()
          here.add(side)
          // A chunk the cut runs through holds both sides by itself.
          if (candidate.divided.has(chunk)) here.add('a').add('b')
          sides.set(key, here)
          if (here.size === 2 && !placed.cells.has(key)) cells.set(key, cell)
        }
      }
      if (cells.size === 0) return
      const outside = neuron.chunks.filter(
        (chunk) =>
          !box.has(chunk) &&
          !placed.asked.has(chunk) &&
          cells.has(neuron.cells.get(chunk)?.join(',') ?? ''),
      )
      for (const chunk of outside) placed.asked.add(chunk)
      const outsideIn = services.chunkSupervoxels(graph, outside, optionsOf(request)).then(
        (fetched) => {
          for (const [chunk, svs] of fetched)
            for (const sv of svs) placed.chunkOf.set(sv, chunk)
        },
        () => {
          for (const chunk of outside) placed.asked.delete(chunk)
        },
      )
      const queue = [...cells]
      const reader = async () => {
        for (let next = queue.shift(); next && onShow(); next = queue.shift()) {
          const [key, cell] = next
          // Another pass for this press may have taken it meanwhile.
          if (placed.cells.has(key)) continue
          placed.cells.add(key)
          try {
            const [labels] = await Promise.all([services.labels(graph, cell), outsideIn])
            if (press !== mine) return
            supervoxelsAtVertices(mesh.positions, labels, placed.chunkOf, placed.supervoxelOf)
            // A new object, so the tiles recolour; the maps grow under it, read only then.
            exactState = { supervoxelOf: placed.supervoxelOf, chunkOf: placed.chunkOf }
            changed.notify()
          } catch {
            // One cell unread: its vertices keep their chunk-level colours, and a later pass
            // may read it.
            placed.cells.delete(key)
          }
          await services.pause()
        }
      }
      await Promise.all(Array.from({ length: LABEL_CELLS_IN_FLIGHT }, reader))
    } catch {
      // A drawing refinement: the tiles keep the chunk-level colours they already have.
    }
  })()
}

export function closeSplit(): void {
  if (hold) return
  press = undefined
  meshState = undefined
  forgetPress()
  set(undefined)
}

export function splitSession(): SplitSession | undefined {
  return session
}

/** The current press's mesh, read apart from its candidates. */
export function splitMesh(): SplitMeshState | undefined {
  return meshState
}

/** The current press's vertices placed exactly at its cuts, once read (`refine`). */
export function splitExact(): ExactVertices | undefined {
  return exactState
}

export function onSplitSession(listener: () => void): () => void {
  return changed.subscribe(listener)
}

let restTimer: ReturnType<typeof setTimeout> | undefined
/** Where the pointer last rested while a read ahead was in flight: read next, then. */
let waiting: SplitRequest | undefined

/**
 * Read `point`'s neuron, mesh and box ahead — **one neuron at a time**: the latest rest waits for
 * the read in flight, and rests in between are passed over. A mesh is a full download at the whole
 * fragment budget, so reading ahead for every neuron the pointer pauses on would be a burst of
 * them at a shared server.
 */
function readAhead(point: SplitRequest): void {
  if (readingAhead) {
    waiting = point
    return
  }
  readingAhead = true
  Promise.allSettled([meshOf(point, point.root), boxOf(point)])
    .then(([, box]) => {
      if (box.status === 'rejected') noteRefusal(point, box.reason)
    })
    .finally(() => {
      readingAhead = false
      const next = waiting
      waiting = undefined
      if (next) readAhead(next)
    })
}

/**
 * The pointer over `point` of a card that can split, or off every such card (`undefined`, which
 * also drops a rest still waiting to be read). Once the key has been used, resting there
 * `REST_MS` — the rest the review card scrolls on — reads the neuron, its mesh and the box under
 * the pointer ahead (`readAhead`).
 */
export function splitPointer(point: SplitRequest | undefined): void {
  clearTimeout(restTimer)
  if (!point) waiting = undefined
  if (!point || !armed || refused.has(targetKey(point))) return
  restTimer = setTimeout(() => readAhead(point), REST_MS)
}

/** Tests: swap the reads and forget everything held. */
export function resetSplitSessionForTests(next: SplitServices = LIVE): void {
  services = next
  hold = undefined
  forgetPress()
  session = undefined
  meshState = undefined
  press = undefined
  armed = false
  readingAhead = false
  waiting = undefined
  clearTimeout(restTimer)
  for (const cache of [refused, graphs, neurons, boxes, meshes, meshSources, volumes])
    cache.clear()
}
