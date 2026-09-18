/**
 * How far apart are two neurons — the arithmetic, with nothing in it that needs a library.
 *
 * `Distance between` is NBLAST's shape asking a different question. NBLAST scores how well one arbour
 * lies *along* another and hands back an abstract similarity; this hands back micrometres, which
 * is what somebody asking whether two cells could touch, or how far a projection runs from a
 * neuropil, actually wants. It is also the node that makes `Linkage` usable on something other
 * than a similarity: a `MatrixValue` whose `measure` is `'distance'` is clustered directly, with
 * no `1 - x` in the way.
 *
 * ## Every measurement is weighted by the material, and that is the load-bearing decision
 *
 * The obvious implementation treats a skeleton as its nodes and a mesh as its vertices, and it
 * is wrong in a way no result can show. Neither sampling is even. A skeleton fetched from
 * neuPrint's SWC has nodes where a tracer put them; the same neuron through CAVE's level-2 chunk
 * decomposition has tens of them instead of tens of thousands; `Clean Skeletons` will resample
 * either to a spacing you choose. A mesh is tessellated finely where it curves and coarsely
 * where it does not, and `Downsample` on the `Meshes` node moves that by two orders of
 * magnitude. So an unweighted mean over samples measures *how the neuron was reconstructed*
 * mixed in with how far away the other one is, and the two are not separable afterwards.
 *
 * Every sample therefore carries the amount of neuron it stands for — **half the length of each
 * edge at a skeleton node, a third of the area of each triangle at a mesh vertex** — and the
 * statistics are weighted by it. What that buys, concretely:
 *
 *  - `mean` and `median` are a mean and a median *over the neuron's cable or surface*, so
 *    resampling upstream does not move them and neither does a level of detail.
 *  - `centroid` is the centre of mass of the cable or the surface, not of the sample points.
 *  - `within` sums cable in µm or surface area in µm², which is what makes it comparable
 *    between two neurons reconstructed differently.
 *
 * `min` and `max` ignore the weights, because they are not averages of anything: the closest
 * approach is the closest approach whatever stands where.
 *
 * ## The target side never samples at all
 *
 * A distance is measured to the nearest point **of** a skeleton and to the nearest point **on**
 * a mesh — `three-mesh-bvh`'s closest-point query, not the nearest vertex. So the target's
 * tessellation is out of the answer entirely, and only the query side has a sampling at all.
 * That asymmetry is why `Symmetry` matters here even more than it does on NBLAST.
 *
 * ## What is deliberately absent
 *
 * **A soma.** `SkeletonGeometry` is positions, radii and parents; there is no soma on it and no
 * node labels either — `data/swc.ts` says outright that the SWC label column "is read and
 * discarded" — and neuPrint's `somaLocation` is a Neo4j point that `neuprint/schema.ts`
 * suppresses. A soma-to-soma distance is a real question and the honest answer today is that
 * Coda cannot ask it; the root of a skeleton is *usually* the soma and is not on a chunk
 * decomposition or on a fragment, and an anchor that silently means two things is worse than
 * one that is missing. `Centroid` is here because it is not a soma standing in for one.
 *
 * **Resampling.** `Clean Skeletons` is one card up and does it properly. With the weighting
 * above it is also no longer needed for a mean to mean something, which is the whole argument
 * for not putting a second copy of the control here.
 *
 * **A point cloud.** `Points` is not among the kinds this takes — see `DISTANCE_KINDS`.
 */

import type { Warner } from '../../core/limits'
import { sliced } from '../../core/slice'
import { describeDuration, refuseIfOverCrashFloor } from '../../core/limits'
import { warnSideCount } from './limitParams'
import type { EnumOption, ParamValues } from '../../core/node'
import type { CodaType, Kind } from '../../core/types'
import { kindIn } from '../../core/types'
import type {
  Boxes,
  MeshGeometry,
  MeshesValue,
  SkeletonGeometry,
  SkeletonsValue,
  Value,
} from '../../core/values'
import { boxesOf, cableLength, triangleArea } from '../../core/values'
import type { KdTree } from './kdTree'
import { anyPairWithin, closestPair, medianOfThree } from './kdTree'

import { NM_PER_UM } from './nblastOps'
import { checkGeometryUnits, frameClash, frameClashMessage } from './transformOps'

/**
 * Skeletons and meshes, and a **fifth** kind list rather than a reuse of `SPLIT_KINDS`, which
 * happens to hold the same two members.
 *
 * The reason is the one kind that is missing. `Split Neurons` declines `points` because a
 * cloud's attribute rows are *connectors* and partitioning them is a different operation; this
 * declines it because a cloud has no items in it. Every axis of the matrix is one neuron, and a
 * `PointsValue` is a single value carrying N points with no notion of which neuron each belongs
 * to — putting one on a port here would need a grouping column, which is a second question
 * (`Split by`) bolted onto a node that has three methods already. The two refusals would come
 * apart the moment either node changed its mind, which is what a shared list cannot express.
 */
export const DISTANCE_KINDS = ['skeletons', 'meshes'] as const satisfies readonly Kind[]

export type DistanceCollection = SkeletonsValue | MeshesValue

/** A value has arrived, so unresolved is not a case — `isSplitCollection`'s rule. */
function isDistanceCollection(v: Value | undefined): v is DistanceCollection {
  return !!v && (DISTANCE_KINDS as readonly string[]).includes(v.kind)
}

/**
 * Why a wire on one of the two ports is the wrong kind, and what to do instead.
 *
 * **One sentence, two layers** — `validate` marks the card at edit time and `distanceSidesFrom`
 * throws on Run — which is `wrongKindReason`'s shape and `kindClashMessage`'s rule: written out
 * per layer, the two had already drifted into different wordings inside this change, and the one
 * a reader met depended on whether they had pressed Run.
 *
 * The sentence **branches**, because the two refused kinds want opposite remedies and a list of
 * what is accepted tells somebody holding the wrong thing nothing they can act on. `points` is
 * the one that matters: `DISTANCE_KINDS` declines a cloud for a specific reason, and "this node
 * measures skeletons or meshes" is not it.
 */
export function wrongDistanceKindReason(
  side: string,
  kind: CodaType['kind'] | undefined,
): string {
  if (kind === 'points') {
    return (
      `${side} is a point cloud. Distance puts one neuron on each axis of its matrix, and a ` +
      'cloud is a single value carrying many points with no notion of which neuron each belongs ' +
      'to — Points in Volumes is the node that asks a spatial question of one.'
    )
  }
  if (kind === 'table' || kind === 'neurons') {
    return (
      `${side} is a table. Distance measures geometry, so put a Skeletons or Meshes node ` +
      'between the table and this one.'
    )
  }
  return (
    `Wire skeletons or meshes to ${side} — the Skeletons or Meshes node, or anything handing a ` +
    `set of them on${kind ? `, not ${kind}` : ''}.`
  )
}

