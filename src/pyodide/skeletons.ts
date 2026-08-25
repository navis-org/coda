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
import { float32From, int32From } from './types'

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
  /** Where each neuron starts, counted in points. Length is `count + 1`. */
  offsets: Int32Array

  /** Reconnect the fragments a reconstruction arrived in. */
  heal: boolean
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

export interface CleanSkeletonsResult {
  points: Float32Array
  parents: Int32Array
  radii: Float32Array
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
  const offsets = int32From(result, 'offsets')

  /*
   * Three lengths that must agree, checked here rather than trusted. A `parents` array one
   * shorter than `points` does not fail downstream — it builds a neuron whose last branch is
   * missing and whose every other branch is still there, which draws.
   */
  if (points.length !== parents.length * 3 || radii.length !== parents.length) {
    throw new Error(
      `Clean Skeletons returned ${points.length / 3} points, ${parents.length} parents and ` +
        `${radii.length} radii, which do not describe one set of nodes`,
    )
  }
  return { points, parents, radii, offsets }
}
