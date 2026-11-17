/**
 * The bookkeeping around the assessor, where every mistake is a number rather than an error.
 *
 * `assessorRun.test.ts` covers the graph loop — the prefetch, the floor, the refusals. What is
 * here is the layer above it: which candidates get a patch at all, what the ones that do not
 * carry, and what happens when no box can be read. Every one of those goes on to a softmax
 * within the tip's list, so a candidate quietly left out reshares every other candidate's
 * probability and nothing downstream can see it.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Triple } from '../../data/precomputed/volume'
import type { AssessorBoxRequest } from '../../pyodide/assessorPatches'
import { assessEnd } from './assessEnds'
import type { AssessSteps, PatchCut } from './assessEnds'

const FLOOR = -258.4

/** An end of `n` candidates, each a micrometre further along x than the last. */
function end(n: number, alias?: ReadonlyMap<bigint, bigint>) {
  return {
    queryRoot: 720n,
    candRoot: BigUint64Array.from({ length: n }, (_, i) => BigInt(100 + i)),
    contactsNm: Array.from({ length: n }, (_, i) => [i * 1000, 0, 0] as Triple),
    alias,
  }
}

/** Steps that answer what the test already knows: a logit per candidate, by position. */
function steps(logits: readonly number[], missing: readonly number[] = []): AssessSteps {
  return {
    box: vi.fn(
      async (cut: PatchCut) =>
        ({
          centresNm: Float64Array.from(cut.centresNm.flat()),
        }) as unknown as AssessorBoxRequest,
    ),
    score: vi.fn(async (request: AssessorBoxRequest) => {
      const given = request.centresNm.length / 3
      const out = new Float64Array(given).fill(FLOOR)
      for (let i = 0; i < given; i++) out[i] = logits[i] ?? FLOOR
      for (const at of missing) out[at] = FLOOR
      return {
        logits: Float32Array.from(out),
        missing: Int32Array.from(missing),
        scored: given - missing.length,
      }
    }),
  }
}