/** What a *type* could carry, which is what `validate` asks: `any` and unknown are not refusals. */
export function isDistanceKind(kind: CodaType['kind'] | undefined): boolean {
  return kindIn(DISTANCE_KINDS, kind)
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

export type DistanceMethod = 'nearest' | 'centroid' | 'within'
export type NearestStatistic = 'min' | 'mean' | 'median' | 'max'
export type DistanceSymmetry = 'mean' | 'min' | 'max' | 'query'
export type WithinReport = 'absolute' | 'fraction'

export const METHOD_OPTIONS: EnumOption[] = [
  { value: 'nearest', label: 'nearest-point distance' },
  { value: 'centroid', label: 'centroid distance' },
  { value: 'within', label: 'cable or area within a distance' },
]

/**
 * The four reductions of one neuron's nearest-point distances.
 *
 * Every one is over the set `{ distance from this sample of the query to the nearest point of
 * the target }` — **not** over every pair of points. An all-pairs mean is dominated by how big
 * each neuron is rather than by how near the two are: two arbours 50 µm apart and 200 µm across
 * average about 150 µm, and would do so whether they touched or not. `min` is the same number
 * either way, which is why the distinction is invisible on the one statistic people check first.
 */
export const STATISTIC_OPTIONS: EnumOption[] = [
  { value: 'min', label: 'closest approach', note: 'min' },
  { value: 'mean', label: 'mean separation', note: 'weighted by cable or area' },
  { value: 'median', label: 'median separation', note: 'weighted by cable or area' },
  { value: 'max', label: 'furthest from the other', note: 'the Hausdorff distance' },
]

/**
 * How the two directions of a pair are combined.
 *
 * Its own list rather than `SYMMETRY_OPTIONS`, whose labels are NBLAST's vocabulary: a
 * *similarity* has a weaker and a stronger direction, and for a distance those words name the
 * wrong ends. The values are the same four ideas and `query` is the same as NBLAST's `none`,
 * spelled for what it does rather than for what it switches off.
 *
 * It matters more here than it does there, because only the query side is sampled at all: A
 * measured against B and B measured against A differ by how each was reconstructed as well as by
 * the geometry. `mean` is the default for that reason, and it is what makes an all-by-all matrix
 * symmetric.
 */
export const SYMMETRY_OPTIONS: EnumOption[] = [
  { value: 'mean', label: 'mean of both directions' },
  { value: 'min', label: 'smaller of the two' },
  { value: 'max', label: 'larger of the two' },
  { value: 'query', label: 'query against target only' },
]

/**
 * The `Symmetry` options a wiring actually offers — **empty where the setting cannot matter**.
 *
 * A closest approach between two *point sets* is symmetric: `min(A→B)` and `min(B→A)` are the
 * same number, so every setting here is the identity over two equal numbers and the control is
 * dead. `closestPairApplies` is the one statement of when that holds, so this is not a second
 * spelling of it.
 *
 * **Empty rather than hidden by `visibleIf`, and for two reasons.** The first is that `visibleIf`
 * is handed params and cannot see the sockets — and this depends on the *kinds*: with a mesh on
 * either port the two directions are a point set against a surface and a surface against a point
 * set, which genuinely differ, so hiding it on `min` alone would be wrong exactly where it is
 * load-bearing. The second is invariant 4: a hidden param is dropped from the provenance key and
 * its value is nobody's, where an empty enum **keeps the stored value untouched** — so wiring a
 * mesh in, or switching to `mean`, finds the setting exactly as it was left. `EnumParam.empty`
 * records both halves; the Meshes node's `Detail` is the same control drawn dead.
 */
export function symmetryOptionsFor(shape: DistanceShape): EnumOption[] {
  // No `queryKind &&` guard: `bothPointSets` is already false for a socket that has not resolved,
  // which is the "a half-built graph is not one whose settings start greying themselves out" rule
  // stated once rather than twice.
  return closestPairApplies(shape) ? [] : SYMMETRY_OPTIONS
}

export const REPORT_OPTIONS: EnumOption[] = [
  { value: 'absolute', label: 'absolute', note: 'µm of cable, µm² of surface' },
  { value: 'fraction', label: 'fraction of the neuron', note: '0 to 1' },
]

export interface DistanceParams {
  method: DistanceMethod
  statistic: NearestStatistic
  /** `Within`, converted from the µm the control is in to the nm everything here works in. */
  withinNm: number
  report: WithinReport
  symmetry: DistanceSymmetry
}

/**
 * Read the controls once.
 *
 * Plain `ctx.params.x` with no `?? default` beside any of them: every context is built through
 * `withDefaults`, and a fallback here would be a second copy of a default that drifts
 * (invariant 4). The casts are the ordinary `enum`-param shape — the stored value is whatever a
 * `.coda.json` holds, and an unrecognised one falls through each `switch` below to its default
 * arm rather than throwing.
 */
export function distanceParamsFrom(params: ParamValues): DistanceParams {
  return {
    method: String(params.method) as DistanceMethod,
    statistic: String(params.statistic) as NearestStatistic,
    withinNm: Number(params.within) * NM_PER_UM,
    report: String(params.report) as WithinReport,
    symmetry: String(params.symmetry) as DistanceSymmetry,
  }
}

/**
 * The three facts every question about a comparison is asked of: the controls, and the kind of
 * geometry on each port.
 *
 * **A record because two of the three have the same type.** Ten functions here took
 * `(params, query, target)` positionally, `query` and `target` both being
 * `'skeletons' | 'meshes' | undefined` — so a swapped pair compiles silently, and
 * `mixedQuantityRefusal` already spelled the triple in a different order from the other nine,
 * which is the shape that produces the swap. It also made `evaluate` a fifteen-line call in which
 * each of the three appeared three times, and a fourth fact would have been ten signature edits.
 *
 * `DistanceWalk` extends it rather than repeating it: the walk is this plus the items and the
 * indexes, and `symmetricCells(walk)` is then the same call the node makes before anything is
 * built.
 */
export interface DistanceShape {
  params: DistanceParams
  /** The Query port's kind, absent while the socket has not resolved — `validate`'s case. */
  queryKind?: DistanceCollection['kind']
  /** The Target port's kind, absent where nothing is wired to it. */
  targetKind?: DistanceCollection['kind']
}

/**
 * The shape a *run* has, where the Query's value has arrived and its kind is therefore known.
 *
 * Two interfaces rather than one with a cast, because the difference is one field and it is the
 * field that separates the two audiences: `validate` and the Python emitter ask about sockets
 * that may not have resolved, and everything from `distanceSidesFrom` onward is holding values.
 * `DistanceWalk` extends this, so `symmetricCells(walk)` is the same call the node makes before
 * anything is built.
 */
export interface ResolvedShape extends DistanceShape {
  queryKind: DistanceCollection['kind']
}

/**
 * The shape a card can be asked about, from whatever context is asking.
 *
 * `validate` and the `Symmetry` control's `options` both had the three lines written out, five
 * apart in one file, and the Python emitter a third copy — which is the re-spelling `DistanceShape`
 * exists to stop, one level up from the positional hazard it was built for. `distanceKindOf` is
 * this function's business rather than three callers'.
 */
export function distanceShapeFrom(ctx: {
  params: ParamValues
  inputs: Readonly<Record<string, CodaType | undefined>>
}): DistanceShape {
  return {
    params: distanceParamsFrom(ctx.params),
    queryKind: distanceKindOf(ctx.inputs.query?.kind),
    targetKind: distanceKindOf(ctx.inputs.target?.kind),
  }
}

/** Whether both directions are computed, which doubles both the indexes and the walk. */
export function needsBothDirections(params: DistanceParams): boolean {
  return params.method !== 'centroid' && params.symmetry !== 'query'
}

// ---------------------------------------------------------------------------
// Samples: the points a neuron is measured from, and how much neuron each one stands for
// ---------------------------------------------------------------------------

export interface Samples {
  /** xyz interleaved, in the geometry's own nanometres. */
  readonly positions: Float32Array
  /**
   * How much of the neuron each position stands for: nm of cable, or nm² of surface.
   *
   * **Built on the first read, not with the record**, and the default settings are why. `min` and
   * `max` are not averages of anything and never touch this; on *meshes* they are also the path
   * that cannot use `closestPair`, so a closest approach — what the node opens on — walks every
   * sample of every pair through `samplesOf` and used to build a weight per vertex on the way. A
   * thousand meshes at 70,000 vertices is **560 MB** of `Float64Array` nobody reads and about
   * 2.2 s of `triangleArea` calls, and `SAMPLES` is keyed on the geometry, so it is held for as
   * long as the value is cached rather than for the run.
   *
   * Read it through a local where a loop wants it (`const weights = samples.weights`): it is a
   * getter, and a getter per sample is the cost this exists to avoid.
   */
  readonly weights: Float64Array
  /** The sum of `weights` — the neuron's whole cable or whole surface area, in nm or nm². */
  readonly total: number
  /**
   * How many samples there are, which is **not** always `positions.length / 3`.
   *
   * A skeleton's is `parents.length`, because that is the count `treeFor` builds its tree over —
   * `kdTree.ts` says outright that the two "agree on every skeleton a source produces, and where
   * they do not the tree is the one that must not read past the tree". The tree defended against
   * that and this did not: `weights` was allocated at `parents.length` while every reader walked
   * `positions.length / 3`, so on a disagreement `weights[i]` is `undefined` past the end and a
   * `mean`, a `median` or a `within` becomes `NaN` for the whole pair with nothing to say why.
   * One count, declared where the weights are built, read by everything that walks them.
   */
  readonly count: number
}

/**
 * Memoised on the geometry's identity, for `cableLength`'s reason and with the same licence: a
 * decoded skeleton or mesh is immutable by convention, and this is one pass over its buffers.
 * What it buys is the second direction and the second Run — an all-by-all computes every item's
 * samples once rather than once per pair.
 */
const SAMPLES = new WeakMap<SkeletonGeometry | MeshGeometry, Samples>()

/**
 * How many samples a geometry has, **without building them**.
 *
 * The one statement of `Samples.count`'s rule. `samplesOf` needs it to build a record at all, and
 * `countLookups` and `cellFor`'s scratch sizing want it over every item without holding a record
 * for each — an integer being a smaller thing to ask for than one. (It was also the only way to
 * avoid a pass over every buffer in front of the loop, until `Samples.weights` became lazy in the
 * same round and `samplesOf` stopped touching a buffer at all. That cost is gone; the rule is
 * still one rule.)
 *
 * Both of those read `positions.length / 3` before this existed, so a skeleton whose `parents`
 * and `positions` disagree sized the scratch from the wrong one — and a scratch one short is a
 * `Float64Array` write past the end, which a typed array **discards in silence** and a median
 * then reads as whatever the previous pair left.
 */
export function sampleCount(item: SkeletonGeometry | MeshGeometry): number {
  // `parents.length` for a skeleton, which is what `treeFor` builds its tree over.
  return 'parents' in item ? item.parents.length : Math.floor(item.positions.length / 3)
}

export function samplesOf(item: SkeletonGeometry | MeshGeometry): Samples {
  const held = SAMPLES.get(item)
  if (held) return held
  let weighted: Weights | undefined
  const build = (): Weights =>
    (weighted ??= 'parents' in item ? cableWeights(item) : areaWeights(item))
  const built: Samples = {
    positions: item.positions,
    count: sampleCount(item),
    get weights() {
      return build().weights
    },
    get total() {
      return build().total
    },
  }
  SAMPLES.set(item, built)
  return built
}

/** What the two builders below produce, and what the getters above hold once one has run. */
interface Weights {
  weights: Float64Array
  total: number
}

/**
 * Each node weighted by half the length of every edge at it, so the weights sum to the cable.
 *
 * **`total` is `cableLength`'s, not this loop's.** The two walk the same edges in the same order
 * and would agree to the last bit either way — which is exactly why it should be one number: the
 * card's footer, `morphometrics` and this all quote a neuron's cable, and a second accumulation
 * is a second thing to keep in step. It is memoised on the geometry, so a value whose length has
 * been asked for anywhere pays nothing here.
 */
function cableWeights(item: SkeletonGeometry): Weights {
  const count = sampleCount(item)
  const weights = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const parent = item.parents[i]!
    if (parent < 0) continue
    // `sqrt` of the sum rather than `Math.hypot`, which V8 does not inline — measured 13.6 ns a
    // call against 6.2, agreeing to 4e-16 relative, over an edge walk that is one per node.
    const dx = item.positions[i * 3]! - item.positions[parent * 3]!
    const dy = item.positions[i * 3 + 1]! - item.positions[parent * 3 + 1]!
    const dz = item.positions[i * 3 + 2]! - item.positions[parent * 3 + 2]!
    const half = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2
    weights[i] = weights[i]! + half
    weights[parent] = weights[parent]! + half
  }
  return { weights, total: cableLength(item) }
}

/**
 * Each vertex weighted by a third of the area of every triangle at it: the weights sum to it.
 *
 * `triangleArea` is `core/values.ts`', shared with the ROI viewer's `meshSurfaceArea` — so a
 * region's reported surface area and the weight spread over its vertices are one formula, and
 * `total` here equals what that function returns for the same mesh by construction. The
 * `cableLength` arrangement one function up, for its reason.
 */
