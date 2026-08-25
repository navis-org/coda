/**
 * Mesh cleaning's typed wrapper over the Python bridge.
 *
 * The fifth capability, and the first to carry a `Uint32Array` — see the note beside it in
 * `types.ts`. Otherwise `nblast.ts`'s shape unchanged.
 */

import { callPython } from './engine'
import type { CallOptions } from './engine'
import { float32From, int32From, uint32From } from './types'

/** Which smoothing filter. Taubin is the one that does not shrink the mesh. */
export type SmoothMethod = 'taubin' | 'laplacian' | 'humphrey'

/**
 * A mesh set flattened for one crossing.
 *
 * Two offset arrays rather than one, because the two counts move independently: capping a
 * hole adds faces and no vertices, and decimating removes both at a ratio nothing here can
 * predict. Face indices are **mesh-local** in both directions, which is what
 * `MeshGeometry.indices` already means — so nothing is re-based on either side.
 */
export type CleanMeshesRequest = {
  /** xyz interleaved, one mesh after the last. */
  positions: Float32Array
  /** Triangle corners, three per face, indexing each mesh's own vertices. */
  indices: Uint32Array
  /** Where each mesh's vertices start, counted in vertices. Length is `count + 1`. */
  vertexOffsets: Int32Array
  /** Where each mesh's faces start, counted in faces. Length is `count + 1`. */
  faceOffsets: Int32Array

  /** Strip invaginated internal membrane and cap what that opens. The expensive one. */
  dropInternals: boolean
  /** Openness below which a face counts as buried. fastcore's operating range is 0.05–0.10. */
  openness: number
  /** Rays cast per face. */
  rays: number
  /** Passes of the whole drop-and-cap cycle. */
  passes: number
  /** Cap whatever boundary rings remain, including the ones the mesh arrived with. */
  fillHoles: boolean
  /** Fraction of the faces to keep, in `(0, 1]`. `1` skips the decimation entirely. */
  ratio: number
  /** Smoothing passes; `0` leaves the vertices alone. */
  smooth: number
  method: SmoothMethod
  /** Rescale about the centroid so the enclosed volume matches what went in. */
  volumeCorrection: boolean
}

export interface CleanMeshesResult {
  positions: Float32Array
  indices: Uint32Array
  vertexOffsets: Int32Array
  faceOffsets: Int32Array
}

/** Repair, decimate and smooth a whole set of meshes in one call. */
export async function runCleanMeshes(
  request: CleanMeshesRequest,
  options: CallOptions = {},
): Promise<CleanMeshesResult> {
  const result = await callPython(
    { module: 'meshes', fn: 'coda_clean_meshes', args: [request] },
    options,
  )

  const positions = float32From(result, 'positions')
  const indices = uint32From(result, 'indices')
  const vertexOffsets = int32From(result, 'vertexOffsets')
  const faceOffsets = int32From(result, 'faceOffsets')

  if (positions.length % 3 !== 0 || indices.length % 3 !== 0) {
    throw new Error(
      `Clean Meshes returned ${positions.length} coordinates and ${indices.length} indices, ` +
        'neither of which divides into triples',
    )
  }
  if (vertexOffsets.length !== faceOffsets.length) {
    // One offset array per count, and they are built in the same loop — a disagreement here
    // means the two describe different numbers of meshes, which slices every mesh after the
    // discrepancy out of somebody else's buffer.
    throw new Error(
      `Clean Meshes returned ${vertexOffsets.length - 1} vertex groups and ` +
        `${faceOffsets.length - 1} face groups`,
    )
  }
  return { positions, indices, vertexOffsets, faceOffsets }
}
