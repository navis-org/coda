/**
 * SEAM's `pipeline` block, read: every frozen number stages 7–9 run on.
 *
 * **One parser, two sources, and that is the whole reason this is its own file.** SEAM writes the
 * same block twice over — in a published suggestion set's manifest (`suggestionSet.ts`, which is
 * how `seam:suggestions` recomputes what it reads) and in a model manifest's `config`
 * (`assessorModel.ts`, which is how `seam:suggestMerges` scores what it searched). The numbers
 * mean the same thing either way, and a second reader of them would be a second place for the
 * design's column order, the seed order and the staircase's direction to be got wrong.
 *
 * It used to live inside `suggestionSet.ts`, where it read as a property of a published run. It is
 * not: it is a property of the **configuration** — which assessor, how many seeds, split or no
 * split — and a configuration can be published as a set of answers or as a model to run.
 *
 * ## Nothing is defaulted, and every refusal names the block
 *
 * SEAM refits these whenever a stage changes: the cutoff moved from 0.208 to 0.153 when the split
 * stage was adopted, again to 0.1177 in the `za` refit, and to 0.1588 for the single-seed
 * configuration — inside a fortnight. A number filled in here would be right on the day it was
 * written and quietly wrong afterwards, and "quietly" is the difficulty: every one of these
 * produces a plausible probability either way.
 *
 * ## One seed or three, written two ways
 *
 * Production states `ref.seeds` as a list, one entry per checkpoint, each tagged with its `k`.
 * The single-seed configuration states `ref.mu` / `ref.sd` / `ref.w` directly, because with one
 * seed there is no average to take and SEAM does not write a list of one. Both are read here, and
 * a bare fit becomes a list of one — so everything downstream addresses a seed by position and
 * has one shape to handle (`stages.ts`).
 */

/**
 * How many columns each design has — ref's three, split's four.
 *
 * Here rather than inside the parser because `stages.ts` builds the row it walks and this is the
 * one statement of how wide it is. The failure these prevent is the quiet one: somebody adds a
 * feature to ref's design, somebody widens the parser and leaves the row at three, and
 * `fitLogit` walks three of four columns — dropping the assessor's own score from every logit,
 * which is the failure `seedFits`' width check exists to prevent, arriving through the check.
 */
export const REF_WIDTH = 3
export const SPLIT_WIDTH = 4

/**
 * One standardised logistic fit, as every block of the manifest states it.
 *
 * `((x - mu) / sd) · w` over the design the stage declares. **A seed is its position** in the
 * list that holds this, which `pipelineFitsFrom` checks: the manifest numbers its seeds and a
 * list out of order would score each seed's logit against another seed's weights.
 */
export interface SeedFit {
  readonly mu: readonly number[]
  readonly sd: readonly number[]
  readonly w: readonly number[]
}

/** The isotonic display steps for `r`: the share right at a score, as a staircase. */
export interface DisplaySteps {
  /** Each step's upper edge in the decided quantity, ascending. */
  readonly q: readonly number[]
  /** The share right in each step. Same length as `q`. */
  readonly r: readonly number[]
  /** How far off 0 and 1 a share is held — no finite sample earns either. */
  readonly clip: number
}

/**
 * Every frozen number stages 7–9 need, read out of a `pipeline` block.
 *
 * All of it is read and none of it defaulted. See the header on why.
 */