function areaWeights(item: MeshGeometry): Weights {
  const count = sampleCount(item)
  const weights = new Float64Array(count)
  let total = 0
  for (let t = 0; t + 2 < item.indices.length; t += 3) {
    const a = item.indices[t]!
    const b = item.indices[t + 1]!
    const c = item.indices[t + 2]!
    const share = triangleArea(item.positions, a * 3, b * 3, c * 3) / 3
    weights[a] = weights[a]! + share
    weights[b] = weights[b]! + share
    weights[c] = weights[c]! + share
    total += share * 3
  }
  return { weights, total }
}

/**
 * The centre of mass of the cable or of the surface, in nm.
 *
 * Weighted for the reason everything else here is, and this is where it is easiest to see the
 * difference: a mesh's vertices crowd wherever the surface curves, so an unweighted vertex mean
 * is pulled towards the fiddliest part of the neuron, and `Downsample` moves it. **A set with no
 * weight at all falls back to the plain mean of its positions** — a one-node skeleton and a mesh
 * with no triangles are both real values and neither has a centre of mass to take.
 */
const CENTROIDS = new WeakMap<SkeletonGeometry | MeshGeometry, [number, number, number]>()

export function centroidOf(item: SkeletonGeometry | MeshGeometry): [number, number, number] {
  const held = CENTROIDS.get(item)
  if (held) return held
  const built = computeCentroid(item)
  CENTROIDS.set(item, built)
  return built
}

/**
 * Memoised on the geometry, for `samplesOf`'s reason and one of its own: it is what lets the
 * centroid walk compute each centre **inside** the sliced loop rather than in a pass in front of
 * it. A pre-pass over five hundred full-resolution meshes is seconds of arithmetic that no Cancel
 * can reach, which is the failure `core/slice.ts` records at the level below this one.
 */
function computeCentroid(item: SkeletonGeometry | MeshGeometry): [number, number, number] {
  const { positions, weights, total, count } = samplesOf(item)
  if (count === 0) return [0, 0, 0]
  let x = 0
  let y = 0
  let z = 0
  if (total > 0) {
    for (let i = 0; i < count; i++) {
      const w = weights[i]!
      if (w === 0) continue
      x += positions[i * 3]! * w
      y += positions[i * 3 + 1]! * w
      z += positions[i * 3 + 2]! * w
    }
    return [x / total, y / total, z / total]
  }
  for (let i = 0; i < count; i++) {
    x += positions[i * 3]!
    y += positions[i * 3 + 1]!
    z += positions[i * 3 + 2]!
  }
  return [x / count, y / count, z / count]
}

// ---------------------------------------------------------------------------
// The two directed measurements
// ---------------------------------------------------------------------------

/**
 * What one target neuron answers about a point, whichever kind it is.
 *
 * The seam that keeps this file free of `three`: `geometryIndex.ts` builds a k-d tree over a
 * skeleton's nodes or a triangle tree over a mesh's surface and hands back this pair, so
 * everything below is arithmetic a test can drive with a stub. Both methods take nanometres and
 * neither allocates — a matrix is one call per sample per target, which is tens of millions on
 * an ordinary comparison.
 */
export interface TargetIndex {
  /** Distance to the nearest point of, or on, this neuron. `Infinity` past `maxDist`. */
  nearest(x: number, y: number, z: number, maxDist?: number): number
  /** Whether any part of this neuron lies within `dist`. Early-exits on the first hit. */
  hasWithin(x: number, y: number, z: number, dist: number): boolean
  /**
   * The k-d tree behind this index, where it is one.
   *
   * **Data rather than a `closestTo?()` method**, which is what this was: an optional method that
   * also returned `undefined`, recognising the *other* index through a side table, was three
   * mechanisms carrying one bit — and the bit is simply whether an index is a point set or a
   * surface. As a field, "these two can descend together" is a question a caller can ask before
   * building anything, which is what `closestPairApplies` needs and what the cost model was
   * re-deriving from kinds.
   *
   * Absent on a mesh: a surface and a point set have no shared descent here, and the
   * surface-to-surface one `three-mesh-bvh` offers was measured three orders of magnitude slower
   * than the per-point walk (`geometryIndex.ts`).
   */
  points?: KdTree
}

/**
 * One direction of the nearest-point methods: query samples against one target, in nm.
 *
 * `min`, `max` and `mean` are each a single pass that keeps nothing — the median is the one
 * statistic that has to see every distance before it can answer, and it is handed a scratch array
 * rather than growing one per pair.
 *
 * `mean` and `median` are weighted by the cable or the area each sample stands for. **A sample
 * with no weight still counts for `min` and `max`**: an isolated node has no cable at it and is
 * still part of the neuron, and leaving it out would make the closest approach depend on whether
 * a reconstruction happened to leave a stub.
 */
/**
 * Everything the weighted median needs that outlives one cell of the matrix.
 *
 * **Both arrays, not just the order.** The order was already shared; `distances` was still a
 * `Float64Array(count)` per call, which on a 500-neuron all-by-all of 20,000-node skeletons is a
 * quarter of a million allocations of 160 kB — about 40 GB — each zero-filled by the runtime
 * before a single distance is written into it.
 *
 * **It is not faster, and that is worth saying rather than implying.** Measured at 20 neurons of
 * 20,000 nodes, median of three each way: 3.73 s shared against 3.75 s per-cell, which is noise.
 * V8's young generation absorbs this size without complaint. What the change buys is the
 * *pressure* at the sizes the node is for, in a browser tab that is also holding geometry buffers
 * and a WebGL context — and a walk that allocates nothing per cell is one whose cost does not
 * depend on what else the page is doing.
 *
 * **Nothing is cleared between cells, and that is sound rather than a shortcut.** `distances` is
 * written at sample index `i` and read only at the indices `order[0 … n)` names, which are
 * exactly the ones this call wrote; a stale value from the previous pair occupies a slot nothing
 * looks at. The alternative — refilling 20,000 doubles with zeroes per cell — is the cost this
 * exists to remove.
 *
 * **The claim above was false while a `compare` closure lived here**, which is worth keeping
 * because the field looked like the careful half. `order.subarray(0, n).sort(compare)` is a view
 * allocated per cell and a V8 sort that, given a comparator, copies the elements into a work
 * array and calls back into JS for every comparison: 20,000 sorts of 2,000 indices ran 757 minor
 * collections. `sortByDistance` below reads the key inline and sorts the range in place, so a
 * walk that allocates nothing per cell now actually does — and it is **8.7x** faster besides
 * (239.5 µs a sort against 27.6 at 2,000 samples).
 */
export interface MedianScratch {
  /** Sample indices with a finite distance, in reading order, then sorted by distance. */
  readonly order: Int32Array
  /** Distance per sample. Read only where `order` points; never cleared. */
  readonly distances: Float64Array
}

/** Room for `size` samples, which is the largest neuron either side carries. */
export function medianScratch(size: number): MedianScratch {
  return { order: new Int32Array(size), distances: new Float64Array(size) }
}

export function directedNearest(
  samples: Samples,
  index: TargetIndex,
  statistic: NearestStatistic,
  /**
   * Reused across every pair — see `MedianScratch`. Absent, which is every test and the
   * `min`/`mean` paths, it is allocated here.
   */
  scratch?: MedianScratch,
): number {
  const count = samples.count
  if (count === 0) return NaN
  // `positions` through a local and `index.nearest` called where it is used, never through an
  // `at(i)` closure: that was one function object per cell — allocated *before* the `min` branch
  // that never called it, so the default statistic paid for it on every pair — and one indirect
  // call per sample on the three that did.
  const pos = samples.positions

  /*
   * **`min` hands its running best back as the search's bound**, which is the whole reason
   * `KdTree.nearest` takes one. After the first sample the bound is already about the pair's
   * closest approach, so for two neurons that do not touch — the ordinary case, and the node's
   * default statistic — the root's two children both fail it and the search ends in two box
   * tests instead of a full descent. Measured on a pair of 20,000-node arbours: **3.3 ms → 0.5 ms
   * apart (6.7x) and 9.6 ms → 0.2 ms overlapping (48x)**, byte-identical answers. A bounded
   * search that finds nothing returns `Infinity`, which the loop already skips.
   *
   * `max` has no such bound — its running best is the *wrong* end — which is why the two are
   * separate loops rather than one with a comparison chosen per sample.
   */
  if (statistic === 'min') {
    let best = Infinity
    for (let i = 0; i < count; i++) {
      const d = index.nearest(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!, best)
      if (d < best) best = d
    }
    return Number.isFinite(best) ? best : NaN
  }

  if (statistic === 'max') {
    let best = -Infinity
    for (let i = 0; i < count; i++) {
      const d = index.nearest(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!)
      if (Number.isFinite(d) && d > best) best = d
    }
    return Number.isFinite(best) ? best : NaN
  }

  /*
   * The mean is streamed — there is nothing to keep, so nothing is allocated. Both totals are
   * accumulated in one pass: the weighted one, and the plain one that answers where a value has
   * no cable or area anywhere (a one-node skeleton, a mesh of loose vertices), which is the
   * honest answer rather than the NaN that would read as "this pair was not measured".
   */
  if (statistic === 'mean') {
    let sum = 0
    let weight = 0
    let plain = 0
    let n = 0
    const weights = samples.weights
    for (let i = 0; i < count; i++) {
      const d = index.nearest(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!)
      if (!Number.isFinite(d)) continue
      const w = weights[i]!
      sum += d * w
      weight += w
      plain += d
      n++
    }
    if (weight > 0) return sum / weight
    return n > 0 ? plain / n : NaN
  }

  return weightedMedian(samples, index, count, scratch ?? medianScratch(count))
}

