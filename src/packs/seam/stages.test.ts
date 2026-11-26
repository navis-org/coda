/**
 * Stages 7–9 against SEAM's own answers, on every row of a real set.
 *
 * **This is the check the stages rest on, and it is why they are not vendored.** Everything else
 * Coda borrows from SEAM is copied byte for byte, because a window built slightly differently
 * still scores. Here the answers are published: `tips.parquet` and `candidates.parquet` carry
 * `logit`, `p_cand`, `rank`, `conf`, `segclr`, `p_tip`, `p_top`, `p_split`, `q_ref`, `q`, `shown`
 * and `r` for every row, computed by the pipeline itself. So the honest test is to recompute them
 * from the stored inputs and compare — which checks the numbers rather than the source, on real
 * data, at every stage.
 *
 * The bar is SEAM's own and it is in the manifest: `checks_largest_difference` records what the
 * pipeline's own replay moved each quantity by, around 2e-16. **Measured here on the tree-ranker
 * set of 2026-11-14, the worst difference over all 25 tips and every candidate row is 5.3e-15**,
 * on `conf_logit` — which sums fifteen fits, so it is summation order and nothing else; the ref
 * half is at 8.9e-16, `conf` at 2.8e-16, and `segclr`, `p_tip`, `q` and `r` at 6.1e-16 or better.
 *
 * It was 3.6e-15 on the `za` set. These are re-measured on each recut rather than carried: the
 * number is the evidence for the claim above it, and a stale one is a claim about a fixture that
 * no longer exists.
 *
 * `TOLERANCE` sits far above that, because a different engine's `Math.exp` may land a bit or two
 * elsewhere, and far below anything that could hide a wrong feature: every mistake available here
 * — a dropped clip, a seed paired with another seed's weights, a mean of maxima read as a maximum
 * of means — moves a logit by whole units.
 *
 * The files are read with **the app's own reader** rather than a JSON copy of them, so the dtypes
 * and the 18-digit ids come across the way they will in the browser.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { blobBytes } from '../../data/files/bytes'
import { openTableFile } from '../../data/files/read'
import type { Field } from './suggestionTables'
import { readFields } from './suggestionRead'
import { parseSuggestionSet } from './suggestionSet'
import { pipelineFitsFrom } from './pipelineFits'
import type { PipelineFits } from './pipelineFits'
import { decideTip, scoreList } from './stages'
import type { CandidateList } from './stages'

const DIR = 'src/packs/seam/__fixtures__'
const URL_ = 'https://example.invalid/coda_rv2/fixture.json'

/** Looser than the manifest's 2e-16, tighter than any wrong feature. See the header. */
const TOLERANCE = 1e-12

const SET = parseSuggestionSet(JSON.parse(readFileSync(`${DIR}/fixture.json`, 'utf8')), URL_)
const FITS = pipelineFitsFrom(SET.pipeline, SET.manifestUrl)

/** A column, by its name in SEAM's file. The published name is irrelevant here. */
const f = (from: string, dtype: Field['dtype'] = 'f64'): Field => ({ from, name: from, dtype })

async function columnsOf(file: string, fields: Field[]): Promise<Record<string, number[]>> {
  const reader = await openTableFile(blobBytes(new Blob([readFileSync(`${DIR}/${file}`)])))
  const { data } = await readFields(reader, fields, file)
  return data as unknown as Record<string, number[]>
}

const SEEDS = [0, 1, 2]
const candidates = await columnsOf('candidates.parquet', [
  f('end_uid', 'i64'),
  f('geo_rank', 'i64'),
  f('vol_um3'),
  ...SEEDS.map((k) => f(`score_s${k}`)),
  ...SEEDS.map((k) => f(`head_s${k}`)),
  ...SEEDS.map((k) => f(`logit_s${k}`)),
  f('logit'),
  f('p_cand'),
  f('p_conf'),
  f('conf_logit'),
  f('conf'),
  f('rank', 'i64'),
])
const tips = await columnsOf('tips.parquet', [
  f('end_uid', 'i64'),
  f('e_tip'),
  f('segclr'),
  f('p_tip'),
  f('p_top'),
  f('p_split'),
  f('q_ref'),
  f('q'),
  // The one column a reader acts on, so it is compared per tip and not as a total: two tips
  // swapping sides leaves the count right.
  f('shown', 'bool'),
  f('r'),
])

