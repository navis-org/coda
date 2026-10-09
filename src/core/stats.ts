/**
 * Small helpers over sorted numbers that more than one layer needs, and that none of them owns:
 * `quantileSorted`, and `lowerBound` — a binary search the table-file readers and the Neuron
 * Dendrogram card both use, moved here out of `data/files/reader.ts` so a viewer need not import
 * a Parquet reader for it.
 *
 * The first is here for a boundary rather than for tidiness. `quantileSorted`
 * lived in `ui/viewers/boxStats.ts` and was reached from `nodes/lib/describeOps.ts` and
 * `nodes/lib/networkMetrics.ts` — a documented, deliberate upward reach, taken because the
 * alternative was a second median beside the first and "which of the nine quantile definitions"
 * is exactly what two copies come to disagree about.
 *
 * What made it untenable was a third caller. `assistant/digest.ts` reuses `describeTable` so that
 * the median a plan is built on and the median the Describe card shows are the same number — and
 * `src/assistant/**` is in `eslint.config.js`'s boundary block, whose whole point is that the
 * assistant stays reachable by a non-React consumer. The chain
 * `assistant → describeOps → ui/viewers/boxStats → ui/colors` made that false in fact while the
 * rule reported clean, because the lint pattern catches only *direct* imports.
 *
 * So the shared arithmetic moved down instead of the reach going sideways. `src/core` is in the
 * boundary block, so the property is now enforced rather than asserted — and
 * `src/test/importGraph.test.ts` walks the transitive imports as well, since lint cannot follow an edge two files
 * deep.
 */

/**
 * Linear-interpolated quantile — the type-7 definition numpy and R default to.
 *
 * `ArrayLike` rather than `number[]`: it only indexes and reads `.length`, and `net.metrics`
 * sorts its degree and weight columns as `Float64Array`s. Converting a million weights to a
 * boxed array to satisfy a signature would be the tail wagging the dog.
 */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]!
  const position = (n - 1) * Math.max(0, Math.min(1, p))
  const lower = Math.floor(position)
  const upper = Math.min(n - 1, lower + 1)
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

/** The first index whose element is not below `target`. */
export function lowerBound<T extends bigint | string | number>(
  sorted: ArrayLike<T>,
  target: T,
): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid]! < target) lo = mid + 1
    else hi = mid
  }
  return lo
}
