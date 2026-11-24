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
import type { BoxableLayout } from '../../data/cave/graphLayout'
import type { DrawnRoute, PathColour, PathStep } from '../../packs/seam/findPath'
import {
  chunkRoute,
  endChunk,
  FIND_PATH_LAYER,
  pathLayer,
  readPathSteps,
  thinnestOf,
  unreadSteps,
  stepText,
  weakestStep,
} from '../../packs/seam/findPath'
import type { SplitNeuron } from '../../packs/seam/splitGalleryRun'
import type { SurfaceRoute } from '../../packs/seam/surfacePath'
import type { Skeleton } from '../../packs/seam/skeletonThickness'
import {
  PATH_SKELETONIZE,
  pieceRadiiAlong,
  skeletonRouteMesh,
} from '../../packs/seam/skeletonThickness'
import { skeletonizeRequestOf } from '../../nodes/lib/skeletonizeOps'
import { runSkeletonize } from '../../pyodide/skeletonize'
import { LruMap } from '../../core/lruMap'
import { memoPromise } from '../../data/memoPromise'
import { bridgedRoute, prepareSurface } from '../../packs/seam/surfacePath'
import { yieldToBrowser } from '../../core/slice'
import { noticeChoice, showNotice } from '../noticeDismiss'
import { useGraphStore } from '../../store/graphStore'
import { plural } from '../../style/format'
import { isTourActive } from '../tour/tourState'
import type { Chunkedgraph, SplitMesh, SplitRequest, SplitTarget } from './splitSession'
import { fullMeshOf, graphOf, meshOf, neuronOf, optionsOf, targetKey } from './splitSession'

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
  /** The neuron's wavefront skeleton, from its full mesh: the route thickness is read along. */
  skeleton(target: SplitTarget, root: string): Promise<Skeleton>
  /** Hand a message to a card's frame. */
  post(frame: object, message: FrameLayerMessage): void
}

/** The skeletons of the last two neurons built: seconds of Pyodide, and F is pressed on one at a time. */
const skeletons = new LruMap<string, Promise<Skeleton>>(2)

/**
 * A neuron's wavefront skeleton (skeletor's, in the Pyodide worker, `PATH_SKELETONIZE`) from its
 * full mesh (`fullMeshOf` — the tiles' reduction merges vertices on a grid, and would merge a thin
 * neck's walls). 0.3 s on a 494 k-triangle Aedes neuron, plus loading Pyodide the first time (~3.5 s).
 */
async function skeletonOf(target: SplitTarget, root: string): Promise<Skeleton> {
  // The mesh's own buffers, handed over (and detached): nothing else holds this read.
  const { positions, indices } = await fullMeshOf(target, root)
  const packed = {
    positions,
    indices,
    vertexOffsets: Int32Array.of(0, positions.length / 3),
    faceOffsets: Int32Array.of(0, indices.length / 3),
  }
  const { points, radii, parents } = await runSkeletonize(
    skeletonizeRequestOf(packed, PATH_SKELETONIZE),
  )
  return { points, radii, parents }
}

