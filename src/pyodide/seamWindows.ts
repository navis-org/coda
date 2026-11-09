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
import { float32From, uint8From } from './types'

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
   * Keep every *n*th of a window's points in `sourceNm`, for drawing.
   *
   * The model still sees all `nPoints` — `points` and `feats` are its input and are never
   * thinned. This is the output's density: a neuron's windows at full density are tens of
   * megabytes of coordinates nobody inspects point by point. A stride rather than a count so
   * the same one applies to the per-point logits, giving a matching pair with no index array.
   */
  drawEvery: number
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
  /** `windows × drawnPerWindow × 3`: where the *drawn* points are, in nanometres. */
  sourceNm: Float32Array
  /** `windows × 3`: the surface point each window is centred on, in nanometres. */
  centresNm: Float32Array
  /**
   * `windows × drawnPerWindow`: 1 where a drawn point lies in **its own window's grid cell**.
   *
   * A window crops a 15 µm sphere but the tiling puts one centre per ~8 µm cell, so most of a
   * window's points are in a neighbour's cell — they are that window's *context*, not its
   * subject. Taking all of them would give one surface point a label from every window that can
   * see it; taking only these gives it exactly one.
   */
  inOwnCell: Uint8Array
  /** The grid's cell size in µm, which is `windowRadiusUm × TILE_FRACTION`. */
  cellUm: number
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
  /** The stride actually applied, which is at least 1 whatever was asked for. */
  drawEvery: number
  /** How many points per window came back in `sourceNm`. */
  drawnPerWindow: number
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
  const centresNm = float32From(result, 'centresNm')
  const inOwnCell = uint8From(result, 'inOwnCell')
  const windows = Number(result.windows)

  // Against `request.nPoints`, never against a value Python echoed back: an echo compares Python
  // with Python, where this compares the answer with what was asked for. Everything downstream
  // slices these by window index, so a short array hands window *i* the tail of window *i-1*
  // rather than failing.
  const drawnPerWindow = Number(result.drawnPerWindow)
  const expected = windows * request.nPoints * 3
  for (const [name, array, per] of [
    ['points', points, request.nPoints],
    ['feats', feats, request.nPoints],
    // Thinned by `drawEvery`, so it is checked against its own width rather than the model's.
    ['sourceNm', sourceNm, drawnPerWindow],
  ] as const) {
    const want = name === 'sourceNm' ? windows * per * 3 : expected
    if (array.length !== want) {
      throw new Error(
        `SEAM windows returned ${array.length} values for ${name}, not the ` +
          `${want} that ${windows} windows of ${per} points need`,
      )
    }
  }
  if (centresNm.length !== windows * 3) {
    throw new Error(
      `SEAM windows returned ${centresNm.length} centre values for ${windows} windows`,
    )
  }
  if (inOwnCell.length !== windows * drawnPerWindow) {
    throw new Error(
      `SEAM windows returned ${inOwnCell.length} cell flags, not the ` +
        `${windows * drawnPerWindow} that ${windows} windows of ${drawnPerWindow} points need`,
    )
  }
  return {
    points,
    feats,
    sourceNm,
    windows,
    tiled: Number(result.tiled),
    empty: Number(result.empty),
    centresNm,
    inOwnCell,
    cellUm: Number(result.cellUm),
    tileMs: Number(result.tileMs),
    windowMs: Number(result.windowMs),
    drawEvery: Number(result.drawEvery),
    drawnPerWindow,
  }
}