/**
 * The distance at which half the neuron's cable or surface is nearer and half further.
 *
 * Sorted by distance, then walked to the half-weight. **Interpolated between the two samples the
 * half falls between**, so the answer moves smoothly as geometry does rather than stepping from
 * one sample's distance to the next.
 *
 * **A value carrying no weight at all is read as one where every sample weighs the same**, rather
 * than falling out to a second implementation. The two agree by construction: at uniform weights
 * the half-weight point *is* the middle, and the interpolation below is the mean of the two
 * middle values — which is `quantileSorted(…, 0.5)` exactly. One walk, one convention, nothing to
 * drift.
 */
function weightedMedian(
  samples: Samples,
  index: TargetIndex,
  count: number,
  scratch: MedianScratch,
): number {
  const distances = scratch.distances
  const pos = samples.positions
  const weights = samples.weights
  let n = 0
  let weight = 0
  for (let i = 0; i < count; i++) {
    const d = index.nearest(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!)
    if (!Number.isFinite(d)) continue
    distances[i] = d
    scratch.order[n++] = i
    weight += weights[i]!
  }
  if (n === 0) return NaN

  const order = scratch.order
  sortByDistance(order, distances, 0, n - 1)
  // `uniform` read inline rather than through a `weightOf(i)` closure, which was a second
  // function object per cell per direction and an indirect call per sample.
  const uniform = weight <= 0
  const half = (uniform ? n : weight) / 2

  let before = 0
  for (let k = 0; k < n; k++) {
    const i = order[k]!
    const w = uniform ? 1 : weights[i]!
    const after = before + w
    if (after >= half) {
      /*
       * **`k + 1 >= n`, spelled out.** This read `order[k + 1] === undefined`, which was true
       * only because `order` was a `subarray(0, n)` — and that view was an allocation per cell.
       * Over the whole scratch the slot past `n` holds an index the *previous* pair left there,
       * so the bound has to be a comparison rather than a shape.
       *
       * It is **unreachable today and written anyway**: `after` at the last sample is the whole
       * weight and `half` is half of it, so `after > half` returns first for any positive total,
       * and the uniform branch is `n` against `n / 2`. Mutation testing says so — removing this
       * fails nothing. What it protects is the next edit to the walk, which would otherwise have
       * to re-derive that argument to find out whether the shape it removed was load-bearing.
       */
      if (k + 1 >= n || after > half || w === 0) return distances[i]!
      // Exactly on the boundary between two samples: the midpoint, as a plain median takes the
      // mean of the two middle values rather than either one.
      return (distances[i]! + distances[order[k + 1]!]!) / 2
    }
    before = after
  }
  return distances[order[n - 1]!]!
}

/**
 * Sort `order[lo, hi]` by the distance each index names, in place.
 *
 * **A sort written out rather than `TypedArray.prototype.sort(compare)`, and the reason is the
 * comparator rather than the algorithm.** V8 has no way to inline a JS comparison function into
 * its sort: given one it copies the elements into a work array and calls back for every
 * comparison, which at 2,000 samples measured **239.5 µs a call against 27.6** here, and 757
 * minor collections over 20,000 sorts where this makes none. On a 500-neuron all-by-all that is
 * the difference between a median costing **1,240 µs a pair and 995** — the last per-cell
 * allocation in the walk, measured over a 120-neuron all-by-all of 2,000-node arbours at
 * 9.01 s against 7.22, with `mean` unmoved beside it at 818 µs either way.
 *
 * `matrixReduce.ts` sorts a line's values with a bare `window.sort()` and is **not** the same
 * case: with no comparator that is the native path, and what it leaves on the table is the sort
 * itself where a selection would do. **A selection is not worth taking here**, and the same
 * measurement is why: at 995 µs a cell against the mean's 818, the median's whole overhead is
 * 177 µs and the sort is 28 of it, so a quickselect's ceiling is under three per cent of the
 * cell — against a second definition of the median, which is what `core/stats.ts` exists to
 * stop there being.
 *
 * Hoare's partition with a **deterministic** median-of-three pivot, which is `selectNth`'s rule
 * in `kdTree.ts` and carries its argument: invariant 4 asks `evaluate` to be deterministic, and a
 * sort whose pivots depend on `Math.random()` puts a different last digit in a cache entry that
 * provenance says is unchanged. It is also why ties need no thought — the scan's strict
 * comparisons walk equal keys inward from both ends, so a run of equal distances splits evenly
 * rather than degenerating, and the permutation among them is fixed rather than resting on
 * whether a runtime's sort happens to be stable. The recursion takes the smaller side and loops
 * on the larger, so the stack is bounded by `log2(n)` rather than by the partition's luck.
 *
 * Non-finite distances never reach here: `weightedMedian` drops them as it fills `order`.
 */
function sortByDistance(order: Int32Array, distances: Float64Array, lo0: number, hi0: number) {
  let lo = lo0
  let hi = hi0
  while (hi - lo > INSERTION_RUN) {
    const mid = (lo + hi) >> 1
    // `medianOfThree` is `kdTree.ts`', where `selectNth` picks its pivot the same way. The
    // written-out *key read* below is what that file's note is about — three doubles already in
    // locals are a monomorphic call this one does not need to inline by hand.
    const pivot = medianOfThree(
      distances[order[lo]!]!,
      distances[order[mid]!]!,
      distances[order[hi]!]!,
    )
    let i = lo
    let j = hi
    while (i <= j) {
      while (distances[order[i]!]! < pivot) i++
      while (distances[order[j]!]! > pivot) j--
      if (i <= j) {
        const swap = order[i]!
        order[i] = order[j]!
        order[j] = swap
        i++
        j--
      }
    }
    if (j - lo < hi - i) {
      sortByDistance(order, distances, lo, j)
      lo = i
    } else {
      sortByDistance(order, distances, i, hi)
      hi = j
    }
  }
  // Insertion sort over the short tail, which is what a quicksort's last levels are worth.
  for (let k = lo + 1; k <= hi; k++) {
    const held = order[k]!
    const d = distances[held]!
    let m = k - 1
    while (m >= lo && distances[order[m]!]! > d) {
      order[m + 1] = order[m]!
      m--
    }
    order[m + 1] = held
  }
}

/**
 * Where `sortByDistance` stops partitioning and finishes with an insertion sort.
 *
 * Swept rather than taken from the conventional dozen, which is `LEAF_SIZE`'s argument in
 * `kdTree.ts` — the curve is shallow enough that a number nobody measured would never be caught.
 * Median of three at 2,000 samples, µs a sort, over the three shapes a run of distances comes in:
 *
 * | run | 4 | 8 | 12 | **16** | 24 | 32 | 48 |
 * | --- | --- | --- | --- | --- | --- | --- | --- |
 * | distinct | 32.8 | 31.2 | 30.1 | **28.7** | 29.1 | 29.7 | 32.2 |
 * | eight distinct values | 29.0 | 25.2 | 25.7 | **24.2** | 22.9 | 22.0 | 21.1 |
 * | already sorted | 20.9 | 18.7 | 20.5 | **16.3** | 16.4 | 14.4 | 14.4 |
 *
 * 16 is the minimum on the first row, which is the shape that matters — distances from a
 * neuron's samples to another neuron are continuous, and the other two rows are here to show the
 * degenerate cases do not punish it. Longer runs keep winning on those two and start losing on
 * the first; the whole band from 8 to 32 is within eight per cent either way, so this is a floor
 * under a bad choice rather than a tuned number.
 */
const INSERTION_RUN = 16

/**
 * One direction of `within`: how much of the query lies within `withinNm` of the target.
 *
 * In nm of cable or nm² of surface — the caller converts. `hasWithin` rather than `nearest`
 * because *which* point is never asked and the early exit is most of what makes this method
 * affordable on a pair that genuinely overlaps.
 *
 * **This is not `navis.cable_overlap`'s arithmetic**, and the difference is worth naming because
 * the export cell says so too. navis queries the *target's* points against the query's tree and
 * sums the length of every query node that came back as somebody's nearest neighbour — so a
 * query node that two target points both pick is counted twice, and one that no target point
 * happens to pick is not counted at all even when it is well inside the distance. Here each
 * query sample is asked its own question once, so the answer is bounded by the neuron's own
 * cable and does not move with how densely the *other* neuron was reconstructed.
 */
export function directedWithin(samples: Samples, index: TargetIndex, withinNm: number): number {
  const count = samples.count
  const pos = samples.positions
  const weights = samples.weights
  let inside = 0
  for (let i = 0; i < count; i++) {
    const w = weights[i]!
    if (w === 0) continue
    if (index.hasWithin(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!, withinNm)) {
      inside += w
    }
  }
  return inside
}

/**
 * Put the two directions together.
 *
 * A direction that could not be measured — an empty neuron, a statistic over no finite distance
 * — is `NaN`, and **`NaN` propagates rather than being treated as the other direction's answer**:
 * `min` of a measured 4 µm and an unmeasured pair is not 4 µm, it is a pair one half of which
 * says nothing. The Heatmap draws an unrecorded cell for it, which is the honest picture.
 */
export function combineDirections(
  forward: number,
  reverse: number,
  symmetry: DistanceSymmetry,
): number {
  if (symmetry === 'query') return forward
  if (Number.isNaN(forward) || Number.isNaN(reverse)) return NaN
  switch (symmetry) {
    case 'min':
      return Math.min(forward, reverse)
    case 'max':
      return Math.max(forward, reverse)
    default:
      return (forward + reverse) / 2
  }
}

// ---------------------------------------------------------------------------
// What the numbers are, and what to call them
// ---------------------------------------------------------------------------

/**
 * What `within` counts on one kind of geometry, and what it is counted in.
 *
 * The one place the two kinds diverge in *units* rather than in implementation, which is why it
 * is a value rather than a pair of branches: `mixedQuantityRefusal` and the caption both read
 * it, and a third spelling is how µm² comes to be labelled µm.
 */
export interface Quantity {
  /** 'cable' or 'surface area'. */
  noun: string
  /** 'µm' or 'µm²'. */
  unit: string
  /** nm or nm² to the unit above. */
  scale: number
}

