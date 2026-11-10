/**
 * What is in a box of segmentation around a point: a typed wrapper over `cutoutSummary.py`.
 *
 * The inputs are deliberately the shapes Coda already has. `labels` and `index` are a
 * `LabelBox` exactly as `readLabelBox` returns it — the distinct supervoxels and one index per
 * voxel, x fastest — and `roots` is what `cavePostBinary` answers for those supervoxels at a
 * timestamp. Nothing here fetches either one: one is a public bucket read and the other an
 * authenticated chunkedgraph call, and keeping them out of the worker keeps the credential out
 * of it too.
 *
 * **Nothing calls this yet**, and it is in the knip baseline for that reason. The Python under
 * it is exercised — `pnpm probe:cutout-summary` runs the vendored function under CPython and
 * under wasm and compares, then runs `coda_cutout_summary` and checks the axis order survived
 * the crossing — but this wrapper and the worker hop are not, because vitest has neither
 * Pyodide nor a `Worker`. The first caller is the candidate search, and it should bring a probe
 * arm that goes through this file rather than around it.
 *
 * **The columns are SEAM's, not Coda's.** They are whatever `summarize_cutout` returns, which is
 * what the geometric ranker was fitted on; naming a subset here would be a second list to keep
 * in step with a file that is vendored precisely so it cannot drift.
 */

import { callPython } from './engine'
import type { CallOptions } from './engine'
import { float64From, numberFrom, uint64From } from './types'

/* A `type`, not an `interface`: only an alias gets the implicit index signature `PyArg` needs. */
export type CutoutSummaryRequest = {
  /** The distinct supervoxels of the box — `LabelBox.labels`. */
  labels: BigUint64Array
  /** One index into `labels` per voxel, x fastest — `LabelBox.index`. */
  index: Uint32Array
  /** The box's extent in voxels, `[x, y, z]` — `LabelBox.size`. */
  size: Int32Array
  /**
   * The root each entry of `labels` belongs to, in the same order, `0` for none.
   *
   * At the snapshot's timestamp, not at head: a supervoxel's root changes with every edit, and
   * a search scored against today's agglomeration cannot be compared with a fit made against
   * last month's.
   */
  roots: BigUint64Array
  /** The neuron the box is about — the root everything else is measured *to*. */
  queryRoot: bigint
  /** Nanometres per voxel of the scale the box was read at. */
  resolutionNm: Float64Array
  /** The box's own corner in that scale's voxels — `VoxelBox.lo`. */
  loVoxels: Float64Array
  /**
   * The open end the search is about, in nanometres, or empty for the distance columns alone.
   *
   * With it come `point_dist_um` and the local moments, which four of the ranker's eight
   * features read. Without it the call is about a third of the cost — see the `.py` header.
   */
  pointNm?: Float64Array
  /** `candidates.POOL_MAX_DIST_UM`'s companion: how near counts as touching the query. */
  touchUm?: number
  /** The radius the local shape is measured over — `tip_candidates`' `MOMENTS_UM`. */
  momentsUm?: number
}

/** One row per root in the box, as flat columns. */
export interface CutoutSummary {
  readonly rows: number
  /**
   * True where the query root has no voxel in its own box, and then there are no rows.
   *
   * **Not an error.** The vendored function answers this for itself, and it is a real state: a
   * tip whose neuron does not reach the cutout around it is a tip worth looking at, not a failed
   * read. A caller that treated it as a failure would drop exactly the ends it is hunting for.
   */
  readonly missingQuery: boolean
  /** Every column `summarize_cutout` returned, by its own name. */
  readonly columns: Readonly<Record<string, Float64Array>>
  /** The id columns, kept 64-bit — a root through a float64 is a different neuron. */
  readonly root: BigUint64Array
  readonly repSupervoxel: BigUint64Array
  /** What the call took in Python, for a caller pricing a search over many ends. */
  readonly ms: number
}

/** The columns that are ids rather than measurements, and so must not become doubles. */
const ID_COLUMNS = new Set(['root', 'rep_svid'])

/**
 * Summarise one box of segmentation.
 *
 * **The arrays are transferred, not copied** — `callPython`'s own rule — so a caller holding a
 * `LabelBox` it means to keep must copy first. Nothing here copies on its behalf: a cutout is
 * 19 MB of index and the common case is a caller that is finished with it.
 */
export async function runCutoutSummary(
  request: CutoutSummaryRequest,
  options: CallOptions = {},
): Promise<CutoutSummary> {
  const result = await callPython(
    { module: 'cutoutSummary', fn: 'coda_cutout_summary', args: [request] },
    options,
  )
  const rows = numberFrom(result, 'rows')
  if (result['missingQuery'] === true) {
    return {
      rows: 0,
      missingQuery: true,
      columns: {},
      root: new BigUint64Array(0),
      repSupervoxel: new BigUint64Array(0),
      ms: numberFrom(result, 'ms'),
    }
  }
  const columns: Record<string, Float64Array> = {}
  for (const key of Object.keys(result)) {
    if (key === 'rows' || key === 'ms' || key === 'missingQuery' || ID_COLUMNS.has(key))
      continue
    columns[key] = float64From(result, key)
  }
  return {
    rows,
    missingQuery: false,
    columns,
    root: uint64From(result, 'root'),
    repSupervoxel: uint64From(result, 'rep_svid'),
    ms: numberFrom(result, 'ms'),
  }
}