/**
 * The candidates of one tip, in file order.
 *
 * File order is the order the stages see in a browser too — the search publishes its list ranked
 * by `geo_rank` — and it decides ties, so a test that sorted here would check a list no caller
 * ever builds.
 */
function listFor(endUid: number): { list: CandidateList; rows: number[] } {
  const rows = candidates.end_uid!.flatMap((one, at) => (one === endUid ? [at] : []))
  const column = (name: string) => rows.map((at) => candidates[name]![at]!)
  return {
    rows,
    list: {
      geoRank: column('geo_rank'),
      volUm3: column('vol_um3'),
      assessor: SEEDS.map((k) => column(`score_s${k}`)),
      head: SEEDS.map((k) => column(`head_s${k}`)),
    },
  }
}

const ENDS = tips.end_uid!

/**
 * Every tip scored once, for the six cases that walk the whole set.
 *
 * `listFor` scans all 1,063 candidate rows per tip, so doing it per case is the same work six
 * times over. Nothing mutates what is held here, so the cases stay independent; the ones that
 * need a *modified* list, or modified fits, call `listFor` themselves.
 */
const SCORED = ENDS.map((endUid) => {
  const { list, rows } = listFor(endUid)
  return { list, rows, scores: scoreList(list, FITS) }
})

describe('stages 7–9, against the set’s own columns', () => {
  /*
   * The guard every loop below needs: each walks the fixture, and a loop over nothing passes.
   * Held to the manifest's own counts rather than to a literal, so a recut moves them together.
   */
  it('covers every row of the set', () => {
    expect(ENDS).toHaveLength(SET.counts.tips)
    expect(candidates.end_uid).toHaveLength(SET.counts.candidates)
    expect(SCORED.every(({ rows }) => rows.length > 0)).toBe(true)
  })

  it('reads the fits the set publishes, and no constant of its own', () => {
    expect(FITS.ref).toHaveLength(3)
    expect(FITS.split).toHaveLength(5)
    expect(FITS.cutoff).toBe(SET.cutoff)
    /*
     * **This set clips, and the agreement tests below are what make that mean something.** The
     * previous fixture predated `score_clip` and this line asserted its absence, so that a set
     * which gained one could not silently reuse the expectations around it. One did (nest 3,
     * 2026-11-11), the line fired, and the reproductions below then passed *with* the clip
     * applied — which is the first time that arm was checked against real published columns
     * rather than against a synthetic fit.
     */
    expect(FITS.scoreClip).toBe(20)
    expect(FITS.cutoffRef).toBeUndefined()
  })

  it('reproduces every candidate’s ref logit, share and rank', () => {
    let worst = 0
    for (const { rows, scores } of SCORED) {
      for (const [i, at] of rows.entries()) {
        for (const k of SEEDS) {
          worst = Math.max(
            worst,
            Math.abs(scores.logitPerSeed[k]![i]! - candidates[`logit_s${k}`]![at]!),
          )
        }
        worst = Math.max(worst, Math.abs(scores.logit[i]! - candidates.logit![at]!))
        worst = Math.max(worst, Math.abs(scores.pCand[i]! - candidates.p_cand![at]!))
        expect(scores.rank[i]).toBe(candidates.rank![at])
      }
    }
    expect(worst).toBeLessThan(TOLERANCE)
  })

  it('reproduces the confidence model’s logit and share', () => {
    let worst = 0
    for (const { rows, scores } of SCORED) {
      for (const [i, at] of rows.entries()) {
        worst = Math.max(worst, Math.abs(scores.confLogit![i]! - candidates.conf_logit![at]!))
        worst = Math.max(worst, Math.abs(scores.pConf![i]! - candidates.p_conf![at]!))
      }
    }
    expect(worst).toBeLessThan(TOLERANCE)
  })

  it('reproduces every tip’s segclr, p_tip, q_ref, q and r', () => {
    let worst = 0
    let shownHere = 0
    const near = (got: number, want: number) => {
      worst = Math.max(worst, Math.abs(got - want))
    }
    for (const [t, { scores }] of SCORED.entries()) {
      const tip = decideTip(scores, tips.e_tip![t]!, FITS)
      near(scores.segclr, tips.segclr![t]!)
      near(tip.pTip, tips.p_tip![t]!)
      near(scores.pTop, tips.p_top![t]!)
      near(scores.pSplit!, tips.p_split![t]!)
      near(tip.qRef, tips.q_ref![t]!)
      near(tip.q!, tips.q![t]!)
      near(tip.against!.r!, tips.r![t]!)
      // The decision, and the one thing a reader acts on. `q`, because this set has the head.
      expect(tip.against?.quantity).toBe('q')
      /*
       * Per tip, against the file's own `shown`. A total would pass with two tips swapping
       * sides — one wrongly shown and one wrongly withheld — which is the one failure of this
       * whole chain that a reader would act on.
       */
      expect(tip.against!.verdict).toBe(tips.shown![t] ? 'shown' : 'withheld')
      if (tip.against!.verdict === 'shown') shownHere += 1
    }
    expect(worst).toBeLessThan(TOLERANCE)
    expect(shownHere).toBe(SET.counts.shown)
  })

  /**
   * `conf` is the per-candidate quantity the card ranks a list by, and `q` is it at rank 1. Worth
   * its own case because the two are easy to compute from different `p_tip`s — one per tip and one
   * per candidate row — and the fixture's rows carry `p_tip` denormalised beside `conf`.
   */
  it('reproduces every candidate’s conf, and q is conf at the file’s rank 1', () => {
    let worst = 0
    for (const [t, { rows, scores }] of SCORED.entries()) {
      const tip = decideTip(scores, tips.e_tip![t]!, FITS)
      for (const [i, at] of rows.entries()) {
        worst = Math.max(worst, Math.abs(tip.pTip * scores.pConf![i]! - candidates.conf![at]!))
      }
      /*
       * Read at the row the **file** calls rank 1, not at our own `first`. Comparing our product
       * against our own `q` could not fail — both are `pTip × pConf[first]` — whereas this also
       * pins `first` against the published rank, which nothing else does.
       */
      const top = rows.find((at) => candidates.rank![at] === 1)!
      worst = Math.max(worst, Math.abs(candidates.conf![top]! - tip.q!))
      expect(rows[scores.first]).toBe(top)
    }
    expect(worst).toBeLessThan(TOLERANCE)
  })
})