export function quantityOf(kind: DistanceCollection['kind']): Quantity {
  return kind === 'skeletons'
    ? { noun: 'cable', unit: 'µm', scale: 1 / NM_PER_UM }
    : { noun: 'surface area', unit: 'µm²', scale: 1 / (NM_PER_UM * NM_PER_UM) }
}

/**
 * What a cell is called, which is `STATISTIC_OPTIONS`' label everywhere but one.
 *
 * Derived rather than transcribed: three of the four were byte-identical, so renaming an option
 * left the matrix's `valueLabel` and `Download`'s header on the old name with nothing failing.
 * `max` is the override and is written as one — the picker offers "furthest from the other",
 * which is what a reader is choosing, and a cell is the Hausdorff distance, which is what it is.
 */
const STATISTIC_LABELS: Record<NearestStatistic, string> = {
  ...(Object.fromEntries(
    STATISTIC_OPTIONS.map((option) => [option.value, option.label]),
  ) as Record<NearestStatistic, string>),
  max: 'Hausdorff distance',
}

/** The cells' own name, which the Heatmap's legend and `Download`'s header both read. */
export function distanceValueLabel(
  params: DistanceParams,
  kind: DistanceCollection['kind'],
): string {
  if (params.method === 'centroid') return 'centroid distance (µm)'
  if (params.method === 'nearest')
    return `${STATISTIC_LABELS[params.statistic] ?? 'distance'} (µm)`
  // Below the two returns that never read it: the kind rather than the `Quantity` it derives,
  // because the one caller had to import `quantityOf` and build one sixty lines before its use.
  const quantity = quantityOf(kind)
  const within = `within ${(params.withinNm / NM_PER_UM).toLocaleString()} µm`
  return params.report === 'fraction'
    ? `fraction of ${quantity.noun} ${within}`
    : `${quantity.noun} ${within} (${quantity.unit})`
}

/**
 * What the cells *are*, which is the field `Linkage` reads to decide whether to invert them.
 *
 * Three answers and each is load-bearing. The two distance methods say `distance`, so a
 * clustering takes the matrix as it stands — this node is the first thing in Coda that hands
 * `Linkage` a real distance rather than a similarity it has to do `1 - x` to. `within` as a
 * **fraction** is a similarity bounded by 1, so `1 - x` is a proper distance and saying
 * `similarity` is correct. `within` in **µm** is neither: `1 - 340` is `-339`, which fastcore
 * clusters without complaint into a tree with merge heights below zero that the viewer draws off
 * the side of the card. So it says `count`, which is what `checkLinkageDistances` already
 * refuses with a message naming `Normalize` — the failure `linkageOps.ts` records was found in a
 * browser and is exactly this one.
 */
export function distanceMeasure(params: DistanceParams): 'distance' | 'similarity' | 'count' {
  if (params.method !== 'within') return 'distance'
  return params.report === 'fraction' ? 'similarity' : 'count'
}

/**
 * Refuse to average micrometres against square micrometres.
 *
 * `within` measures the *query's* material in one direction and the *target's* in the other, so
 * a skeleton on one port and a mesh on the other makes the two directions cable in µm and
 * surface in µm² — and `mean`, `min` and `max` over those two is not a number of anything. It
 * reads perfectly well on a heatmap, which is why this refuses rather than warns.
 *
 * **The fraction is refused too**, although two fractions are both dimensionless. They are
 * fractions *of different materials*: "a tenth of this skeleton's cable is near that surface, and
 * a fifth of that surface is near this cable" averages to a number that describes neither. One
 * rule and one sentence rather than a second, narrower one nobody would find.
 */
export function mixedQuantityRefusal(shape: DistanceShape): string | undefined {
  /*
   * **Kinds, not values**, so `validate` and `evaluate` render the same function rather than the
   * same paragraph twice — `kindClashMessage`'s rule, and this one is asked at edit time because
   * both halves of it are known then: the two sockets' kinds and two params. A card that goes red
   * on Run for something that was visible while it was being configured is a worse card.
   *
   * `DistanceShape` rather than `ResolvedShape`: an unresolved socket is `undefined` here and is
   * never a refusal.
   */
  const { params, queryKind: query, targetKind: target } = shape
  if (params.method !== 'within' || !query || !target) return undefined
  if (query === target || params.symmetry === 'query') return undefined
  const q = quantityOf(query)
  const t = quantityOf(target)
  return (
    `Query is ${query} and Target is ${target}, so the two directions of this ` +
    `measurement are ${q.noun} in ${q.unit} and ${t.noun} in ${t.unit}. Combining them is not a ` +
    `number of anything, and it would draw a perfectly ordinary heatmap. Set Symmetry to ` +
    `“query against target only”, which measures the Query’s ${q.noun} and nothing else, or ` +
    `wire the same kind of geometry to both ports.`
  )
}

// ---------------------------------------------------------------------------
// What it costs
// ---------------------------------------------------------------------------

/**
 * Nearest-point searches a second, single-threaded, by target kind and by how much the method's
 * pruning saves — measured by `pnpm probe:distance` on the arrangement that prunes *worst*.
 *
 * **`exhaustive` is `mean` and `median`**, which ask every sample its own question and can skip
 * nothing. **`bounded` is `within`**, which asks `hasWithin` and stops at the first hit, and
 * `min` wherever it cannot use `closestPair` below. Measured at 1.4 M/s against 2.9 M/s on
 * skeletons — about two — and the mesh pair carries the same factor rather than a number of its
 * own.
 *
 * Two arrangements were measured and the **worse** is what these are: neurons scattered through a
 * brain prune far better than neurons sharing territory (83 M/s against 16 M/s for a closest
 * approach), and a warning built on the happy one under-promises on the graph somebody is most
 * likely to be waiting for — a cell type against itself.
 *
 * **The mesh rate halves with every quadrupling of the surface, so the size it is taken at is
 * part of the constant.** `pnpm probe:distance` measures 235,000 / 98,000 / 49,000 / **24,000**
 * searches a second at 2,048 / 18,432 / 73,728 / 294,912 triangles, and it grew that last row
 * because the three before it are all smaller than a neuron: the number here had been the
 * 73,728-triangle one, which is about half the wait a real surface costs. It is the worst
 * *measured* size and still not the worst there is — `Meshes` spends a 1.5 M-triangle budget and
 * a graphene body can carry ten times that — so this stays an under-estimate for a
 * full-resolution scene, which the node's own 5-minute threshold is far enough out to absorb.
 */
const SEARCHES_PER_SECOND: Record<
  DistanceCollection['kind'],
  { exhaustive: number; bounded: number }
> = {
  skeletons: { exhaustive: 1_400_000, bounded: 2_900_000 },
  meshes: { exhaustive: 24_000, bounded: 48_000 },
}

/**
 * Microseconds for one closest approach between two skeletons, measured at 2,000 nodes each.
 *
 * **A pair, not a lookup, because `min` performs no lookups at all** where both sides are point
 * sets: `closestPair` walks the two trees together, so the work is a descent rather than a query
 * per sample, and pricing it per sample is what produced a twenty-hour estimate for a run that
 * takes a minute. It grows with the depth of the two trees rather than with the sample count, so
 * it is not scaled by one.
 *
 * 75 µs is the **overlapping** arrangement — neurons sharing territory, where nothing prunes —
 * against 19 µs scattered through a brain. It was 130 before the descent stopped allocating a
 * closure per call and started reading its spans from an array, which is the sort of thing that
 * moves a calibration constant and is why the probe prints it.
 */
const CLOSEST_PAIR_MICROS = 75

/**
 * How long a comparison has to threaten before it says so: **five minutes**.
 *
 * `MESH_WARN_SECONDS` exactly, and for its argument — five minutes is about where a wait stops
 * being something you sit through. **Restated rather than imported**, because that one lives in
 * `data/cave/meshes.ts` and is about a *fetch* from one backend: a node measuring geometry
 * reaching into a CAVE module for its own patience threshold would make the two move together
 * whether or not the argument still applied to both. If a third reader ever wants it, the number
 * belongs beside `describeDuration` in `core/limits.ts` rather than in either caller. It was thirty seconds, which is a sentence in front of a wait
 * the progress bar already describes, and a warning raised over half a minute is how a reader
 * learns to dismiss the next one.
 *
 * A **warning, not a refusal** — `NBLAST_PAIRS_WARN`'s argument, and the same history.
 */
const DISTANCE_WARN_SECONDS = 300

/**
 * Whether a pair can be answered by one dual-tree descent rather than a walk of samples.
 *
 * **The one statement of it**, read by three places that were each deciding it for themselves —
 * the node, when it chooses which index sets to build; `cellFor`, when it picks a cell function;
 * and `estimatedSeconds`, which was re-deriving it from kinds alone. That last one is how the
 * estimate came to describe an algorithm the walk did not run: with `Symmetry: query against
 * target only` and two ports, `needsBothDirections` is false, so no query-side index was built,
 * so the descent could not happen — and the estimate quoted its price anyway. Five times out on
 * the run, and in the direction that had already been reported once.
 *
 * `symmetry` is therefore *not* part of this: the descent answers a symmetric quantity, so it
 * serves every setting equally. What had to change is that the node builds both index sets
 * whenever this is true, rather than only when two directions are combined.
 */
export function closestPairApplies(shape: DistanceShape): boolean {
  return isClosestApproach(shape.params) && bothPointSets(shape)
}

/**
 * Skeletons on both sides, which is the whole of when a dual-tree descent is available at all.
 *
 * A mesh is a surface, and a surface and a point set have no shared descent here — see
 * `geometryIndex.ts`, which records that `closestPointToGeometry`, the surface-to-surface
 * counterpart, was written and measured three orders of magnitude the wrong way.
 */
function bothPointSets({ queryKind, targetKind }: DistanceShape): boolean {
  return queryKind === 'skeletons' && (targetKind ?? queryKind) === 'skeletons'
}

