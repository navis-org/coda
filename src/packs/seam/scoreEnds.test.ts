/**
 * The join between the assessor's logits and the columns the review card reads.
 *
 * `singleSeed.test.ts` checks the arithmetic against SEAM's own published numbers on real tips.
 * What is left for here is the wiring around it, where the failures are not arithmetic at all:
 * a list published in the wrong order, a tip's number read off the wrong row, a column the
 * search did not carry arriving as `NaN` through a softmax that then makes every candidate of
 * the tip not-a-number.
 */

import { describe, expect, it } from 'vitest'

import type { AssessedEnd, WhyFilled } from './searchTips'
import type { PipelineFits } from './pipelineFits'
import type { SearchedEnd } from './searchRun'
import type { PublishedEnd } from './searchTips'
import { contactsOf, publishedEnd, reportOnRun } from './scoreEnds'

/**
 * A fit that leaves the assessor's score alone: `mu` 0, `sd` 1, and weight only on the third
 * column. So `logit` **is** `score_s0`, and every ordering assertion below reads straight off
 * the numbers the test wrote.
 */
const FITS: PipelineFits = {
  ref: [{ mu: [0, 0, 0], sd: [1, 1, 1], w: [0, 0, 1] }],
  split: undefined,
  scoreClip: undefined,
  pTip: [0, 0, 0],
  segclrFloor: -9,
  eTipFloor: -2,
  cutoff: 0.5,
  cutoffRef: undefined,
  steps: { q: [0.2, 1], r: [0.3, 0.9], clip: 0.01 },
}

function end(scores: readonly number[], extra: Partial<SearchedEnd> = {}): SearchedEnd {
  const n = scores.length
  return {
    tip: 0,
    rows: n,
    candRoot: BigUint64Array.from({ length: n }, (_, i) => BigInt(100 + i)),
    columns: {
      geo_rank: Float64Array.from({ length: n }, (_, i) => i + 1),
      vol_um3: Float64Array.from({ length: n }, () => 1),
      contact_x_nm: Float64Array.from({ length: n }, (_, i) => i * 10),
      contact_y_nm: Float64Array.from({ length: n }, () => 2),
      contact_z_nm: Float64Array.from({ length: n }, () => 3),
    },
    missingQuery: false,
    pooled: n,
    tooFar: 0,
    anothersTip: 0,
    ...extra,
  }
}

function assessed(scores: readonly number[], filled?: readonly WhyFilled[]): AssessedEnd {
  return { score: Float64Array.from(scores), filled: filled ?? scores.map(() => '') }
}

describe('publishedEnd', () => {
  /**
   * **The published order is the assessor's, and `geo_rank` keeps the forest's.** SEAM ranks a
   * list by `logit`, so the first row of an assessed list is the assessor's choice — a reader
   * comparing the two columns is reading how much the assessor moved.
   */
  it('publishes the list in the assessor’s order, not the search’s', () => {
    const one = publishedEnd(end([1, 5, 3]), assessed([1, 5, 3]), 0, FITS)
    expect([...one.order]).toEqual([1, 2, 0])
  })

  /**
   * Ties keep the forest's order, which is `orderByScores`' stability over a list that arrives in
   * `geo_rank` order — pandas' `method='first'`, and SEAM's. Resolved the other way, two equal
   * logits would hand the decision to the geometrically worse of the pair.
   */
  it('breaks a tie towards the better geometric rank', () => {
    const one = publishedEnd(end([2, 2, 2]), assessed([2, 2, 2]), 0, FITS)
    expect([...one.order]).toEqual([0, 1, 2])
  })

  it('carries the assessor’s raw score beside ref’s logit', () => {
    const one = publishedEnd(end([4, 1]), assessed([4, 1]), 0, FITS)
    expect([...one.scores!.columns['score_s0']!]).toEqual([4, 1])
    expect([...one.scores!.columns['logit']!]).toEqual([4, 1])
  })

  /** `conf` is `p_tip × p_cand`, so a tip-level mistake and a list-level one both land in it. */
  it('writes conf as the tip’s probability times the candidate’s share', () => {
    const one = publishedEnd(end([0, 0]), assessed([0, 0]), 0, FITS)
    const pTip = one.scores!.tip.p_tip
    expect([...one.scores!.columns['conf']!]).toEqual([pTip * 0.5, pTip * 0.5])
  })

  /**
   * **Why a candidate carries the floor, not whether it does.** SEAM's `filled` is one cause; a
   * run here has two, fixed by different things, and a boolean would put them under one word.
   */
  it('says why each floored candidate was not scored', () => {
    const one = publishedEnd(
      end([1, 2, 3]),
      assessed([1, -9, -9], ['', 'no patch', 'capped']),
      0,
      FITS,
    )
    expect(one.scores!.filled).toEqual(['', 'no patch', 'capped'])
  })

  /**
   * A tip whose every candidate belonged to a nearer tip of the same neuron. SEAM publishes it —
   * the floor for `segclr`, a real `p_tip`, a `q` of zero and a verdict of withheld — and a row
   * left blank here would read as a tip nobody searched.
   */
  it('scores a tip with no candidates rather than leaving it blank', () => {
    const one = publishedEnd(end([]), assessed([]), 0, FITS)
    expect([...one.order]).toEqual([])
    expect(one.scores!.tip.segclr).toBe(FITS.segclrFloor)
    expect(one.scores!.tip.q).toBe(0)
    expect(one.scores!.tip.shown).toBe(false)
  })

  /**
   * `undefined` means Model E found no cell near the tip, and `decideTip` substitutes the floor
   * the fit itself saw. Leaving the substitution to a caller is what `segclrFloor` deliberately
   * does not do, and the first reader who forgot would get a plausible `p_tip` for every such tip.
   */
  it('substitutes the fit’s own e_tip floor where Model E found nothing', () => {
    const withFloor = publishedEnd(end([1]), assessed([1]), undefined, FITS)
    const spelled = publishedEnd(end([1]), assessed([1]), FITS.eTipFloor, FITS)
    expect(withFloor.scores!.tip.p_tip).toBe(spelled.scores!.tip.p_tip)
  })

  /**
   * **The shape a real empty end has**, which is not the shape this file's `end([])` builds:
   * `searchRun.ts`' `emptyEnd` carries `columns: {}` — no arrays at all — and that is what a tip
   * whose query root has no voxel in its own box yields. Every end of a run pointed at the wrong
   * materialization is one of these, so a throw here ends the run on its first end rather than
   * reporting the cause. It was a throw, twice over, until a review found it.
   */
  it('scores an end that carries no columns at all, as a refused one does', () => {
    const bare: SearchedEnd = { ...end([]), columns: {}, missingQuery: true }
    const one = publishedEnd(bare, assessed([]), 0, FITS)
    expect([...one.order]).toEqual([])
    expect(one.scores!.tip.segclr).toBe(FITS.segclrFloor)
    expect(one.scores!.tip.shown).toBe(false)
    expect(contactsOf(bare)).toEqual([])
  })

  /**
   * The quiet one. `-undefined` is `NaN`, `NaN` through a softmax makes **every** candidate of
   * the tip not-a-number, and the table would publish a whole list of them under a heading that
   * says it was scored.
   */
  it('refuses a list the search measured no volume for', () => {
    const missing = end([1, 2])
    const columns = { ...missing.columns }
    delete (columns as Record<string, unknown>)['vol_um3']
    expect(() => publishedEnd({ ...missing, columns }, assessed([1, 2]), 0, FITS)).toThrow(
      /ref's fit is on it/,
    )
  })
})