/**
 * **What the clip does, as arithmetic, which the agreement tests above cannot say.**
 *
 * Those reproduce SEAM's published columns with the set's own clip of 20 applied, so they prove
 * the reading is right. They cannot isolate the clip's *effect*: a one-sided clamp, a sign slip
 * or a clip reaching the wrong design column would move the published columns too, and be
 * reproduced along with them. These two cases vary the clip against a fixed baseline instead.
 *
 * Written when no published set carried one at all, which is why the baseline below is an
 * explicitly unclipped fit rather than the set's own.
 */
describe('the score clip', () => {
  const widest = Math.max(
    ...SEEDS.flatMap((k) => candidates[`score_s${k}`]!.map((one) => Math.abs(one))),
  )
  /*
   * **The baseline is an explicitly unclipped fit, not `SCORED`.** `SCORED` is scored with the
   * set's own fits, which now carry a clip of 20 — so comparing against it would measure the
   * difference between two clips rather than the effect of clipping at all, and these two tests
   * failed exactly that way when the fixture gained one. Stated here so the next set to change
   * its clip does not need them rewritten again.
   */
  const unclipped: PipelineFits = { ...FITS, scoreClip: undefined }
  const BASE = SCORED.map(({ list }) => scoreList(list, unclipped))

  it('changes nothing when it is wider than every score', () => {
    const loose: PipelineFits = { ...FITS, scoreClip: widest + 1 }
    for (const [at, { list }] of SCORED.entries()) {
      expect([...scoreList(list, loose).logit]).toEqual([...BASE[at]!.logit])
    }
  })

  /**
   * Below the scores, each seed's logit must move by exactly `w·Δ/sd` on the assessor's column
   * and nothing else — which is what pins the clip to the **third** column and to both signs.
   */
  it('moves a clipped seed’s logit by exactly its weight times the change', () => {
    const clip = 2
    const tight: PipelineFits = { ...FITS, scoreClip: clip }
    let worst = 0
    for (const [which, { list, rows }] of SCORED.entries()) {
      // Not `at`: the inner loop below already binds one, and the shadow read as a bug.
      const scores = BASE[which]!
      const got = scoreList(list, tight)
      for (const [i, at] of rows.entries()) {
        let shift = 0
        for (const k of SEEDS) {
          const raw = candidates[`score_s${k}`]![at]!
          const delta = Math.min(Math.max(raw, -clip), clip) - raw
          const move = (FITS.ref[k]!.w[2]! * delta) / FITS.ref[k]!.sd[2]!
          worst = Math.max(
            worst,
            Math.abs(got.logitPerSeed[k]![i]! - (scores.logitPerSeed[k]![i]! + move)),
          )
          /*
           * The same `delta` must reach **split's** column 2 as well. `score_clip` is stated
           * under `ref` and `split.design` names "assessor score of seed k", so clipping it the
           * same way was a *reading* when this was written and no published set carried a clip.
           * Nest 3 does, and the confidence model's reproduction above passes with it applied —
           * so SEAM's own `conf_logit` column now confirms the reading, and this pins the shape.
           */
          for (const fold of FITS.split!) {
            shift += (fold[k]!.w[2]! * delta) / fold[k]!.sd[2]!
          }
        }
        const fitted = FITS.split!.length * SEEDS.length
        worst = Math.max(
          worst,
          Math.abs(got.confLogit![i]! - (scores.confLogit![i]! + shift / fitted)),
        )
      }
    }
    expect(worst).toBeLessThan(TOLERANCE)
    // The fixture has scores well past ±2, so the case is not vacuous.
    expect(widest).toBeGreaterThan(clip)
  })
})

