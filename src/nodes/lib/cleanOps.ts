/**
 * Geometry in, the shape the cleaning pipelines want out — and back again.
 *
 * Headless and pure, `nblastOps.ts`'s arrangement: vitest has no Pyodide and jsdom has no
 * `Worker`, so the flattening, the scattering, the unit rules and every ceiling live here
 * where a test can see them, and what is left on the other side of the seam is one call.
 *
 * ## The one invariant both halves rest on
 *
 * **The item count never changes.** `SkeletonsValue` and `MeshesValue` both promise one
 * attribute row per item *in the same order*, and every consumer reads a neuron's type by
 * indexing the table with the item's position. A pipeline that dropped a skeleton it could
 * not resample, or a mesh that decimated away to nothing, would hand on a collection where
 * every item after it wears somebody else's name — and it draws. So an emptied item stays in
 * the collection as an empty item, and the node says how many that happened to.
 *
 * ## Distances are micrometres on the card and nanometres on the wire
 *
 * fastcore's distance arguments are "in the units of `coords`", and Coda's coordinates are
 * nanometres. The cards ask for micrometres because that is what a neuroanatomist thinks in
 * and what NBLAST's own Resample already asks for. The multiplication happens here rather
 * than in Python, which keeps the coordinates from being round-tripped through a second
 * scale — the same split `nblastOps.ts` makes, and the same reason: the side that still knows
 * what the numbers are is the side that should convert.
 *
 * That is also why `checkCleanUnits` exists. A spacing of 1 µm applied to voxel coordinates
 * is not a smaller error than a bad unit conversion, it is the *same* error — a confident,
 * uniformly wrong answer with nothing to say why — and it is refused for the reason
 * `checkNblastUnits` refuses: there is no run-time warning channel that survives a result
 * being restored from cache rather than recomputed.
 */

import type { Warner } from '../../core/limits'
import { formatBytes, refuseIfOverCrashFloor, warnOverThreshold } from '../../core/limits'
import type { ParamValues } from '../../core/node'
import type {
  GeometryUnits,
  MeshGeometry,
  MeshesValue,
  SkeletonGeometry,
  SkeletonsValue,
} from '../../core/values'
import { boundsOf, cableLength, meshTriangleCount, skeletonPointCount } from '../../core/values'
import type { CleanMeshesRequest, CleanMeshesResult, SmoothMethod } from '../../pyodide/meshes'
import type {
  CleanSkeletonsRequest,
  CleanSkeletonsResult,
  ThinMethod,
} from '../../pyodide/skeletons'
import { NM_PER_UM } from './nblastOps'
import { geometryPointCount } from './transformOps'

/**
 * Refuse coordinates a distance parameter cannot be applied to.
 *
 * **Only when a distance is actually in play**, which is the whole of the care here. `Keep
 * every Nth node` counts hops and means exactly the same thing in voxels as in nanometres, so
 * refusing a voxel set outright would refuse a perfectly well-defined operation on the
 * strength of a control the user left at zero. Absent units are allowed through, on
 * `checkNblastUnits`' rule: absent means unknown, and no source produces it today.
 */