describe('contactsOf', () => {
  it('reads the three contact columns as the triples a patch box is sized from', () => {
    expect(contactsOf(end([1, 2]))).toEqual([
      [0, 2, 3],
      [10, 2, 3],
    ])
  })

  /** A patch centred anywhere but the contact is a different 4 µm of the volume. */
  it('refuses a list with no contact point to centre a patch on', () => {
    const one = end([1])
    const columns = { ...one.columns }
    delete (columns as Record<string, unknown>)['contact_y_nm']
    expect(() => contactsOf({ ...one, columns })).toThrow(/centred on one/)
  })
})

/**
 * The run's warnings, which were unreachable from any test while they lived inside `evaluate`.
 *
 * What is checked is mostly **silence**: `docs/limits.md` records twice over that a channel used
 * on every run is one readers learn to skip, and this one sits above two sentences that are
 * genuinely about something being wrong.
 */
describe('reportOnRun', () => {
  const warnings = () => {
    const said: string[] = []
    return { said, warner: { warn: (text: string) => said.push(text) } }
  }
  const tip = (shown: boolean | null, filled: readonly WhyFilled[] = ['']) =>
    ({
      end: end([1]),
      order: Int32Array.from([0]),
      scores: {
        columns: {},
        filled,
        tip: { segclr: 1, p_tip: 0.5, p_top: 0.5, q: 0.25, r: 0.5, shown },
      },
    }) as PublishedEnd

  it('says nothing at all about a run that found suggestions', () => {
    const { said, warner } = warnings()
    reportOnRun(warner, [tip(true), tip(false)])
    expect(said).toEqual([])
  })

  /** An empty queue says why it is empty, rather than looking like a run that failed. */
  it('says so when it assessed candidates and showed none of them', () => {
    const { said, warner } = warnings()
    reportOnRun(warner, [tip(false), tip(false)])
    expect(said.join(' ')).toMatch(/None of the 2 assessed tips/)
    // The moment follows the root now: a materialization is no longer the other reading.
    expect(said.join(' ')).not.toMatch(/materialization/)
  })

  /**
   * Every end missing its own neuron. Each neuron is read at its own moment, so the cause left
   * is tips that are not on it — and advice about the cache beside that is noise.
   */
  it('names tips that are not on the neuron, and says nothing of the cache, where no end was measured', () => {
    const { said, warner } = warnings()
    const missing = { ...tip(null), end: { ...end([]), missingQuery: true } } as PublishedEnd
    reportOnRun(warner, [missing, missing], { asked: 200, hits: 0, budget: 512 * 1024 * 1024 })
    const text = said.join(' ')
    expect(text).toMatch(/None of the 2 open ends had its own neuron/)
    expect(text).toMatch(/tips that are not on it/)
    expect(text).not.toMatch(/materialization/)
    expect(text).not.toMatch(/`Chunk cache`/)
  })

  /**
   * Three states, counted as three. Folding `null` — no cutoff was published for the quantity
   * these tips could reach — in with `false` would print a sentence about a cutoff that was
   * never applied.
   */
  it('does not call an undecided run an empty one', () => {
    const { said, warner } = warnings()
    reportOnRun(warner, [tip(null), tip(null)])
    expect(said).toEqual([])
  })

  /**
   * **A run where nothing was scored reports the floor and nothing else.** The tally sentence
   * is for a run that assessed real candidates and showed none of them — here there were none
   * to assess, so "none cleared the cutoff" would be true and useless, and would sit next to a
   * sentence already saying why. (The name said "says nothing"; the assertion never did.)
   */
  it('reports the floor but does not call a wholly capped run an empty one', () => {
    const { said, warner } = warnings()
    reportOnRun(warner, [tip(false, ['capped']), tip(false, ['capped'])])
    expect(said.join(' ')).toMatch(/took the checkpoint’s lowest score/)
    expect(said.join(' ')).not.toMatch(/None of the/)
  })

  /**
   * **The partial branch**, which said the opposite of what happened for a round: "3 of the 10
   * searched ends *could* have a patch box read around them", in the sentence whose whole job
   * is to say what went wrong. The all-refused branch was right, which is how it survived — two
   * sentences sharing a shape and not a statement.
   */
  it('says a patch box could not be read, whether some ends failed or all of them', () => {
    const refused = (): PublishedEnd => {
      const one = tip(false)
      return { ...one, scores: { ...one.scores!, refusal: 'the box lies outside the volume' } }
    }
    const some = warnings()
    reportOnRun(some.warner, [refused(), tip(true), tip(true)])
    expect(some.said.join(' ')).toMatch(/1 of the 3 searched ends could not have a patch box/)

    const every = warnings()
    reportOnRun(every.warner, [refused(), refused()])
    expect(every.said.join(' ')).toMatch(/No patch box could be read around any of the 2/)
    expect(every.said.join(' ')).not.toMatch(/could have a patch box/)
  })

  it('names the two reasons a candidate carried the floor apart', () => {
    const { said, warner } = warnings()
    reportOnRun(warner, [tip(true, ['', 'capped', 'no patch'])])
    expect(said.join(' ')).toMatch(/1 past `Assess top`/)
    expect(said.join(' ')).toMatch(/1 with no patch to cut/)
  })

  /**
   * The chunk cache's own tally. The run is bandwidth-bound and a chunk is wider than either box
   * an end reads, so a poor hit rate is not a fact about the data — it is a budget too small to
   * hold one end's working set, or ends arriving in an order that defeats one. Both are the
   * reader's to fix, and this is the only place either is visible.
   */
  describe('what it says about the reading', () => {
    const MB = 1024 * 1024
    /** A cache that was switched on, unless the test says otherwise. */
    const reads = (asked: number, hits: number, budget = 512 * MB) => ({ asked, hits, budget })

    it('says nothing about a cache that is doing its job', () => {
      const { said, warner } = warnings()
      reportOnRun(warner, [tip(true)], reads(200, 150))
      expect(said).toEqual([])
    })

    it('names the share and both ways to fix it when most reads miss', () => {
      const { said, warner } = warnings()
      reportOnRun(warner, [tip(true)], reads(200, 40))
      const text = said.join(' ')
      expect(text).toMatch(/160 chunks of segmentation were fetched/)
      expect(text).toMatch(/20% of its reads/)
      expect(text).toMatch(/`Chunk cache`/)
      expect(text).toMatch(/`Sort` above this node/)
    })

    /**
     * **A reader who set `Chunk cache` to 0 made a decision.** At that budget every `set` is
     * refused and every `get` misses, so the counters are indistinguishable from a cache doing
     * badly — and advice to raise a number they chose, perhaps because the machine has no
     * memory to spare, is the sentence `docs/limits.md` says teaches a reader to dismiss the
     * next one.
     */
    it('says nothing to a reader who turned the cache off', () => {
      const { said, warner } = warnings()
      reportOnRun(warner, [tip(true)], reads(200, 0, 0))
      expect(said).toEqual([])
    })

    /**
     * A run of two ends is about 48 reads and its first box can hit nothing, so a short run is
     * *expected* to look bad. Reporting there would teach a reader to dismiss the sentence,
     * which `docs/limits.md` records as the way a warning stops working.
     */
    it('stays quiet on a run too short for the share to mean anything', () => {
      const { said, warner } = warnings()
      reportOnRun(warner, [tip(true)], reads(24, 0))
      expect(said).toEqual([])
    })

    /** A run with no cache at all — a probe, a test — reports nothing rather than 0%. */
    it('says nothing where no cache was passed', () => {
      const { said, warner } = warnings()
      reportOnRun(warner, [tip(true)])
      expect(said).toEqual([])
    })
  })
})
