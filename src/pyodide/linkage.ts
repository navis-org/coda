/**
 * Hierarchical clustering's typed wrapper over the Python bridge.
 *
 * The second capability, written to the shape `nblast.ts` set: a `.py` in `runtime.ts`'s
 * `MODULES`, the request and result types, and a function that calls `callPython` and reads
 * the answer by name. Nothing else moved.
 *
 * Note the `type` rather than `interface` on the request — TypeScript gives a type alias an
 * implicit index signature and an interface none, so an interface is not assignable to
 * `PyArg` and the call fails to compile with a message about `undefined`.
 */

import { callPython } from './engine'
import type { NblastSymmetry } from './nblast'
import type { CallOptions } from './engine'
import { float64From, int32From, numberFrom } from './types'

/**
 * How the two directions of a pair are combined before clustering.
 *
 * NBLAST is not symmetric and a distance must be, so somebody has to decide. Folded into
 * fastcore's own pass rather than done here: `(M + M.T) / 2` in JavaScript would be a second
 * `n x n` array, and the whole reason this crosses the bridge is that the fused pass allocates
 * only the condensed vector.
 */
export type LinkageSymmetry = NblastSymmetry

/** How a similarity becomes a distance. `one_minus` is `1 - score`, NBLAST's convention. */
export type LinkageTransform = 'one_minus' | 'none'

export type LinkageRequest = {
  /**
   * Row-major `n * n`.
   *
   * **A copy, never the matrix off the wire.** `callPython` *transfers* every typed array in
   * a call's arguments, so passing an upstream value's own buffer detaches it — and that
   * buffer is the scheduler's cached result for the node above, which would come back empty
   * on the next render with nothing to connect it to this node. `linkageOps.ts` copies.
   */
  scores: Float64Array
  /** Side length, so the flat buffer can be reshaped. */
  n: number
  /** One of `LINKAGE_METHODS`. Passed through to fastcore, which speaks SciPy's names. */
  method: string
  symmetry: LinkageSymmetry
  transform: LinkageTransform
}

export interface LinkageResult {
  /** Row-major `count * 4`: `[a, b, height, size]` per merge. SciPy's `Z`, ravelled. */
  merges: Float64Array
  /** Merges, i.e. `n - 1`. */
  count: number
  /** The observations left to right for drawing; a permutation of `0..n-1`. */
  order: Int32Array
}

/** Cluster a square score matrix, returning a SciPy-compatible linkage matrix. */
export async function runLinkage(
  request: LinkageRequest,
  options: CallOptions = {},
): Promise<LinkageResult> {
  const result = await callPython(
    { module: 'linkage', fn: 'coda_linkage_run', args: [request] },
    options,
  )

  const count = numberFrom(result, 'count')
  const merges = float64From(result, 'merges')
  const order = int32From(result, 'order')
  if (merges.length !== count * 4) {
    throw new Error(`Linkage returned ${merges.length} numbers for ${count} merges`)
  }
  if (order.length !== count + 1) {
    throw new Error(`Linkage returned ${order.length} leaves for ${count} merges`)
  }
  return { merges, count, order }
}

// ---------------------------------------------------------------------------
// The Heatmap node's cluster order
// ---------------------------------------------------------------------------

/**
 * A clustermap's axis order: each row (or column) as a vector, clustered by the distance
 * between those vectors. The same `.py` as the linkage above, since it is the same wheel and
 * the same leaf-order call; a different *question*, since here the matrix is the data rather
 * than the distances. See `coda_cluster_order`.
 */
export type ClusterOrderRequest = {
  /** Row-major `rows * cols` — **a copy**, for the reason `LinkageRequest.scores` gives. */
  values: Float64Array
  rows: number
  cols: number
  /** Which lines are the vectors. `columns` transposes on the far side. */
  axis: 'rows' | 'columns'
  /** One of `LINKAGE_METHODS`. */
  method: string
  /** `euclidean`, `correlation` or `cosine` — `matrixShape.ts`'s list. */
  metric: string
}

/** Leaf order of the clustered axis: a permutation of `0..n-1`. */
export async function runClusterOrder(
  request: ClusterOrderRequest,
  options: CallOptions = {},
): Promise<Int32Array> {
  const result = await callPython(
    { module: 'linkage', fn: 'coda_cluster_order', args: [request] },
    options,
  )
  const count = numberFrom(result, 'count')
  const order = int32From(result, 'order')
  if (order.length !== count) {
    throw new Error(
      `Cluster order returned ${order.length} positions for ${count} observations`,
    )
  }
  return order
}