/**
 * Whether the walk will ask a dual-tree descent about a pair **at all** — and therefore whether
 * it needs the query side's trees as well as the target's.
 *
 * Two methods reach for one, and only one of them is *answered* by it. `closestPairApplies` is
 * the cell: a closest approach between two point sets is what the descent returns, and nothing
 * else runs. `within` asks the same question as an **exact pre-rejection** — if the nearest parts
 * of two neurons are further apart than `Within`, no sample of either can be inside it and the
 * cell is zero — and walks the samples where they are not.
 *
 * **One predicate, because the two need the same resource**, and splitting them is what went
 * wrong: `needsQueryIndexes` asked `closestPairApplies`, so the `within` half was switched off
 * for `Symmetry: query against target only` on two ports, where `needsBothDirections` is false
 * as well. That is `closestPairApplies`' own recorded defect one method over, with the same cause
 * and the same shape — a question about arithmetic standing in for a question about resources.
 *
 * It was never a missing *feature*, which is what settles the trade. An all-by-all hands its
 * target indexes over as its query indexes, so one port has always had the pre-rejection, and two
 * ports had it under every symmetry but that one; what this does is make them agree. Measured on
 * 60 two-port skeletons of 2,000 nodes, `within` with one direction: **45.4 µs a pair against
 * 13.0** scattered through a brain.
 */
export function descentApplies(shape: DistanceShape): boolean {
  const { params } = shape
  return (isClosestApproach(params) || params.method === 'within') && bothPointSets(shape)
}

/**
 * The half of `closestPairApplies` that is about the *settings* alone.
 *
 * The params half of `closestPairApplies` and `descentApplies`, named because both read it and
 * because `cellFor` picks its arm from it. (It was introduced when `cellFor` had no kinds to ask
 * about; `DistanceWalk extends ResolvedShape` now, so the arm *could* ask `closestPairApplies`
 * outright — what stops it is that the per-cell `points` check is also the fallback that lets a
 * caller hand over indexes the predicate would not have asked for, which several tests do.)
 */
function isClosestApproach(params: DistanceParams): boolean {
  return params.method === 'nearest' && params.statistic === 'min'
}

/**
 * Whether the run needs an index for the **query** side as well as the target.
 *
 * Two directions need one; so does a dual-tree descent, which reads both trees however few
 * directions are reported. `needsBothDirections` answers the first and was being asked the
 * second, which is a question about arithmetic standing in for a question about resources — and
 * `descentApplies` rather than `closestPairApplies` is that same fix finished, `within`'s
 * pre-rejection reading both trees exactly as a closest approach does.
 */
export function needsQueryIndexes(shape: DistanceShape): boolean {
  return needsBothDirections(shape.params) || descentApplies(shape)
}

/**
 * Whether cell `(i, j)` is the same number as cell `(j, i)`, which is what lets an all-by-all
 * walk its upper triangle and mirror the rest.
 *
 * **`symmetry !== 'query'` is not the whole of it, and reading it as though it were cost a
 * factor of two twice over.** Combining the two directions with `mean`, `min` or `max` is
 * symmetric in them by construction, so that arm is the easy one; what it misses is that two of
 * the *quantities* are symmetric whatever `Symmetry` says. A centroid distance is `|c_i - c_j|`
 * and has one direction by construction. A closest approach between two point sets is a property
 * of the two **sets** — `closestPair` answers it with one descent, and that is the whole argument
 * behind `symmetryOptionsFor` drawing the control dead there. So an all-by-all in either of those
 * configurations was computing the entire grid, and `countLookups` — which is documented as
 * counting the pairs actually *computed* — was pricing half of it. Measured at 80 neurons on the
 * default statistic: **0.030 s mirrored against 0.053 s not**, with an identical estimate over
 * the top.
 *
 * The configuration is reachable with the control drawn dead, which is why this is not a
 * theoretical arm: an empty `EnumParam.options` deliberately **keeps** the stored value, so
 * setting `Symmetry: query against target only` under `within` and switching to a closest
 * approach leaves `query` in the params with no control offering to change it back.
 *
 * `closestPairApplies` rather than a second reading of the kinds, and it is also what keeps this
 * honest at run time: `needsQueryIndexes` builds the query-side trees exactly when this says the
 * descent answers every cell, so `cellFor`'s fallback to the asymmetric `walkPair` cannot be
 * reached on a walk this has called symmetric.
 */
export function symmetricCells(shape: DistanceShape): boolean {
  const { params } = shape
  if (params.symmetry !== 'query') return true
  return params.method === 'centroid' || closestPairApplies(shape)
}

/**
 * The effective rate for what this method actually does, which is `checkDistanceSize`'s divisor.
 *
 * A mixed pair takes the slower of the two kinds, the reverse direction searching the Query's
 * index.
 */
function searchesPerSecond({ params, queryKind, targetKind }: ResolvedShape): number {
  const pruning =
    params.method === 'within' || params.statistic === 'min' ? 'bounded' : 'exhaustive'
  return Math.min(
    SEARCHES_PER_SECOND[queryKind][pruning],
    SEARCHES_PER_SECOND[targetKind ?? queryKind][pruning],
  )
}

/**
 * How many cells the walk will actually compute, which is what everything downstream is priced
 * per.
 *
 * **Here rather than in the node, because it was a one-line expression in the node and the line
 * was wrong.** `allByAll ? rows * (rows + 1) / 2 : rows * cols` reads as though an all-by-all
 * always halves; `distanceValues` halves an all-by-all whose *cells* are symmetric, which is a
 * narrower thing (`symmetricCells`). The two disagreed for `Symmetry: query against target only`,
 * so a run walking the whole grid was announced at half its cost — the one direction an estimate
 * must not be wrong in, and exactly the drift `closestPairApplies`' doc comment describes from
 * the other side. One expression, in the file whose test can reach it.
 */
export function pairsWalked(
  rows: number,
  cols: number,
  shape: DistanceShape,
  allByAll: boolean,
): number {
  return mirrorsCells(shape, allByAll) ? (rows * (rows + 1)) / 2 : rows * cols
}

/**
 * Whether the walk will fill the lower half by mirroring rather than by measuring.
 *
 * The *predicate* `pairsWalked` counts and `distanceValues` walks — and it was written out at
 * both, which is the drift `pairsWalked`'s own comment was added to end one level down. It
 * centralised the arithmetic and left the condition in two places, so the estimate and the walk
 * could still come apart on the one question they must agree about.
 */
export function mirrorsCells(shape: DistanceShape, allByAll: boolean): boolean {
  return allByAll && symmetricCells(shape)
}

/**
 * How many nearest-point searches a comparison will run.
 *
 * Every sample of every query neuron against every target neuron, doubled where both directions
 * are wanted — over the pairs that are actually **computed**, which `pairsWalked` answers and
 * which on a mirrored all-by-all is the upper triangle rather than the whole grid. Counting the
 * grid was a straight factor of two on the commonest shape there is; counting the triangle
 * whatever the symmetry was the same factor back the other way.
 *
 * Counted **before any index is built** — `volumeBoxes`' rule, and the same reason: a sentence
 * that arrives after a second of tree building is a sentence about a wait the reader was never
 * told about and could not cancel.
 *
 * It is a count of the *samples*, which is the right unit only for the methods that walk them.
 * `estimatedSeconds` is where that distinction is made; this number is what it divides.
 */
export function countLookups(
  queryItems: readonly (SkeletonGeometry | MeshGeometry)[],
  targetItems: readonly (SkeletonGeometry | MeshGeometry)[],
  params: DistanceParams,
  pairs: number,
): number {
  if (params.method === 'centroid') return 0
  const meanSamples = (items: readonly (SkeletonGeometry | MeshGeometry)[]): number =>
    items.length === 0
      ? 0
      : items.reduce((sum, item) => sum + sampleCount(item), 0) / items.length
  const perPair =
    meanSamples(queryItems) + (needsBothDirections(params) ? meanSamples(targetItems) : 0)
  return pairs * perPair
}

/**
 * How long this comparison will take, in seconds.
 *
 * **Two shapes, because the methods are two algorithms**, and pricing them as one is what told
 * somebody a twenty-hour wait for a run of about a minute. A closest approach between two
 * skeletons is a single descent of both trees, so it costs a flat amount *per pair* and the
 * sample count barely enters; everything else asks a question per sample, so it costs the
 * samples divided by a rate.
 */
/*
 * **Building the indexes is not in this, and that is an argument rather than an omission.** A
 * tree is built once per neuron and a search is run once per sample per *pair*, so the build is
 * bounded by the two sides where the wait is bounded by their product — it can only be the larger
 * half where the product is small, which is where nothing warns. At the sizes the threshold is
 * near: 1,000 neuron-sized meshes build in about 58 s (58 ms each, measured) against a search
 * cost in the thousands of hours, and even a two-by-two of them is 232 ms of building against
 * 37 s of searching, because a mesh carries so many samples. The bar reports the build as its
 * own stretch (0.01 to 0.25) for exactly this reason: it is a wait worth *showing* and never the
 * one worth warning about. Adding it would also be wrong on a second Run, where `meshTrees.ts`
 * and `treeFor` hold every tree against its geometry and the phase costs nothing at all.
 */
export function estimatedSeconds(pairs: number, lookups: number, shape: ResolvedShape): number {
  // No centroid arm: `countLookups` already answers zero for it, and a second copy of that policy
  // is a second thing to keep in step.
  if (closestPairApplies(shape)) return (pairs * CLOSEST_PAIR_MICROS) / 1e6
  return lookups / searchesPerSecond(shape)
}

/**
 * Say what a long comparison will cost, and refuse only a matrix that cannot be allocated.
 *
 * **Not through `warnOverThreshold`**, which is the house shape and does not fit this one: it
 * renders "N unit is past CONTROL (threshold)" and then the caller's own sentence, which for a
 * threshold measured in *seconds* printed the duration twice — "62 seconds of searching … is past
 * … (30). That is about 62 seconds." `CaveSource`'s graphene warning is the precedent for writing
 * the sentence out at a seconds-stated limit, and it keeps the clause that matters: these
 * messages were refusals for most of Coda's life, so each says there will still be a result.
 *
 * Short on purpose. The progress bar says whether it is moving; what this has to add is how long,
 * and the one lever that actually moves it — which is nothing at all for a closest approach,
 * where resampling does not help and the neurons on the two ports are the question being asked.
 */
