/**
 * The route between two points on a neuron, with how strongly each step along it is joined
 * (`docs/find-path-plan.md`). Coda's find path (F in a Neuroglancer card, `ui/seam/splitKey.ts`)
 * in place of neuroglancer's own, which draws the route in one colour.
 *
 * - **The route** is a shortest path of level-2 chunks, breadth first (`chunkPaths`), over the
 *   neuron's level-2 graph — the graph the split gallery reads anyway. Measured against the
 *   server's `find_path` on six Aedes neurons: the same number of steps every time, and the server
 *   answered one route with a 500. Each end is the chunk nearest the point in the point's own grid
 *   cell (`endChunk`), as a mesh vertex takes its chunk (`nearestChunks`).
 * - **How strongly each step is joined** is read from the supervoxel graph (`subgraph`) along the
 *   route, in `boxesAlong`'s boxes, with each route chunk's supervoxels (`leaves_many`) — 2–5 s on
 *   those neurons. **Not chunk to chunk**: a supervoxel is cut at every chunk border and its
 *   halves joined by an infinite affinity, so two neighbouring chunks of a neuron are almost always
 *   joined that way (all 36 steps of 648518347493136877's route, 2026-11-24), and the joins that
 *   matter — between two supervoxels — mostly sit *inside* a chunk. So the route's supervoxels are
 *   followed instead, by **the strongest path** (`strongestPath`: the one whose weakest join is as
 *   strong as any can be), whose weakest join is the weakest link the two ends depend on; each
 *   drawn step takes the weakest join of the stretch it covers.
 * - **A weak step is a place to look, not a verdict**: on Aedes, false merges are often moderate
 *   contacts and some real ones are weak (`split-sites-plan.md`).
 *
 * Reads only.
 */

import type { CaveRequestOptions } from '../../data/cave/client'
import { CaveError } from '../../data/cave/client'
import type { GrapheneSource } from '../../data/cave/graphene'
import type { BoxableLayout } from '../../data/cave/graphLayout'
import { cellOf } from '../../data/cave/graphLayout'
import { chunkSupervoxels } from '../../data/cave/rootIds'
import type { GraphBox, SupervoxelGraph } from '../../data/cave/subgraph'
import { edgeKind, NoAffinitiesError, readSubgraph, unionOf } from '../../data/cave/subgraph'
import { inFlight } from '../../data/concurrency'
import type { Triple } from '../../data/precomputed/volume'
import { CHART_INK, cycleColor, parseHex, sequentialColor } from '../../style/colors'
import type { SplitNeuron } from './splitGalleryRun'
import { localAnnotationLayer } from './scene'
import { nearestChunks } from './splitColours'
import { findRoot, unite } from './splitSites'
import type { SurfaceRoute } from './surfacePath'
import { chunkOfMembers } from './splitGallery'
import { adjacencyOf, boxesAlong, chunkPaths, SUBGRAPH_CONCURRENCY } from './splitSitesRun'

/** The local annotation layer the route is drawn in; the frame adds it beside the scene's own. */
export const FIND_PATH_LAYER = 'find path'

/**
 * How one drawn step of the route — chunk to chunk — is joined, by the weakest join of the
 * strongest supervoxel path on its stretch (the joins into the chunk it reaches, and inside it):
 *
 * - `contact`: a measured contact between two supervoxels; `affinity` is its mean (summed affinity
 *   over area, as `subgraph` gives both summed).
 * - `piece`: nothing but one supervoxel's halves across chunk borders — as joined as anything gets.
 * - `userMerge`: a proofreader's merge (no contact area).
 * - `unread`: the path was not found — a box the server would not answer.
 */
export interface PathStep {
  readonly from: string
  readonly to: string
  readonly kind: 'contact' | 'piece' | 'userMerge' | 'unread'
  /** The weakest contact's mean affinity; NaN unless `kind` is `contact`. */
  readonly affinity: number
  /** That contact's area, voxel faces. */
  readonly area: number
}

/**
 * The neuron's chunk nearest `pointNm` among those in the point's own grid cell, or among all
 * where none is there (a point a voxel or two off the neuron's surface, over a chunk border) — the
 * rule a mesh vertex takes its chunk by (`nearestChunks`), so the route's ends and the split
 * gallery's colours agree. Undefined for a neuron with no placed chunk.
 */
