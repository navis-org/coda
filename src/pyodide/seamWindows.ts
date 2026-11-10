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
import { float32From, int32From, uint8From } from './types'

/* A `type`, not an `interface`: only an alias gets the implicit index signature `PyArg`
 * needs, which is why `CleanMeshesRequest` is one too. */
export type SeamWindowRequest = {
  /**
   * The neuron's mesh vertices, xyz interleaved, in **nanometres**.
   *
   * Empty is allowed, and only, where `meshKey` names a tiling the bridge is already holding —
   * which is also how the 20 MB of mesh stops crossing on every call.
   */
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
   * Exactly these centres, in exactly this order — absent, the whole tiling; **empty, none at
   * all**, which is how a caller asks to tile and be told where the windows are before deciding
   * which to build.
   *
   * **The one way to choose windows**, because it is the only one a caller needs: selecting by
   * distance, taking a page, and asking for the tiling alone are all "these centres, in this
   * order", and each spelled separately was a second place for the geometry to be decided. A
   * caller that wants the centres near a tip works them out from `tilingCentresNm`, which comes
   * back on every call; one that wants a page slices this array.
   *
   * A window is built from its own seeded stream, so **the order is free**: building centre 90
   * before centre 2 gives both the same windows it would give either way. That is what lets a
   * caller sweep a neuron tip by tip instead of in the tiling's own arbitrary order, which is
   * the difference between first rows in seconds and first rows well into the run.
   */
  only?: Int32Array
  /**
   * Stop after this many centres of whatever `only` named; `0` or less takes them all.
   *
   * A **cap**, not a selection, which is why it survives beside `only`: Find Merges offers a
   * reader a `Max windows` rail and cannot name the centres it wants, since it does not know how
   * many there are until the call comes back.
   */
  limit: number
  /**
   * A name for this mesh, so the tiling is built once and kept for the calls that follow.
   *
   * **The tiling is the expensive half and it is paid in `Scan`'s constructor** — the face grid
   * and the seeded surface draw. Measured on a 3.7 M-face neuron: one tip's dozen windows took
   * 5.4 s, of which 4.9 s was re-tiling a mesh that had not changed. With a key, the first call
   * sends the mesh and builds it; later calls send empty arrays and the same key, and skip both
   * the tiling and the transfer.
   *
   * The caller names it because the caller knows what it is holding — a neuron at a dataset at a
   * level of detail. Hashing the mesh instead would spend a good part of what this saves. Any
   * change of key or of window constants rebuilds, which is the safe direction, and **only one
   * tiling is kept**: it holds the mesh as float64, so a second is a leak with a lookup.
   */
  meshKey?: string
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
   * `tiled × 3`: **every** centre of the tiling, indexed by centre number, whatever was
   * selected or paged.
   *
   * With `windowIndex` it is what lets a caller say which centres it still owes — a tip is
   * finished once every centre that can reach it has been scored, and that is a question about
   * centres, not about the windows that happened to be built. A few thousand triples, so it
   * comes back always rather than behind a flag nobody would know to set.
   */
  tilingCentresNm: Float32Array
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
  /** How many centres `only` named — equal to `tiled` where it named none. */
  selected: number
  /** Whether a cached tiling answered, so a caller meaning to reuse can assert rather than infer. */
  scanCached: boolean
  /** `windows`: which centre each built window came from, an index into the whole tiling. */
  windowIndex: Int32Array
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
        {
          ...request,
          positions: request.positions.slice(),
          indices: request.indices.slice(),
          // Copied for the reason the header gives, and defaulted here rather than in Python so
          // the absent case crosses as an empty array rather than as a missing key.
          // Absent stays absent — the key is left out, not set to null: `only: []` is "no
          // windows", which is a different request, and a JS null crosses as `JsNull` rather
          // than as `None`.
          ...(request.only ? { only: request.only.slice() } : {}),
          meshKey: request.meshKey ?? '',
        },
      ],
    },
    options,
  )

  const points = float32From(result, 'points')
  const feats = float32From(result, 'feats')
  const sourceNm = float32From(result, 'sourceNm')
  const centresNm = float32From(result, 'centresNm')
  const tilingCentresNm = float32From(result, 'tilingCentresNm')
  const inOwnCell = uint8From(result, 'inOwnCell')
  const windowIndex = int32From(result, 'windowIndex')
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
  if (windowIndex.length !== windows) {
    throw new Error(
      `SEAM windows returned ${windowIndex.length} indices for ${windows} windows`,
    )
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
    windowIndex,
    tiled: Number(result.tiled),
    selected: Number(result.selected),
    scanCached: Boolean(result.scanCached),
    empty: Number(result.empty),
    centresNm,
    tilingCentresNm,
    inOwnCell,
    cellUm: Number(result.cellUm),
    tileMs: Number(result.tileMs),
    windowMs: Number(result.windowMs),
    drawEvery: Number(result.drawEvery),
    drawnPerWindow,
  }
}

