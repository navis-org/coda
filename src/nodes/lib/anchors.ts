/**
 * A position stored in a param to stand for a place on a neuron — a split correction's anchor, a
 * point placed by hand — and how far from the neuron it may land and still be that place.
 *
 * Stored as nanometres rather than as a node index, which a re-fetch may renumber; read back with
 * `isPoint`, and placed again on whatever skeleton arrives. One further than `SNAP_NM` is stale.
 */

/**
 * How far an anchor may be from its node and still be that node, in nanometres.
 *
 * Re-fetching the same reconstruction gives the same positions, so the slack is for a different
 * route to the same neuron, which re-samples the cable. 2 µm is a few node spacings of a traced
 * skeleton and well inside the gap between two neurites that run apart — past it an anchor is
 * more likely on the wrong branch than a moved copy of the right one.
 */
export const SNAP_NM = 2000

/** Node `n`'s position, as an anchor stores one: the write half of `isPoint`. */
export function positionOf(p: Float32Array, n: number): [number, number, number] {
  return [p[n * 3]!, p[n * 3 + 1]!, p[n * 3 + 2]!]
}

/** Three finite numbers: a stored position. */
export function isPoint(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
}