export function checkDistanceSize(
  ctx: Warner,
  rows: number,
  cols: number,
  seconds: number,
  shape: DistanceShape,
): void {
  refuseIfOverCrashFloor(
    `A ${rows.toLocaleString()} x ${cols.toLocaleString()} matrix`,
    rows * cols * 8,
  )
  if (seconds <= DISTANCE_WARN_SECONDS) return
  /*
   * The lever is offered only where it works. A coarser resample is worth a factor of ten to a
   * statistic that asks every sample its own question, and the node's cable weighting is what
   * makes it safe — but a dual-tree descent walks the trees rather than the samples, so there it
   * would be advice that does nothing.
   */
  const lever = closestPairApplies(shape)
    ? ''
    : ' A coarser Resample on Clean Skeletons moves that proportionally, and these statistics are' +
      ' weighted by cable, so it does not change the answer.'
  ctx.warn(
    `A ${rows.toLocaleString()} x ${cols.toLocaleString()} comparison is ` +
      `${describeDuration(seconds)} of searching.${lever} Running anyway; cancel if that is not ` +
      `what you meant.`,
  )
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export interface DistanceWalk extends ResolvedShape {
  queryItems: readonly (SkeletonGeometry | MeshGeometry)[]
  targetItems: readonly (SkeletonGeometry | MeshGeometry)[]
  /** One per target item. Unused by `centroid`, which asks nothing of either side's geometry. */
  targetIndexes: readonly TargetIndex[]
  /** One per query item, needed only when `needsBothDirections`. */
  queryIndexes?: readonly TargetIndex[]
  /*
   * `queryKind` is inherited and is **one quantity for the whole walk**, not one per side. That
   * is a consequence of `mixedQuantityRefusal` rather than an approximation: the only path that
   * reads `quantityOf` is `within` reporting an absolute, and the only way the two sides could
   * disagree is a skeleton against a mesh with both directions taken — which is exactly what that
   * refusal throws on, before this walk is built. Held as the kind rather than as the `Quantity`
   * it derives, so a caller cannot hand over a unit that disagrees with the geometry it walks.
   */
  /**
   * Whether the two ports hold one and the same value. With `symmetricCells` that is what halves
   * the walk; on its own it is not enough, which is what that predicate is about.
   */
  allByAll: boolean
}

/**
 * The gap between two items' bounding boxes — zero where they overlap, and a **lower bound** on
 * the distance between any point of one and any point of the other.
 *
 * What that buys is `within`'s pre-rejection for the kinds the dual-tree descent cannot serve.
 * `anyPairWithin` answers the question exactly and needs two k-d trees, so a mesh on either port
 * fell through to a `hasWithin` per sample — each one rejected at the BVH root, but a root test
 * plus a `Vector3.set` is still ~400 ns, and at 70,000 vertices that is **~30 ms a pair to prove
 * the answer is zero**. A 100-mesh all-by-all is 5,050 such pairs. The box test is five
 * nanoseconds and rejects the same pairs.
 *
 * `boxesOf` is `core/values.ts`', beside the `boundsOf` it reads, and that is where the argument
 * for it lives: `boundsOf` memoises each buffer's box, and every geometry value on a wire was
 * constructed by calling it, so this is a lookup rather than a second sweep over every vertex.
 *
 * **Not `kdTree.ts`' `boxGapSq`**, which is the same three axes over a `Float32Array`: that one
 * is called twice per node visit inside the descents, and widening it to `ArrayLike<number>` to
 * serve both would make the hottest read in that file polymorphic. Two arrays, two readers, one
 * formula written twice — where sharing costs the reader that cannot afford it.
 */
function boxGap(boxes: Boxes, i: number, other: Boxes, j: number): number {
  const a = i * 6
  const b = j * 6
  const gx =
    boxes[a]! > other[b + 3]!
      ? boxes[a]! - other[b + 3]!
      : other[b]! > boxes[a + 3]!
        ? other[b]! - boxes[a + 3]!
        : 0
  const gy =
    boxes[a + 1]! > other[b + 4]!
      ? boxes[a + 1]! - other[b + 4]!
      : other[b + 1]! > boxes[a + 4]!
        ? other[b + 1]! - boxes[a + 4]!
        : 0
  const gz =
    boxes[a + 2]! > other[b + 5]!
      ? boxes[a + 2]! - other[b + 5]!
      : other[b + 2]! > boxes[a + 5]!
        ? other[b + 2]! - boxes[a + 5]!
        : 0
  return Math.sqrt(gx * gx + gy * gy + gz * gz)
}

/**
 * Fill the matrix, row-major, in display units.
 *
 * **The upper triangle is mirrored rather than recomputed** on an all-by-all whose cells are
 * symmetric, so the lower half is arithmetic that has already been done. `symmetricCells` is
 * which those are and is the half that was got wrong — combining two directions is not the only
 * way a pair comes out the same both ways round. It is half the run, and the way it goes wrong is
 * a matrix that is subtly not symmetric rather than an error, which is what
 * `geometryDistance.test.ts` checks against the unmirrored walk.
 *
 * Sliced over **pairs** rather than over rows: a row of five hundred meshes is seconds of
 * unyielding arithmetic, which is a frozen tab in front of a progress bar that has not moved and
 * a Cancel button that does nothing. `core/slice.ts` records why that loop is shared rather than
 * written out here.
 */
export async function distanceValues(
  walk: DistanceWalk,
  hooks: { progress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<Float64Array> {
  const rows = walk.queryItems.length
  const cols = walk.targetItems.length
  const values = new Float64Array(rows * cols)
  const mirrored = mirrorsCells(walk, walk.allByAll)
  const cell = cellFor(walk)

  /*
   * **A cursor over the pairs actually walked, not an index into the grid with the lower half
   * skipped** — and that is a cancellation fix rather than a tidy-up. `sliced` doubles its clock
   * stride after every under-budget batch, so a mirrored row `i` that begins with `i` no-op
   * bodies of about twenty nanoseconds ramps the stride to its 64 ceiling *before the row's first
   * real cell runs*, and the rest of that row then goes by with no abort check. Every body here
   * is real work instead, so the stride can only be inflated by cells that genuinely are cheap.
   *
   * Measured on a 120-neuron all-by-all of 2,000-node arbours, longest stretch between progress
   * callbacks: **73 ms against 56**. Modest at that shape because a long no-op prefix leaves few
   * real cells behind it — the exposure is a *middle* row, where about half the width is skipped
   * and the other half runs at the ceiling, so it grows with both the row width and the cell
   * cost. A thousand meshes at a couple of seconds a cell is the shape this matters at, and it is
   * `core/slice.ts`' own recorded failure on the node the adaptive stride was written for.
   *
   * It also makes the progress bar linear, where before it reached half way at three quarters of
   * the work.
   */
  let i = 0
  let j = 0
  await sliced(pairsWalked(rows, cols, walk, walk.allByAll), hooks, () => {
    const value = cell(i, j)
    values[i * cols + j] = value
    if (mirrored && j !== i) values[j * cols + i] = value
    if (++j >= cols) {
      i++
      j = mirrored ? i : 0
    }
  })
  return values
}

/**
 * What fills one cell, chosen once rather than per pair.
 *
 * The three methods differ only in this function; the slicing, the index arithmetic and the
 * mirroring above are one copy because the way a mirror goes wrong is a matrix that is subtly not
 * symmetric rather than an error — written out per method, the half of it that is wrong is the
 * half nobody reads.
 */
/** One slot per item, filled from `centroidOf` on first touch — see `cellFor`'s centroid arm. */
function centreSlots(
  items: readonly (SkeletonGeometry | MeshGeometry)[],
): (i: number) => [number, number, number] {
  const held: ([number, number, number] | undefined)[] = new Array(items.length)
  return (i) => (held[i] ??= centroidOf(items[i]!))
}

function cellFor(walk: DistanceWalk): (i: number, j: number) => number {
  if (walk.params.method === 'centroid') {
    /*
     * `centroidOf` is memoised on the geometry, so each centre is computed once however many
     * pairs read it — and computed **lazily, inside the sliced walk**. A pass in front of the
     * loop would be the same work in a stretch nothing can interrupt, which on a wire of
     * full-resolution meshes is seconds with the Cancel button already pressed.
     *
     * The *lookup* is not free, though, and this is the one cell cheap enough for it to show:
     * two `WeakMap` gets and a `Math.hypot` measured **31.1 ns a cell against 1.17** for two
     * array reads and a `sqrt` of the sum. A slot per item, filled on first touch, keeps the
     * laziness the paragraph above argues for and pays the `WeakMap` once per neuron.
     */
    const queryCentres = centreSlots(walk.queryItems)
    const targetCentres = walk.allByAll ? queryCentres : centreSlots(walk.targetItems)
    return (i, j) => {
      const a = queryCentres(i)
      const b = targetCentres(j)
      const dx = a[0] - b[0]
      const dy = a[1] - b[1]
      const dz = a[2] - b[2]
      return Math.sqrt(dx * dx + dy * dy + dz * dz) / NM_PER_UM
    }
  }

  /*
   * One scratch array for the median's sort order, sized to the largest sample set either side
   * carries and reused by every pair — the alternative is growing and discarding one per cell,
   * which on a 500-neuron all-by-all of 20,000-node skeletons is a quarter of a million of them.
   * `directedNearest` allocates its own where none is supplied, which is every test.
   */
  const longest = (items: readonly (SkeletonGeometry | MeshGeometry)[]): number =>
    items.reduce((most, item) => Math.max(most, sampleCount(item)), 0)
  const scratch =
    walk.params.statistic === 'median' && walk.params.method === 'nearest'
      ? medianScratch(Math.max(longest(walk.queryItems), longest(walk.targetItems)))
      : undefined

  // Read once for the walk, never per cell: `quantityOf` mints an object, and `within` reporting
  // an absolute would be the one path in this file that allocates per pair.
  const scale = quantityOf(walk.queryKind).scale

  const directed = (samples: Samples, index: TargetIndex | undefined): number => {
    if (!index) return NaN
    if (walk.params.method === 'nearest') {
      return directedNearest(samples, index, walk.params.statistic, scratch) / NM_PER_UM
    }
    return reportWithin(samples, directedWithin(samples, index, walk.params.withinNm))
  }

  /**
   * How much of a neuron lies within the distance, in the unit `Report` asks for.
   *
   * **One statement, because the shortcut and the walk had two.** A fraction divides by the
   * neuron's own total, so a neuron with no cable and no area has none to give and the answer is
   * `NaN` — and the pre-rejection used to answer a literal `0` for exactly the pairs the walk
   * never saw, so which one a reader got depended on how far away the *other* neuron was. Both
   * ends of the escalation ladder return through here now: `directedWithin`'s measurement, and a
   * proved zero.
   */
  function reportWithin(samples: Samples, inside: number): number {
    if (walk.params.report !== 'fraction') return inside * scale
    return samples.total > 0 ? inside / samples.total : NaN
  }

  /*
   * The sample records once per item rather than a `samplesOf` lookup per cell. The weights stay
   * lazy — a record is `positions`, `count` and two getters — so nothing is built in front of the
   * loop; what goes is ~15 ns of `WeakMap` per cell, which is noise beside a `min` and the
   * dominant cost on `within`'s fast reject, where `boxGap` answers in about two.
   */
  const querySamples = walk.queryItems.map(samplesOf)
  const targetSamples = walk.allByAll ? querySamples : walk.targetItems.map(samplesOf)

  const both = needsBothDirections(walk.params)
  const targets = walk.targetIndexes
  // Plainly, because the node hands an all-by-all the same array on both fields — the rule that
  // "an all-by-all's query indexes are its target indexes" is stated where the indexes are built
  // and not a second time here.
  const queries = walk.queryIndexes

  /** The general answer: one direction, or two combined. Every method ends here. */
  const walkPair = (i: number, j: number): number => {
    const forward = directed(querySamples[i]!, targets[j])
    const reverse = both ? directed(targetSamples[j]!, queries?.[i]) : NaN
    return combineDirections(forward, reverse, walk.params.symmetry)
  }

  /*
   * The trees a dual-tree descent reads, where both sides are point sets. `descentApplies` is the
   * same fact in kinds, asked before anything is built; `points` is what it resolves to once the
   * indexes exist, so a wiring that predicate declines simply has no tree here and the arm falls
   * through to `walkPair` — which is the one thing all three methods share and the reason the
   * arms are closures chosen once rather than branches taken per cell.
   */
  if (isClosestApproach(walk.params)) {
    /*
     * **The closest approach is a property of the two sets**, so where both are point sets it is
     * asked once — no per-point walk, and no reverse direction, the quantity being symmetric and
     * every `Symmetry` therefore the identity over two equal numbers.
     */
    return (i, j) => {
      const target = targets[j]?.points
      const query = queries?.[i]?.points
      return target && query ? closestPair(query, target) / NM_PER_UM : walkPair(i, j)
    }
  }

  if (walk.params.method === 'within') {
    /*
     * The same descent as an **exact pre-rejection**: if the two neurons come nowhere within the
     * distance being asked about, no sample of either is inside it and the cell is zero without a
     * single query.
     *
     * **`anyPairWithin` rather than `closestPair`**, which is what this asked first. The exact
     * closest approach is more than the question needs, and the difference is not free in the one
     * case the shortcut cannot help: two neurons that genuinely overlap paid a full descent
     * refining a minimum, and then the sample walk ran anyway — **250 µs a pair against 327** on
     * co-located arbours, against a 3.5x saving where they are apart. Asked as a yes or a no the
     * walk stops at the first pair inside the limit, so the overlapping case costs a descent to
     * one leaf and the trade disappears.
     *
     * **The zero is not a literal, which it was and which disagreed with the walk it replaces.**
     * `directed` answers a *fraction* by dividing by the neuron's own total, and a neuron with no
     * cable and no area — a one-node skeleton, a mesh of loose vertices — has no fraction to give
     * and comes back `NaN`. So the shortcut returned 0 where the long path returned `NaN` for the
     * same pair, and which one a reader saw depended on how far apart the two neurons were: a
     * weightless neuron read `NaN` against everything near it and 0 against everything else. An
     * absolute is 0 either way, so that arm is decided once for the whole walk rather than per
     * cell, and `combineDirections` puts the two directions together by the rule everything else
     * here uses.
     */
    const noneInside = (i: number, j: number) =>
      combineDirections(
        reportWithin(querySamples[i]!, 0),
        both ? reportWithin(targetSamples[j]!, 0) : NaN,
        walk.params.symmetry,
      )
    /*
     * The boxes first, which is the half that serves every kind — see `boxGap`. The descent is
     * the sharper test and needs two point sets; the boxes reject the same distant pairs for
     * every combination, including the mesh one where a sample walk costs ~30 ms to answer zero.
     */
    const queryBoxes = boxesOf(walk.queryItems)
    const targetBoxes = walk.allByAll ? queryBoxes : boxesOf(walk.targetItems)
    return (i, j) => {
      if (boxGap(queryBoxes, i, targetBoxes, j) > walk.params.withinNm) return noneInside(i, j)
      const target = targets[j]?.points
      const query = queries?.[i]?.points
      if (target && query && !anyPairWithin(query, target, walk.params.withinNm)) {
        return noneInside(i, j)
      }
      return walkPair(i, j)
    }
  }

  return walkPair
}

// ---------------------------------------------------------------------------
// Reading the two ports
// ---------------------------------------------------------------------------

/**
 * Refuse coordinates that are not nanometres, in this node's words.
 *
 * `checkGeometryUnits` is the guard, shared with both NBLAST nodes; the consequence is the half
 * that is this node's, and it is a step worse here than there. Every number that leaves is
 * *labelled* µm, so geometry in dataset voxels puts a value eight times too small under that
 * label with nothing anywhere to say so.
 */
function checkDistanceUnits(side: string, value: DistanceCollection): void {
  checkGeometryUnits(
    side,
    value,
    'geometry',
    'Skeletons or Meshes',
    'every distance here would be labelled µm and be wrong by the size of a voxel.',
  )
}

/**
 * Refuse two template spaces, which is a comparison of nothing.
 *
 * `frameClash` and `frameClashMessage` are `transformOps.ts`', beside `checkStackable` and
 * `checkPointFrame`, which render through the same pair. What is supplied here is the part that
 * genuinely differs: **what goes wrong is a number**, not an error and not an empty port. Two
 * neurons in unrelated coordinate systems are hundreds of micrometres apart by construction, so
 * every cell comes back large, plausible and meaningless, and an ordinary heatmap is drawn over
 * it.
 */
function checkDistanceFrame(
  query: DistanceCollection,
  target: DistanceCollection | undefined,
): string | undefined {
  const clash = frameClash(query, target)
  return clash
    ? frameClashMessage(
        clash,
        { left: 'The Query', right: 'the Target' },
        {
          units: 'Every distance would be out by the ratio between them.',
          space:
            'Every pair would come back hundreds of micrometres apart whatever their real ' +
            'shapes, which draws a perfectly ordinary heatmap of nothing.',
        },
      )
    : undefined
}

/**
 * Read both ports: refuse what must not be measured, and say what the rest will cost.
 *
 * `nblastSidesFrom`'s shape and its argument — both nodes ask the same four questions of their
 * inputs and asking them at each node was the same twenty lines twice, messages included. Not
 * *shared* with it, because the four answers differ at every one: this takes meshes, its units
 * refusal is about a label rather than a scoring matrix, its size warning counts lookups rather
 * than pairs, and its frame refusal has a different consequence.
 */
export function distanceSidesFrom(
  ctx: Warner,
  queryValue: Value | undefined,
  targetValue: Value | undefined,
  limit: number,
): { query: DistanceCollection; target?: DistanceCollection } {
  if (!isDistanceCollection(queryValue)) {
    throw new Error(wrongDistanceKindReason('Query', queryValue?.kind))
  }
  if (targetValue !== undefined && !isDistanceCollection(targetValue)) {
    throw new Error(wrongDistanceKindReason('Target', targetValue.kind))
  }
  if (queryValue.items.length === 0) throw new Error('No neurons on the Query input')
  /*
   * And the Target, which said nothing: a wired-but-empty set gives an R x 0 matrix, which the
   * Heatmap draws as a blank card with no message anywhere. It names the remedy because an empty
   * Target and no Target are different graphs — unwiring it is an all-by-all, which is very often
   * what somebody meant.
   */
  if (targetValue && targetValue.items.length === 0) {
    throw new Error(
      'No neurons on the Target input — unwire it to compare the Query against itself.',
    )
  }

  const cost = 'Searching is single-threaded and grows with the product of the two sides.'
  warnSideCount(ctx, 'Query', queryValue.items.length, limit, cost)
  if (targetValue) warnSideCount(ctx, 'Target', targetValue.items.length, limit, cost)

  checkDistanceUnits('Query', queryValue)
  if (targetValue) {
    checkDistanceUnits('Target', targetValue)
    // Only meaningful with two sides. An all-by-all is one set against itself, which is in one
    // frame by construction however little it says about which.
    const frame = checkDistanceFrame(queryValue, targetValue)
    if (frame) throw new Error(frame)
  }

  return { query: queryValue, ...(targetValue ? { target: targetValue } : {}) }
}

/**
 * A socket's kind narrowed to one this node measures, or `undefined`.
 *
 * What `validate` needs and `isDistanceKind` cannot give it: that predicate answers `true` for
 * `any` and for unknown, which is right for deciding whether to complain about a wire and wrong
 * for asking which quantity a port carries.
 */
export function distanceKindOf(
  kind: CodaType['kind'] | undefined,
): DistanceCollection['kind'] | undefined {
  return kind === 'skeletons' || kind === 'meshes' ? kind : undefined
}
