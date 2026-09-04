/**
 * A set of skeletons flattened for one crossing of the Python bridge.
 *
 * Every Pyodide call that takes skeletons sends the same two arrays — a `parents` soup and an
 * `offsets` index saying where each neuron starts — and the two rules about them are exactly the
 * kind that look like details until one is missed. They were written twice, in `cleanOps.ts` and
 * in the Topology node, and only one copy carried the comment.
 *
 * - **Parent indices stay neuron-local.** The Python side slices each neuron out and hands
 *   fastcore row numbers as node ids, so adding a global offset here produces a forest of
 *   dangling references rather than a tree — and fastcore answers, plausibly, about the wrong
 *   graph.
 * - **The buffers are built rather than borrowed.** `callPython` transfers, so anything passed in
 *   is detached the moment the call is posted; a `subarray` view onto a cached skeleton would
 *   take the caller's own geometry with it.
 *
 * Callers layer their own per-call buffers on top — positions and radii for a clean, synapse
 * counts for a split — over the same `offsets`, which is what lets the result be scattered
 * straight back onto the geometry they already hold.
 */

import type { SkeletonsValue } from '../../core/values'
import { skeletonPointCount } from '../../core/values'

export interface PackedSkeletons {
  /** Parent index per node across the whole set, `-1` for a root. Neuron-local. */
  readonly parents: Int32Array
  /** Where each neuron starts, counted in nodes. Length is `items.length + 1`. */
  readonly offsets: Int32Array
  /** Total node count — `offsets[items.length]`, named so callers need not reach for it. */
  readonly total: number
}

export function packSkeletons(skeletons: SkeletonsValue): PackedSkeletons {
  const total = skeletonPointCount(skeletons)
  const parents = new Int32Array(total)
  const offsets = new Int32Array(skeletons.items.length + 1)

  let at = 0
  for (let n = 0; n < skeletons.items.length; n++) {
    const item = skeletons.items[n]!
    const count = item.parents.length
    parents.set(item.parents.subarray(0, count), at)
    at += count
    offsets[n + 1] = at
  }
  return { parents, offsets, total }
}