const LIVE: FindPathServices = {
  chunkedgraph: graphOf,
  neuron: neuronOf,
  steps: (graph, root, neuron, route, options) =>
    readPathSteps(graph.graphene, graph.layout, root, neuron, route, options),
  mesh: meshOf,
  skeleton: (target, root) =>
    memoPromise(skeletons, `${targetKey(target)}|${root}`, () => skeletonOf(target, root), {
      keep: 'resolved',
    }),
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
  shown = undefined
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
    shown = undefined
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
  shown = undefined
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
    // The skeleton beside the steps, where thickness is the colour and there is a step to measure:
    // it needs only the neuron, and takes seconds.
    if (colour === 'thickness' && chunks.length > 1) {
      services.skeleton(request, request.root).catch(() => undefined)
    }
    // The steps and the surface at once: the surface needs the mesh and the route, not the steps.
    const stepsRead = services.steps(graph, request.root, neuron, chunks, {
      ...optionsOf(request),
      signal: mine.signal,
    })
    const surfaceRead = alongSurface(meshRead, neuron, graph.layout, chunks, fromNm, toNm, mine)
    // A chunkedgraph with no affinities (1.x, FlyWire) still has a route: drawn, its steps unread.
    let weighed = true
    const steps = await stepsRead.catch((error: unknown) => {
      if (!(error instanceof NoAffinitiesError)) throw error
      weighed = false
      return unreadSteps(chunks)
    })
    if (reading !== mine) return
    shown = {
      frame,
      fromNm,
      route: { steps, positions: neuron.positions },
      weighed,
      request,
      neuron,
      layout: graph.layout,
      chunks,
    }
    drawShown()
    sayShown()
    // Thickness down the skeleton — only where the colour shows it.
    if (colour === 'thickness') void measureThickness()
    const surface = await surfaceRead
    // Nothing to draw where the skeleton's route is in: it is drawn in the surface's place.
    if (!surface || reading !== mine || !shown || shown.route.skeleton) return
    shown = { ...shown, route: { ...shown.route, surface } }
    drawShown()
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
  layout: BoxableLayout,
  chunks: readonly string[],
  fromNm: Triple,
  toNm: Triple,
  mine: AbortController,
): Promise<SurfaceRoute | undefined> {
  try {
    const mesh = await meshRead
    if (!mesh || reading !== mine) return undefined
    const prepared = prepareSurface(mesh, neuron, layout, chunks, fromNm, toNm)
    if (!prepared) return undefined
    // Stopped by a newer press, or by the skeleton's route coming in first.
    return await bridgedRoute(prepared, () =>
      pauseWhile(() => reading === mine && !shown?.route.skeleton),
    )
  } catch {
    // The straight lines stay.
  }
  return undefined
}

/** Let the browser in, then say whether the work is still wanted. */
async function pauseWhile(wanted: () => boolean): Promise<boolean> {
  await yieldToBrowser()
  return wanted()
}

/**
 * What the route's colour says (`PathColour`), the reader's choice on the notice — kept for the next
 * route too. Thickness is the skeleton's (`measureThickness`); affinity is drawn until it is in.
 */
let colour: PathColour = 'affinity'

/** The route on show, to draw again in another colour, and to word its notice. */
let shown:
  | {
      readonly frame: object
      readonly fromNm: Triple
      readonly route: DrawnRoute
      /** Whether its steps could be weighed: not on a chunkedgraph with no affinities. */
      readonly weighed: boolean
      readonly request: SplitRequest
      /** What the route was found in, to find it again down the skeleton. */
      readonly neuron: SplitNeuron
      readonly layout: BoxableLayout
      readonly chunks: readonly string[]
      /**
       * The skeleton's thickness under way, or why it could not be had — what the notice says of
       * it. A failure is tried again when thickness is next chosen.
       */
      readonly thickness?: { readonly measuring: boolean; readonly text: string } | undefined
    }
  | undefined

/** The colour a route is drawn in: the chosen one, or affinity until its skeleton is measured. */
function colourOf(route: DrawnRoute): PathColour {
  return colour === 'thickness' && route.skeleton ? 'thickness' : 'affinity'
}

/**
 * The route's thickness down the neuron's wavefront skeleton, once: build the skeleton in the
 * Pyodide worker (seconds the first time), find the route again along it — the surface search over
 * its parent links, kept to the same chunks (`skeletonRouteMesh`) — and give each piece its nodes'
 * radius (`pieceRadiiAlong`). Drawn in place of the surface route when in, if the route is still the
 * one on show; a failure is said, and affinity stays drawn.
 */