export function endChunk(
  neuron: SplitNeuron,
  layout: BoxableLayout,
  pointNm: Triple,
): string | undefined {
  const [index] = nearestChunks(Float32Array.from(pointNm), neuron.chunks, neuron.positions, {
    of: neuron.cells,
    at: (x, y, z) => cellOf(layout, [x, y, z]),
  })
  return index !== undefined && index >= 0 ? neuron.chunks[index] : undefined
}

/** A shortest route of level-2 chunks from `from` to `to`; `[from]` where none joins them. */
export function chunkRoute(neuron: SplitNeuron, from: string, to: string): string[] {
  return chunkPaths(adjacencyOf(neuron.links), [from], [to])[0]!
}

/**
 * How strongly a join holds, for the strongest path: a contact's mean affinity, a supervoxel's
 * halves infinitely, a proofreader's merge barely (so a measured contact beside one is preferred),
 * an edge the server gave no numbers for not at all.
 */
function strengthOf(affinity: number, area: number): number | undefined {
  switch (edgeKind(affinity, area)) {
    case 'piece':
      return Infinity
    case 'contact':
      return affinity / area
    case 'userMerge':
      return USER_MERGE_STRENGTH
    case 'unread':
      return undefined
  }
}

/** Below any measured mean affinity (FANC's run from 0.09), above nothing. */
const USER_MERGE_STRENGTH = 1e-6

/**
 * The strongest path through `graph`'s edges among `allowed` supervoxels, from any of `sources` to
 * any of `targets`, as edge indices in order; undefined where none joins them. It is the path in a
 * **maximum spanning tree** (Kruskal, strongest edge first), which is strongest not only overall —
 * its weakest edge as strong as any path's — but along every stretch of it: a best-first search that
 * maximises only the overall weakest edge keeps whichever later edges it met first, so a step after
 * the weakest could show a weak contact where one supervoxel ran through (code review, 2026-11-24).
 */
export function strongestPath(
  graph: SupervoxelGraph,
  allowed: ReadonlySet<string>,
  sources: readonly string[],
  targets: ReadonlySet<string>,
): number[] | undefined {
  const index = new Map<string, number>()
  for (const sv of allowed) index.set(sv, index.size)
  // A start joined to every source and an end to every target, unbreakably: the tree's path from
  // one to the other is then the strongest from any source to any target, not the fewest hops.
  const START = index.size
  const END = index.size + 1
  const edges: Array<{ e: number; a: number; b: number; strength: number }> = []
  for (let e = 0; e < graph.a.length; e++) {
    const a = index.get(graph.a[e]!)
    const b = index.get(graph.b[e]!)
    if (a === undefined || b === undefined) continue
    const strength = strengthOf(graph.affinity[e]!, graph.area[e]!)
    if (strength !== undefined) edges.push({ e, a, b, strength })
  }
  for (const sv of sources) {
    const v = index.get(sv)
    if (v !== undefined) edges.push({ e: -1, a: START, b: v, strength: Infinity })
  }
  for (const sv of targets) {
    const v = index.get(sv)
    if (v !== undefined) edges.push({ e: -1, a: END, b: v, strength: Infinity })
  }
  edges.sort((x, y) => y.strength - x.strength)
  // The tree, kept as each vertex's tree edges.
  const parent = new Int32Array(index.size + 2)
  for (let v = 0; v < parent.length; v++) parent[v] = v
  const tree = new Map<number, Array<{ to: number; e: number }>>()
  const link = (v: number, to: number, e: number) => {
    const list = tree.get(v)
    if (list) list.push({ to, e })
    else tree.set(v, [{ to, e }])
  }
  for (const { e, a, b } of edges) {
    if (findRoot(parent, a) === findRoot(parent, b)) continue
    unite(parent, a, b)
    link(a, b, e)
    link(b, a, e)
  }
  // The tree path from the start to the end, less the joins to them.
  const cameBy = new Map<number, { from: number; e: number }>([[START, { from: -1, e: -1 }]])
  const queue = [START]
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!
    if (v === END) {
      const path: number[] = []
      for (let at = v; cameBy.get(at)!.from !== -1; at = cameBy.get(at)!.from) {
        const { e } = cameBy.get(at)!
        if (e >= 0) path.push(e)
      }
      return path.reverse()
    }
    for (const { to, e } of tree.get(v) ?? []) {
      if (cameBy.has(to)) continue
      cameBy.set(to, { from: v, e })
      queue.push(to)
    }
  }
  return undefined
}