describe('what a live tip can reach', () => {
  /**
   * The head scores are published as data and not as a model, so a tip searched and scored in the
   * browser has none. Everything up to `q_ref` must still come out, identical to what the same
   * list gives with the head — the head must not reach back into ref's half.
   */
  it('gives the same ref half with no head scores, and stops at q_ref', () => {
    const endUid = ENDS[0]!
    const { list } = listFor(endUid)
    const live: CandidateList = { ...list, head: undefined }
    const full = scoreList(list, FITS)
    const partial = scoreList(live, FITS)
    expect([...partial.logit]).toEqual([...full.logit])
    expect(partial.pTop).toBe(full.pTop)
    expect(partial.segclr).toBe(full.segclr)
    expect(partial.pConf).toBeUndefined()
    expect(partial.pSplit).toBeUndefined()

    const tip = decideTip(partial, tips.e_tip![0]!, FITS)
    expect(tip.qRef).toBeCloseTo(tips.q_ref![0]!, 12)
    expect(tip.q).toBeUndefined()
    /*
     * No verdict, and that is the point of the field: this set publishes no cutoff on `q_ref`
     * (SEAM states it in prose), so there is nothing to decide against. A reader is shown a
     * number and told the decision was not made, never a rejection.
     */
    expect(tip.against).toBeUndefined()
  })

  /** With a cutoff published for it, the same tip decides — on `q_ref`, and says so. */
  it('decides on q_ref once the set publishes a cutoff for it', () => {
    const { list } = listFor(ENDS[0]!)
    const withRef: PipelineFits = { ...FITS, cutoffRef: 0.208 }
    const tip = decideTip(
      scoreList({ ...list, head: undefined }, FITS),
      tips.e_tip![0]!,
      withRef,
    )
    expect(tip.against).toEqual({
      quantity: 'q_ref',
      score: tip.qRef,
      cutoff: 0.208,
      verdict: tip.qRef >= 0.208 ? 'shown' : 'withheld',
      /*
       * Absent: the steps were fitted against `q`, so reading them at `q_ref` would answer "how
       * often is a shown first right" with a staircase built for a different quantity.
       */
      r: undefined,
    })
  })

  /**
   * **An empty list is an answer.** The own-tip rule takes candidates away — a tip every one of
   * whose candidates belongs to a nearer tip of the same neuron keeps none — and SEAM scores such
   * a tip at the set's floor rather than dropping it. A dropped tip is one nobody is told about.
   */
  it('scores a tip with no candidates at the set’s floor, not at zero', () => {
    const empty: CandidateList = { geoRank: [], volUm3: [], assessor: [[], [], []] }
    const scores = scoreList(empty, FITS)
    expect(scores.first).toBe(-1)
    expect(scores.pTop).toBe(0)
    expect(scores.segclr).toBe(FITS.segclrFloor)

    /*
     * `undefined` rather than the floor spelled out: `decideTip` substitutes it, which is the
     * point of carrying `e_tip_floor` on the fits at all. Passing the floor explicitly gives the
     * same answer, which is what the second assertion says.
     */
    const tip = decideTip(scores, undefined, FITS)
    expect(tip.qRef).toBe(0)
    expect(tip.against?.r).toBeUndefined()
    expect(tip.pTip).toBe(decideTip(scores, FITS.eTipFloor, FITS).pTip)
    // `p_tip` is still a real number: the tip exists and may well be a false split. It is the
    // *candidate* that is missing, which is what makes q zero.
    expect(tip.pTip).toBeGreaterThan(0)
  })

  /**
   * The other way round: head scores in hand, but a configuration that states no split fits. The
   * **fits** decide, not the columns — scoring against a `split` the manifest does not state
   * would be a confidence model of this build's own invention, so `pConf` stays undefined.
   *
   * What the tip still gets is a verdict, and that is the part worth pinning. A configuration
   * with no split has no second quantity for its cutoff to be about: SEAM's single-seed fixture
   * fits `show.cutoff` and the `r` staircase against `p_tip × p_top` and calls that number `q`.
   * Reading them as belonging to a quantity the configuration cannot compute would leave every
   * one of its tips undecided, with nothing to see but a review queue that never shows anything.
   */
  it('decides on q_ref, under the name q, where the fits state no split', () => {
    const { list } = listFor(ENDS[0]!)
    const old: PipelineFits = { ...FITS, split: undefined }
    const scores = scoreList(list, old)
    expect(scores.pConf).toBeUndefined()
    const tip = decideTip(scores, tips.e_tip![0]!, old)
    expect(tip.q).toBe(tip.qRef)
    expect(tip.against?.quantity).toBe('q')
    expect(tip.against?.cutoff).toBe(old.cutoff)
    // And `r` comes with it: the staircase was fitted against the quantity just decided on.
    expect(tip.against?.r).toBeGreaterThan(0)
  })

  /**
   * The case the ref arm is still for: a **split** configuration whose tip was scored live, so
   * the head's EM was never read. The set's cutoff belongs to a quantity this tip did not reach,
   * and carrying it over would decide a different question with the same confidence.
   */
  it('leaves a split configuration’s live tip with a number and no verdict', () => {
    const { list } = listFor(ENDS[0]!)
    const scores = scoreList({ ...list, head: undefined }, FITS)
    const tip = decideTip(scores, tips.e_tip![0]!, FITS)
    expect(tip.q).toBeUndefined()
    expect(tip.qRef).toBeGreaterThan(0)
    expect(tip.against).toBeUndefined()
  })

  /**
   * An empty list **with** head scores is still undecided, and that caught a doc line that was
   * wrong: `pSplit` is not "undefined exactly when `pConf` is". `pConf` here is a defined
   * zero-length array, and there is no first candidate for it to answer about.
   */
  it('gives no q for an empty list even where the head is there', () => {
    const scores = scoreList(
      { geoRank: [], volUm3: [], assessor: [[], [], []], head: [[], [], []] },
      FITS,
    )
    expect(scores.pConf).toBeDefined()
    expect(scores.pSplit).toBeUndefined()
    expect(decideTip(scores, undefined, FITS).q).toBeUndefined()
  })
})

