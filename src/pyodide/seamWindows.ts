/**
 * The windows a SEAM model takes: a typed wrapper over `seamWindows.py`.
 *
 * `meshes.ts`' shape — one flat array per quantity, one crossing — for the reason stated there
 * and one of its own: a neuron is tiled into on the order of a hundred windows of 4,096 points
 * each, so a list of per-window arrays would be a hundred proxies to build and destroy.
 *
 * **The constants come from the model's manifest, never from here.** A window's radius, spacing
 * and point count are part of what a checkpoint was trained on; building one at the wrong radius
 * produces a confident answer to a question the model was never asked, and nothing downstream
 * can see it. `affinityConfig.ts` makes the same argument for the affinity model.
 */

import { callPython } from './engine'
import type { CallOptions } from './engine'
import { float32From } from './types'

/* A `type`, not an `interface`: only an alias gets the implicit index signature `PyArg`
 * needs, which is why `CleanMeshesRequest` is one too. */
export type SeamWindowRequest = {
  /** The neuron's mesh vertices, xyz interleaved, in **nanometres**. */
  positions: Float32Array
  /**
   * `MeshesValue.units`, passed rather than assumed and refused when it is not `nm`.
   *
   * `scan.py` multiplies the window radius by 1,000 to reach nanometres, so a voxel-space mesh
   * tiles at a wrong physical scale and comes back with a plausible window count, plausible
   * windows and a plausible timing. There is nothing downstream that could notice.
   */
  units: 'nm' | 'voxels'
  /** Triangle corners, three per face, indexing `positions`. */
  indices: Uint32Array
  /** `config.preprocessing.windowRadiusUm` — the half-width the checkpoint was trained at. */
  radiusUm: number
  /** `config.preprocessing.spacingUm` — one surface point per this much area, squared. */
  spacingUm: number
  /** `config.preprocessing.nPoints` — points per window, after the resample. */
  nPoints: number
  /** `config.preprocessing.features === 'normals'`. */
  useNormals: boolean
  /** Fixes the tiling and every window's resample. A fixed seed is what keeps invariant 4. */
  seed: number
  /**
   * Stop after this many **centres**; `0` or less takes the whole tiling.
   *
   * Centres, not windows: a centre whose cells hold no surface yields none, so `limit: 50` gives
   * `50 - empty` windows. The node's rail rather than this file's — only the node knows what the
   * reader asked for. Note it takes the *first* centres, and `tile_centres` returns them in grid
   * order, so a limited run reads one region of the neuron rather than sampling it.
   */
  limit: number
}

export interface SeamWindows {
  /** `windows × nPoints × 3`, model units, one window after the last. */
  points: Float32Array
  /** The same shape: surface normals, or zeros where the model takes none. */
  feats: Float32Array
  /** The same shape: where each sampled point actually is, in nanometres. */
  sourceNm: Float32Array
  /** How many windows were built. */
  windows: number
  /** How many centres the tiling produced, which is `windows` plus `empty` plus whatever `limit` cut. */
  tiled: number
  /** Centres whose cells held no surface after the crop. Counted, never dropped silently. */
  empty: number
  /** Building the face grid and tiling the surface: once per **mesh**, and it grows with faces. */
  tileMs: number
  /** Cropping and resampling every window: once per **window**. */
  windowMs: number
}

/**
 * Tile one neuron's mesh and build every window's model input.
 *
 * **The mesh is copied before it crosses.** `callPython` *transfers* every typed array in its
 * arguments — its own header says so, and anything meaning to keep one has to copy it first. The
 * mesh a node passes here comes from a `MeshesValue` the scheduler is holding in its cache, so
 * handing the originals over would detach them: the node would see an empty mesh afterwards, and
 * so would every other node reading the same cached value. One memcpy of ~20 MB against a build
 * measured in tens of seconds, and the alternative is a corrupted cache nothing reports.
 *
 * `cleanMeshes.ts` avoids the same trap by packing fresh arrays before it calls; doing it here
 * instead means a caller cannot get it wrong. Note the mesh is then copied more than once —
 * here, across the worker boundary, and again by `astype` in Python — so this is about
 * correctness, not about saving a copy.
 */
export async function runSeamWindows(
  request: SeamWindowRequest,
  options: CallOptions = {},
): Promise<SeamWindows> {
  const result = await callPython(
    {
      module: 'seamWindows',
      fn: 'coda_seam_windows',
      args: [
        { ...request, positions: request.positions.slice(), indices: request.indices.slice() },
      ],
    },
    options,
  )

  const points = float32From(result, 'points')
  const feats = float32From(result, 'feats')
  const sourceNm = float32From(result, 'sourceNm')
  const windows = Number(result.windows)

  // Against `request.nPoints`, never against a value Python echoed back: an echo compares Python
  // with Python, where this compares the answer with what was asked for. Everything downstream
  // slices these by window index, so a short array hands window *i* the tail of window *i-1*
  // rather than failing.
  const expected = windows * request.nPoints * 3
  for (const [name, array] of [
    ['points', points],
    ['feats', feats],
    ['sourceNm', sourceNm],
  ] as const) {
    if (array.length !== expected) {
      throw new Error(
        `SEAM windows returned ${array.length} values for ${name}, not the ` +
          `${expected} that ${windows} windows of ${request.nPoints} points need`,
      )
    }
  }
  return {
    points,
    feats,
    sourceNm,
    windows,
    tiled: Number(result.tiled),
    empty: Number(result.empty),
    tileMs: Number(result.tileMs),
    windowMs: Number(result.windowMs),
  }
}