export interface PipelineFits {
  /** Ref's fit per seed: `[-geo_rank, log(vol_um3), assessor score]`. */
  readonly ref: readonly SeedFit[]
  /**
   * The confidence model, by fold and then by seed: ref's design plus the head's score.
   *
   * Absent where the block states no `split`, which is the shape of a set made before the
   * confidence model was adopted **and** of the single-seed configuration, which drops split
   * deliberately: its head reads EM, and EM is the expensive read in a browser. Then there is no
   * split quantity at all, and the block's own cutoff is about `p_tip × p_top` — see `decideTip`.
   */
  readonly split: readonly (readonly SeedFit[])[] | undefined
  /**
   * How far a model score is clipped before it enters a fit, where the block declares one.
   *
   * SEAM added this after a raw logit of 22,652 flattened a seed's weight. A set written before
   * it has none, and its published numbers are unclipped — so this is read rather than assumed,
   * and a fixed value here would disagree with every number such a set carries.
   */
  readonly scoreClip: number | undefined
  /** `p_tip`'s three weights: the intercept, then `segclr` and `e_tip`, in that order. */
  readonly pTip: readonly [number, number, number]
  /** What `segclr` is for a tip whose list is empty — the value the fit saw, not a neutral one. */
  readonly segclrFloor: number
  /** What `e_tip` is where Model E found no cell near the tip. Same reasoning. */
  readonly eTipFloor: number
  /**
   * The cutoff on the quantity this configuration decides with.
   *
   * `pipeline.show.cutoff`. Which quantity that is depends on `split`: with a split block it is
   * `p_tip × p_split`, and without one there is no split quantity, so it is `p_tip × p_top`.
   * `decideTip` is where that is read; nothing here has to know.
   */
  readonly cutoff: number
  /**
   * A cutoff on `q_ref` stated separately, where the block carries one.
   *
   * It matters for exactly one case: a **split** configuration whose tips were scored live, so
   * the head's EM was never read and `q` cannot be reached. SEAM states that number in prose
   * ("its cutoff was 0.208"), which is not something to parse, so such a tip gets a number and no
   * verdict. A configuration with no split has no such gap — its own cutoff is the ref one.
   */
  readonly cutoffRef: number | undefined
  readonly steps: DisplaySteps
}

/**
 * Read a `pipeline` block, refusing by name what this build cannot run.
 *
 * `where` names the source in every refusal — a manifest URL, or a model id — because the block
 * is SEAM's and the reader cannot edit it: what they can do is say which set, or which model, or
 * which build of Coda, and all three need the field.
 */
export function pipelineFitsFrom(pipeline: unknown, where: string): PipelineFits {
  const block = asRecord(pipeline, 'pipeline', where)
  const ref = asRecord(block.ref, 'pipeline.ref', where)
  const seeds = refSeeds(ref, where)

  const pTip = asRecord(block.p_tip, 'pipeline.p_tip', where)
  /*
   * The fit's own column list, checked rather than trusted. `apply_fit` multiplies the weights by
   * whatever columns the fit names, so a refit that added a third feature would be applied here
   * as if it had two — the intercept and the first two weights against the wrong columns, which
   * is a probability for every tip and the right one for none.
   */
  const columns = pTip.columns
  if (
    !Array.isArray(columns) ||
    columns.length !== 2 ||
    columns[0] !== 'segclr' ||
    columns[1] !== 'e_tip'
  ) {
    throw new Error(
      `${where}: \`pipeline.p_tip.columns\` is ${JSON.stringify(columns)}, and this build ` +
        'applies the fit on `segclr` and `e_tip`. A refit on other features needs a Coda that ' +
        'knows how to compute them.',
    )
  }
  const weights = numbers(pTip.weights, 'pipeline.p_tip.weights', where)
  if (weights.length !== 3) {
    throw new Error(
      `${where}: \`pipeline.p_tip.weights\` has ${weights.length} numbers, and a fit on ` +
        'two columns has three — the intercept first.',
    )
  }

  const show = asRecord(block.show, 'pipeline.show', where)
  const steps = asRecord(block.r, 'pipeline.r', where)
  const stepsQ = numbers(steps.steps_q, 'pipeline.r.steps_q', where)
  const stepsR = numbers(steps.steps_r, 'pipeline.r.steps_r', where)
  if (stepsQ.length !== stepsR.length || stepsQ.length === 0) {
    throw new Error(
      `${where}: \`pipeline.r\` has ${stepsQ.length} edges and ${stepsR.length} shares. ` +
        'They are one staircase, so a mismatch would read a share at the wrong step.',
    )
  }
  /*
   * **Ascending, because `applySteps` binary-searches it.** `lowerBound` on an unsorted list
   * answers by halving a thing that is not ordered — it returns *an* index, for every input, and
   * the share read off it is a share. The isotonic fit produces an ascending staircase by
   * construction, so this only fires on a file that is not one.
   */
  const outOfOrder = stepsQ.findIndex((edge, at) => at > 0 && edge < stepsQ[at - 1]!)
  if (outOfOrder > 0) {
    throw new Error(
      `${where}: \`pipeline.r.steps_q\` falls at [${outOfOrder}] (${stepsQ[outOfOrder]!} ` +
        `after ${stepsQ[outOfOrder - 1]!}). The staircase is searched, so an unsorted one reads ` +
        'a share at whatever step the search lands on.',
    )
  }

  return {
    ref: seeds,
    // Absent is the shape of a set made before the confidence model, and of the single-seed
    // configuration, which drops it; `undefined`, not an error.
    split: block.split === undefined ? undefined : splitFolds(block.split, seeds.length, where),
    scoreClip:
      ref.score_clip === undefined
        ? undefined
        : asNumber(ref.score_clip, 'pipeline.ref.score_clip', where),
    pTip: [weights[0]!, weights[1]!, weights[2]!],
    segclrFloor: asNumber(pTip.segclr_floor, 'pipeline.p_tip.segclr_floor', where),
    eTipFloor: asNumber(
      asRecord(block.model_e, 'pipeline.model_e', where).e_tip_floor,
      'pipeline.model_e.e_tip_floor',
      where,
    ),
    cutoff: asNumber(show.cutoff, 'pipeline.show.cutoff', where),
    cutoffRef:
      show.cutoff_ref === undefined
        ? undefined
        : asNumber(show.cutoff_ref, 'pipeline.show.cutoff_ref', where),
    steps: { q: stepsQ, r: stepsR, clip: asNumber(steps.clip, 'pipeline.r.clip', where) },
  }
}

