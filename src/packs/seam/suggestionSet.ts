/**
 * A suggestion set's manifest: where SEAM's merge candidates are, and what they were made with.
 *
 * The manifest is SEAM's own `fixture.json`, unchanged — it already carries the snapshot, the
 * datastack, the neurons, every frozen fit of the pipeline and the counts, which is exactly what
 * `src/ml/manifest.ts` carries for a model. Reading it rather than inventing a Coda-side wrapper
 * is what keeps the node's input the same shape on the day a service answers instead of a
 * directory of files.
 *
 * ## The fits are carried, and parsed only when something recomputes
 *
 * `pipeline` reaches `SuggestionSet` as `unknown`, and `parsePipelineFits` turns it into numbers
 * for `stages.ts`. The two are separate on purpose: **a set that cannot be recomputed must still
 * display.** Phase 1 reads `q`, `shown` and `r` as columns and needs no fit at all, so a manifest
 * whose `ref` block is missing or has grown a shape this build does not know is still a perfectly
 * good set to look at — it is only stages 7–9 that have to refuse, by name, at the moment somebody
 * asks for them.
 *
 * What `parseSuggestionSet` reads is what Phase 1 shows or checks: the snapshot (a suggestion is
 * tied to one, and the neurons have been edited since), the datastack, the neuron list, the
 * commit, and the counts the probe asserts against.
 *
 * ## The cutoff is read, never written down
 *
 * `shown` arrives as a column, so nothing here needs the cutoff to decide anything. It is read
 * only to *say* — a card that prints "97 of 2,708 above 0.2084" has to get the number from the
 * file, because SEAM refits it whenever a stage changes and a hard-coded 0.2084 would be right
 * today and quietly wrong after the next run.
 */

import { fetchText } from '../../data/fetchText'
import { suggestionsAddress } from './suggestionIndex'

/** The files a set is made of, resolved against the manifest's own URL. */
export const TIPS_FILE = 'tips.parquet'
export const CANDIDATES_FILE = 'candidates.parquet'

export interface SuggestionCounts {
  readonly tips: number
  readonly shown: number
  readonly candidates: number
}

export interface SuggestionSet {
  /** Where the manifest was read from. Every file resolves against it. */
  readonly manifestUrl: string
  /** ISO-ish, as SEAM writes it. Shown, never parsed: it is a label on an answer. */
  readonly snapshot: string
  readonly datastack: string
  readonly dataset: string
  /** The neurons this set covers, as text (invariant 8). */
  readonly neurons: readonly string[]
  /** The neuron held out of the cutoff's calibration, where the set names one. */
  readonly testNeuron: string | undefined
  /** SEAM's commit, with `-dirty` where it had uncommitted changes. The set's version. */
  readonly commit: string
  /** The absolute score at or above which a first candidate is shown. Read, never assumed. */
  readonly cutoff: number
  readonly counts: SuggestionCounts
  /**
   * The whole `pipeline` block, unread.
   *
   * Carried rather than parsed here so that `parsePipelineFits` can be asked for it later without
   * fetching the manifest a second time, and so that a set whose fits this build cannot read is
   * still a set this build can show. See the header.
   */
  readonly pipeline: unknown
}

/**
 * How many columns each design has — ref's three, split's four.
 *
 * Here, beside the parser that checks a fit against them, and imported by `stages.ts`, which
 * builds the row. They were a literal in one file and a named constant in the other: SEAM adds a
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
 * list that holds this, which `parsePipelineFits` checks: the manifest numbers its seeds and a
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
 * Every frozen number stages 7–9 need, read out of the set's own manifest.
 *
 * All of it is read and none of it defaulted. SEAM refits these whenever a stage changes — the
 * cutoff moved twice in a week — and a stage that filled in a missing fit would answer with a
 * plausible probability against a rule nobody chose.
 */
