/**
 * Match extraction's typed wrapper over the Python bridge.
 *
 * The sixth capability, `nblast.ts`'s shape unchanged. The one thing worth knowing before
 * reading it is that the three modes return three different shapes, so the result is a
 * discriminated union rather than one type with everything optional — a `values` array that
 * is sometimes ranked-and-padded and sometimes ragged is two arrays wearing one name.
 */

import { callPython } from './engine'
import type { CallOptions } from './engine'
import { float64From, int32From, numberFrom } from './types'

/** Which question to ask of the matrix. */
export type MatchMode = 'top' | 'above' | 'count'

/** Which of the two cutoffs `above` and `count` are given. fastcore wants exactly one. */
export type MatchCutoff = 'threshold' | 'percentage'

export type MatchesRequest = {
  /**
   * Row-major `rows * cols`.
   *
   * **A copy, never the matrix off the wire** — `callPython` transfers every typed array in
   * a call's arguments, so passing an upstream value's own buffer detaches the scheduler's
   * cached result for the node above. `matchOps.ts` copies, exactly as `linkageOps.ts` does.
   */
  scores: Float64Array
  rows: number
  cols: number

  mode: MatchMode
  /** `0` groups by row (one set of matches per query); `1` groups by column. */
  axis: 0 | 1
  /** Lower is better. Derived from the matrix's own `measure` unless the node overrides it. */
  distances: boolean
  /** Exclude each group's diagonal cell. Needs a square matrix; the node refuses otherwise. */
  skipSelf: boolean

  /** Matches per group, for `top`. */
  n: number
  cutoff: MatchCutoff
  /** Absolute cutoff, for `above` and `count`. */
  threshold: number
  /** Band around each group's *own* best value, in `[0, 1]`. */
  percentage: number
  /** Refuse to allocate more than this many matches, for `above`. */
  maxMatches: number
}

/** `n` matches per group, rectangular and padded with `-1` / NaN. */
export interface TopMatchesResult {
  mode: 'top'
  /** Row-major `groups * n`, indices along the other axis, best first. */
  idx: Int32Array
  /** Aligned to `idx`; NaN where the index is `-1`. */
  values: Float64Array
  groups: number
  n: number
}

/** Everything clearing the cutoff, CSR-style: group `g` is `idx[offsets[g]..offsets[g+1]]`. */
export interface MatchesAboveResult {
  mode: 'above'
  offsets: Int32Array
  idx: Int32Array
  values: Float64Array
  groups: number
}

/** How many each group *would* yield, without materialising any of them. */
export interface MatchCountsResult {
  mode: 'count'
  counts: Int32Array
  groups: number
}

export type MatchesResult = TopMatchesResult | MatchesAboveResult | MatchCountsResult

/** Extract matches from a score matrix, in whichever of the three shapes was asked for. */
export async function runMatches(
  request: MatchesRequest,
  options: CallOptions = {},
): Promise<MatchesResult> {
  const result = await callPython(
    { module: 'matches', fn: 'coda_matches_run', args: [request] },
    options,
  )

  const groups = numberFrom(result, 'groups')

  if (request.mode === 'count') {
    const counts = int32From(result, 'counts')
    if (counts.length !== groups) {
      throw new Error(`Match counts returned ${counts.length} numbers for ${groups} groups`)
    }
    return { mode: 'count', counts, groups }
  }

  const idx = int32From(result, 'idx')
  const values = float64From(result, 'values')
  if (idx.length !== values.length) {
    throw new Error(`Matches returned ${idx.length} indices and ${values.length} scores`)
  }

  if (request.mode === 'top') {
    const n = numberFrom(result, 'n')
    if (idx.length !== groups * n) {
      throw new Error(`Top matches returned ${idx.length} entries for ${groups} x ${n}`)
    }
    return { mode: 'top', idx, values, groups, n }
  }

  const offsets = int32From(result, 'offsets')
  if (offsets.length !== groups + 1) {
    throw new Error(`Matches returned ${offsets.length} offsets for ${groups} groups`)
  }
  return { mode: 'above', offsets, idx, values, groups }
}