/**
 * Ref's fits, whichever of the two ways SEAM wrote them.
 *
 * A `seeds` list is production's, one entry per checkpoint. A block carrying `mu`/`sd`/`w`
 * directly is the single-seed configuration's: with one seed there is no average to take, and
 * SEAM does not write a list of one. Either becomes a list, because a seed is addressed by its
 * position everywhere downstream and two shapes would be two code paths through `scoreList`.
 *
 * **Both, not either-or**, and refused when it is both: a block carrying `seeds` *and* a bare fit
 * has two answers to "what scores a candidate", and taking the list quietly would ignore numbers
 * somebody put there on purpose.
 */
function refSeeds(ref: Record<string, unknown>, where: string): SeedFit[] {
  const bare = ref.mu !== undefined || ref.sd !== undefined || ref.w !== undefined
  if (ref.seeds !== undefined && bare) {
    throw new Error(
      `${where}: \`pipeline.ref\` states both a \`seeds\` list and its own \`mu\`/\`sd\`/\`w\`. ` +
        'One of them is what scores a candidate and nothing here can say which.',
    )
  }
  if (ref.seeds !== undefined) {
    return seedFits(ref.seeds, 'pipeline.ref.seeds', REF_WIDTH, where)
  }
  if (!bare) {
    throw new Error(
      `${where}: \`pipeline.ref\` has neither a \`seeds\` list nor \`mu\`/\`sd\`/\`w\` of its ` +
        'own, so there is no fit to turn an assessor score into a logit.',
    )
  }
  // Through the same checker, which is why `oneFit` is a function: the width check and the "a
  // fit of another shape is a different model" sentence are stated once, and this path's
  // refusals name `pipeline.ref.w` rather than an element of a list that does not exist.
  return [oneFit(ref, 'pipeline.ref', REF_WIDTH, where)]
}

/**
 * Split's folds, each carrying **the configuration's** seeds.
 *
 * `seedFits` checks a fold's own shape; the roster is a property of the configuration, so it is
 * checked here, against ref's. `scoreList` indexes split by ref's seed positions and averages
 * over the flat count of fits, so a fold with fewer seeds both reads the wrong column and weighs
 * less than its neighbours — and the manifest's own `split.design` ("mean over folds of the mean
 * over seeds") equals that flat average only while every fold has the same count. A fold with
 * more reads past the head's columns and throws a `TypeError` naming nothing.
 */
function splitFolds(value: unknown, seeds: number, where: string): SeedFit[][] {
  const folds = asRecord(value, 'pipeline.split', where).folds
  if (!Array.isArray(folds) || folds.length === 0) {
    throw new Error(`${where}: \`pipeline.split.folds\` must be a non-empty list of folds.`)
  }
  return folds.map((fold, at) => {
    const what = `pipeline.split.folds[${at}]`
    const fits = seedFits(fold, what, SPLIT_WIDTH, where)
    if (fits.length !== seeds) {
      throw new Error(
        `${where}: \`${what}\` has ${fits.length} seeds and ref's fit has ${seeds}. Every fold ` +
          'scores the same seeds, and one that does not is a mean over a different number of ' +
          'them — still a confidence, and not this set’s.',
      )
    }
    return fits
  })
}

