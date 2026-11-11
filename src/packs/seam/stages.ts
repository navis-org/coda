/**
 * Stages 7–9: from a tip's scored candidates to "show this one, and how often that is right".
 *
 * The arithmetic at the end of SEAM's pipeline, and the only part of it with no model in it. A
 * list of candidates arrives carrying the assessor's logit per seed; what comes out is a ranked
 * list, a probability for the tip, and a decision against the cutoff the set itself publishes.
 *
 * ## Why this is TypeScript and not vendored Python
 *
 * Every other piece of SEAM that Coda runs is vendored whole (`src/pyodide/seam`), because a
 * window built slightly differently still scores and a patch cut half a voxel over still looks
 * like a patch. This is the one stage where that argument does not hold, for two reasons.
 *
 * It is **a table operation on a table the node already has** — a few multiplications per row —
 * so putting it in a worker would mean a round trip through Pyodide to compute a softmax, on the
 * main-thread path a card redraws from.
 *
 * And the drift it could suffer is **visible**. SEAM publishes the answers: `tips.parquet` and
 * `candidates.parquet` carry `logit`, `p_cand`, `conf`, `segclr`, `p_tip`, `p_top`, `p_split`,
 * `q_ref`, `q`, `shown` and `r` for every row of a real set. `stages.test.ts` recomputes all of
 * them from the stored inputs and compares, which is a stronger check than a byte comparison of
 * source: it checks the numbers, on real data, at every stage. The worst difference is 3.6e-15,
 * on `conf_logit`, which sums fifteen fits; `stages.test.ts` holds the figure per stage.
 *
 * **Not "it meets SEAM's own 2e-16 bar"**, which this file used to say. SEAM's
 * `checks_largest_difference` records nine quantities and `conf_logit` is not among them, so
 * there is no published bar for the one quantity that is furthest out — and a reader who went
 * looking would measure 3.6e-15 against a number meant for something else and read a regression
 * into a difference of summation order.
 *
 * ## Every number comes from the set
 *
 * Nothing here is a constant. The fits, the floors, the cutoff and the isotonic steps are read
 * from the set's own manifest (`parsePipelineFits`), because SEAM refits them whenever a stage
 * changes — the cutoff moved from 0.208 to 0.153 when the split stage was adopted and again to
 * 0.146 in the `za` refit, inside a week. A number written here would be right on the day it was
 * written and quietly wrong afterwards, and "quietly" is the whole difficulty: every one of
 * these produces a plausible probability either way.
 *
 * ## What a live tip can and cannot reach
 *
 * `q` is `p_tip × p_split`, and `p_split` comes from the **EM-texture head**, which SEAM
 * publishes as data (`candidates.parquet`'s `head_s<k>`) and not as a model. So a tip read out
 * of a published set reaches `q` and `shown`; a tip searched and scored live in the browser
 * reaches `q_ref` — SEAM's own pre-split quantity — and stops.
 *
 * That is one shape and not two: `scoreList` computes split's half only when the head scores are
 * there, and `decideTip` says **which quantity it decided on** (`against`). A reader is never
 * shown a number that looks like `q` and is not.
 */

import { logistic, lowerBound } from '../../core/stats'
import { orderByScores } from '../../nodes/lib/matrixShape'
import { REF_WIDTH, SPLIT_WIDTH } from './suggestionSet'
import type { DisplaySteps, PipelineFits, SeedFit } from './suggestionSet'

/**
 * One tip's candidates, by column rather than by row.
 *
 * Columns because that is how both callers hold them — a published set is parquet columns, and a
 * live search publishes the same shape — and because a hundred small objects per tip would be
 * allocated and thrown away on every redraw.
 *
 * `assessor[k][i]` is seed `k`'s logit for candidate `i`. Seed-major, so that one seed's column
 * arrives as one array from a file and from a model run alike. **A seed is its position** here
 * and in every fit the manifest carries, which `parsePipelineFits` checks rather than assumes:
 * a fold listed out of order would otherwise score each seed against another seed's weights, and
 * every logit would still be a logit.
 */
