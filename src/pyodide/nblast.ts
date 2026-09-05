/**
 * NBLAST's typed wrapper over the Python bridge.
 *
 * **This file is the shape a second capability copies.** A capability is three things and no
 * more: a `.py` registered in `runtime.ts`'s `MODULES`, the types its request and result take,
 * and a function that calls `callPython` and reads the answer by name. Nothing in `engine.ts`,
 * `worker.ts` or `types.ts` changes when one is added — that was the whole point of making the
 * protocol about calling a function rather than about scoring neurons.
 *
 * The types live here rather than in `types.ts` for the same reason: `types.ts` is the wire,
 * and what travels on it is nobody else's business.
 */

import { callPython } from './engine'
import type { CallOptions } from './engine'
import { float64From, int32From, numberFrom } from './types'

/** How a query set is scored against a target that is the same set. */
export type NblastSymmetry = 'none' | 'min' | 'max' | 'mean'

/**
 * One neuron set, flattened.
 *
 * Three buffers rather than an array of objects: a hundred skeletons is a hundred thousand
 * points, and an array of `{x, y, z}` would be a hundred thousand objects to clone at the
 * postMessage boundary. Flattened, the whole set moves as three transfers and costs nothing.
 *
 * **Points are micrometres**, converted on the way in. See `nblast.py` for why that is not a
 * preference — the embedded FCWB matrix stops at 40 um, so nanometres score every pair as
 * strangers with no error anywhere.
 */
export type PointSet = {
  /** xyz interleaved, one neuron after the last. */
  points: Float32Array
  /** Parent index per point, `-1` for a root. Neuron-local, so index 0 is that neuron's first. */
  parents: Int32Array
  /** Where each neuron starts, counted in points. Length is `count + 1`. */
  offsets: Int32Array
}

/*
 * A `type` rather than an `interface`, and the same for `PointSet` above — not a style choice.
 * TypeScript gives a type alias an implicit index signature and an interface none, so an
 * interface is not assignable to `PyArg`'s object branch and a request declared as one fails
 * to compile at the `callPython` call with a message about `undefined`. Worth knowing before
 * writing the second capability, since it is not obvious from the error.
 */
export type NblastRequest = {
  query: PointSet
  /** Absent means all-by-all, which is a different fastcore call rather than `target = query`. */
  target?: PointSet
  /** Neighbours per point for the tangent-vector fit. */
  k: number
  /** Point spacing in micrometres; `0` leaves the skeleton as traced. */
  resample: number
  normalize: boolean
  symmetry: NblastSymmetry
  useAlpha: boolean
}

export interface NblastResult {
  /** Row-major, `rows * cols`. */
  scores: Float64Array
  rows: number
  cols: number
}

/** Score one set against another, or a set against itself. */
export async function runNblast(
  request: NblastRequest,
  options: CallOptions = {},
): Promise<NblastResult> {
  const result = await callPython(
    { module: 'nblast', fn: 'coda_nblast_run', args: [request] },
    options,
  )

  const rows = numberFrom(result, 'rows')
  const cols = numberFrom(result, 'cols')
  const scores = float64From(result, 'scores')
  if (scores.length !== rows * cols) {
    throw new Error(
      `NBLAST returned ${scores.length} scores for a ${rows} x ${cols} comparison`,
    )
  }
  return { scores, rows, cols }
}

/**
 * The k nearest neighbours of each neuron, without the full matrix.
 *
 * The scores are exact NBLAST values; only which pairs were scored is approximate, which is
 * what makes this `n * nCandidates` rather than `n^2`. `symmetry` matters more here than for a
 * matrix and is applied *before* the top-k cut — once only k neighbours per row survive there
 * is no transpose left to symmetrise against.
 */
export type NblastKnnRequest = {
  query: PointSet
  /**
   * Absent means each neuron's neighbours are found among the others, and a neuron is excluded
   * from its own row. With a target set nothing is excluded, so a neuron present in both
   * matches itself at 1.0 — fastcore's behaviour, kept rather than corrected.
   */
  target?: PointSet
  /** Neighbours to return per neuron. */
  k: number
  /** Shortlist size per neuron: the one recall-against-cost knob. */
  nCandidates: number
  /** Neighbours per point for the tangent-vector fit — fastcore's other `k`. */
  tangentK: number
  resample: number
  normalize: boolean
  symmetry: NblastSymmetry
  useAlpha: boolean
}

export interface NblastKnnResult {
  /**
   * Row-major `rows * k` indices into the target set (or the query set for an all-by-all),
   * descending by score. A row with fewer than `k` candidates is padded with `-1`.
   */
  idx: Int32Array
  /** Aligned to `idx`; padding is `-Infinity`. */
  scores: Float64Array
  rows: number
  k: number
}

export async function runNblastKnn(
  request: NblastKnnRequest,
  options: CallOptions = {},
): Promise<NblastKnnResult> {
  const result = await callPython(
    { module: 'nblast', fn: 'coda_nblast_knn_run', args: [request] },
    options,
  )

  const rows = numberFrom(result, 'rows')
  const k = numberFrom(result, 'k')
  const idx = int32From(result, 'idx')
  const scores = float64From(result, 'scores')
  if (idx.length !== rows * k || scores.length !== rows * k) {
    throw new Error(`NBLAST k-NN returned ${idx.length} matches for ${rows} x ${k}`)
  }
  return { idx, scores, rows, k }
}

/**
 * One neuron set's synapses, flattened.
 *
 * `PointSet`'s sibling and deliberately not the same type: a dotprop set carries a tree, and
 * a synapse set carries a connector type instead. Neither field means anything to the other
 * call, and one type with both halves optional is how two callers come to disagree about
 * which of them is required.
 *
 * **Points are micrometres**, converted on the way in for the reason `PointSet` records.
 */
export type SynapseSet = {
  /** xyz interleaved, one neuron after the last. */
  points: Float32Array
  /**
   * A small integer per point — Coda maps `polarity` onto 0 for pre and 1 for post.
   *
   * Read only when `byType` is set. Where the point cloud carries no polarity column at all
   * every point is 0, which makes `byType` a comparison every synapse passes; the node turns
   * the control off rather than leaving it on and meaningless.
   */
  types: Int32Array
  /** Where each neuron starts, counted in points. Length is `count + 1`. */
  offsets: Int32Array
}

export type SynblastRequest = {
  query: SynapseSet
  /** Absent means an all-by-all, which is fastcore's own `target=None`. */
  target?: SynapseSet
  /** Compare a presynapse only against presynapses, and a postsynapse only against those. */
  byType: boolean
  normalize: boolean
  symmetry: NblastSymmetry
}

/**
 * Score two neuron sets by where their synapses are rather than by their shape.
 *
 * The result is a `NblastResult` and not a type of its own, because it is the same thing: a
 * row-major score matrix on the same scale, out of the same FCWB lookup table. What differs
 * is the question, and that belongs on the node rather than in the shape of the answer.
 */
export async function runSynblast(
  request: SynblastRequest,
  options: CallOptions = {},
): Promise<NblastResult> {
  const result = await callPython(
    { module: 'nblast', fn: 'coda_synblast_run', args: [request] },
    options,
  )

  const rows = numberFrom(result, 'rows')
  const cols = numberFrom(result, 'cols')
  const scores = float64From(result, 'scores')
  if (scores.length !== rows * cols) {
    throw new Error(
      `syNBLAST returned ${scores.length} scores for a ${rows} x ${cols} comparison`,
    )
  }
  return { scores, rows, cols }
}
