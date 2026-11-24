/**
 * Coda's find path (`docs/find-path-plan.md`): F over a neuron in a Neuroglancer card marks the
 * start, F over the same neuron again draws the route between the two points, each step coloured
 * by how strongly it is joined (`packs/seam/findPath.ts`). The route is a layer of the frame's own
 * (`FrameLayerMessage`), never part of the card's scene, so drawing it rebuilds nothing and saves
 * nothing.
 *
 * - **A press over another neuron, or another card, moves the start there**, and the old card's
 *   route goes. After a route is drawn, the next press starts a new one.
 * - **Reads are the split gallery's** (`graphOf`, `neuronOf` in `splitSession.ts`): the same
 *   neuron for F and K is read once.
 * - **A newer press drops an older one's late answer**, as the split key's does.
 * - **Dismissing find path's own notice clears it** — the route, or a start still waiting for its
 *   end (user, 2026-11-24). Only the reader's × (`dismissNotice`): a notice that merely
 *   replaces this one (a hand pick refused, say) leaves the route drawn.
 */

import { errorMessage } from '../../core/errors'
import type { CaveRequestOptions } from '../../data/cave/client'
import { NoAffinitiesError } from '../../data/cave/subgraph'
import type { FrameLayerMessage } from '../../data/neuroglancer/frameMessage'
import { FRAME_LAYER_MESSAGE } from '../../data/neuroglancer/frameMessage'
import type { Triple } from '../../data/precomputed/volume'
import type { PathStep } from '../../packs/seam/findPath'
import {
  chunkRoute,
  endChunk,
  FIND_PATH_LAYER,
  pathLayer,
  readPathSteps,
  unreadSteps,
  stepText,
  weakestStep,
} from '../../packs/seam/findPath'
import type { SplitNeuron } from '../../packs/seam/splitGalleryRun'
import type { SurfaceRoute } from '../../packs/seam/surfacePath'
import { BRIDGE_NM, prepareSurface, surfaceRoute } from '../../packs/seam/surfacePath'
import { yieldToBrowser } from '../../core/slice'
import { showNotice } from '../noticeDismiss'
import { plural } from '../../style/format'
import { isTourActive } from '../tour/tourState'
import type { Chunkedgraph, SplitMesh, SplitRequest, SplitTarget } from './splitSession'
import { graphOf, meshOf, neuronOf, optionsOf, targetKey } from './splitSession'

/** The reads and the frame, injected in tests. */
export interface FindPathServices {
  chunkedgraph(target: SplitTarget): Promise<Chunkedgraph>
  neuron(target: SplitTarget, root: string): Promise<SplitNeuron>
  steps(
    graph: Chunkedgraph,
    root: string,
    neuron: SplitNeuron,
    route: readonly string[],
    options: CaveRequestOptions,
  ): Promise<PathStep[]>
  /** The neuron's reduced mesh, for the route along its surface (`surfaceRoute`). */
  mesh(target: SplitTarget, root: string): Promise<SplitMesh>
  /** Hand a message to a card's frame. */
  post(frame: object, message: FrameLayerMessage): void
}

const LIVE: FindPathServices = {
  chunkedgraph: graphOf,
  neuron: neuronOf,
  steps: (graph, root, neuron, route, options) =>
    readPathSteps(graph.graphene, graph.layout, root, neuron, route, options),
  mesh: meshOf,
  post(frame, message) {
    const target = (frame as { contentWindow?: Window | null }).contentWindow
    target?.postMessage(message, window.location.origin)
  },
}

let services = LIVE

/** Where the route starts: the press, and the frame it was made in. */
let start: { readonly request: SplitRequest; readonly frame: object } | undefined
/** The frame a route or a start is drawn in, to take it away when the next goes elsewhere. */
let drawnIn: object | undefined
/**
 * The newest press that reads: an older one's late answer is dropped, and its requests cancelled
 * (`stopReading`) so a route nobody will see does not keep reading the shared chunkedgraph.
 */
let reading: AbortController | undefined

/** A notice of find path's own: the reader dismissing it clears the route (`showNotice`). */
const say = (text: string) => showNotice(text, clearPath)

/** Take the route, or the start, away: the drawing, and whatever is still being read for it. */
function clearPath(): void {
  if (drawnIn) draw(drawnIn, null)
  start = undefined
  stopReading()
}

/** Cancel what the current press is still reading, and drop its answer. */
function stopReading(): void {
  reading?.abort()
  reading = undefined
}
const sameNeuron = (a: SplitRequest, b: SplitRequest) =>
  targetKey(a) === targetKey(b) && a.root === b.root

function draw(frame: object, layer: FrameLayerMessage['layer']): void {
  if (drawnIn && drawnIn !== frame) {
    services.post(drawnIn, { type: FRAME_LAYER_MESSAGE, name: FIND_PATH_LAYER, layer: null })
  }
  drawnIn = layer ? frame : undefined
  services.post(frame, { type: FRAME_LAYER_MESSAGE, name: FIND_PATH_LAYER, layer })
}