export interface CandidateList {
  readonly geoRank: readonly number[]
  readonly volUm3: readonly number[]
  /** The assessor's logit per seed, seed-major. One row per seed of the set's `ref` fit. */
  readonly assessor: readonly (readonly number[])[]
  /**
   * The EM-texture head's logit per seed, where the set publishes it.
   *
   * Absent on a live tip, which is a state rather than a failure: see the header. Present, it
   * must have the same seeds and the same length as `assessor`.
   */
  readonly head?: readonly (readonly number[])[]
}

/** What stage 7 makes of one list. */
export interface ListScores {
  /** Each seed's ref logit per candidate, seed-major — SEAM's `logit_s<k>`. */
  readonly logitPerSeed: readonly Float64Array[]
  /** The seed mean, which is what ranks the list — SEAM's `logit`. */
  readonly logit: Float64Array
  /** Each candidate's share of the list under `logit` — SEAM's `p_cand`. */
  readonly pCand: Float64Array
  /** 1-based, by `logit` descending, ties by list order — SEAM's `rank`. */
  readonly rank: Int32Array
  /** Where ref's first candidate is, or `-1` for an empty list. */
  readonly first: number
  /** `pCand[first]`, ref's own confidence in its first candidate — SEAM's `p_top`. */
  readonly pTop: number
  /** Each seed's best logit in the list, averaged — SEAM's `segclr`, the tip's feature. */
  readonly segclr: number
  /** The confidence model's logit per candidate, where the head scores were given. */
  readonly confLogit: Float64Array | undefined
  /** Each candidate's share under the confidence model — SEAM's `p_conf`. */
  readonly pConf: Float64Array | undefined
  /**
   * `pConf[first]` — SEAM's `p_split`.
   *
   * Undefined where there is **no first candidate** as well as where there are no head scores:
   * an empty list has a `pConf` of length zero, so the two states are not the same one.
   */
  readonly pSplit: number | undefined
}

/** What stages 8 and 9 make of one tip. */
export interface TipDecision {
  /** The chance this tip is a false split at all — SEAM's `p_tip`. */
  readonly pTip: number
  /** `pTip × pTop`: the pre-split quantity, always computable. SEAM's `q_ref`. */
  readonly qRef: number
  /** `pTip × pSplit` — SEAM's `q`. Undefined with no head scores, and on an empty list. */
  readonly q: number | undefined
  /**
   * Which quantity the decision was made on, against which published cutoff, and what it said.
   *
   * `undefined` means **no decision**, not "not shown": the set publishes no cutoff for the
   * quantity this tip could reach. Drawn as "no verdict", never as a rejection.
   */
  readonly against: DecisionBasis | undefined
}

/** The quantity a decision was made on, the cutoff it met, and what it said. */
export interface DecisionBasis {
  readonly quantity: 'q' | 'q_ref'
  readonly score: number
  readonly cutoff: number
  /**
   * **A word, not a boolean**, because the field above it is optional and `against?.shown` is
   * falsy for a withheld tip *and* for one nothing decided. Those are the two states this shape
   * exists to keep apart, and a boolean puts the misreading one character away. `?.verdict`
   * cannot answer a verdict where there was none.
   */
  readonly verdict: 'shown' | 'withheld'
  /**
   * The share of shown firsts that are right at this score — SEAM's `r`.
   *
   * On the basis rather than on the tip, and `undefined` on the `q_ref` arm, because the
   * isotonic steps were fitted **against `q`**. As a number on the tip, `0` would have meant
   * three things at once: an empty list, a quantity the steps were never fitted for, and a
   * genuine measured zero.
   */
  readonly r: number | undefined
}

/**
 * A logistic fit applied to one design matrix row, standardised the way it was fitted.
 *
 * `((x - mu) / sd) · w`, which is the form every fit in the manifest states. Written once because
 * ref and split differ only in how many columns they put in, and a second copy is how the two
 * come to standardise differently.
 */
