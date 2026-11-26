/**
 * Coda's stages 7–9 against SEAM's own published numbers, for the configuration it will run.
 *
 * `stages.test.ts` does this for **production** — three assessor seeds and the EM-texture split
 * head — reading that set's whole `tips.parquet` and `candidates.parquet`. This is the same check
 * for the single-seed, masks-only configuration, which is the one a browser can actually run and
 * the one whose fits ride in the assessor's manifest.
 *
 * Two things make it a different test rather than a second copy:
 *
 * * **The fits come from the model manifest, not from a set.** `__fixtures__/assessorManifest.json`
 *   is the real output of `pnpm make:assessor-manifest` — the file that will be uploaded — so this
 *   checks the generator, the reader and the arithmetic as one chain. A manifest that loads and a
 *   `config` that parses to the wrong numbers both look like success from anywhere else.
 * * **There is no split block**, so `decideTip` takes the arm where the configuration's own cutoff
 *   is about `p_tip × p_top`. Getting that wrong leaves every tip undecided, and the only symptom
 *   is a review queue that never shows anything.
 *
 * The golden is 75 chosen tips rather than all 2,708 — `__fixtures__/make_single_seed_golden.py`
 * says which and why. Its inputs are in `geo_rank` order, which is the order Coda's own search
 * produces, and not the `rank` order SEAM's parquet is written in: ties are broken by arrival, so
 * a list already sorted by the answer could not show a wrong tie rule.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { ModelManifest } from '../../ml/manifest'
import { parseAssessorConfig } from './assessorModel'
import { decideTip, scoreList } from './stages'

interface GoldenTip {
  readonly neuron: string
  readonly end_uid: number
  readonly why: string
  readonly e_tip: number
  readonly in: {
    readonly geo_rank: number[]
    readonly vol_um3: number[]
    readonly score_s0: number[]
  }
  readonly seam: {
    readonly logit: number[]
    readonly p_cand: number[]
    readonly rank: number[]
    readonly conf: number[]
    readonly cand_root: string[]
    readonly segclr: number
    readonly p_tip: number
    readonly p_top: number | null
    readonly q: number
    readonly r: number
    readonly shown: boolean
    readonly top_cand_root: string | null
  }
}

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as T
}

/**
 * Each configuration Coda can run, as the file that gets uploaded and SEAM's golden for it. Seed 0
 * is retired from the menu (2026-11-20) and still runs for a card that holds it, so it keeps its
 * check; student 1 (`n3d_mal_mask_s1`, SEAM's `coda-student1.md`) is the one offered.
 *
 * `onTheLine` is the tip whose `q` is its own cutoff, to the last bit — see the verdict test.
 */
const CONFIGURATIONS = [
  {
    name: 'seed 0',
    golden: 'singleSeedTips.json',
    manifest: 'assessorManifest.json',
    onTheLine: ['648518347558097460/704'],
  },
  {
    name: 'student 1',
    golden: 'student1Tips.json',
    manifest: 'assessorManifestStudent1.json',
    onTheLine: ['648518347686959617/573'],
  },
]