/**
 * The two a *list* can be wrong about. The refusals of `pipelineFitsFrom` live beside the
 * parser, in `suggestionSet.test.ts` — a refusal tested away from the thing that refuses is one
 * nobody finds when they change it (`docs/testing-layers.md`).
 */
describe('what scoreList refuses', () => {
  it('refuses a list whose seeds do not match the set’s fit', () => {
    const { list } = listFor(ENDS[0]!)
    expect(() => scoreList({ ...list, assessor: list.assessor.slice(0, 2) }, FITS)).toThrow(
      /2 assessor columns/,
    )
  })

  it('refuses columns of different lengths', () => {
    const { list } = listFor(ENDS[0]!)
    expect(() => scoreList({ ...list, volUm3: [] }, FITS)).toThrow(/columns of one table/)
  })

  /**
   * A head column shorter than the list used to read `undefined` into the fit, which makes every
   * confidence `NaN` — a list whose shares are not numbers rather than one that refuses.
   */
  it('refuses a head column shorter than the list', () => {
    const { list } = listFor(ENDS[0]!)
    const short = [list.head![0]!.slice(0, 1), list.head![1]!, list.head![2]!]
    expect(() => scoreList({ ...list, head: short }, FITS)).toThrow(/head's seed 0 column/)
  })
})
