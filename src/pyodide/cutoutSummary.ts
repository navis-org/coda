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
 * **Nothing calls this yet** — but it is tested, which is why it is not in the knip baseline: `cutoutSummary.test.ts` drives it against a mocked `callPython`, which is
 * `warp.test.ts`' arrangement and exists there because a marshalling bug in a wrapper survived
 * on the argument that vitest has no Worker. The Python under it is exercised separately by
 * `pnpm probe:cutout-summary`.
 *
 * **The columns are SEAM's, not Coda's.** They are whatever `summarize_cutout` returns, which is
 * what the geometric ranker was fitted on; naming a subset here would be a second list to keep
 * in step with a file that is vendored precisely so it cannot drift.
 */

import { callPython } from './engine'
import type { CallOptions } from './engine'
import { numberFrom, uint64From } from './types'

/* A `type`, not an `interface`: only an alias gets the implicit index signature `PyArg` needs. */
export type CutoutSummaryRequest = {
  /** The distinct supervoxels of the box — `LabelBox.labels`. */
  labels: BigUint64Array
  /** One index into `labels` per voxel, x fastest — `LabelBox.index`. */
  index: Uint32Array
  /**
   * The box's extent in voxels, `[x, y, z]` — `LabelBox.size`.
   *
   * A plain array, not a typed one, and so are the three below it. `callPython` **transfers**
   * every view in its arguments, so a three-element `Int32Array` would be detached on the
   * caller's side for no saving at all — and a caller passing `scale.resolution` twice would
   * find it empty the second time. Only the box itself is big enough to be worth transferring.
   */
  size: readonly number[]
  /**
   * The root each entry of `labels` belongs to, in the same order, `0` for none.
   *
   * At the snapshot's timestamp, not at head: a supervoxel's root changes with every edit, and
   * a search scored against today's agglomeration cannot be compared with a fit made against
   * last month's.
   */
  roots: BigUint64Array
  /**
   * The neuron the box is about — the root everything else is measured *to*.
   *
   * **Never `0`.** That is the id for "no object" in `roots`, and the Python refuses it rather
   * than measuring every candidate's distance to background voxels, which comes back as a full
   * table of plausible rows. A zero reaches a caller from an unmapped supervoxel or a root
   * lookup that soft-failed, so it is an input to check rather than a typo.
   */
  queryRoot: bigint
  /** Nanometres per voxel of the scale the box was read at. */
  resolutionNm: readonly number[]
  /** The box's own corner in that scale's voxels — `VoxelBox.lo`. */
  loVoxels: readonly number[]
  /**
   * The open end the search is about, in nanometres, or empty for the distance columns alone.
   *
   * With it come `point_dist_um` and the local moments, which four of the ranker's eight
   * features read — so a search always passes it, and omitting it is for a caller that wants
   * only "what is near this box" rather than a ranking.
   */
  pointNm?: readonly number[]
  /** How near counts as touching the query. SEAM's default is 0.5 µm. */
  touchUm?: number
  /** The radius the local shape is measured over. SEAM's default is 3 µm. */
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
  /*
   * The columns are told apart by **dtype, not by name**: Python casts the two id columns to
   * uint64 and everything else to float64, so a second list of which names are ids — which this
   * had, and which the module header argues against three paragraphs above — is a cross-language
   * pair with nothing testing either half. A third id column upstream now simply arrives as a
   * `BigUint64Array` and is left out of `columns`, rather than reaching `float64From`.
   */
  const columns: Record<string, Float64Array> = {}
  for (const [key, value] of Object.entries(result)) {
    if (value instanceof Float64Array) columns[key] = value
  }
  return {
    rows: numberFrom(result, 'rows'),
    missingQuery: result['missingQuery'] === true,
    columns,
    root: uint64From(result, 'root'),
    repSupervoxel: uint64From(result, 'rep_svid'),
    ms: numberFrom(result, 'ms'),
  }
}