describe.each(CONFIGURATIONS)('$name, against SEAM’s own numbers', (configuration) => {
  const GOLDEN = fixture<{ cutoff: number; tips: readonly GoldenTip[] }>(configuration.golden)
  const MANIFEST = fixture<ModelManifest>(configuration.manifest)
  const FITS = parseAssessorConfig(MANIFEST.config, MANIFEST.id).fits

  /** One tip through stages 7–9, exactly as the node runs it. */
  function recompute(tip: GoldenTip) {
    const list = scoreList(
      { geoRank: tip.in.geo_rank, volUm3: tip.in.vol_um3, assessor: [tip.in.score_s0] },
      FITS,
    )
    return { list, decided: decideTip(list, tip.e_tip, FITS) }
  }

  /** The largest absolute difference over every tip, for one quantity. */
  function worst(
    of: (tip: GoldenTip) => readonly number[],
    want: (tip: GoldenTip) => readonly number[],
  ) {
    let top = 0
    for (const tip of GOLDEN.tips) {
      const got = of(tip)
      const expected = want(tip)
      expect(got.length, `${tip.neuron}/${tip.end_uid}`).toBe(expected.length)
      for (let i = 0; i < got.length; i++) {
        top = Math.max(top, Math.abs(got[i]! - expected[i]!))
      }
    }
    return top
  }

  /**
   * The fits this runs on are the manifest's, which is the file that gets uploaded. Pinned
   * against SEAM's published cutoff so a regenerated manifest and a regenerated golden have to
   * move together — two fixtures from two commits is the drift neither can see on its own.
   */
  it('runs the fits the manifest carries, for the set the golden came from', () => {
    expect(FITS.cutoff).toBe(GOLDEN.cutoff)
    expect(FITS.ref).toHaveLength(1)
    expect(FITS.split).toBeUndefined()
    expect(GOLDEN.tips.length).toBeGreaterThan(50)
  })

  /*
   * The published differences are all at the last bits of a double, which is the only agreement
   * worth asserting: SEAM's own `checks_largest_difference` for this fixture records 1.8e-15,
   * recomputing the same quantities in numpy from the same frozen numbers. A bound rather than
   * an equality because the two sum in different orders, and a bound this tight cannot hide a
   * wrong weight, a wrong column or a wrong clip.
   */
  it('reproduces ref’s logit per candidate', () => {
    expect(
      worst(
        (t) => [...recompute(t).list.logit],
        (t) => t.seam.logit,
      ),
    ).toBeLessThan(1e-12)
  })

  it('reproduces p_cand, the candidate’s share of its tip’s list', () => {
    expect(
      worst(
        (t) => [...recompute(t).list.pCand],
        (t) => t.seam.p_cand,
      ),
    ).toBeLessThan(1e-14)
  })

  /**
   * `conf` is `p_tip × p_cand`, so it carries both halves — a tip-level mistake and a list-level
   * one both land here, which is why it is checked as well as its two factors.
   */
  it('reproduces conf, which is the tip’s probability times the candidate’s share', () => {
    const got = worst(
      (t) => {
        const { list, decided } = recompute(t)
        return [...list.pCand].map((p) => p * decided.pTip)
      },
      (t) => t.seam.conf,
    )
    expect(got).toBeLessThan(1e-14)
  })

  /**
   * **The ranking, not just the numbers.** Two lists can agree on every logit to fifteen places
   * and still disagree about which candidate is first, if the tie rule differs — and the first
   * candidate is the whole answer. SEAM's is pandas' `method='first'` on a descending rank, which
   * is `orderByScores`' stable descending order over a list that arrives in `geo_rank` order.
   */
  it('puts every candidate at the rank SEAM gives it', () => {
    for (const tip of GOLDEN.tips) {
      expect([...recompute(tip).list.rank], `${tip.neuron}/${tip.end_uid}`).toEqual(
        tip.seam.rank,
      )
    }
  })

  it('names the same first candidate on every tip that has one', () => {
    for (const tip of GOLDEN.tips) {
      const { list } = recompute(tip)
      const first = list.first < 0 ? null : tip.seam.cand_root[list.first]!
      expect(first, `${tip.neuron}/${tip.end_uid}`).toBe(tip.seam.top_cand_root)
    }
  })

  it('reproduces segclr, p_tip and p_top', () => {
    let top = 0
    for (const tip of GOLDEN.tips) {
      const { list, decided } = recompute(tip)
      top = Math.max(
        top,
        Math.abs(list.segclr - tip.seam.segclr),
        Math.abs(decided.pTip - tip.seam.p_tip),
        // Null where SEAM has no first candidate to give a share to. Coda carries 0 there, which
        // multiplied into `q` gives the zero SEAM also publishes — checked on the `q` test, so
        // the two agree about the answer and differ only about how to write "there is none".
        tip.seam.p_top === null ? 0 : Math.abs(list.pTop - tip.seam.p_top),
      )
    }
    expect(top).toBeLessThan(1e-12)
  })

  /**
   * `q` is `p_tip × p_top` here, under that name, because the configuration states no split —
   * SEAM's fixture writes `show.q` as "p_tip x p_cand of the first candidate (no split)".
   * `decideTip` reads the absent split block and says so; reading it the other way would leave
   * `q` undefined on all 2,708 tips.
   */
  it('reproduces q, the quantity this configuration decides on', () => {
    let top = 0
    for (const tip of GOLDEN.tips) {
      const { decided } = recompute(tip)
      expect(decided.q, `${tip.neuron}/${tip.end_uid}`).toBeDefined()
      expect(decided.against?.quantity).toBe('q')
      top = Math.max(top, Math.abs(decided.q! - tip.seam.q))
    }
    expect(top).toBeLessThan(1e-14)
  })

  /**
   * **The decision itself**, which is the only thing a proofreader acts on.
   *
   * Every tip agrees but one, and the exception is worth the paragraph. SEAM's cutoff is chosen
   * at an **observed** operating point on the calibration scores, so it is not a round number —
   * it is one of the tips' own `q` values, to every bit. That tip therefore sits exactly on its
   * own cutoff, SEAM's `>=` shows it, and Coda's `q` for it lands **one unit in the last place
   * lower** because the two sum the same products in different orders.
   *
   * So the assertion is: the verdicts agree except where `q` is within a few bits of the cutoff,
   * and there is **exactly one** such tip in each configuration's set of 2,708. A tolerance inside `decideTip`
   * would be the wrong fix — it would move the cutoff for every tip to rescue a tie that only
   * exists because the cutoff was read off this one.
   */
  it('shows and withholds the same tips, bar the one sitting on the cutoff', () => {
    const onTheLine: string[] = []
    for (const tip of GOLDEN.tips) {
      const { decided } = recompute(tip)
      const where = `${tip.neuron}/${tip.end_uid}`
      // Four units in the last place of the cutoff — a few additions' worth of reordering, and
      // some twelve orders of magnitude below the gap to the next tip either side of it.
      if (Math.abs(decided.q! - GOLDEN.cutoff) < 4 * Number.EPSILON * GOLDEN.cutoff) {
        onTheLine.push(where)
        continue
      }
      expect(decided.against?.verdict === 'shown', where).toBe(tip.seam.shown)
    }
    expect(onTheLine).toEqual(configuration.onTheLine)
  })

  /**
   * The isotonic staircase, which is searched rather than interpolated — so an off-by-one at a
   * boundary reads a share one step out and still reads as a share.
   */
  it('reads the same r off the display staircase', () => {
    for (const tip of GOLDEN.tips) {
      const { decided } = recompute(tip)
      // SEAM writes `r = 0` for a tip with no list; Coda carries no `r` where there is no first
      // candidate to be right about, which is the same statement with the third meaning of zero
      // taken out. Both agree the tip is withheld.
      const r = decided.against?.r ?? 0
      expect(r, `${tip.neuron}/${tip.end_uid}`).toBeCloseTo(tip.seam.r, 10)
    }
  })

  /**
   * A tip whose every candidate belonged to a nearer tip of the same neuron. SEAM scores it
   * rather than dropping it, and so does this: the floor for `segclr`, a real `p_tip` — the tip
   * may well be a false split; it is the *candidate* that is missing — and a `q` of zero.
   */
  it('scores a tip with no candidates at the fit’s own floor', () => {
    const empty = GOLDEN.tips.filter((tip) => tip.in.geo_rank.length === 0)
    expect(empty.length).toBeGreaterThan(0)
    for (const tip of empty) {
      const { list, decided } = recompute(tip)
      expect(list.segclr).toBe(FITS.segclrFloor)
      expect(list.first).toBe(-1)
      expect(decided.pTip).toBeGreaterThan(0)
      expect(decided.q).toBe(0)
      expect(decided.against?.verdict).toBe('withheld')
    }
  })
})