describe('assessEnd', () => {
  it('scores every candidate where no cap is set', async () => {
    const got = await assessEnd(end(3), FLOOR, steps([1, 2, 3]))
    expect([...got.score]).toEqual([1, 2, 3])
    expect([...got.filled]).toEqual(['', '', ''])
  })

  /**
   * A tip whose every candidate belonged to a nearer tip of the same neuron. It costs no box and
   * no patch, and it is an answer rather than a failure — `scoreList` gives such a tip the fit's
   * own `segclr` floor and a real `p_tip`.
   */
  it('reads no box at all for an end with no candidates', async () => {
    const run = steps([])
    const got = await assessEnd(end(0), FLOOR, run)
    expect(got.score).toHaveLength(0)
    expect(run.box).not.toHaveBeenCalled()
  })

  /**
   * **The cap floors the tail; it does not shorten the list.** A dropped row would reshare every
   * other candidate's probability, and a candidate absent from the answer is not "ranked last",
   * it is a merge nobody was offered.
   */
  it('floors everything past the cap, and says that is why', async () => {
    const got = await assessEnd(end(5), FLOOR, steps([1, 2]), { top: 2 })
    expect([...got.score]).toEqual([1, 2, FLOOR, FLOOR, FLOOR])
    expect([...got.filled]).toEqual(['', '', 'capped', 'capped', 'capped'])
  })

  /**
   * The cap's second saving, and the one a reader would not predict: the box is sized by the
   * contacts in it, so capping a list whose tail straggles shrinks the read as well as the
   * scoring.
   */
  it('sizes the box from the capped contacts only', async () => {
    const run = steps([1, 2])
    await assessEnd(end(5), FLOOR, run, { top: 2 })
    expect(run.box).toHaveBeenCalledWith({
      centresNm: [
        [0, 0, 0],
        [1000, 0, 0],
      ],
      // The capped tail is out of the request entirely, not just out of the scoring.
      candRoots: BigUint64Array.from([100n, 101n]),
      queryRoot: 720n,
      alias: undefined,
    })
  })

  it('hands the box the roots that are read as the query’s — an accepted piece’s path', async () => {
    // The search read the piece as part of the neuron; the patches have to be cut from the same
    // reading. Left off, the query had no voxel in a piece's patch box and the run failed.
    const alias = new Map([[801n, 720n]])
    const run = steps([1])
    await assessEnd(end(1, alias), FLOOR, run)
    expect(run.box).toHaveBeenCalledWith(expect.objectContaining({ queryRoot: 720n, alias }))
  })

  it('a cap no shorter than the list changes nothing', async () => {
    const got = await assessEnd(end(2), FLOOR, steps([4, 5]), { top: 9 })
    expect([...got.score]).toEqual([4, 5])
    expect([...got.filled]).toEqual(['', ''])
  })

  /**
   * Told apart from a capped one, because the two are fixed by different things — one by a param
   * a reader set, one by nothing they can do. Both carry the floor, which is what `scoreList`
   * reads; `filled` is the only place the difference survives.
   */
  it('marks a candidate the box could not cut a patch for', async () => {
    const got = await assessEnd(end(3), FLOOR, steps([1, 2, 3], [1]))
    expect([...got.filled]).toEqual(['', 'no patch', ''])
    expect(got.score[1]).toBe(FLOOR)
  })

  /**
   * One end's failure is not the run's — `SearchedEnd.refusal` is the same decision one stage
   * earlier. A patch box clamps to nothing at the edge of the volume, and a throw here would end
   * a run of several hundred after the expensive ends had been paid for.
   */
  it('carries a box that could not be read as a refusal, with every score at the floor', async () => {
    const broken: AssessSteps = {
      box: async () => {
        throw new Error('the box lies outside the volume')
      },
      score: vi.fn(),
    }
    const got = await assessEnd(end(2), FLOOR, broken)
    expect(got.refusal).toMatch(/outside the volume/)
    expect([...got.score]).toEqual([FLOOR, FLOOR])
    expect([...got.filled]).toEqual(['no patch', 'no patch'])
    expect(broken.score).not.toHaveBeenCalled()
  })

  /**
   * **A refused end has no *capped* candidates**, however short the cap was: `filled` says why a
   * candidate carries the floor, and here the reason is the same for every one of them — no box
   * could be read, so no patch was attempted for anyone. Marked `capped`, the tail made the
   * run's tally report "N past `Assess top`" about an end where the cap changed nothing, which
   * blames a control the reader set for a failure of the volume.
   */
  it('blames the box, not the cap, when the box could not be read', async () => {
    const broken: AssessSteps = {
      box: async () => {
        throw new Error('the box lies outside the volume')
      },
      score: vi.fn(),
    }
    const got = await assessEnd(end(4), FLOOR, broken, { top: 1 })
    expect([...got.filled]).toEqual(['no patch', 'no patch', 'no patch', 'no patch'])
  })

  /**
   * The one thing a length check buys that a type cannot: a short answer written in by position
   * leaves the tail of the list at its floor, which is a believable ranking of rows nobody
   * looked at.
   */
  it('refuses an answer that is not as long as the list it was given', async () => {
    const short: AssessSteps = {
      box: async (cut) =>
        ({
          centresNm: Float64Array.from(cut.centresNm.flat()),
        }) as unknown as AssessorBoxRequest,
      score: async () => ({
        logits: Float32Array.from([1]),
        missing: Int32Array.from([]),
        scored: 1,
      }),
    }
    await expect(assessEnd(end(3), FLOOR, short)).rejects.toThrow(/silently left at its floor/)
  })

  it('stops at a cancel before any box is read', async () => {
    const run = steps([1])
    await expect(
      assessEnd(end(2), FLOOR, run, { signal: AbortSignal.abort() }),
    ).rejects.toThrow()
    expect(run.box).not.toHaveBeenCalled()
  })
})