export interface PipelineFits {
  /** Ref's fit per seed: `[-geo_rank, log(vol_um3), assessor score]`. */
  readonly ref: readonly SeedFit[]
  /**
   * The confidence model, by fold and then by seed: ref's design plus the head's score.
   *
   * Absent where the set states no `split` block, which is the shape of a set made before the
   * confidence model was adopted. Then there is no `q`, only `q_ref`.
   */
  readonly split: readonly (readonly SeedFit[])[] | undefined
  /**
   * How far a model score is clipped before it enters a fit, where the set declares one.
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
   * The cutoff on `q`.
   *
   * The same `pipeline.show.cutoff` that `SuggestionSet.cutoff` carries, read a second time
   * because this parser deliberately takes the `pipeline` block alone and not the set. The two
   * cannot disagree — one field, one file — and `stages.test.ts` holds them equal.
   */
  readonly cutoff: number
  /**
   * The cutoff on `q_ref`, if the set publishes one as a number.
   *
   * It does not yet: SEAM states it in prose ("its cutoff was 0.208"), which is not something to
   * parse. Until it is a field, a tip that can only reach `q_ref` gets a number and no verdict —
   * see `decideTip`.
   */
  readonly cutoffRef: number | undefined
  readonly steps: DisplaySteps
}

/** The address of one of the set's files. */
export function fileUrl(set: SuggestionSet, file: string): string {
  return new URL(file, set.manifestUrl).toString()
}

/**
 * Fetch and read a manifest.
 *
 * Through `fetchText`, which is the one reader that can tell "unreachable" from "CORS refused" —
 * the two failures a reader pointed at a URL meets, and the two that look identical in a bare
 * `fetch`.
 */
export async function loadSuggestionSet(
  raw: string,
  signal?: AbortSignal,
): Promise<SuggestionSet> {
  /*
   * Normalised here rather than by the caller, and that is a correction: it used to be the
   * caller's, and three different callers forgot — the node's first draft, the probe, and a
   * one-off script — each getting the host's `403` for a directory and reading it as the set
   * being unreachable. `suggestionsAddress` is idempotent, so a caller that has already done it
   * loses nothing, and one that has not can no longer be wrong.
   */
  const url = suggestionsAddress(raw)
  const text = await fetchText(url, { signal })
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(
      `${url} is not JSON. A suggestion set's address is its manifest — SEAM's \`fixture.json\` — ` +
        `not the directory holding it.`,
    )
  }
  return parseSuggestionSet(json, url)
}

/**
 * Read a manifest's fields, or say which one is wrong.
 *
 * Every refusal names the field and the file, because the thing a reader has most likely done is
 * point this at the wrong JSON — a model manifest, a directory listing, an error page that
 * parsed. A set missing `counts` is a set this node cannot check itself against, so it is refused
 * rather than defaulted.
 */
export function parseSuggestionSet(json: unknown, manifestUrl: string): SuggestionSet {
  const root = asRecord(json, 'the manifest')
  /*
   * A directory's index, handed over where one set's manifest was wanted. Said in its own words
   * rather than as "needs `pipeline`", because the reader has not given a broken manifest — they
   * have given the right file for a different question, and the answer is which set they mean.
   */
  if (Array.isArray(root.sets)) {
    const ids = root.sets
      .map((entry) => (entry as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === 'string')
    throw new Error(
      `${manifestUrl} is a directory index, not one set's manifest. ` +
        (ids.length > 0
          ? `It lists ${ids.join(', ')}; name one in \`Set\`.`
          : 'It lists no sets.'),
    )
  }
  const pipeline = asRecord(root.pipeline, 'pipeline')
  const show = asRecord(pipeline.show, 'pipeline.show')
  const counts = asRecord(root.counts, 'counts')
  const neurons = root.neurons
  if (!Array.isArray(neurons) || neurons.some((n) => typeof n !== 'string')) {
    // Not a convenience check: a numeric id in this list is already a different neuron by the
    // time anybody could notice (invariant 8), so a set carrying one is refused rather than read.
    throw new Error(
      `${manifestUrl}: \`neurons\` must be a list of root ids as text. A numeric id is a ` +
        `different neuron.`,
    )
  }
  return {
    manifestUrl,
    snapshot: asString(root.snapshot, 'snapshot', manifestUrl),
    datastack: asString(root.datastack, 'datastack', manifestUrl),
    dataset: asString(root.dataset, 'dataset', manifestUrl),
    neurons: neurons as string[],
    testNeuron: typeof root.test_neuron === 'string' ? root.test_neuron : undefined,
    commit: asString(root.commit, 'commit', manifestUrl),
    cutoff: asNumber(show.cutoff, 'pipeline.show.cutoff', manifestUrl),
    pipeline,
    counts: {
      tips: asNumber(counts.tips, 'counts.tips', manifestUrl),
      shown: asNumber(counts.shown, 'counts.shown', manifestUrl),
      candidates: asNumber(counts.candidates, 'counts.candidates', manifestUrl),
    },
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`A suggestion set's manifest needs \`${what}\`, and this one has none.`)
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, field: string, url: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${url}: \`${field}\` must be a non-empty string.`)
  }
  return value
}

