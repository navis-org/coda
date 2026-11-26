/**
 * The run's own account of where its seconds went.
 *
 * Two things are worth pinning and neither is the arithmetic. A wrapped step must charge its
 * stage **even when it throws**, because a run that failed slowly is exactly the one somebody
 * wants the split for. And the report must stay quiet on a run too short for the split to mean
 * anything — `docs/limits.md` records what happens to a channel that speaks when there is
 * nothing to do.
 */

import { describe, expect, it } from 'vitest'

import { TIMING_WORTH_REPORTING_SECONDS, runClock } from './runClock'

/** A clock the test moves by hand, so nothing here waits or flakes. */
function fake() {
  let now = 0
  const clock = runClock(() => now)
  return { clock, tick: (ms: number) => (now += ms) }
}

/** A step that takes `ms` on the fake clock, optionally failing at the end of it. */
const step = (tick: (ms: number) => void, ms: number, fail = false) => {
  return async () => {
    tick(ms)
    if (fail) throw new Error('nope')
    return 'done'
  }
}

describe('the run clock', () => {
  /**
   * The card's sentence (user, 2026-11-18): the wait, the two stages that took most of it, and
   * the levers. The per-stage shapes and the network's rate are `detail`, for the console.
   */
  it('says the wait and the two biggest stages in one sentence, the rest in the detail', async () => {
    const { clock, tick } = fake()
    await clock.around('reading the search box', step(tick, 40_000))()
    await clock.around('running the network', step(tick, 30_000))()
    await clock.around('measuring the pool', step(tick, 10_000))()
    const { said, detail } = clock.report({ ends: 10, patches: 0 })!
    expect(said).toBe(
      '10 ends took 8.0 s each, mostly reading the search box (50%) and running the network ' +
        '(38%). To speed this up, raise `Chunk cache`, or filter the ends above this node.',
    )
    expect(detail).toMatch(/measuring the pool 13%/)
  })

  it('charges a wrapped step to its stage', async () => {
    const { clock, tick } = fake()
    await clock.around('measuring the pool', step(tick, 40_000))()
    await clock.around('reading the search box', step(tick, 30_000))()
    const said = clock.report({ ends: 10, patches: 0 })!.detail
    expect(said).toMatch(/measuring the pool 57%/)
    expect(said).toMatch(/reading the search box 43%/)
  })

  /**
   * In a `finally`, because the run that most wants the split is the one that gave up slowly —
   * and because a step that throws has still spent whatever it spent.
   */
  it('charges a step that threw', async () => {
    const { clock, tick } = fake()
    await expect(
      clock.around('reading the patch box', step(tick, 70_000, true))(),
    ).rejects.toThrow()
    expect(clock.report({ ends: 10, patches: 0 })?.detail).toMatch(/reading the patch box 100%/)
  })

  /*
   * Three patches in flight on one queue: each call's own span counts the ones ahead of it
   * (10, 20 and 30 ms), but the GPU was busy 30 ms. The queue's time is charged, once.
   */
  it('charges a queue the time it was busy, not each call its wait', async () => {
    const { clock, tick } = fake()
    const answers: (() => void)[] = []
    const run = clock.aroundQueue(
      'running the network',
      () => new Promise<void>((resolve) => answers.push(resolve)),
    )
    const calls = [run(), run(), run()]
    for (const answer of answers) {
      tick(10)
      answer()
      await Promise.resolve()
      await Promise.resolve()
    }
    await Promise.all(calls)
    expect(clock.spent('running the network')).toBe(30)
    // Idle between two bursts is not charged: the next call starts the clock again.
    tick(100)
    const late = run()
    tick(5)
    answers[3]!()
    await late
    expect(clock.spent('running the network')).toBe(35)
  })

  /** The clock is moved as well as charged: `spend` names work that really took wall time. */
  it('takes a stage charged directly, for work behind no step', () => {
    const { clock, tick } = fake()
    tick(70_000)
    clock.spend('rebuilding the published tables', 70_000)
    expect(clock.report({ ends: 10, patches: 0 })?.detail).toMatch(
      /rebuilding the published tables 100%/,
    )
  })

  /**
   * **The wait and the sum of the stages are two numbers**, and since the run began overlapping
   * them they differ. What a reader sat through is wall clock; what the stages come to counts a
   * second twice wherever two of them ran together. Adding the stages up and calling the answer
   * the wait was right while everything was serial and is an over-statement now.
   */
  /** Two stages of 50 s charged over 70 s of wall clock: 30 s of the 100 ran alongside. */
  const overlapping = () => {
    const { clock, tick } = fake()
    tick(70_000)
    clock.spend('reading the search box', 50_000)
    clock.spend('running the network', 50_000)
    return clock.report({ ends: 10, patches: 0 })!.detail
  }

  it('states the wait and the work separately', async () => {
    const said = overlapping()
    expect(said).toMatch(/10 ends took 7.0 s each/)
    expect(said).toMatch(/come to 10.0 s of work an end/)
  })

  /**
   * The gap is the useful part: it says how much of a stage is already hidden behind another,
   * and therefore whether attacking it would buy a reader anything at all.
   */
  it('says how much of the work ran alongside something else', async () => {
    expect(overlapping()).toMatch(/30% of it alongside something else/)
  })

  /**
   * **Quiet where the run was serial.** The timed stages are most of a run and never all of it,
   * so their sum sits a little under the wait — and a report claiming a few per cent of
   * concurrency from that shortfall would be noise wearing the authority of a measurement.
   */
  it('says nothing about overlap in a run whose stages did not overlap', async () => {
    const { clock, tick } = fake()
    await clock.around('reading the search box', step(tick, 35_000))()
    await clock.around('running the network', step(tick, 35_000))()
    // A little wall clock that no stage claimed, as a real run always has.
    tick(4_000)
    expect(clock.report({ ends: 10, patches: 0 })?.detail).not.toMatch(/alongside/)
  })

  /** A minute. Shorter and the split is one cold end rather than a fact about the run. */
  it('says nothing about a run too short for the split to be stable', async () => {
    const { clock, tick } = fake()
    await clock.around(
      'measuring the pool',
      step(tick, TIMING_WORTH_REPORTING_SECONDS * 1000 - 1),
    )()
    expect(clock.report({ ends: 10, patches: 0 })).toBeUndefined()
  })

  it('says nothing where no end was searched', () => {
    const { clock } = fake()
    clock.spend('measuring the pool', 600_000)
    expect(clock.report({ ends: 0, patches: 0 })).toBeUndefined()
  })

  /**
   * A rate, because the total is the one number the reader already has — they sat through it —
   * and what they can act on is what one more end would cost.
   */
  it('states the cost of an end, not the cost of the run', async () => {
    const { clock, tick } = fake()
    await clock.around('measuring the pool', step(tick, 100_000))()
    expect(clock.report({ ends: 25, patches: 0 })?.detail).toMatch(/25 ends took 4.0 s each/)
  })

  /**
   * **Gated on the wait, not on the sum.** Under overlap the sum is the larger of the two, so
   * gating on it would let a run speak about half a minute it never spent.
   */
  it('says nothing about a short run whose overlapping stages sum past the threshold', () => {
    const { clock, tick } = fake()
    tick(30_000)
    clock.spend('reading the search box', 30_000)
    clock.spend('running the network', 30_000)
    expect(clock.report({ ends: 10, patches: 0 })).toBeUndefined()
  })

  /**
   * **Every stage gets a shape once it has enough calls**, not only the network — the question
   * "did this stage get slower or did it start waiting" is the one `shapeOf` answers, and it is
   * asked about the stages the network is overlapped against.
   */
  it('names the shape of any stage with enough calls, not only the network', async () => {
    const { clock, tick } = fake()
    for (let i = 0; i < 25; i++) {
      await clock.around('cutting patches', step(tick, i < 5 ? 1_000 : 10_000))()
    }
    const said = clock.report({ ends: 25, patches: 0 })!.detail
    expect(said).toMatch(/cutting patches 100% \(best 1000, median 10000/)
    // No rate: a patch count is the network's denominator and means nothing for a cut.
    expect(said).not.toMatch(/a patch\)/)
  })

  /** A stage worth a fraction of a per cent is noise in the line rather than information. */
  it('folds away a stage too small to act on', async () => {
    const { clock, tick } = fake()
    await clock.around('measuring the pool', step(tick, 99_000))()
    await clock.around('pool sizes', step(tick, 1_000))()
    const said = clock.report({ ends: 10, patches: 0 })!.detail
    expect(said).toMatch(/measuring the pool 99%/)
    expect(said).not.toMatch(/pool sizes/)
  })

  /**
   * **The rate, not only the share.** The same 25 ends on one laptop put the same network at
   * 27 ms a patch in Chrome and 98 in Firefox — the share says how the run divided, the rate
   * says whether that is the work or the browser, and only the second tells a reader whether
   * `Assess top` is worth the answers it costs.
   */
  it('names what the network cost a patch, where it ran any', async () => {
    const { clock, tick } = fake()
    await clock.around('running the network', step(tick, 91_000))()
    expect(clock.report({ ends: 10, patches: 1000 })?.detail).toMatch(
      /running the network 100% \(91 ms a patch\)/,
    )
  })

  /**
   * **The best call beside the average**, which is the number that tells a slow machine from a
   * slow run: the same network measured 26.5 ms a patch in a probe that does nothing else and
   * 91 ms inside a run on the same GPU. A total cannot tell those apart; a minimum near the
   * probe's figure says the graph is fine and the run is losing the rest around it. Here it
   * said the opposite, and the cause turned out to be the browser rather than the loop.
   */
  it('says nothing about the shape of too few calls to have one', async () => {
    const { clock, tick } = fake()
    const run = clock.around('running the network', step(tick, 30_000))
    await run()
    await clock.around('running the network', step(tick, 90_000))()
    const said = clock.report({ ends: 2, patches: 2 })!.detail
    expect(said).toMatch(/60000 ms a patch\)/)
    expect(said).not.toMatch(/median/)
  })

  /**
   * **The shape, which is what tells three explanations apart.** A median near the best with a
   * higher mean is something periodic stealing time from some calls; a median near the mean is a
   * cost nearly every call carries; a last fifth well above the first is a machine getting
   * slower as the run goes on. The measurement that prompted this had a best of 47 ms against
   * an average of 90, and no way to say which of the three it was. It was the fourth: a browser
   * whose every dispatch costs more (Firefox), which looks like the second.
   */
  it('names the shape of the network’s calls once there are enough to have one', async () => {
    const { clock, tick } = fake()
    // Twenty-five calls: five fast, then twenty slow. Bimodal, and getting worse. The seconds
    // are large because a report says nothing at all about a run under a minute.
    for (let i = 0; i < 25; i++) {
      await clock.around('running the network', step(tick, i < 5 ? 1_000 : 10_000))()
    }
    const said = clock.report({ ends: 1, patches: 25 })!.detail
    expect(said).toMatch(/best 1000/)
    expect(said).toMatch(/median 10000/)
    expect(said).toMatch(/first fifth 1000 and last 10000/)
  })

  /** A capped run can score none at all, and "NaN ms a patch" is worse than saying nothing. */
  it('names no rate where the network ran nothing', async () => {
    const { clock, tick } = fake()
    await clock.around('running the network', step(tick, 70_000))()
    const said = clock.report({ ends: 10, patches: 0 })!.detail
    expect(said).toMatch(/running the network 100%/)
    expect(said).not.toMatch(/a patch/)
  })

  /**
   * Each stage names the control that moves it; a split nobody can act on is just a number.
   * `Assess top` only where something was assessed — without an assessor it is hidden.
   */
  it('names what a reader can do about it', async () => {
    const { clock, tick } = fake()
    await clock.around('reading the search box', step(tick, 70_000))()
    const assessed = clock.report({ ends: 10, patches: 100 })!.said
    expect(assessed).toMatch(/`Chunk cache`/)
    expect(assessed).toMatch(/`Assess top`/)
    expect(assessed).toMatch(/filter the ends/)
    expect(clock.report({ ends: 10, patches: 0 })!.said).not.toMatch(/`Assess top`/)
  })

  /**
   * The chunk cache's share of the reads, as a clause of the sentence (user, 2026-11-26) — it was
   * a warning of its own. Silent where the share means nothing: a cache switched off (every read
   * misses, by the reader's decision), a run too short for the share to settle, no cache at all.
   */
  describe('the chunk cache', () => {
    const MB = 1024 * 1024
    const reads = (asked: number, hits: number, budget = 512 * MB) => ({ asked, hits, budget })
    const said = async (got?: ReturnType<typeof reads>) => {
      const { clock, tick } = fake()
      await clock.around('reading the search box', step(tick, 70_000))()
      return clock.report({ ends: 10, patches: 0, ...(got ? { reads: got } : {}) })!.said
    }

    it('gives its hit rate', async () => {
      expect(await said(reads(200, 40))).toMatch(/; `Chunk cache` answered 20% of reads\./)
    })

    it('says nothing of a cache that was switched off', async () => {
      expect(await said(reads(200, 0, 0))).not.toMatch(/answered/)
    })

    it('says nothing on a run too short for the share to mean anything', async () => {
      expect(await said(reads(24, 0))).not.toMatch(/answered/)
    })

    it('says nothing where no cache was passed', async () => {
      expect(await said()).not.toMatch(/answered/)
    })
  })
})