/** F over `request`'s point, in `frame`. */
export function pressFindPath(request: SplitRequest, frame: object): void {
  if (isTourActive()) {
    say('Find path waits until the tour is over.')
    return
  }
  const from = start
  if (!from || from.frame !== frame || !sameNeuron(from.request, request)) {
    start = { request, frame }
    stopReading()
    draw(frame, pathLayer(request.pointNm))
    say(
      from && from.frame === frame && from.request.root !== request.root
        ? `Find path: started again on ${request.root}, a different neuron. Press F at the other end.`
        : `Find path: start set on ${request.root}. Press F at the other end.`,
    )
    return
  }
  start = undefined
  stopReading()
  const mine = new AbortController()
  reading = mine
  // Both points at once; the steps follow when they are read.
  draw(frame, pathLayer(from.request.pointNm, request.pointNm))
  say('Find path: reading the route and how each step is joined…')
  void route(request, from.request.pointNm, frame, mine)
}

/**
 * Read the route from `fromNm` to the press's point and draw it: straight lines between the chunks'
 * points once the steps are read, then along the neuron's mesh once that is in (`alongSurface`).
 */
async function route(
  request: SplitRequest,
  fromNm: Triple,
  frame: object,
  mine: AbortController,
): Promise<void> {
  const toNm = request.pointNm
  // The mesh beside everything else: nothing here waits on it but the surface, and it is K's too.
  const meshRead = services.mesh(request, request.root).catch(() => undefined)
  try {
    const [graph, neuron] = await Promise.all([
      services.chunkedgraph(request),
      services.neuron(request, request.root),
    ])
    const a = endChunk(neuron, graph.layout, fromNm)
    const b = endChunk(neuron, graph.layout, toNm)
    if (!a || !b) throw new Error(`${request.root} has no level-2 chunk with a known position.`)
    const chunks = chunkRoute(neuron, a, b)
    if (chunks.at(-1) !== b) {
      if (reading === mine) say(`Find path: the two points are not joined in ${request.root}.`)
      return
    }
    // The steps and the surface at once: the surface needs the mesh and the route, not the steps.
    const stepsRead = services.steps(graph, request.root, neuron, chunks, {
      ...optionsOf(request),
      signal: mine.signal,
    })
    const surfaceRead = alongSurface(meshRead, neuron, graph, chunks, fromNm, toNm, mine)
    // A chunkedgraph with no affinities (1.x, FlyWire) still has a route: drawn, its steps unread.
    let weighed = true
    const steps = await stepsRead.catch((error: unknown) => {
      if (!(error instanceof NoAffinitiesError)) throw error
      weighed = false
      return unreadSteps(chunks)
    })
    if (reading !== mine) return
    draw(frame, pathLayer(fromNm, toNm, steps, neuron.positions))
    const notes = [
      weighed
        ? summaryOf(steps)
        : `Find path: ${plural(steps.length, 'step')}, drawn unweighed: ${request.datastack}'s ` +
          'chunkedgraph publishes no affinities.',
      neuron.placed === 'cells'
        ? `Drawn through grid-cell centres: ${request.datastack} has no level-2 cache to place ` +
          'each chunk.'
        : '',
    ]
    say(notes.filter(Boolean).join(' '))
    const surface = await surfaceRead
    if (surface && reading === mine) {
      draw(frame, pathLayer(fromNm, toNm, steps, neuron.positions, surface))
    }
  } catch (error) {
    if (reading === mine) say(`Find path failed: ${errorMessage(error)}`)
  }
}

/**
 * The route along the neuron's mesh (`surfaceRoute`), to draw in place of the straight lines — or
 * undefined where the mesh cannot be read or holds no path along the route, and the straight lines
 * stay with nothing said: the steps and their strengths are the same either way. Each bridge width
 * in turn, the browser let in before each (each is up to ~0.7 s: `BRIDGE_NM`). Never throws.
 */
async function alongSurface(
  meshRead: Promise<SplitMesh | undefined>,
  neuron: SplitNeuron,
  graph: Chunkedgraph,
  chunks: readonly string[],
  fromNm: Triple,
  toNm: Triple,
  mine: AbortController,
): Promise<SurfaceRoute | undefined> {
  try {
    const mesh = await meshRead
    if (!mesh || reading !== mine) return undefined
    const prepared = prepareSurface(mesh, neuron, graph.layout, chunks, fromNm, toNm)
    if (!prepared) return undefined
    for (const bridgeNm of BRIDGE_NM) {
      await yieldToBrowser()
      if (reading !== mine) return undefined
      const surface = surfaceRoute(prepared, bridgeNm)
      if (surface) return surface
    }
  } catch {
    // The straight lines stay.
  }
  return undefined
}

/** The status bar's account of a drawn route. */
export function summaryOf(steps: readonly PathStep[]): string {
  if (steps.length === 0) return 'Find path: both points are in one level-2 chunk.'
  const weakest = weakestStep(steps)
  const count = (kind: PathStep['kind']) => steps.filter((step) => step.kind === kind).length
  const merges = count('userMerge')
  const unread = count('unread')
  return [
    `Find path: ${plural(steps.length, 'step')}.`,
    weakest
      ? `Weakest: step ${steps.indexOf(weakest) + 1}, ${stepText(weakest)}.`
      : 'No step is a measured contact.',
    merges ? `${plural(merges, 'step')} joined by a proofreader’s merge only.` : '',
    unread ? `${plural(unread, 'step')} not read.` : '',
    'Weak steps draw brightest; hover a step for its affinity.',
  ]
    .filter(Boolean)
    .join(' ')
}

/** Tests: swap the reads and the frame, and forget the start. */
export function resetFindPathForTests(next: FindPathServices = LIVE): void {
  // Nothing drawn, so `clearPath` posts nothing: it resets the start and cancels the read.
  drawnIn = undefined
  clearPath()
  services = next
}
