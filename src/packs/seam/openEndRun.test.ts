/**
 * The sweep, driven with fake pages — which is the whole reason it is not inside `evaluate`.
 *
 * Every failure here is a number rather than an error: a tip settled one page early keeps a
 * lower score and is never looked at again, a tip never settled is a row that does not appear,
 * and a sweep that settles everything on the last page is a node that works and does not stream.
 * None of that is reachable from a test if the sequence lives in the node, because scoring a
 * page needs Pyodide, a GPU and a neuron.
 */

import { describe, expect, it, vi } from 'vitest'

import { runOpenEnds } from './openEndRun'

/** Three tips in a line, 10 µm apart. */
const TIPS = Float32Array.from([0, 0, 0, 10_000, 0, 0, 20_000, 0, 0])
/** One centre on each tip, plus one nothing is waiting on. */
const CENTRES = Float32Array.from([0, 0, 0, 10_000, 0, 0, 20_000, 0, 0, 900_000, 0, 0])
/** Tight enough that each centre reaches exactly its own tip. */
const WITHIN = 1000
const REACH = 1000

/** A page that scores one cell, on the first centre it was asked for. */
const scoreAt = (value: (centre: number) => number) => async (centres: Int32Array) => {
  const centre = centres[0]!
  return {
    cellsNm: Float32Array.from([
      CENTRES[centre * 3]!,
      CENTRES[centre * 3 + 1]!,
      CENTRES[centre * 3 + 2]!,
    ]),
    scores: Float32Array.from([value(centre)]),
  }
}

/** The common options, so each case states only what it is about. */
const run = (over: Partial<Parameters<typeof runOpenEnds>[0]>) =>
  runOpenEnds({
    tipsNm: TIPS,
    centresNm: CENTRES,
    within: WITHIN,
    tipReachNm: REACH,
    // Cells half a micrometre across, as every SEAM checkpoint pools at.
    cellUm: 0.5,
    pageSize: 1,
    score: scoreAt((centre) => centre),
    onSettled: () => {},
    ...over,
  })

describe('runOpenEnds', () => {
  it('settles each tip on the page that finishes it, not at the end', async () => {
    const settled: number[][] = []
    const out = await run({
      score: scoreAt((centre) => centre),
      onSettled: (tips) => void settled.push([...tips]),
    })
    expect(settled).toEqual([[0], [1], [2]])
    expect([...out.best]).toEqual([0, 1, 2])
    expect(out.settled).toBe(3)
  })

  /** A window no tip is waiting on is work whose answer is never asked for. */
  it('never asks for a centre no tip needs', async () => {
    const asked: number[] = []
    const out = await run({
      pageSize: 4,
      score: async (centres) => {
        asked.push(...centres)
        return { cellsNm: new Float32Array(0), scores: new Float32Array(0) }
      },
      onSettled: () => {},
    })
    expect(asked).toEqual([0, 1, 2])
    expect(out.swept).toBe(3)
  })

  /**
   * The one that would otherwise hang a neuron: a centre whose cells hold no surface builds no
   * window, and a tip waiting on it has to be settled by it all the same.
   */
  it('settles a tip on a centre that scored nothing', async () => {
    const settled: number[][] = []
    await run({
      pageSize: 3,
      score: async () => ({ cellsNm: new Float32Array(0), scores: new Float32Array(0) }),
      onSettled: (tips, best) => void settled.push(tips.map((t) => best[t]!)),
    })
    expect(settled).toEqual([[-Infinity, -Infinity, -Infinity]])
  })

  /** A tip nothing reaches is finished before the sweep starts; nothing could ever settle it. */
  it('settles a tip no centre reaches, before anything is scored', async () => {
    const order: string[] = []
    const out = await run({
      tipsNm: Float32Array.from([0, 0, 0, 500_000, 0, 0]),
      centresNm: Float32Array.from([0, 0, 0]),
      score: async (centres) => {
        order.push('score')
        return scoreAt(() => 5)(centres)
      },
      onSettled: (tips) => void order.push(`settled ${tips.join(',')}`),
    })
    expect(order).toEqual(['settled 1', 'score', 'settled 0'])
    expect([...out.best]).toEqual([5, -Infinity])
  })

  /**
   * A settled tip is published and must not be revisited — its score cannot change, and folding
   * it again is work with no answer. Checked through the score it keeps rather than by counting
   * calls, which is what a reader would notice.
   */
  it('does not change a tip after it has settled', async () => {
    /*
     * Each centre settles its own tip (`within` is tight) while every cell reaches every tip
     * (`tipReachNm` is wide), so each page after the first would raise the score of a tip that
     * has already been published — if the fold did not skip it. Scores rise page by page, so the
     * answer says plainly which tips were left alone.
     */
    const settled: number[] = []
    const out = await run({
      tipReachNm: 1e9,
      score: scoreAt((centre) => centre * 100),
      onSettled: (tips) => void settled.push(...tips),
    })
    expect(settled).toEqual([0, 1, 2])
    expect([...out.best]).toEqual([0, 100, 200])
  })

  it('stops when the signal says so', async () => {
    const controller = new AbortController()
    const score = vi.fn(async (centres: Int32Array) => {
      controller.abort()
      return scoreAt(() => 1)(centres)
    })
    await expect(
      run({
        score,
        onSettled: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    expect(score).toHaveBeenCalledTimes(1)
  })

  it('a neuron with no tips sweeps nothing', async () => {
    const score = vi.fn()
    const out = await run({ tipsNm: new Float32Array(0), pageSize: 4, score })
    expect(score).not.toHaveBeenCalled()
    expect(out.swept).toBe(0)
    expect(out.settled).toBe(0)
  })
})
