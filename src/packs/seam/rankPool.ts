/**
 * Order one open end's candidates — the half of SEAM's stage 5 that is no longer in the worker.
 *
 * The pool crosses the bridge unranked (`runCandidatePool`), its two size features arrive from a
 * second crossing (`runPoolSizes`), and what is left is the part SEAM used to do in three lines
 * of pandas: score the pool, sort it, cut it to `top_k` and number it from one. That moved here
 * with the scoring, because the scoring had to move — LightGBM has no Pyodide build, which
 * `treeRanker.ts` argues at length.
 *
 * ## The sign, which is the one thing here that fails silently
 *
 * `geo_score` is a **rank key: lower is better**, and `geo_rank` ascends with it. That was true
 * of the logistic fit, where the column was `-score`, and it is still true of the forest — not
 * from the manifest, whose `pipeline.search.ranker.score` line reads "the booster's raw score"
 * and so points the other way, but from the set's own published numbers: on
 * `rv2-20483049f936`, `searchEnd.json`'s nine rows ascend from −1.5297 at rank 1 to +2.8554 at
 * rank 8, cut straight out of SEAM's `candidates_all.parquet` with nothing negated on the way.
 *
 * Taking the raw score and sorting it the other way gives a list that is exactly reversed, with
 * every number plausible and every rank wrong — nothing downstream can see it, and the whole
 * point of `pnpm probe:candidate-search` comparing against a real end's published ranks is to
 * catch precisely this. So `rankKey`, which is `-scoreRow`, and ascending.
 *
 * ## Ties
 *
 * SEAM's `sort_values` is pandas' default quicksort, which is **not** stable, so two candidates
 * on the same score may be ordered either way there. This sorts stably, breaking a tie by the
 * pool's own order, which makes Coda's answer reproducible without making it SEAM's: a tie is a
 * place the two may legitimately disagree, and the probe counts how often that happens rather
 * than treating it as a defect.
 */

import { orderByScores } from '../../nodes/lib/matrixShape'
import type { CandidatePool } from '../../pyodide/cutoutSummary'
import type { Pool, TreeRanker } from './treeRanker'
import { rankKeys } from './treeRanker'

function refuse(why: string): never {
  throw new Error(`seam candidate rank: ${why}`)
}

/**
 * What a measured pool looks like here — `CandidatePool` minus the fields this does not read.
 *
 * `Pick` rather than a hand-written copy, which is the convention `ownTip.ts` set beside it: a
 * column added to `CandidatePool` then reaches both files the same way.
 */
export type MeasuredPool = Pick<CandidatePool, 'rows' | 'candRoot' | 'columns'>

/** One end's candidates, ranked, cut and numbered — the shape stage 6 onwards reads. */
export interface RankedPool {
  /** How many survived the cut: `min(topK, pool.rows)`. */
  readonly rows: number
  /** The candidate of each row, in the new order, 64-bit. */
  readonly candRoot: BigUint64Array
  /**
   * Every column the pool carried, gathered into the new order, plus `l2c`, `l2x`, `geo_score`
   * and `geo_rank` — by SEAM's own names, because `ownTip.ts` and everything after it read them
   * that way and a second spelling here would be a transliteration at every call site.
   */
  readonly columns: Readonly<Record<string, Float64Array>>
}

/** Columns this mints, which the pool may therefore not already carry. */
const MINTED = ['geo_score', 'geo_rank'] as const

/**
 * Score, sort, cut and number one measured pool.
 *
 * `topK` is the set's own `pipeline.search.top_k` (SEAM keeps 100) — **read from the manifest**,
 * not defaulted here, for the reason the ranker itself is: the cut is part of what the stages
 * after it were fitted against, and a different one gives lists the published cutoffs no longer
 * describe.
 */
export function rankPool(ranker: TreeRanker, pool: MeasuredPool, topK: number): RankedPool {
  if (!Number.isInteger(topK) || topK < 1) {
    refuse(`a cut of ${topK}, where the set's \`top_k\` is a positive whole number`)
  }
  const { rows, candRoot, columns } = pool
  if (candRoot.length !== rows) {
    refuse(`the pool says ${rows} rows and its candidate ids number ${candRoot.length}`)
  }
  /*
   * A pool that already carried one of these arrived ranked — which is what the old one-call
   * bridge returned. Overwriting it quietly would score an already-cut list a second time: a
   * hundred rows the *old* ranker chose, renumbered by the new one, every number believable and
   * the set wrong. It is the exact failure the three-part split was made to avoid, so it is
   * refused rather than merged over.
   */
  for (const name of MINTED) {
    if (columns[name])
      refuse(`the pool already carries \`${name}\`, so it has been ranked once`)
  }

  /*
   * **This file names no feature, and that is deliberate.** `rankKeys` refuses a column that is
   * missing or the wrong length by the model's own name for it, the gather walks whatever the
   * pool carries, and the ordering is borrowed — so a refit that adds a twelfth feature is no
   * change here. `l2c` and `l2x` arriving by a second crossing is a fact about the *fetch*
   * sequence, and it lives in `searchRun.ts`, which is what joins them in.
   */
  const scored: Pool = { rows, columns }
  const keys = rankKeys(ranker, scored)

  /*
   * **The repo's ordering, not this file's.** `orderByScores` is ascending here and stable, so
   * equal keys keep the pool's own order; `stages.ts` in this pack calls it for the same reason
   * and its comment says the tie rule is deliberately not any one file's.
   *
   * It also sinks anything non-finite, where a hand-written `keys[a] - keys[b] || a - b` would
   * float it: `NaN` is falsy, so the comparator falls through to arrival order. That cannot
   * happen with this format — a key is a sum of leaf values and `missing_type = None` turns an
   * absent feature into zero before the walk, so no row scores `NaN` — which is why there is no
   * test for it here. The point of borrowing the helper is that the pack states the rule once.
   */
  const kept = orderByScores(keys, false).subarray(0, Math.min(topK, rows))

  /*
   * Every allocation below is `kept.length`, so the cut happens before the gather, not after.
   *
   * **Checked, including the columns the model does not read.** `rankKeys` guards the eleven
   * features by name, and nothing guarded the rest — but the gather reads `column[from]` for a
   * row index drawn from the *pool's* length, so a short `contact_x_nm` yields `undefined` and
   * the gathered column is the right length full of `NaN`. Downstream that passes every check
   * there is: `ownTipRule`'s own length test sees a column as long as the list, and then
   * decides the candidate from a contact at `(NaN, NaN, NaN)`.
   */
  const out: Record<string, Float64Array> = {}
  for (const [name, column] of Object.entries(scored.columns)) {
    if (column.length !== rows) {
      refuse(`the pool says ${rows} rows and its \`${name}\` column has ${column.length}`)
    }
    out[name] = Float64Array.from(kept, (from) => column[from]!)
  }
  /*
   * `-0` flattened to `0`. The key is `-scoreRow`, so a candidate every tree sent to a zero leaf
   * comes out as negative zero — which sorts and compares exactly like zero and then prints as
   * "-0" in a table, the one place it is visible and the one place it is wrong. `Object.is`
   * rather than `|| 0`, which would also swallow a NaN.
   */
  out['geo_score'] = Float64Array.from(kept, (from) =>
    Object.is(keys[from], -0) ? 0 : keys[from]!,
  )
  // 1-based, as the set's own is.
  out['geo_rank'] = Float64Array.from(kept, (_, at) => at + 1)
  return {
    rows: kept.length,
    candRoot: BigUint64Array.from(kept, (from) => candRoot[from]!),
    columns: out,
  }
}
