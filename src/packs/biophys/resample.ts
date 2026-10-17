/**
 * Linear resampling of one trace onto a grid: Combine Traces' and Fit Model's, both of which need
 * a trace at times it was not sampled at.
 *
 * A module of its own, importing nothing, because the fit worker reads it: `traceOps.ts` beside it
 * reaches the skeleton helpers and through them Pyodide, which no worker but Pyodide's may load
 * (`src/test/importGraph.test.ts`).
 */

/**
 * A trace read at every time of an ascending grid, by walking the two together: linear between
 * neighbours, exact on a sample, null outside the trace or beside a gap (NaN in `y`).
 */
export function resample(
  t: Float64Array,
  y: Float64Array,
  grid: Float64Array,
): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(grid.length).fill(null)
  const last = t.length - 1
  if (last < 0) return out
  let k = 0
  for (let g = 0; g < grid.length; g++) {
    const x = grid[g]!
    if (x < t[0]! || x > t[last]!) continue
    while (k < last && t[k + 1]! <= x) k++
    if (t[k] === x || k === last) {
      out[g] = Number.isNaN(y[k]!) ? null : y[k]!
      continue
    }
    const a = y[k]!
    const b = y[k + 1]!
    if (Number.isNaN(a) || Number.isNaN(b)) continue
    const span = t[k + 1]! - t[k]!
    out[g] = span > 0 ? a + ((b - a) * (x - t[k]!)) / span : a
  }
  return out
}