function fitLogit(fit: SeedFit, row: Float64Array, width: number): number {
  let total = 0
  for (let i = 0; i < width; i++) total += ((row[i]! - fit.mu[i]!) / fit.sd[i]!) * fit.w[i]!
  return total
}

/**
 * One model score as it enters a fit.
 *
 * **The clip is applied only where the set declares one.** SEAM added `score_clip` after one raw
 * logit of 22,652 flattened a seed's weight, and a set written before that has none — so a fixed
 * ±20 here would silently disagree with every number such a set publishes. Read, never assumed.
 */
function clipped(score: number, clip: number | undefined): number {
  return clip === undefined ? score : Math.min(Math.max(score, -clip), clip)
}

/**
 * Softmax within one list, shifted by the maximum.
 *
 * The shift is not a nicety: a ref logit of 40 is ordinary and `Math.exp(40)` is 2.4e17, so the
 * sum overflows to `Infinity` long before any individual term does and every share comes back
 * `NaN`. SEAM's own `probs` subtracts the per-list maximum for the same reason.
 */
function softmax(logit: Float64Array): Float64Array {
  const out = new Float64Array(logit.length)
  if (logit.length === 0) return out
  let top = -Infinity
  for (let i = 0; i < logit.length; i++) if (logit[i]! > top) top = logit[i]!
  let total = 0
  for (let i = 0; i < logit.length; i++) {
    out[i] = Math.exp(logit[i]! - top)
    total += out[i]!
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total
  return out
}

export class StageInputError extends Error {}

/**
 * Stage 7: rank one tip's candidates, and work out ref's confidence in its first.
 *
 * **An empty list is an answer, not a failure.** The own-tip rule takes candidates away — a tip
 * whose every candidate belongs to a nearer tip of the same neuron keeps none — so `first` is
 * `-1`, `pTop` is 0 and `segclr` is the set's floor. SEAM scores such a tip at the floor rather
 * than dropping it, and a dropped tip is one nobody is told about.
 */
export function scoreList(list: CandidateList, fits: PipelineFits): ListScores {
  const n = list.geoRank.length
  if (list.volUm3.length !== n) {
    throw new StageInputError(
      `A candidate list has ${n} ranks and ${list.volUm3.length} volumes; they are columns of one table.`,
    )
  }
  const seeds = fits.ref.length
  if (list.assessor.length !== seeds) {
    throw new StageInputError(
      `This set's ref fit has ${seeds} seeds and the list carries ${list.assessor.length} ` +
        'assessor columns. A seed missing here is a mean over the wrong number of scores, which ' +
        'is still a number.',
    )
  }
  if (list.head && list.head.length !== seeds) {
    throw new StageInputError(
      `The head scores cover ${list.head.length} seeds and ref's fit has ${seeds}.`,
    )
  }
  /*
   * Every score column, in one loop. The head's columns were checked for *count* and not for
   * length until a review asked why: a short head column reads `undefined` into the fit, and
   * `NaN` through a softmax makes every share `NaN` — a tip whose confidence is not a number
   * rather than one that refuses.
   */
  for (const [k, column] of [...list.assessor, ...(list.head ?? [])].entries()) {
    if (column.length !== n) {
      const which = k < seeds ? `Seed ${k}'s assessor` : `The head's seed ${k - seeds}`
      throw new StageInputError(
        `${which} column has ${column.length} scores for ${n} candidates.`,
      )
    }
  }
  /*
   * Split's half as **one** optional thing rather than three.
   *
   * The head's columns and the set's fold fits are needed together or not at all, and when they
   * were two `undefined`s plus a derived array the loop had to re-assert both — `list.head![k]!`
   * on a presence the type had already lost. One object carries them, so the guard below is one
   * test and the columns come out of it typed.
   */
  const split =
    list.head && fits.split
      ? {
          folds: fits.split,
          head: list.head,
          out: new Float64Array(n),
          // Loop-invariant: the same sum of fold lengths for every candidate in the list.
          fits: fits.split.reduce((total, fold) => total + fold.length, 0),
        }
      : undefined

  /*
   * One pass over the candidates, with **one row reused** for every fit.
   *
   * The arithmetic is what it was and the loop order is what it was; what has gone is the row
   * per fit. Ref asks three fits per candidate and split asks fifteen (five folds × three
   * seeds), each of which used to allocate a fresh array and recompute `Math.log(vol)` — so a
   * published set of 100,000 candidates built 1.8 million short-lived arrays and took eighteen
   * logarithms of every volume.
   *
   * Measured over a set of that shape (2,700 tips × 37 candidates, 3 seeds, 5 folds, median of
   * nine passes), the logits alone: **54.6 ms to 20.7 ms, and the worst difference between the
   * two is 0** — not "within tolerance", the same floats. The fold-major order is kept for the
   * sake of that zero: a sum reordered is a sum that lands on a different float.
   *
   * **Nothing further was done, and the number says why.** The whole of `scoreList` over that set
   * is 52.2 ms, so what is left is mostly the comparator sort below — but a *tip* is one list of
   * about 37 candidates, which is 19 µs, and a whole-set pass happens beside a parquet fetch of
   * several megabytes. A review measured a gated insertion sort at a few milliseconds better; it
   * was declined because it puts the tie rule back into two statements, which is what the block
   * below exists to prevent, for a saving nothing can perceive.
   */
  /*
   * One buffer for every seed's column, handed out as views. Three allocations a list became one,
   * which is 1.2 ms of the 33 over a published set — small, and free: `logitPerSeed` is still
   * `Float64Array[]` to everyone outside, and a `subarray` is a window on the same bytes.
   */
  const columns = new Float64Array(seeds * n)
  const logitPerSeed = Array.from({ length: seeds }, (_, k) =>
    columns.subarray(k * n, (k + 1) * n),
  )
  const logit = new Float64Array(n)
  const row = new Float64Array(SPLIT_WIDTH)
  const scores = new Float64Array(seeds)
  for (let i = 0; i < n; i++) {
    // **`-geoRank`, not `geoRank`.** The search ranks 1 as best and the fit wants a feature that
    // grows with goodness; the sign is in the design SEAM states, not an accident of either side.
    row[0] = -list.geoRank[i]!
    row[1] = Math.log(list.volUm3[i]!)
    let mean = 0
    for (let k = 0; k < seeds; k++) {
      scores[k] = clipped(list.assessor[k]![i]!, fits.scoreClip)
      row[2] = scores[k]!
      const one = fitLogit(fits.ref[k]!, row, REF_WIDTH)
      logitPerSeed[k]![i] = one
      mean += one
    }
    logit[i] = mean / seeds
    if (!split) continue
    let total = 0
    for (const fold of split.folds) {
      for (let k = 0; k < fold.length; k++) {
        row[2] = scores[k]!
        row[3] = split.head[k]![i]!
        total += fitLogit(fold[k]!, row, SPLIT_WIDTH)
      }
    }
    split.out[i] = total / split.fits
  }

  /*
   * One statement of the tie rule, and it is **not this file's**.
   *
   * `orderByScores` is the repo's: descending, stable so equal scores keep their arrival order,
   * anything non-finite last. Stability is what matters here — it is pandas' `method='first'` on
   * a descending rank, which is what SEAM's `idxmax` and `rank` both do, and the list arrives in
   * `geo_rank` order, so a tie resolved the other way would hand the decision to the
   * geometrically worse of two identical scores. The non-finite rule is the part a hand-written
   * comparator gets wrong: `logit[b] - logit[a]` is `NaN` for a `NaN` logit, which is falsy, so a
   * candidate whose logit is not a number could take rank 1 and be published with a `p_top`.
   *
   * `first` is read off the same order rather than scanned for separately: `p_top` and `q` follow
   * `first` while the table a reader sees follows `rank`, so two statements drifting apart would
   * publish a probability belonging to a candidate that is not the one shown at rank 1.
   */
  const order = orderByScores(logit)
  const rank = new Int32Array(n)
  for (let place = 0; place < n; place++) rank[order[place]!] = place + 1
  const first = n === 0 ? -1 : order[0]!

  const pCand = softmax(logit)

  /*
   * The tip's SegCLR feature: each seed's best logit in the list, then the mean over seeds. The
   * order is load-bearing — the mean of the maxima is not the maximum of the means, and the two
   * differ most on exactly the lists where the seeds disagree, which are the interesting ones.
   */
  let segclr = fits.segclrFloor
  if (n > 0) {
    let total = 0
    for (const column of logitPerSeed) {
      let best = -Infinity
      for (let i = 0; i < n; i++) if (column[i]! > best) best = column[i]!
      total += best
    }
    segclr = total / seeds
  }

  const pConf = split ? softmax(split.out) : undefined

  return {
    logitPerSeed,
    logit,
    pCand,
    rank,
    first,
    pTop: first < 0 ? 0 : pCand[first]!,
    segclr,
    confLogit: split?.out,
    pConf,
    pSplit: pConf && first >= 0 ? pConf[first]! : undefined,
  }
}

/**
 * Stages 8 and 9: the tip's own probability, and the decision.
 *
 * `eTip` is Model E's answer near the tip. **Pass `undefined` where it found no cell**, and the
 * set's `model_e.e_tip_floor` is substituted here — the value SEAM's own fit saw for "nothing
 * near", not a neutral one. Leaving that to the caller is what `segclrFloor` deliberately does
 * not do two functions up, and the first reader of Model E who forgot would get a plausible
 * `p_tip` for every tip with no cell nearby.
 */
export function decideTip(
  scores: ListScores,
  eTip: number | undefined,
  fits: PipelineFits,
): TipDecision {
  const e = eTip ?? fits.eTipFloor
  const pTip = logistic(fits.pTip[0]! + fits.pTip[1]! * scores.segclr + fits.pTip[2]! * e)
  const qRef = pTip * scores.pTop
  const q = scores.pSplit === undefined ? undefined : pTip * scores.pSplit

  /*
   * The decision is made on `q` where the head reached it and on `q_ref` otherwise, and only
   * against a cutoff the set publishes for that quantity. A set that publishes none for `q_ref`
   * — which is every set so far, since SEAM states it in prose — leaves a live tip with a number
   * and no verdict. That is the honest answer: a cutoff carried over from the other quantity
   * would decide a different question with the same confidence.
   *
   * `r` rides on the basis rather than on the tip, and only on the `q` arm, because the steps
   * were fitted against `q`. An empty list has no first candidate to be right about, so it has
   * no `r` either — which is a third thing a bare `0` used to mean.
   */
  if (q !== undefined) {
    const r = scores.first < 0 ? undefined : applySteps(fits.steps, q)
    return { pTip, qRef, q, against: basis('q', q, fits.cutoff, r) }
  }
  const against =
    fits.cutoffRef === undefined ? undefined : basis('q_ref', qRef, fits.cutoffRef, undefined)
  return { pTip, qRef, q, against }
}

function basis(
  quantity: DecisionBasis['quantity'],
  score: number,
  cutoff: number,
  r: number | undefined,
): DecisionBasis {
  return { quantity, score, cutoff, verdict: score >= cutoff ? 'shown' : 'withheld', r }
}

/**
 * The isotonic display steps: the share of shown firsts that are right at this score.
 *
 * A step function, so a reader sees the same number for a band of scores rather than a spurious
 * third decimal — SEAM fitted it that way deliberately. The clip keeps it off 0 and 1, which no
 * finite sample earns.
 *
 * `lowerBound` rather than a scan of its own: that is `src/core/stats.ts`' statement of "the
 * first index not below the target", which is `np.searchsorted`'s left side and so SEAM's own
 * `apply_steps`. A second hand-written boundary is the kind that reads a share one step out.
 */
function applySteps(steps: DisplaySteps, score: number): number {
  const value = steps.r[Math.min(lowerBound(steps.q, score), steps.r.length - 1)]!
  return Math.min(Math.max(value, steps.clip), 1 - steps.clip)
}