async function measureThickness(): Promise<void> {
  const now = shown
  if (!now || now.route.steps.length === 0 || now.route.skeleton || now.thickness?.measuring) {
    return
  }
  const token = reading
  const ours = () => reading === token && shown?.request === now.request
  shown = {
    ...now,
    thickness: { measuring: true, text: 'Measuring thickness along the neuron’s skeleton…' },
  }
  resayShown()
  let failed: string | undefined
  let skeleton: DrawnRoute['skeleton']
  try {
    const measured = await services.skeleton(now.request, now.request.root)
    if (!ours()) return
    const { neuron, layout, chunks, fromNm, request } = now
    const routeMesh = skeletonRouteMesh(measured, neuron, layout)
    const prepared = prepareSurface(routeMesh, neuron, layout, chunks, fromNm, request.pointNm)
    const along = prepared && (await bridgedRoute(prepared, () => pauseWhile(ours)))
    if (!ours()) return
    const radii = along && pieceRadiiAlong(measured, along)
    if (along && radii?.some((r) => r !== undefined)) skeleton = { along, radii }
    else
      failed = along ? 'no node along the route has a radius.' : 'its skeleton holds no path.'
  } catch (error) {
    if (!ours()) return
    failed = errorMessage(error)
  }
  const thickness = failed
    ? {
        measuring: false,
        text: `Thickness could not be measured along the skeleton: ${failed}`,
      }
    : undefined
  shown = { ...shown!, route: { ...shown!.route, skeleton }, thickness }
  drawShown()
  resayShown()
}

/** Say the route's notice again where it is the one on show, with its choice. */
function resayShown(): void {
  if (noticeChoice(useGraphStore.getState().notice)) sayShown()
}

function drawShown(): void {
  if (!shown) return
  draw(
    shown.frame,
    pathLayer(shown.fromNm, shown.request.pointNm, {
      ...shown.route,
      colour: colourOf(shown.route),
    }),
  )
}

/** The route's notice: its account in the colour on show, and the choice of colour beside it. */
function sayShown(): void {
  if (!shown) return
  const { route, weighed, request, neuron, thickness } = shown
  const { datastack } = request
  const by = colourOf(route)
  const notes = [
    !weighed && by === 'affinity'
      ? `Find path: ${plural(route.steps.length, 'step')}, drawn unweighed: ${datastack}'s ` +
        'chunkedgraph publishes no affinities.'
      : summaryOf(route, by),
    colour === 'thickness' ? thickness?.text : '',
    neuron.placed === 'cells'
      ? `Drawn through grid-cell centres: ${datastack} has no level-2 cache to place each chunk.`
      : '',
  ]
  showNotice(notes.filter(Boolean).join(' '), clearPath, {
    label: 'Colour by',
    // The reader's choice, though affinity is drawn until thickness is in: the notice says why.
    value: colour,
    options: [
      {
        value: 'affinity',
        label: 'affinity',
        disabled: weighed ? undefined : `${datastack}'s chunkedgraph publishes no affinities.`,
      },
      { value: 'thickness', label: 'thickness' },
    ],
    onChange: (value) => {
      colour = value === 'thickness' ? 'thickness' : 'affinity'
      drawShown()
      sayShown()
      if (colour === 'thickness') void measureThickness()
    },
  })
}

/** The status bar's account of a drawn route, by what its colour says. */
export function summaryOf(route: DrawnRoute, by: PathColour = 'affinity'): string {
  const { steps } = route
  if (steps.length === 0) return 'Find path: both points are in one level-2 chunk.'
  if (by === 'thickness') {
    const thinnest = thinnestOf(route)
    return [
      `Find path: ${plural(steps.length, 'step')}.`,
      thinnest
        ? `Thinnest: radius ${Math.round(thinnest.radius)} nm, at step ${thinnest.step + 1}.`
        : 'No step has a radius.',
      'Measured along the neuron’s skeleton; thin draws brightest.',
    ].join(' ')
  }
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
  colour = 'affinity'
  services = next
}