export function checkCleanUnits(value: { units?: GeometryUnits }, usesDistance: boolean): void {
  if (!usesDistance) return
  if (value.units === undefined || value.units === 'nm') return
  throw new Error(
    `These coordinates are in ${value.units}, not nanometres, so a distance in micrometres ` +
      'means nothing here — the result would be smoothed or resampled at whatever scale a ' +
      'voxel happens to be, uniformly and with nothing to say so. Either leave the distance ' +
      'controls at zero, or fetch from a dataset whose Meta publishes a voxel size.',
  )
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

/** Every distance control on the Clean Skeletons card, in micrometres. */
export interface SkeletonCleanParams {
  heal: boolean
  healMaxDist: number
  smooth: number
  method: ThinMethod
  spacing: number
  factor: number
}

/**
 * Raw params in, `SkeletonCleanParams` out — the one place that says what the card means.
 *
 * **The Python emitter calls this too**, `matchParamsFrom`'s reason: an emitter that
 * transcribed these defaults would be a notebook that could come to disagree with the canvas
 * about what a control did, and only one of the two has a test. The micrometre→nanometre
 * conversion stays in `cleanRequestFrom` rather than here, because the emitter needs the
 * card's own numbers to write `NM_PER_UM` into the cell.
 */
export function skeletonCleanParamsFrom(params: ParamValues): SkeletonCleanParams {
  return {
    heal: params.heal === true,
    healMaxDist: Number(params.healMaxDist ?? 0),
    smooth: Number(params.smooth ?? 0),
    method: String(params.method ?? 'none') as ThinMethod,
    spacing: Number(params.spacing ?? 1),
    factor: Number(params.factor ?? 2),
  }
}

/** Whether these params ask a question a voxel coordinate cannot answer. */
export function usesDistance(params: SkeletonCleanParams): boolean {
  if (params.smooth > 0) return true
  if (params.heal && params.healMaxDist > 0) return true
  return params.method === 'resample' && params.spacing > 0
}

/** Whether these params ask for anything at all. */
export function isNoOp(params: SkeletonCleanParams): boolean {
  if (params.heal || params.smooth > 0) return false
  if (params.method === 'resample') return params.spacing <= 0
  if (params.method === 'downsample') return params.factor <= 1
  return true
}

/**
 * Lay a skeleton set out flat, in nanometres, with the params folded in.
 *
 * Four buffers rather than an array of objects, `dotpropSetFrom`'s reason: a hundred skeletons
 * is a hundred thousand points, and an array of `{x, y, z}` would be a hundred thousand
 * objects to clone at the `postMessage` boundary. `radii` is the fourth and NBLAST has no
 * equivalent — resampling interpolates a radius along the edge each new node lands on, so a
 * set that crossed without them would come back uniformly thick with nothing to say so.
 *
 * The buffers are **built here, not borrowed**: `callPython` transfers every typed array in a
 * call, so handing over an upstream item's own `positions` would detach the scheduler's cached
 * result for the node above and leave it empty on the next render.
 */
export function cleanRequestFrom(
  skeletons: SkeletonsValue,
  params: SkeletonCleanParams,
): CleanSkeletonsRequest {
  const total = skeletonPointCount(skeletons)

  const points = new Float32Array(total * 3)
  const parents = new Int32Array(total)
  const radii = new Float32Array(total)
  const offsets = new Int32Array(skeletons.items.length + 1)

  let at = 0
  for (let n = 0; n < skeletons.items.length; n++) {
    const item = skeletons.items[n]!
    const count = item.parents.length
    points.set(item.positions.subarray(0, count * 3), at * 3)
    radii.set(item.radii.subarray(0, count), at)
    // Parent indices stay neuron-local: `skeletons.py` slices each neuron out and hands
    // fastcore row numbers as node ids, so a global offset here would be a forest of
    // dangling references rather than a tree.
    parents.set(item.parents.subarray(0, count), at)
    at += count
    offsets[n + 1] = at
  }

  return {
    points,
    parents,
    radii,
    offsets,
    heal: params.heal,
    healMaxDist: params.healMaxDist * NM_PER_UM,
    smooth: params.smooth * NM_PER_UM,
    method: params.method,
    spacing: params.spacing * NM_PER_UM,
    factor: params.factor,
  }
}

/**
 * The same set with new nodes, scattered back item by item.
 *
 * Everything that is not geometry rides through untouched — the attribute table, the ids, the
 * units, the space — because this changes where and how many the nodes are and nothing about
 * which neuron they belong to. Bounds are recomputed, being a roll-up over exactly what
 * changed. `withPositions` in `transformOps.ts` is the same operation for a transform that
 * cannot change the count; this one can, which is why it takes the offsets rather than
 * deriving them.
 */
export function skeletonsFromResult(
  original: SkeletonsValue,
  result: CleanSkeletonsResult,
): SkeletonsValue {
  const count = original.items.length
  if (result.offsets.length !== count + 1) {
    // Every consumer indexes the attribute table by item position, so a set that came back
    // with a different number of neurons is a set where the labels have moved.
    throw new Error(
      `Clean Skeletons returned ${result.offsets.length - 1} neurons for ${count} — the ` +
        'attribute table and the geometry would no longer line up.',
    )
  }

  const items: SkeletonGeometry[] = original.items.map((item, n) => {
    const from = result.offsets[n]!
    const to = result.offsets[n + 1]!
    return {
      // The id is the draw and export key and this neuron is still that neuron — invariant 8's
      // line, and the same call `mirrorGeometry` makes.
      id: item.id,
      positions: result.points.slice(from * 3, to * 3),
      radii: result.radii.slice(from, to),
      parents: result.parents.slice(from, to),
    }
  })

  return { ...original, items, bounds: boundsOf(items.map((item) => item.positions)) }
}

/**
 * What a resample will allocate, checked before it is allocated.
 *
 * This is the node's one genuine footgun and it is the shape `docs/gotchas.md` records for a
 * node whose output size is a product of two independently-resolved things: the spacing comes
 * off this card and the cable length comes from a fetch several nodes upstream, and neither
 * knows what the other did. A set of five hundred neurons resampled at 0.01 µm is a hundred
 * times the nodes it arrived with, and the first sign of it is a locked tab.
 *
 * The estimate is exact rather than a heuristic — `resample_skeleton` divides each segment
 * into `round(length / spacing)` parts, so total cable over spacing is the node count to
 * within one node per segment. Twenty bytes each: three float32 coordinates, one float32
 * radius, one int32 parent.
 */
/*
 * Twenty bytes a node — three float32 coordinates, one float32 radius, one int32 parent — so
 * this is 100 MB of geometry, and the crash floor refuses at 25.6 million. Set inside the
 * floor rather than at it deliberately: a warning that only fires in the last 20% before a
 * refusal is a warning nobody sees. For scale, the largest thing Coda fetches today — 500
 * neurons at their traced density — is on the order of a million nodes.
 */
const RESAMPLE_NODES_WARN = 5_000_000
const BYTES_PER_NODE = 20

export function checkResampleSize(
  ctx: Warner,
  skeletons: SkeletonsValue,
  spacingNm: number,
): void {
  if (spacingNm <= 0) return

  let cable = 0
  for (const item of skeletons.items) cable += cableLength(item)
  const nodes = Math.round(cable / spacingNm)

  refuseIfOverCrashFloor(
    `Resampling to ${(spacingNm / NM_PER_UM).toLocaleString()} µm — about ` +
      `${nodes.toLocaleString()} nodes`,
    nodes * BYTES_PER_NODE,
  )
  // Checked here rather than inside `warnOverThreshold`, which formats a warning and does not
  // decide whether there is one — `checkNblastSize` guards the same way one seam over.
  if (nodes <= RESAMPLE_NODES_WARN) return
  warnOverThreshold(ctx, {
    count: nodes,
    threshold: RESAMPLE_NODES_WARN,
    unit: 'nodes after resampling',
    control: 'what this node resamples to without comment',
    cost:
      `${skeletonPointCount(skeletons).toLocaleString()} nodes went in and about ` +
      `${nodes.toLocaleString()} would come out at a Spacing of ` +
      `${(spacingNm / NM_PER_UM).toLocaleString()} µm, which is ` +
      `${formatBytes(nodes * BYTES_PER_NODE)} of geometry before anything draws it.`,
  })
}

/** How many items came back with nothing in them, for the sentence the node warns with. */
export function emptiedItems(offsets: Int32Array): number {
  let empty = 0
  for (let i = 0; i + 1 < offsets.length; i++) if (offsets[i + 1]! === offsets[i]!) empty++
  return empty
}

// ---------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------

/** Every control on the Clean Meshes card. None of them is a distance. */
export interface MeshCleanParams {
  dropInternals: boolean
  openness: number
  rays: number
  passes: number
  fillHoles: boolean
  ratio: number
  smooth: number
  method: SmoothMethod
  volumeCorrection: boolean
}

/** Raw params in, `MeshCleanParams` out. See `skeletonCleanParamsFrom`. */
export function meshCleanParamsFrom(params: ParamValues): MeshCleanParams {
  return {
    dropInternals: params.dropInternals === true,
    openness: Number(params.openness ?? 0.05),
    rays: Number(params.rays ?? 16),
    passes: Number(params.passes ?? 3),
    fillHoles: params.fillHoles === true,
    ratio: Number(params.ratio ?? 1),
    smooth: Number(params.smooth ?? 0),
    method: String(params.method ?? 'taubin') as SmoothMethod,
    volumeCorrection: params.volumeCorrection === true,
  }
}

export function isMeshNoOp(params: MeshCleanParams): boolean {
  return !params.dropInternals && !params.fillHoles && params.ratio >= 1 && params.smooth <= 0
}

/** Whether these params can change the face count, which is what decides `detail`'s fate. */
export function changesFaces(params: MeshCleanParams): boolean {
  return params.dropInternals || params.fillHoles || params.ratio < 1
}

/**
 * Lay a mesh set out flat.
 *
 * Two offset arrays, because the two counts move independently: capping a hole adds faces and
 * no vertices, and decimating removes both at a ratio nothing on this side can predict. Face
 * indices stay **mesh-local**, which is what `MeshGeometry.indices` already means — a global
 * re-base here would have to be undone on the way back, and a mesh whose faces index the
 * wrong vertices renders as a cloud of stray triangles rather than as an error.
 *
 * Buffers are built rather than borrowed, `cleanRequestFrom`'s reason.
 */
export function meshRequestFrom(
  meshes: MeshesValue,
  params: MeshCleanParams,
): CleanMeshesRequest {
  const positions = new Float32Array(geometryPointCount(meshes) * 3)
  const indices = new Uint32Array(meshTriangleCount(meshes) * 3)
  const vertexOffsets = new Int32Array(meshes.items.length + 1)
  const faceOffsets = new Int32Array(meshes.items.length + 1)

  let vAt = 0
  let fAt = 0
  for (let n = 0; n < meshes.items.length; n++) {
    const item = meshes.items[n]!
    positions.set(item.positions, vAt * 3)
    indices.set(item.indices, fAt * 3)
    vAt += item.positions.length / 3
    fAt += item.indices.length / 3
    vertexOffsets[n + 1] = vAt
    faceOffsets[n + 1] = fAt
  }

  return {
    positions,
    indices,
    vertexOffsets,
    faceOffsets,
    dropInternals: params.dropInternals,
    openness: params.openness,
    rays: params.rays,
    passes: params.passes,
    fillHoles: params.fillHoles,
    ratio: params.ratio,
    smooth: params.smooth,
    method: params.method,
    volumeCorrection: params.volumeCorrection,
  }
}

/**
 * The same set with new surfaces, scattered back item by item.
 *
 * **`detail` is dropped wherever the face count could have moved**, rather than carried
 * forward with a new number in it. Both halves of that are deliberate. The count it holds
 * would be stale, which is the easy half; the harder one is that `detailNote` reads
 * `decimated` as *"this source publishes one level of detail, so meshes were simplified on
 * arrival to fit the triangle budget — raise Detail on the Meshes node"*, every clause of
 * which is false about a mesh somebody decimated here on purpose. Two levels of detail in one
 * collection is no level of detail; so is a level that has been overwritten. Same call
 * `stackGeometry` makes, for the same reason.
 *
 * Smoothing alone leaves it in place, since that moves vertices and touches neither count.
 */
export function meshesFromResult(
  original: MeshesValue,
  result: CleanMeshesResult,
  keepDetail: boolean,
): MeshesValue {
  const count = original.items.length
  if (result.vertexOffsets.length !== count + 1) {
    throw new Error(
      `Clean Meshes returned ${result.vertexOffsets.length - 1} meshes for ${count} — the ` +
        'attribute table and the geometry would no longer line up.',
    )
  }

  const items: MeshGeometry[] = original.items.map((item, n) => ({
    id: item.id,
    positions: result.positions.slice(
      result.vertexOffsets[n]! * 3,
      result.vertexOffsets[n + 1]! * 3,
    ),
    indices: result.indices.slice(result.faceOffsets[n]! * 3, result.faceOffsets[n + 1]! * 3),
  }))

  const { detail: _dropped, ...rest } = original
  const kept = keepDetail && original.detail ? { detail: original.detail } : {}
  return {
    ...rest,
    ...kept,
    items,
    bounds: boundsOf(items.map((item) => item.positions)),
  }
}

/**
 * What stripping internal membrane will cost, which is the one number on this card nobody can
 * guess.
 *
 * `drop_internals` fires `rays` rays off every face, three passes over, and asks each whether
 * it escapes the mesh — so the work is faces times rays times passes, and a single FlyWire
 * neuron at full resolution is half a million faces. Measured by fastcore on a 578k-face mesh,
 * one openness sweep at 16 rays is on the order of a second natively; wasm here is
 * single-threaded, which is where the minutes come from.
 *
 * A warning and not a refusal — the answer is correct, it is a wait — and the sentence names
 * the two controls that move it as well as the Detail param upstream that moves it most.
 */
const RAY_CASTS_WARN = 2e8

export function checkDropInternalsSize(
  ctx: Warner,
  meshes: MeshesValue,
  params: MeshCleanParams,
): void {
  if (!params.dropInternals) return
  const triangles = meshTriangleCount(meshes)
  const casts = triangles * params.rays * params.passes
  if (casts <= RAY_CASTS_WARN) return
  // Through `warnOverThreshold` rather than hand-written, so this reads like the other nine:
  // its closing "going ahead anyway" clause is load-bearing, and `core/limits.ts` records why.
  warnOverThreshold(ctx, {
    count: casts,
    threshold: RAY_CASTS_WARN,
    unit: 'ray casts',
    control: 'what this node strips without comment',
    cost:
      `That is ${triangles.toLocaleString()} triangles at ${params.rays} rays and ` +
      `${params.passes} passes, single-threaded in the browser. Lower Rays or Passes, or ` +
      'take the meshes at a coarser Detail on the Meshes node, which moves this most.',
  })
}