/**
 * Each drawn step of `route` and how it is joined, from the supervoxel graph read along it and each
 * route chunk's supervoxels (`chunkOf`): the strongest path from the first chunk's supervoxels to
 * the last's, among the route's own (`strongestPath`), each of its joins given to the step it is
 * on — a join between chunks `i` and `i + 1` to step `i`, one inside chunk `i` to the step reaching
 * it (the first chunk's to the first step), one across a bend to every step it passes over — and
 * each step its weakest. Every step `unread` where no path is found.
 */
export function pathSteps(
  route: readonly string[],
  chunkOf: ReadonlyMap<string, string>,
  graph: SupervoxelGraph,
): PathStep[] {
  const steps = route.length - 1
  if (steps < 1) return []
  const at = new Map(route.map((chunk, i) => [chunk, i]))
  // The route's supervoxels, and the first and last chunks' among them, in one pass.
  const allowed = new Set<string>()
  const sources: string[] = []
  const targets = new Set<string>()
  for (const [sv, chunk] of chunkOf) {
    const i = at.get(chunk)
    if (i === undefined) continue
    allowed.add(sv)
    if (i === 0) sources.push(sv)
    if (i === steps) targets.add(sv)
  }
  const path = strongestPath(graph, allowed, sources, targets)
  const unread = unreadSteps(route)
  if (!path) return unread
  // Each step's weakest edge on the path, and that edge's strength.
  const weakest = new Array<number | undefined>(steps)
  const weakestStrength = new Array<number>(steps).fill(Infinity)
  for (const e of path) {
    // A path edge has a strength (`strengthOf`): an unread one is never on it.
    const strength = strengthOf(graph.affinity[e]!, graph.area[e]!)!
    const i = at.get(chunkOf.get(graph.a[e]!)!)!
    const j = at.get(chunkOf.get(graph.b[e]!)!)!
    const [lo, hi] =
      i === j ? [Math.max(i - 1, 0), Math.max(i, 1)] : [Math.min(i, j), Math.max(i, j)]
    for (let k = lo; k < hi; k++) {
      if (weakest[k] === undefined || strength < weakestStrength[k]!) {
        weakest[k] = e
        weakestStrength[k] = strength
      }
    }
  }
  return Array.from(weakest, (e, i) => {
    if (e === undefined) return step(route[i]!, route[i + 1]!, 'piece')
    const affinity = graph.affinity[e]!
    const area = graph.area[e]!
    // A path edge has a strength (`strengthOf`), so it is never `unread`.
    const kind = edgeKind(affinity, area) as Exclude<PathStep['kind'], 'unread'>
    return kind === 'contact'
      ? { from: route[i]!, to: route[i + 1]!, kind, affinity: affinity / area, area }
      : step(route[i]!, route[i + 1]!, kind)
  })
}

/** Whether `box` (base voxels, as `cellBox` writes one) covers grid cell `cell`. */
function holdsCell(layout: BoxableLayout, box: GraphBox, cell: Triple): boolean {
  return [0, 1, 2].every((a) => {
    const lo = layout.voxelOffset[a]! + cell[a]! * layout.chunkSize[a]!
    return box[0][a]! <= lo && lo + layout.chunkSize[a]! - 1 <= box[1][a]!
  })
}

/** Every step of `route` unread: what is drawn where nothing could weigh them. */
export function unreadSteps(route: readonly string[]): PathStep[] {
  return route.slice(1).map((to, i) => step(route[i]!, to, 'unread'))
}

function step(from: string, to: string, kind: Exclude<PathStep['kind'], 'contact'>): PathStep {
  return { from, to, kind, affinity: Number.NaN, area: 0 }
}

/**
 * Read how each step of `route` is joined (`pathSteps`). A box the server answers with a 500 — one
 * holding none of the neuron's edges is that, not an empty answer (`find-path-plan.md`) — leaves the
 * steps whose chunks no answered box holds `unread`, rather than failing the route or letting the
 * path show a weaker way round them; any other failure is thrown.
 */
