/**
 * Skeleton cleaning's typed wrapper over the Python bridge.
 *
 * The fourth capability, written to the shape `nblast.ts` set: a `.py` in `runtime.ts`'s
 * `MODULES`, the request and result types, and a function that calls `callPython` and reads
 * the answer by name. Nothing in `engine.ts`, `worker.ts` or `types.ts` moved for it.
 *
 * A `type` rather than an `interface` on the request, for the reason `NblastRequest` records:
 * TypeScript gives a type alias an implicit index signature and an interface none, so an
 * interface is not assignable to `PyArg` and the call fails to compile talking about
 * `undefined`.
 */

import { callPython } from './engine'
import type { CallOptions } from './engine'
import { float32From, uint8From, int32From } from './types'

/** Which of the two node-count operations to run. They are alternatives, not a sequence. */
export type ThinMethod = 'none' | 'resample' | 'downsample'

/**
 * A skeleton set flattened for one crossing, with everything the pipeline may need.
 *
 * `PointSet`'s shape plus `radii`, which NBLAST has no use for and this does: resampling
 * interpolates a radius along the edge each new node lands on, so a set that crossed without
 * them would come back as a neuron of uniform thickness with nothing to say it had been
 * flattened.
 *
 * **Distances are in the units of `points`** — nanometres, as Coda holds them. The node's
 * card asks for micrometres and `cleanOps.ts` multiplies, which keeps the coordinates on this
 * side exactly as they were rather than round-tripping them through a second scale.
 */
export type CleanSkeletonsRequest = {
  /** xyz interleaved, one neuron after the last. */
  points: Float32Array
  /** Parent index per point, `-1` for a root. Neuron-local. */
  parents: Int32Array
  /** One per point, in the same units as `points`. */
  radii: Float32Array
  /** One SWC compartment code per point, 0 where the neuron carried no labels. */
  compartments: Uint8Array
  /** Where each neuron starts, counted in points. Length is `count + 1`. */
  offsets: Int32Array
  /**
   * Per neuron, the neuron-local soma node to reroot at after the heal, or `-1`
   * (`PackedSkeletons.somas`).
   */
  somas: Int32Array

  /** Reconnect the fragments a reconstruction arrived in. */
  heal: boolean
  /** Which nodes a healing bridge may land on. */
  healMethod: HealMethod
  /** Longest bridge to build while healing; `0` means no limit. */
  healMaxDist: number
  /** Gaussian kernel width along the neurite; `0` leaves the coordinates alone. */
  smooth: number
  method: ThinMethod
  /** Target node spacing, for `resample`. */
  spacing: number
  /** Keep one node in every `factor`, for `downsample`. */
  factor: number
}

/**
 * Which nodes a healing bridge is allowed to end on — fastcore's `heal_skeleton` `method`.
 *
 * `ALL` considers every node of both fragments and so finds the genuinely shortest bridge.
 * `LEAFS` only lets a bridge start and end at a leaf or a root, which is both faster and a
 * different claim about the data: a fragment that broke mid-neurite reattaches at its own end
 * rather than sideways onto the middle of the piece it belongs to.
 */
export type HealMethod = 'ALL' | 'LEAFS'

export interface CleanSkeletonsResult {
  points: Float32Array
  parents: Int32Array
  radii: Float32Array
  /** Carried through each step by the same index map as the radii. */
  compartments: Uint8Array
  /** Rebuilt: two of the four operations change the node count. */
  offsets: Int32Array
}

/** Heal, smooth and thin a whole set of skeletons in one call. */
export async function runCleanSkeletons(
  request: CleanSkeletonsRequest,
  options: CallOptions = {},
): Promise<CleanSkeletonsResult> {
  const result = await callPython(
    { module: 'skeletons', fn: 'coda_clean_skeletons', args: [request] },
    options,
  )

  const points = float32From(result, 'points')
  const parents = int32From(result, 'parents')
  const radii = float32From(result, 'radii')
  const compartments = uint8From(result, 'compartments')
  const offsets = int32From(result, 'offsets')

  /*
   * Three lengths that must agree, checked here rather than trusted. A `parents` array one
   * shorter than `points` does not fail downstream — it builds a neuron whose last branch is
   * missing and whose every other branch is still there, which draws.
   */
  if (
    points.length !== parents.length * 3 ||
    radii.length !== parents.length ||
    compartments.length !== parents.length
  ) {
    throw new Error(
      `Clean Skeletons returned ${points.length / 3} points, ${parents.length} parents, ` +
        `${radii.length} radii and ${compartments.length} compartments, which do not describe ` +
        'one set of nodes',
    )
  }
  return { points, parents, radii, compartments, offsets }
}

/**
 * How Simplify Skeletons thins what survives the pruning — one of four, never two, for Clean
 * Skeletons' reason: each throws away nodes by its own rule, and running two is the second one
 * undoing the first's choices.
 */
export type SimplifyMethod = 'none' | 'every' | 'rdp' | 'vw'

/**
 * A skeleton set flattened for Simplify Skeletons.
 *
 * Coordinates and parents only. Pruning and thinning both keep a subset of the nodes and move
 * none of them, so radii, labels, a computed split and per-node values never need to cross:
 * `keep` on the way back says which rows survived and the caller gathers everything else
 * itself, exactly.
 */
export type SimplifySkeletonsRequest = {
  /** xyz interleaved, one neuron after the last, in nanometres. */
  points: Float32Array
  /** Parent index per point, `-1` for a root. Neuron-local. */
  parents: Int32Array
  /** Where each neuron starts, counted in points. Length is `count + 1`. */
  offsets: Int32Array
  /** Per neuron, the neuron-local soma node, or `-1` (`PackedSkeletons.somas`). Never removed. */
  somas: Int32Array

  /** Shortest twig to keep, in the units of `points`; `0` prunes nothing. */
  prune: number
  /** Prune again until nothing changes, navis' `recursive=True`. */
  repeat: boolean
  method: SimplifyMethod
  /** Keep one node in every `factor`, for `every`. */
  factor: number
  /** How far the path may move, in the units of `points`, for `rdp`. */
  tolerance: number
  /** Smallest triangle a node may add, in the *squared* units of `points`, for `vw`. */
  area: number
}

export interface SimplifySkeletonsResult {
  /** Per surviving node, its neuron-local row in the request, in the original order. */
  keep: Int32Array
  /** Per surviving node, its parent as a neuron-local row of the survivors. */
  parents: Int32Array
  /** Rebuilt over the survivors. Length is `count + 1`. */
  offsets: Int32Array
}

/** Prune twigs and thin a whole set of skeletons in one call. */
export async function runSimplifySkeletons(
  request: SimplifySkeletonsRequest,
  options: CallOptions = {},
): Promise<SimplifySkeletonsResult> {
  const result = await callPython(
    { module: 'skeletons', fn: 'coda_simplify_skeletons', args: [request] },
    options,
  )
  const keep = int32From(result, 'keep')
  const parents = int32From(result, 'parents')
  const offsets = int32From(result, 'offsets')
  // `runCleanSkeletons`' check, for the same silent failure: a short `parents` draws.
  if (keep.length !== parents.length) {
    throw new Error(
      `Simplify Skeletons returned ${keep.length} kept nodes and ${parents.length} parents, ` +
        'which do not describe one set of nodes',
    )
  }
  return { keep, parents, offsets }
}
