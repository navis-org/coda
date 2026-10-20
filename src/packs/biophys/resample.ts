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

/**
 * A command read at every time of an ascending grid, held as an amplifier holds it: each value
 * from its own time until the next sample's, the last for as long as the step before it (one
 * sample's worth), and 0 before the first, after that, and on a NaN. `t` ascending. What a table of
 * injected current becomes on a run's steps, a few breakpoints or a recording alike.
 */
export function held(t: Float64Array, y: Float64Array, grid: Float64Array): Float64Array {
  const out = new Float64Array(grid.length)
  const last = t.length - 1
  if (last < 0) return out
  const end = last > 0 ? t[last]! + (t[last]! - t[last - 1]!) : t[0]!
  let k = 0
  for (let g = 0; g < grid.length; g++) {
    const x = grid[g]!
    if (x < t[0]! || x >= end) continue
    while (k < last && t[k + 1]! <= x) k++
    const v = y[k]!
    if (!Number.isNaN(v)) out[g] = v
  }
  return out
}

/**
 * A long table's rows by sweep, in order of first appearance, each list in time order: rows with
 * no finite time left out, and every row one sweep where there is no sweep column (`cell` null).
 * Keyed by the sweep's text, so 1 and "1" are one sweep; `cell` is its first row's own value. The
 * walk Fit Model Passive reads a recording by and Simulate Model a table of current by, so one
 * recording splits into the same sweeps on either card.
 */
export function rowsBySweep<C>(
  times: ArrayLike<unknown>,
  sweeps?: ArrayLike<C>,
): { cell: C | null; rows: number[] }[] {
  const groups = new Map<string, { cell: C | null; rows: number[] }>()
  for (let row = 0; row < times.length; row++) {
    const t = times[row]
    if (typeof t !== 'number' || !Number.isFinite(t)) continue
    const cell = sweeps ? (sweeps[row] ?? null) : null
    const key = cell === null ? '' : String(cell)
    const group = groups.get(key)
    if (group) group.rows.push(row)
    else groups.set(key, { cell, rows: [row] })
  }
  for (const { rows } of groups.values()) {
    rows.sort((a, b) => (times[a] as number) - (times[b] as number))
  }
  return [...groups.values()]
}
