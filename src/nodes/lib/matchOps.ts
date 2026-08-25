/**
 * A score matrix in, a table of matches out.
 *
 * Headless and pure, `nblastOps.ts`'s arrangement — everything decidable without Pyodide is
 * decided here, and what is left on the other side of the seam is one call.
 *
 * ## Why a table and not a matrix
 *
 * A matrix is the shape for *looking*: the Heatmap draws one, clustering takes one. A table is
 * the shape for *working* — Filter, Sort, Join, Download and Build Network all take one, and
 * none of them takes a matrix. So "the top five matches for each neuron" is a question whose
 * answer wants to be long and thin, one row per match, which is the shape `knnTable` already
 * produces for NBLAST k-NN and the reason the columns are spelled to match it as far as they
 * can be.
 *
 * ## Where the spelling has to diverge from `knnSchema`
 *
 * `knnSchema` emits `queryId` / `targetId` typed as whatever the source's own `neuronId` is,
 * because it is built from two `SkeletonsValue`s and can read their attribute tables. **A
 * matrix has no attribute table.** Its labels are strings — neuron ids as text when nobody
 * picked a Label by, and cell types when somebody did — and there is nothing anywhere to say
 * which. So the columns here are `query` / `target`, `str`, and that is the honest type
 * rather than a narrowing: re-deriving an `i64` from a label that might read `LC4` would be a
 * column of nulls for every graph that labelled its NBLAST.
 *
 * The `Id` suffix goes with it, and deliberately. `isIdentifierColumn` reads a name's last
 * word to decide whether a *number* is an identifier or a quantity; these are never numbers,
 * so the suffix would buy nothing and would promise a dtype the column does not have.
 */