export async function readPathSteps(
  graphene: GrapheneSource,
  layout: BoxableLayout,
  root: string,
  neuron: SplitNeuron,
  route: readonly string[],
  options: CaveRequestOptions,
): Promise<PathStep[]> {
  if (route.length < 2) return []
  const cells = route.map((chunk) => neuron.cells.get(chunk)).filter((c) => c !== undefined)
  const { boxes } = boxesAlong([cells], 0, layout)
  const parts: SupervoxelGraph[] = []
  const answered: GraphBox[] = []
  const [, svs] = await Promise.all([
    inFlight(boxes, SUBGRAPH_CONCURRENCY, async (box) => {
      // One refused box costs only the steps it held, so each is caught alone.
      try {
        parts.push(await readSubgraph(graphene, root, box, options))
        answered.push(box)
      } catch (error) {
        // Only the server's answer to a box holding none of the neuron's edges — a 500, `index 0
        // is out of bounds` — is a box with nothing to say. A refused sign-in, a rate limit, a
        // cancel or a 1.x chunkedgraph (`NoAffinitiesError`) is said, never drawn as steps unread.
        if (
          !(error instanceof CaveError && error.status === 500) ||
          error instanceof NoAffinitiesError
        ) {
          throw error
        }
      }
    }),
    chunkSupervoxels(graphene, [...route], options),
  ])
  const steps = pathSteps(route, chunkOfMembers(svs), unionOf(parts))
  // A step whose chunks no answered box holds is not read, whatever way round the path found.
  const read = (chunk: string) => {
    const cell = neuron.cells.get(chunk)
    return cell !== undefined && answered.some((box) => holdsCell(layout, box, cell))
  }
  return steps.map((step) =>
    step.kind === 'unread' || (read(step.from) && read(step.to))
      ? step
      : { from: step.from, to: step.to, kind: 'unread', affinity: Number.NaN, area: 0 },
  )
}

/**
 * A step's colour (`pathShader` draws with these): the sequential red ramp by weakness (1 − mean affinity), so the weakest steps
 * draw brightest on neuroglancer's black; a step within one supervoxel at the ramp's strong end;
 * a proofreader's merge the palette's first categorical colour; an unread step muted ink.
 */
export function stepColor(step: PathStep): string {
  return step.kind === 'contact'
    ? sequentialColor(1 - step.affinity, 'dark', 'red')
    : kindColor(step.kind)
}

/** The colour of a step that is not a measured contact, by its kind alone. */
function kindColor(kind: Exclude<PathStep['kind'], 'contact'>): string {
  switch (kind) {
    case 'piece':
      return sequentialColor(0, 'dark', 'red')
    case 'userMerge':
      return cycleColor(0, 'dark')
    case 'unread':
      return CHART_INK.dark.muted
  }
}

/** A step as the reader is told it, in a line annotation's description and the status bar. */
export function stepText(step: PathStep): string {
  switch (step.kind) {
    case 'piece':
      return 'one supervoxel throughout'
    case 'contact':
      // Two significant digits below 0.1, where a proofreader's merge on a real edge sits (0.00…).
      return `mean affinity ${
        step.affinity < 0.1 ? step.affinity.toPrecision(2) : step.affinity.toFixed(2)
      } over ${Math.round(step.area)} faces`
    case 'userMerge':
      return 'joined by a proofreader’s merge only'
    case 'unread':
      return 'not read'
  }
}

/** The weakest contact step on the route, if any step is a contact. */
export function weakestStep(steps: readonly PathStep[]): PathStep | undefined {
  let weakest: PathStep | undefined
  for (const step of steps) {
    if (step.kind !== 'contact') continue
    if (!weakest || step.affinity < weakest.affinity) weakest = step
  }
  return weakest
}

/** What each drawn annotation is, as the `kind` property numbers it and hover names it. */
const KINDS = ['contact', 'piece', 'userMerge', 'unread', 'point'] as const
const KIND_LABELS: Record<(typeof KINDS)[number], string> = {
  contact: 'contact',
  piece: 'one supervoxel',
  userMerge: 'proofreader merge',
  unread: 'not read',
  point: 'end point',
}
/** The `affinity` property where there is no measured contact (JSON has no NaN). */
const NO_AFFINITY = -1
/** Stops of the weakness ramp the shader interpolates between, sampled from `sequentialColor`. */
const RAMP_STOPS = 9

const glslColor = (hex: string) =>
  `vec3(${parseHex(hex)
    .map((v) => (v / 255).toFixed(4))
    .join(', ')})`

/**
 * The layer's shader: each annotation coloured from its `kind` and `affinity` properties — a
 * contact on the weakness ramp, any other kind its `stepColor` — so hover shows the numbers and
 * names (`annotationProperties`) rather than a colour property, and the colours are still the
 * palette's: the ramp is `sequentialColor` sampled at `RAMP_STOPS`, the rest `kindColor`, as `stepColor` gives them.
 */