function asNumber(value: unknown, field: string, url: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${url}: \`${field}\` must be a number.`)
  }
  return value
}

/**
 * Read the frozen fits stages 7–9 run on, refusing by name what this build cannot run.
 *
 * Separate from `parseSuggestionSet` because the two answer different questions: that one asks
 * "is this a suggestion set", which a reader who pointed at the wrong URL needs, and this one
 * asks "can this build recompute it", which only matters to whoever is about to. A set can fail
 * this and still be perfectly good to read.
 *
 * Every refusal names the block, because the manifest is SEAM's and the reader cannot edit it:
 * what they can do is say which set, or which build of Coda, and both of those need the field.
 */
export function parsePipelineFits(set: SuggestionSet): PipelineFits {
  const manifestUrl = set.manifestUrl
  const block = asRecord(set.pipeline, 'pipeline')
  const ref = asRecord(block.ref, 'pipeline.ref')
  const seeds = seedFits(ref.seeds, 'pipeline.ref.seeds', REF_WIDTH, manifestUrl)

  const pTip = asRecord(block.p_tip, 'pipeline.p_tip')
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
      `${manifestUrl}: \`pipeline.p_tip.columns\` is ${JSON.stringify(columns)}, and this build ` +
        'applies the fit on `segclr` and `e_tip`. A refit on other features needs a Coda that ' +
        'knows how to compute them.',
    )
  }
  const weights = numbers(pTip.weights, 'pipeline.p_tip.weights', manifestUrl)
  if (weights.length !== 3) {
    throw new Error(
      `${manifestUrl}: \`pipeline.p_tip.weights\` has ${weights.length} numbers, and a fit on ` +
        'two columns has three — the intercept first.',
    )
  }

  const show = asRecord(block.show, 'pipeline.show')
  const steps = asRecord(block.r, 'pipeline.r')
  const stepsQ = numbers(steps.steps_q, 'pipeline.r.steps_q', manifestUrl)
  const stepsR = numbers(steps.steps_r, 'pipeline.r.steps_r', manifestUrl)
  if (stepsQ.length !== stepsR.length || stepsQ.length === 0) {
    throw new Error(
      `${manifestUrl}: \`pipeline.r\` has ${stepsQ.length} edges and ${stepsR.length} shares. ` +
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
      `${manifestUrl}: \`pipeline.r.steps_q\` falls at [${outOfOrder}] (${stepsQ[outOfOrder]!} ` +
        `after ${stepsQ[outOfOrder - 1]!}). The staircase is searched, so an unsorted one reads ` +
        'a share at whatever step the search lands on.',
    )
  }

  return {
    ref: seeds,
    // Absent is the shape of a set made before the confidence model; `undefined`, not an error.
    split:
      block.split === undefined
        ? undefined
        : splitFolds(block.split, seeds.length, manifestUrl),
    scoreClip:
      ref.score_clip === undefined
        ? undefined
        : asNumber(ref.score_clip, 'pipeline.ref.score_clip', manifestUrl),
    pTip: [weights[0]!, weights[1]!, weights[2]!],
    segclrFloor: asNumber(pTip.segclr_floor, 'pipeline.p_tip.segclr_floor', manifestUrl),
    eTipFloor: asNumber(
      asRecord(block.model_e, 'pipeline.model_e').e_tip_floor,
      'pipeline.model_e.e_tip_floor',
      manifestUrl,
    ),
    // The set's own, already read: `pipeline.show.cutoff` through one parse, not two.
    cutoff: set.cutoff,
    cutoffRef:
      show.cutoff_ref === undefined
        ? undefined
        : asNumber(show.cutoff_ref, 'pipeline.show.cutoff_ref', manifestUrl),
    steps: { q: stepsQ, r: stepsR, clip: asNumber(steps.clip, 'pipeline.r.clip', manifestUrl) },
  }
}