/**
 * A `meshKey` minted from the mesh itself, so a caller cannot make up one that is wrong.
 *
 * `perGeometry`'s idea one seam over, and for the same reason: a key a node *writes* — a neuron
 * id, a model name, an index — is a description of the mesh rather than the mesh, and two meshes
 * a description cannot tell apart get each other's tiling. The same root from another dataset, at
 * another `Detail`, downsampled: all of them collide, and none of it shows in the window count,
 * the centre count or `scanCached`. It shows up as scores that do not reproduce.
 *
 * Keyed on **both** arrays, weakly: a decimation replaces the indices and keeps the positions, a
 * transform does the opposite, and either alone would hand the changed mesh the old one's
 * tiling. A slot lives exactly as long as its arrays, which is as long as the tiling could be
 * wanted.
 */
const meshKeys = new WeakMap<Float32Array, WeakMap<Uint32Array, string>>()
let nextMeshKey = 0

export function meshKeyFor(positions: Float32Array, indices: Uint32Array): string {
  let byIndices = meshKeys.get(positions)
  if (!byIndices) meshKeys.set(positions, (byIndices = new WeakMap()))
  let key = byIndices.get(indices)
  if (key === undefined) byIndices.set(indices, (key = `mesh-${(nextMeshKey += 1)}`))
  return key
}

/** Points and their scores in, one point per `cellUm` cell out. */
export interface SeamReduceRequest {
  /** `n × 3` nanometres, interleaved. */
  pointsNm: Float32Array
  /** One per point. */
  scores: Float32Array
  /** `config.scan.reduce_um` — 0.5 µm for every SEAM checkpoint so far. */
  cellUm: number
}

export interface SeamCells {
  /** `cells × 3` nanometres: the best-scoring point of each cell, which *is* the cell. */
  pointsNm: Float32Array
  /** That point's score. */
  scores: Float32Array
  cells: number
}

/**
 * Pool per-point scores to one point per cell — SEAM's own `reduce_max`.
 *
 * **Idempotent**, which is the property a caller depends on: the max of maxima per cell is the
 * max, so a batch can be reduced as it arrives and the concatenation reduced again. That is what
 * `replay_scan.score_neuron` does, and it is what keeps a whole neuron's points — tens of
 * millions, at 4,096 a window — from having to exist at once.
 */
export async function runSeamReduce(
  request: SeamReduceRequest,
  options: CallOptions = {},
): Promise<SeamCells> {
  if (request.pointsNm.length !== request.scores.length * 3) {
    throw new Error(
      `${request.pointsNm.length / 3} points against ${request.scores.length} scores`,
    )
  }
  const result = await callPython(
    {
      module: 'seamWindows',
      fn: 'coda_seam_reduce',
      args: [
        { ...request, pointsNm: request.pointsNm.slice(), scores: request.scores.slice() },
      ],
    },
    options,
  )
  const pointsNm = float32From(result, 'pointsNm')
  const scores = float32From(result, 'scores')
  const cells = Number(result.cells)
  if (pointsNm.length !== cells * 3 || scores.length !== cells) {
    throw new Error(
      `SEAM reduce returned ${pointsNm.length} coordinates and ${scores.length} scores for ` +
        `${cells} cells`,
    )
  }
  return { pointsNm, scores, cells }
}

/**
 * Drop the cached tiling and the mesh it holds.
 *
 * Only worth calling when nothing follows soon: a cached `Scan` keeps the mesh as float64, which
 * on a large neuron is on the order of 134 MB in a heap that never gives memory back. Moving to
 * another neuron needs no call — a different `meshKey` replaces the entry.
 */
export async function forgetSeamScan(options: CallOptions = {}): Promise<boolean> {
  const result = await callPython(
    { module: 'seamWindows', fn: 'coda_seam_forget', args: [{}] },
    options,
  )
  return Boolean(result.dropped)
}
