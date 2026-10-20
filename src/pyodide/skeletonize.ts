/**
 * Wavefront skeletonization's typed wrapper over the Python bridge.
 *
 * `meshes.ts`' request layout in and `skeletons.ts`' result layout out, since that is exactly
 * what this does: a mesh set crosses the way Clean Meshes sends one, and a skeleton set comes
 * back the way Clean Skeletons receives one. A `type` on the request, `NblastRequest`'s reason.
 */

import { callPython } from './engine'
import type { CallOptions } from './engine'
import type { PackedMeshes } from './meshes'
import { float32From, int32From } from './types'

/** How each ring's radius is aggregated from its vertices' distances to the ring's centre. */
export type RadiusAgg = 'mean' | 'median' | 'min' | 'max' | 'percentile25' | 'percentile75'

/** The clean-up after the wavefront: none, navis' bristle pass, or fafbseg's thorough shave. */
export type Shave = 'off' | 'bristles' | 'thorough'

export type SkeletonizeRequest = PackedMeshes & {
  /** Waves cast from different seeds and averaged. At least 1. */
  waves: number
  /** Hop counts binned into one ring, `step_size` at a time. At least 1. */
  stepSize: number
  radiusAgg: RadiusAgg
  /** Pieces with fewer vertices than this are removed first; 0 keeps every piece. */
  minFragment: number
  shave: Shave
  /** For `thorough`: an edge this long or longer marks its terminal segment. In mesh units (nm). */
  shaveCutoff: number
  /** Give a radius-0 node half its parent's radius, as navis does. */
  fixZeroRadii: boolean
  /** One xyz per mesh, in mesh units: the source's soma, NaN where it has none. */
  somaPositions: Float32Array
  /** Collapse the soma region onto one node before nodes are formed. Source positions only. */
  somaCleanup: boolean
  /** The soma's radius in mesh units (nm): the collapse region, and how far a position snaps. */
  somaRadius: number
  /** Where a mesh has no source soma, take its widest node as the soma. */
  detectSoma: boolean
  /** The narrowest a detected soma may be, in mesh units (nm). */
  minSomaRadius: number
}

export interface SkeletonizeResult {
  points: Float32Array
  /** Parent row per node, `-1` for a root, local to its skeleton. */
  parents: Int32Array
  radii: Float32Array
  /** One skeleton per mesh, empty where the mesh was. Length is `count + 1`. */
  offsets: Int32Array
  /**
   * Per mesh, the soma's row in its own skeleton — a root — or -1. Detected rather than placed
   * exactly where the request's `somaPositions` held NaN for that mesh.
   */
  somas: Int32Array
}

/** Skeletonize a whole set of meshes in one call. */
export async function runSkeletonize(
  request: SkeletonizeRequest,
  options: CallOptions = {},
): Promise<SkeletonizeResult> {
  const result = await callPython(
    { module: 'skeletonize', fn: 'coda_skeletonize_meshes', args: [request] },
    options,
  )

  const points = float32From(result, 'points')
  const parents = int32From(result, 'parents')
  const radii = float32From(result, 'radii')
  const offsets = int32From(result, 'offsets')
  const somas = int32From(result, 'somas')

  // `runCleanSkeletons`' check: lengths that disagree build a neuron missing a branch, which draws.
  if (points.length !== parents.length * 3 || radii.length !== parents.length) {
    throw new Error(
      `Skeletonize Meshes returned ${points.length / 3} points, ${parents.length} parents and ` +
        `${radii.length} radii, which do not describe one set of nodes`,
    )
  }
  return { points, parents, radii, offsets, somas }
}
