/**
 * What a skeleton's radii say, read one way for every surface: whether there are any (`hasRadii`),
 * and what widths are scaled against (`radiusReference`). Headless, so the 3D View, the Explore
 * thumbnail, the arbour drawings and Skeleton to Points read the same rule.
 */

/** Whether any radius is measured: 0 is "unmeasured" on every source, not a neuron of no thickness. */
export function hasRadii(radii: ArrayLike<number>): boolean {
  for (let i = 0; i < radii.length; i++) if (radii[i]! > 0) return true
  return false
}

/**
 * The p95 of the **positive** radii, or 0 where there are none — what a skeleton's widths are
 * scaled against.
 *
 * One function for everything that draws by radius — the 3D View's `radius` mode, the Explore
 * thumbnail (`strokeWidths`) and the arbour drawings (`radiusWidths`) — so one neuron cannot get
 * two references. Positive only, because a
 * radius of 0 is "unmeasured" on every source (CATMAID's −1 is clamped to it, and a level-2 chunk
 * too small for `max_dt_nm` has none).
 *
 * Nearest-rank, `ceil(p * n) - 1`, rather than the interpolating `floor(p * (n - 1))`. They agree
 * on anything the size of a real skeleton and disagree badly on a small one: over two endpoints
 * the second form picks the *smaller*, i.e. a p95 that is not even in the top half. Test fixtures
 * are exactly where a small one shows up.
 */
export function radiusReference(radii: ArrayLike<number>): number {
  let count = 0
  for (let i = 0; i < radii.length; i++) if (radii[i]! > 0) count++
  if (count === 0) return 0
  const positive = new Float32Array(count)
  let at = 0
  for (let i = 0; i < radii.length; i++) if (radii[i]! > 0) positive[at++] = radii[i]!
  // A `Float32Array` sorts numerically by default, where a plain `Array` would sort these
  // as strings and put 100 before 9.
  positive.sort()
  return positive[Math.max(0, Math.ceil(0.95 * count) - 1)]!
}
