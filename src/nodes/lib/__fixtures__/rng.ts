/**
 * A deterministic pseudo-random source, so a failure reproduces.
 *
 * `chain.ts`' argument at a second fixture, and with the same history: this was written three
 * times over one change — `kdTree.test.ts`, `geometryDistance.test.ts` and `probe-distance.ts` —
 * byte-identical apart from whether the divisor was `0xffffffff` or `0x100000000`, which is a
 * quiet way for two suites to disagree about what "the same seed" means.
 *
 * Numerical Recipes' LCG constants. `>>> 0` keeps the state an unsigned 32-bit integer, which is
 * what makes it reproduce across engines; the divisor is `0x100000000`, so the result is a half-
 * open `[0, 1)` rather than `[0, 1]`.
 */
export function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** `count` xyz triples spread over a cube `spread` wide, centred on the origin. */
export function cloud(count: number, spread = 10_000, seed = 1): Float32Array {
  const next = rng(seed)
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count * 3; i++) positions[i] = (next() - 0.5) * spread
  return positions
}