/**
 * Split's folds, each carrying **the set's** seeds.
 *
 * `seedFits` checks a fold's own shape; the roster is a property of the set, so it is checked
 * here, against ref's. `scoreList` indexes split by ref's seed positions and averages over the
 * flat count of fits, so a fold with fewer seeds both reads the wrong column and weighs less
 * than its neighbours — and the manifest's own `split.design` ("mean over folds of the mean over
 * seeds") equals that flat average only while every fold has the same count. A fold with more
 * reads past the head's columns and throws a `TypeError` naming nothing.
 */
function splitFolds(value: unknown, seeds: number, url: string): SeedFit[][] {
  const folds = asRecord(value, 'pipeline.split').folds
  if (!Array.isArray(folds) || folds.length === 0) {
    throw new Error(`${url}: \`pipeline.split.folds\` must be a non-empty list of folds.`)
  }
  return folds.map((fold, at) => {
    const what = `pipeline.split.folds[${at}]`
    const fits = seedFits(fold, what, SPLIT_WIDTH, url)
    if (fits.length !== seeds) {
      throw new Error(
        `${url}: \`${what}\` has ${fits.length} seeds and ref's fit has ${seeds}. Every fold ` +
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
function seedFits(value: unknown, what: string, width: number, url: string): SeedFit[] {
  if (!Array.isArray(value)) {
    throw new Error(`${url}: \`${what}\` must be a list of per-seed fits.`)
  }
  /*
   * Here rather than beside ref's call, which is where it was: every fold of `split` comes
   * through this function too, and a fold with no seeds divides by a count of zero and hands
   * back a confidence of `NaN` for every candidate in the set.
   */
  if (value.length === 0) {
    throw new Error(`${url}: \`${what}\` is empty, so nothing can be scored.`)
  }
  return value.map((entry, at) => {
    const fit = asRecord(entry, `${what}[${at}]`)
    if (fit.k !== at) {
      throw new Error(
        `${url}: \`${what}[${at}]\` is seed ${String(fit.k)}. A seed is addressed by its ` +
          'position here, so a list out of order scores each seed with another seed’s weights.',
      )
    }
    const out = {
      mu: numbers(fit.mu, `${what}[${at}].mu`, url),
      sd: numbers(fit.sd, `${what}[${at}].sd`, url),
      w: numbers(fit.w, `${what}[${at}].w`, url),
    }
    for (const [name, column] of Object.entries(out)) {
      if (column.length !== width) {
        throw new Error(
          `${url}: \`${what}[${at}].${name}\` has ${column.length} numbers and this design has ` +
            `${width}. A fit of another shape is a different model.`,
        )
      }
    }
    return out
  })
}

/**
 * A list of numbers, each checked by `asNumber` so the predicate is stated once.
 *
 * It also names the element: `pipeline.ref.seeds[1].w[2]` sends a reader to the number, where
 * "must be a list of numbers" sends them to read a list of eighty.
 */
function numbers(value: unknown, field: string, url: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${url}: \`${field}\` must be a list of numbers.`)
  }
  return value.map((one, at) => asNumber(one, `${field}[${at}]`, url))
}