/**
 * A list of per-seed fits, checked for the two things that are silent when wrong.
 *
 * **The seeds must be in order**, because every caller addresses a seed by position: seed `k`'s
 * score column against fold entry `k`'s weights. A manifest listing them out of order would pair
 * each score with another seed's fit and hand back a perfectly ordinary logit.
 *
 * **The three vectors must be the width of the design**, because `((x - mu) / sd) · w` walks the
 * row and a short `w` would simply leave the last feature out — dropping the assessor's own score
 * from ref, say, and scoring on geometry and size alone.
 */
function seedFits(value: unknown, what: string, width: number, where: string): SeedFit[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where}: \`${what}\` must be a list of per-seed fits.`)
  }
  /*
   * Here rather than beside ref's call, which is where it was: every fold of `split` comes
   * through this function too, and a fold with no seeds divides by a count of zero and hands
   * back a confidence of `NaN` for every candidate in the set.
   */
  if (value.length === 0) {
    throw new Error(`${where}: \`${what}\` is empty, so nothing can be scored.`)
  }
  return value.map((entry, at) => {
    const fit = asRecord(entry, `${what}[${at}]`, where)
    if (fit.k !== at) {
      throw new Error(
        `${where}: \`${what}[${at}]\` is seed ${String(fit.k)}. A seed is addressed by its ` +
          'position here, so a list out of order scores each seed with another seed’s weights.',
      )
    }
    return oneFit(fit, `${what}[${at}]`, width, where)
  })
}

/**
 * One fit's three vectors, checked for the thing that is silent when wrong.
 *
 * **The width**, because `((x - mu) / sd) · w` walks the row and a short `w` would simply leave
 * the last feature out — dropping the assessor's own score from ref, say, and scoring on
 * geometry and size alone.
 *
 * `what` is the path the fit is actually at, which is why this is a function rather than part of
 * the loop above: a seed in a list is at `pipeline.ref.seeds[1]`, and the single-seed
 * configuration's fit is at `pipeline.ref` with no index at all. Refusing the second with
 * `pipeline.ref[0].w` would send a reader to look for an element of something that is not a
 * list, against this file's own rule that a refusal names the number.
 */
function oneFit(
  fit: Record<string, unknown>,
  what: string,
  width: number,
  where: string,
): SeedFit {
  const out = {
    mu: numbers(fit.mu, `${what}.mu`, where),
    sd: numbers(fit.sd, `${what}.sd`, where),
    w: numbers(fit.w, `${what}.w`, where),
  }
  for (const [name, column] of Object.entries(out)) {
    if (column.length !== width) {
      throw new Error(
        `${where}: \`${what}.${name}\` has ${column.length} numbers and this design has ` +
          `${width}. A fit of another shape is a different model.`,
      )
    }
  }
  return out
}

/**
 * A list of numbers, each checked by `asNumber` so the predicate is stated once.
 *
 * It also names the element: `pipeline.ref.seeds[1].w[2]` sends a reader to the number, where
 * "must be a list of numbers" sends them to read a list of eighty.
 */
function numbers(value: unknown, field: string, where: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where}: \`${field}\` must be a list of numbers.`)
  }
  return value.map((one, at) => asNumber(one, `${field}[${at}]`, where))
}

/**
 * An object, or a refusal naming the block **and where it came from**. Shared with
 * `suggestionSet.ts`, which was the other half of this file a week ago.
 *
 * `where` is not decoration: this parser now reads two sources — a published set's manifest and
 * a model's `config` — and a reader told "`pipeline.ref` is missing" with no idea which of them
 * is missing it cannot act. It is the rule the header states, and the first version of this
 * function dropped it.
 */
export function asRecord(value: unknown, what: string, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where}: \`${what}\` must be an object, and there is none.`)
  }
  return value as Record<string, unknown>
}

/** A finite number, or a refusal naming the field. Shared with `suggestionSet.ts`. */
export function asNumber(value: unknown, field: string, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${where}: \`${field}\` must be a number.`)
  }
  return value
}