export function pathShader(): string {
  const stops = Array.from({ length: RAMP_STOPS }, (_, i) =>
    glslColor(sequentialColor(i / (RAMP_STOPS - 1), 'dark', 'red')),
  )
  const fixed = (kind: Exclude<PathStep['kind'], 'contact'>) => glslColor(kindColor(kind))
  return [
    `const vec3 RAMP[${RAMP_STOPS}] = vec3[${RAMP_STOPS}](${stops.join(', ')});`,
    'vec3 ramp(float t) {',
    `  float x = clamp(t, 0.0, 1.0) * ${(RAMP_STOPS - 1).toFixed(1)};`,
    '  int i = int(floor(x));',
    `  int j = min(i + 1, ${RAMP_STOPS - 1});`,
    '  return mix(RAMP[i], RAMP[j], x - float(i));',
    '}',
    'void main() {',
    '  float k = prop_kind();',
    '  vec3 c = vec3(1.0);',
    // Each kind by its place in `KINDS`, as the `kind` property numbers it; a point stays white.
    ...KINDS.map((kind, i) => {
      const test = `${i === 0 ? '  if' : '  else if'} (k < ${(i + 0.5).toFixed(1)})`
      if (kind === 'contact') return `${test} c = ramp(1.0 - prop_affinity());`
      if (kind === 'point') return `${test} c = vec3(1.0);`
      return `${test} c = ${fixed(kind)};`
    }),
    '  setColor(c);',
    '  setLineWidth(4.0);',
    '  setEndpointMarkerSize(0.0);',
    '  setPointMarkerSize(10.0);',
    '}',
  ].join('\n')
}

/**
 * The route as a local annotation layer in nanometres: a line per step from the start point
 * through each chunk's point to the end point, with its step number, how it is joined (`kind`)
 * and its weakest contact's mean (`affinity`) as properties — what neuroglancer shows on hover —
 * and coloured from them (`pathShader`) — along the mesh where `surface` is given, each piece
 * carrying its step's numbers. With no steps yet (`undefined`), the points alone: the start, then
 * both while the route is read. A step whose chunk has no position is drawn from the
 * last placed point.
 */
export function pathLayer(
  fromNm: Triple,
  toNm?: Triple,
  steps?: readonly PathStep[],
  /** Each chunk's point, for the straight lines between them; not needed without `steps`. */
  positions: ReadonlyMap<string, Triple> = new Map(),
  /** The route along the mesh, once read (`surfaceRoute`): drawn in place of the straight lines. */
  surface?: SurfaceRoute,
): Readonly<Record<string, unknown>> {
  const props = (kind: (typeof KINDS)[number], affinity = NO_AFFINITY, step = 0) => [
    step,
    KINDS.indexOf(kind),
    affinity,
  ]
  const point = (id: string, at: Triple) => ({
    type: 'point',
    id,
    point: [...at],
    props: props('point'),
    description: id,
  })
  const line = (id: string, a: Triple, b: Triple, index: number) => {
    const step = steps![index]!
    return {
      type: 'line',
      id,
      pointA: [...a],
      pointB: [...b],
      props: props(step.kind, step.kind === 'contact' ? step.affinity : NO_AFFINITY, index + 1),
      description: `step ${index + 1} of ${steps!.length}: ${stepText(step)}`,
    }
  }
  const annotations: Record<string, unknown>[] = [point('start', fromNm)]
  if (toNm) annotations.push(point('end', toNm))
  if (toNm && steps) {
    if (surface) {
      surface.steps.forEach((index, k) => {
        annotations.push(line(`piece-${k}`, surface.points[k]!, surface.points[k + 1]!, index))
      })
    } else if (steps.length > 0) {
      let last: Triple = fromNm
      steps.forEach((step, i) => {
        const next = i === steps.length - 1 ? toNm : (positions.get(step.to) ?? last)
        annotations.push(line(`step-${i}`, last, next, i))
        last = next
      })
    } else {
      annotations.push({
        type: 'line',
        id: 'step-0',
        pointA: [...fromNm],
        pointB: [...toNm],
        props: props('piece'),
        description: 'both points in one level-2 chunk',
      })
    }
  }
  return {
    ...localAnnotationLayer(FIND_PATH_LAYER, '', annotations),
    annotationProperties: [
      { id: 'step', type: 'uint16', description: 'step along the route, from the start' },
      {
        id: 'kind',
        type: 'float32',
        description: 'how the step is joined at its weakest',
        enum_values: KINDS.map((_, i) => i),
        enum_labels: KINDS.map((kind) => KIND_LABELS[kind]),
      },
      {
        id: 'affinity',
        type: 'float32',
        description: `the weakest contact's mean affinity; ${NO_AFFINITY} where the step has none`,
      },
    ],
    shader: pathShader(),
  }
}