import type { Warner } from '../../core/limits'
import { CRASH_FLOOR_CELLS, refuseIfOverCrashFloor } from '../../core/limits'
import type { ParamValues } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { CellValue, MatrixValue, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import type { MatchCutoff, MatchMode, MatchesRequest, MatchesResult } from '../../pyodide/matches'

/** Which way round the scores run, and where the answer comes from when nobody said. */
export type MatchDirection = 'auto' | 'higher' | 'lower'

export const MATCH_MODES = [
  { value: 'top', label: 'top N per neuron' },
  { value: 'above', label: 'everything above a cutoff' },
  { value: 'count', label: 'how many clear a cutoff' },
]

export const MATCH_CUTOFFS = [
  { value: 'threshold', label: 'an absolute score' },
  { value: 'percentage', label: 'within % of each best' },
]

export const MATCH_AXES = [
  { value: '0', label: 'each row (query)' },
  { value: '1', label: 'each column (target)' },
]

export const MATCH_DIRECTIONS = [
  { value: 'auto', label: 'from the matrix' },
  { value: 'higher', label: 'higher is better' },
  { value: 'lower', label: 'lower is better (distances)' },
]

/**
 * Whether lower wins, answered from the matrix unless the node overrides it.
 *
 * `MatrixValue.measure` is the machine-readable half of `valueLabel` and exists precisely so a
 * consumer does not have to special-case per producer. It is optional, and **absent means
 * unknown rather than similarity** — Pivot genuinely cannot say, since its cells are whatever
 * aggregation was picked. So absent falls back to higher-is-better, which is what a score
 * matrix is nine times in ten, and the override is there for the tenth.
 */
export function lowerIsBetter(matrix: MatrixValue, direction: MatchDirection): boolean {
  if (direction === 'higher') return false
  if (direction === 'lower') return true
  return matrix.measure === 'distance'
}

/**
 * Every control on the card, already interpreted.
 *
 * `maxMatches` is deliberately **not** here: it is `MAX_MATCHES` at every call site and always
 * will be, so a field for it is a ceiling a caller could pass that `checkMatchSize` never
 * reasoned about. `matchRequestFrom` writes it directly.
 */
export interface MatchParams {
  mode: MatchMode
  axis: 0 | 1
  direction: MatchDirection
  skipSelf: boolean
  n: number
  cutoff: MatchCutoff
  threshold: number
  percentage: number
}

/**
 * Raw params in, `MatchParams` out — the one place that says what a card's values *mean*.
 *
 * **Both exporters call this too**, which is the whole reason it is here rather than a helper
 * in the node file. `decodeRenames` and `resolveFilters` set the precedent: a param's
 * interpretation lives in `nodes/lib` and the emitters import it, so a notebook cannot come to
 * disagree with the canvas about what a control did. Three transcriptions of `axis` — a string
 * on the card, `0 | 1` in the request — is three places to get the parse wrong, and only one of
 * them has a test.
 */
export function matchParamsFrom(params: ParamValues): MatchParams {
  return {
    mode: String(params.mode ?? 'top') as MatchMode,
    // The card stores an enum, which is text; fastcore's argument is an axis number.
    axis: String(params.axis ?? '0') === '1' ? 1 : 0,
    direction: String(params.direction ?? 'auto') as MatchDirection,
    skipSelf: params.skipSelf !== false,
    n: Number(params.n ?? 5),
    cutoff: String(params.cutoff ?? 'threshold') as MatchCutoff,
    threshold: Number(params.threshold ?? 0.5),
    percentage: Number(params.percentage ?? 0.05),
  }
}

/**
 * How many groups a run produces, and how many candidates each has to choose from.
 *
 * The pair is worth naming because getting them the wrong way round is invisible: `axis=0`
 * groups by *row* and matches along the columns, so on a 500 x 12 matrix it is 500 groups of
 * at most 12 — and asking for the top 20 of those is the error `clampN` exists to prevent.
 */
export function groupsAndCandidates(matrix: MatrixValue, axis: 0 | 1): [number, number] {
  return axis === 0
    ? [matrix.rowLabels.length, matrix.colLabels.length]
    : [matrix.colLabels.length, matrix.rowLabels.length]
}

/**
 * `n` cut down to what the matrix can actually offer.
 *
 * fastcore raises when `n` exceeds the scanned axis, and a raise here would be a stack trace
 * about an argument the user cannot see — they set "top 20" on a card that has no idea how
 * wide the matrix is until it runs. Clamped and reported instead: `matchIssues` says so at
 * edit time, where the matrix's shape is not yet known, and `evaluate` warns with the real
 * numbers once it is.
 *
 * `skipSelf` takes one of the candidates away on a square matrix, which is why it is here
 * rather than at the call site — it is the same off-by-one either way.
 */
export function clampN(n: number, candidates: number, skipSelf: boolean): number {
  return Math.max(1, Math.min(n, Math.max(1, candidates - (skipSelf ? 1 : 0))))
}

/**
 * Refuse a self-skip the matrix cannot define.
 *
 * fastcore's `skip_self=True` means *the diagonal*, so on a rectangular matrix there is no
 * such cell — and on a square one built from two different neuron sets there is a cell but it
 * is not a self-match. The first is refused here because it would raise inside Python with a
 * message about shapes; the second cannot be detected at all, and the param's help says so.
 */
export function checkSkipSelf(matrix: MatrixValue, skipSelf: boolean): void {
  if (!skipSelf) return
  if (matrix.rowLabels.length === matrix.colLabels.length) return
  throw new Error(
    `"Skip self-matches" means the diagonal, and this matrix is ` +
      `${matrix.rowLabels.length} x ${matrix.colLabels.length} — it has no diagonal to skip. ` +
      'Turn it off, or wire in an all-by-all.',
  )
}

/**
 * The request, with the scores **copied**.
 *
 * `callPython` transfers every typed array in a call's arguments, so passing the matrix's own
 * buffer would detach it — and that buffer is the scheduler's cached result for the node
 * above, which would come back empty on the next render with nothing to connect it to this
 * node. Exactly the trap `LinkageRequest.scores` records, and the same answer.
 */
export function matchRequestFrom(matrix: MatrixValue, params: MatchParams): MatchesRequest {
  const [, candidates] = groupsAndCandidates(matrix, params.axis)
  return {
    scores: matrix.values.slice(),
    rows: matrix.rowLabels.length,
    cols: matrix.colLabels.length,
    mode: params.mode,
    axis: params.axis,
    distances: lowerIsBetter(matrix, params.direction),
    skipSelf: params.skipSelf,
    n: clampN(params.n, candidates, params.skipSelf),
    cutoff: params.cutoff,
    threshold: params.threshold,
    percentage: params.percentage,
    maxMatches: MAX_MATCHES,
  }
}

// ---------------------------------------------------------------------------
// Schema half and value half — invariant 3
// ---------------------------------------------------------------------------

/**
 * The columns each mode produces.
 *
 * Two shapes, not three: `top` and `above` differ in *how many* rows a group gets and not in
 * what a row says, so they share a schema. `count` is one row per group and has no target to
 * name, which is the whole point of it — a cutoff you are still choosing is a question about
 * sizes rather than about neurons.
 *
 * `matchTable` below must agree with this. `matchOps.test.ts` asserts it does, for every mode.
 */
export function matchSchema(mode: MatchMode): TableSchema {
  if (mode === 'count') {
    return tableSchema(column('query', 'str'), column('matches', 'i64'))
  }
  return tableSchema(
    column('query', 'str'),
    column('target', 'str'),
    column('rank', 'i64'),
    column('score', 'f64'),
  )
}

/*
 * The value column is called `score` whatever the matrix called its cells, and that is a
 * decision rather than an oversight.
 *
 * `MatrixValue.valueLabel` is right there — `NBLAST score` off the NBLAST node, `count` off a
 * Pivot — and naming the column after it was the first shape. It breaks invariant 3: the label
 * is *data*, decided by the run, so `inferOutputs` cannot know it, and a schema promising
 * `score` while the run produced `nblastScore` breaks every downstream column picker the
 * moment somebody presses Run. The notebook exporter cannot know it either, so the two would
 * have drifted a second way.
 *
 * `score` also matches `knnSchema`, which means the two match tables Coda produces are
 * interchangeable everywhere that addresses a column by name.
 */

/**
 * One row per match, best first.
 *
 * **Padding is dropped**, `knnTable`'s rule and for its reason: `top_matches` fills a short
 * group with `-1` and NaN to keep the two arrays rectangular, and carrying that through would
 * put a match called -1 with a score of NaN in front of somebody. What is left is a group with
 * fewer than `n` rows, which is the honest artefact.
 *
 * `rank` is 1-based, so the best match reads as rank 1.
 */
export function matchTable(matrix: MatrixValue, result: MatchesResult, axis: 0 | 1): TableValue {
  // The group is whichever axis was scanned and the match is the other one — which is the one
  // thing about `axis` that has to be right in two places at once, so it is derived here from
  // the same expression the request used.
  const groupLabels = axis === 0 ? matrix.rowLabels : matrix.colLabels
  const matchLabels = axis === 0 ? matrix.colLabels : matrix.rowLabels

  if (result.mode === 'count') {
    const query: CellValue[] = []
    const matches: CellValue[] = []
    for (let g = 0; g < result.groups; g++) {
      query.push(groupLabels[g] ?? null)
      matches.push(result.counts[g]!)
    }
    return makeTable(matchSchema('count'), { query, matches })
  }

  /*
   * The four columns are built directly rather than through `tableFromRows`, which is the one
   * place in this file where the shape of the loop is about size rather than about clarity.
   * `tableFromRows`' own docstring says it is "not hot paths", and this is the hottest: `above`
   * mode is bounded only by `MAX_MATCHES`, which is sixteen million. A row object per match is
   * ~50 bytes of transient garbage each, so at the ceiling the *intermediate* would be larger
   * than the crash floor the ceiling was derived from — and it would be thrown away
   * immediately, since `tableFromRows` then re-walks every row by string key to build exactly
   * these four arrays.
   *
   * Sized up front from the exact upper bound each mode knows, so nothing reallocates while it
   * fills. Padding still shortens the result, which is why the arrays are pushed into rather
   * than indexed.
   */
  const capacity = result.mode === 'top' ? result.groups * result.n : result.idx.length
  const query: CellValue[] = new Array<CellValue>(capacity)
  const target: CellValue[] = new Array<CellValue>(capacity)
  const rank: CellValue[] = new Array<CellValue>(capacity)
  const score: CellValue[] = new Array<CellValue>(capacity)
  let kept = 0

  const take = (group: number, at: number, place: number): void => {
    const match = result.idx[at]!
    if (match < 0) return
    const value = result.values[at]!
    if (!Number.isFinite(value)) return
    query[kept] = groupLabels[group] ?? null
    target[kept] = matchLabels[match] ?? null
    rank[kept] = place
    score[kept] = value
    kept++
  }

  if (result.mode === 'top') {
    for (let g = 0; g < result.groups; g++) {
      for (let i = 0; i < result.n; i++) take(g, g * result.n + i, i + 1)
    }
  } else {
    for (let g = 0; g < result.groups; g++) {
      const from = result.offsets[g]!
      const to = result.offsets[g + 1]!
      for (let at = from; at < to; at++) take(g, at, at - from + 1)
    }
  }

  // Trimmed once at the end rather than pushed one at a time: the padding is a minority of the
  // rows in every real case, so this is one copy against `capacity` reallocation steps.
  if (kept < capacity) {
    query.length = kept
    target.length = kept
    rank.length = kept
    score.length = kept
  }
  return makeTable(matchSchema(result.mode), { query, target, rank, score })
}

// ---------------------------------------------------------------------------
// Ceilings and edit-time issues
// ---------------------------------------------------------------------------

/**
 * The ceiling `matches_above` needs, because it is the one mode whose output size is not
 * bounded by anything on the card.
 *
 * `top` produces at most `groups × n` rows and `count` exactly `groups`; a threshold of zero
 * on a similarity matrix produces *every cell*, which for a 5,000-neuron all-by-all is
 * twenty-five million rows. fastcore takes `max_matches` for exactly this and raises rather
 * than allocating, which is the right half of the answer — this is the other half, choosing a
 * number and saying what it means.
 *
 * Set from the same allocation floor everything else here uses rather than from a guess: a
 * match is four cells, so this is the point at which the *table* would be the thing that
 * fails rather than the search.
 */
export const MAX_MATCHES = Math.floor(CRASH_FLOOR_CELLS / 4)

export function checkMatchSize(ctx: Warner, matrix: MatrixValue, params: MatchParams): void {
  if (params.mode !== 'top') return
  const [groups, candidates] = groupsAndCandidates(matrix, params.axis)
  const n = clampN(params.n, candidates, params.skipSelf)
  refuseIfOverCrashFloor(`${groups.toLocaleString()} × ${n} matches`, groups * n * 4 * 8)
  if (n < params.n) {
    ctx.warn(
      `Asked for the top ${params.n} but this matrix offers only ${candidates.toLocaleString()} ` +
        `per group${params.skipSelf ? ' before the self-match is skipped' : ''}, so it ` +
        `returned ${n}.`,
    )
  }
}

/** What the node warns about at edit time, where the matrix's shape is not yet known. */
export function matchIssues(params: MatchParams): string[] {
  const banded = params.mode !== 'top' && params.cutoff === 'percentage'
  return banded && (params.percentage < 0 || params.percentage > 1)
    ? ['Percentage is a fraction in 0–1, not a percent — 0.05 keeps within 5% of each best']
    : []
}
