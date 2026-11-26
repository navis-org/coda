/**
 * Where a run's seconds went, per stage, said once at the end.
 *
 * ## Why a node that takes ten minutes should be able to say what it spent them on
 *
 * A run of several hundred open ends is eight or nine things in a loop — two volume reads, three
 * bridge crossings, a chunkedgraph call, the assessor, and the tables rebuilt for each publish —
 * and they are spread across a GPU, a Pyodide worker, two servers and a browser's network stack.
 * Which of them dominates is not derivable from the code and is **not the same on two machines**:
 * every number in this pack's headers was taken on one laptop against one bucket, and a reader
 * on a slower link or a weaker GPU has a different bottleneck and no way to find out.
 *
 * The levers this node offers — `Chunk cache`, `Assess top`, a `Filter Table` above it, the
 * order its ends arrive in — each help with exactly one of those stages and none of the others.
 * Choosing between them without knowing the split is guessing, which is how a reader comes to
 * spend memory on a cache when their run is GPU-bound, or caps the candidates when their run is
 * waiting on the network.
 *
 * ## It is a clock, not a profiler
 *
 * Every step that can take real time is already a **function the node injects** — `SearchSteps`,
 * `AssessSteps`, an end's own `box()` — because the sequences that use them had to be testable
 * without a token or a GPU (`searchRun.ts`, `assessEnds.ts`). That seam is what this uses: each
 * step is wrapped once where the run builds it, and nothing inside the sequences knows. There is
 * no instrumentation to thread, nothing to remember to remove, and the stages are exactly the
 * boundaries somebody already drew.
 *
 * What it therefore does **not** see is the work between the steps: the forest, the own-tip rule,
 * the softmax. That is deliberate rather than a gap — all of it is arithmetic over a few hundred
 * rows, and a stage nobody can act on is a line in a report nobody reads.
 */

import { plural } from '../../style/format'

/**
 * The stages, in the order one end meets them.
 *
 * Named for what a reader would call them rather than for the function that does them: the
 * report is read by somebody deciding which control to reach for, and `coda_candidate_pool`
 * tells them nothing about which that is.
 */
export const STAGES = [
  'reading the search box',
  'measuring the pool',
  'chunk counts',
  'pool sizes',
  'reading the patch box',
  /*
   * **The assessor is three stages, not one**, and the split is the whole reason this file grew
   * past a curiosity. A first run put "cutting and scoring patches" at 63% of 9.0 s an end,
   * against a model that priced the inference at 1.06 s — so five seconds an end were going
   * somewhere inside a stage named for the GPU, and the three things in it answer to three
   * different controls. Handing a 13 M-voxel box to Pyodide is a smaller patch box; cutting is
   * the group size; the network is `Assess top` and which assessor was picked.
   */
  'handing the patch box to Python',
  'cutting patches',
  'running the network',
  'rebuilding the published tables',
] as const

export type Stage = (typeof STAGES)[number]

export interface RunClock {
  /**
   * Wrap a step so what it spends lands under `stage`.
   *
   * Wrapping rather than timing at the call site, because the call sites are inside the
   * sequences — which take these as arguments precisely so they can be driven by something with
   * no volume and no GPU. A timer in there would be a second thing those tests have to satisfy.
   */
  around<A extends readonly unknown[], R>(
    stage: Stage,
    step: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R>
  /**
   * `around` for a step whose calls wait in **one queue**, so a call's own duration counts the
   * calls ahead of it: the assessor with several patches in flight, where twelve outstanding
   * calls each lasting the twelve would charge the network twelve times over.
   *
   * Each call is charged the time since the previous call finished, or since it was made where
   * none was outstanding, so the stage comes to the time the queue was busy. No call's shape is
   * kept: a gap between two answers is no call's cost, and Firefox hands answers back in
   * batches, so the report gives such a stage its rate alone.
   */
  aroundQueue<A extends readonly unknown[], R>(
    stage: Stage,
    step: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R>
  /** Charge a stage directly, for work that is not behind an injected step. */
  spend(stage: Stage, ms: number): void
  /** What a stage has taken so far. */
  spent(stage: Stage): number
  /**
   * What the run spent, longest first — or undefined where there is nothing worth saying.
   *
   * `patches` is how many the assessor actually scored, and it is here rather than left out
   * because the share alone does not say what to do about it: "the network is half the run" is
   * a fact about this machine as much as about the work, and the rate is the only form of it a
   * reader can compare against anything.
   *
   * **Two different quantities, since the run began overlapping its stages.** How long an end
   * took is wall clock, measured from this clock's own making; what the stages come to is a sum
   * of the time each spent, which once two ends are in flight counts seconds twice. Adding the
   * stages up and calling the answer the wait was right while everything was serial and is a
   * plain over-statement now — and the gap between the two is itself the most useful number
   * here, because it says how much of a stage is already hidden behind another and therefore
   * whether attacking it would buy anything.
   */
  report(run: {
    ends: number
    patches: number
    /** The chunk cache's counters, where the run had one (`ChunkCache`). */
    reads?: ChunkReads
  }): TimingReport | undefined
}

/** What the report needs of a chunk cache: its counters and whether it was switched on at all. */
export interface ChunkReads {
  readonly asked: number
  readonly hits: number
  readonly budget: number
}

/**
 * How many chunk reads a run needs before its cache's hit rate is worth a clause.
 *
 * One end's two boxes are about 24 reads and the first of them can hit nothing, so a run of a
 * couple of ends is *expected* to look bad. Forty is a few ends in, by which point the number
 * says something about the walk rather than about its start.
 */
const READS_WORTH_REPORTING = 40

/**
 * The cache's share of the reads, as a clause of the timing sentence — or nothing.
 *
 * **A clause, not a warning of its own** (user, 2026-11-26): it is a debugging number like the
 * rest of the sentence, and the lever it points at (`Chunk cache`) is already named there. Silent
 * for a cache switched off (`budget` 0 is a decision, and every read would miss) and for a run
 * too short for the share to mean anything.
 */
function cacheClause(reads: ChunkReads | undefined): string {
  if (!reads || reads.budget === 0 || reads.asked < READS_WORTH_REPORTING) return ''
  return `; \`Chunk cache\` answered ${Math.round((100 * reads.hits) / reads.asked)}% of reads`
}

/**
 * The report in two lengths (user, 2026-11-18). `said` is the card's sentence: the wait, the two
 * stages that took most of it, and the levers. `detail` is everything above — every stage with
 * its shape and the network's rate a patch — for the browser console, where the reader who
 * needs it (two browsers, 27 ms a patch against 98) can still find it, and the card stays a
 * sentence a reader can act on.
 */
export interface TimingReport {
  readonly said: string
  readonly detail: string
}

/**
 * How long a run has to be before where its time went is worth a sentence.
 *
 * A minute, which is already a wait somebody has noticed and sat through. Shorter than that and
 * the split is both unstable — one cold end dominates it — and not worth acting on, and
 * `docs/limits.md` records what happens to a channel that speaks when there is nothing to do:
 * "a warning raised over half a minute teaches a reader to dismiss the next one".
 */
export const TIMING_WORTH_REPORTING_SECONDS = 60

/** A share below which a stage is dropped from the line rather than named — nothing prints a
 * tail, so the percentages simply do not sum to 100. */
const WORTH_NAMING = 0.05

/**
 * How much of the work has to have run alongside something else before the report says so.
 *
 * A twentieth. Below that the excess is as likely to be the stages not quite tiling the run —
 * they are most of it, never all — as it is to be real overlap, and a sentence claiming 2% of
 * concurrency would be noise given the authority of a measurement.
 */
const OVERLAP_WORTH_SAYING = 0.05

/**
 * The shape of a stage's calls, in the few words that tell three explanations apart.
 *
 * `best` and `median` together say whether the slow calls are most of them or a tail: a median
 * near the best with a mean above it is something periodic stealing time from some calls, and a
 * median near the mean is a cost nearly every call carries. The first and last fifths say
 * whether it gets worse as the run goes on, which is what sustained load on a GPU looks like and
 * nothing else does.
 *
 * Empty for a handful of calls, where the quintiles are one or two samples each and would read
 * as a trend that is not there.
 *
 * ## It worked, and the record is the reason this file is as long as it is
 *
 * The case it was built for: the assessor measured **26.5 ms a patch** in a probe that does
 * nothing else and **91** inside a run, and nothing on screen could say which half was at
 * fault. A best near 26 would have meant the graph was fine and the run was losing the
 * difference around it. Instead every call came back near 91 — median on the mean, no trend —
 * which sent the search into the call rather than around it, and a nine-rung ladder
 * (`pnpm probe:assessor-gap`) then cleared the loop, the Pyodide cut beside it, half a gigabyte
 * of held buffers, a blocked main thread and a repainting page, none worth 7 ms between them.
 *
 * The answer was a fourth explanation this line cannot distinguish and the reader could:
 * **two browsers**, 27 ms a patch in Chrome against 98 in Firefox on one laptop and one GPU
 * (`docs/seam-assessor-speed.md`). What made it findable was that a reader could report what their machine
 * did in the one unit that compares against anything, without this file knowing which browser
 * they were in. (And the browser was not the end of it: driven directly, Firefox waits ~100 ms
 * for any GPU answer, which keeping patches in flight shares out — 29 ms a patch since.)
 */
function shapeOf(calls: readonly number[]): string {
  if (calls.length < 20) return ''
  const sorted = [...calls].sort((a, b) => a - b)
  const fifth = Math.floor(calls.length / 5)
  const mean = (of: readonly number[]) => of.reduce((a, b) => a + b, 0) / of.length
  return (
    `, best ${Math.round(sorted[0]!)}` +
    `, median ${Math.round(sorted[Math.floor(sorted.length / 2)]!)}` +
    `, first fifth ${Math.round(mean(calls.slice(0, fifth)))}` +
    ` and last ${Math.round(mean(calls.slice(-fifth)))}`
  )
}

export function runClock(now: () => number = () => performance.now()): RunClock {
  /*
   * **The wall clock, from here.** The node makes this where the search begins — after the
   * model has been opened and consented to — so a 133 MB download is not charged to the ends.
   * Moving the construction earlier would silently fold that wait into "an end took".
   */
  const startedAt = now()
  const spent = new Map<Stage, number>()
  /**
   * Every call of every stage, in order.
   *
   * A total says that most calls are slower than the fastest; it does not say **why**, and the
   * explanations leave different marks. A run that heats up degrades from beginning to end. One
   * losing time to something periodic is bimodal — a median near the best with a mean well
   * above it. One in steady contention has a median near its mean and neither near the best.
   *
   * **Every stage, not just the network**, which is the special case this used to be. The
   * shapes wanted turn out to be on the *other* stages: when the search was pipelined against
   * the assessor, `cutting patches` appeared to slow down, and the question "did it get slower
   * or did it start waiting" is exactly the one `shapeOf` answers — it could not be asked,
   * because the samples were kept for one stage. A once-an-end stage is a few hundred numbers
   * over a long run, against the tens of thousands the network already kept.
   */
  const calls = new Map<Stage, number[]>()
  /** `aroundQueue`'s state: how many calls are out on a stage, and since when it is charged. */
  const queues = new Map<Stage, { outstanding: number; since: number }>()
  /** `sample` false charges the time without keeping it as a call, for `aroundQueue`. */
  const add = (stage: Stage, ms: number, sample = true) => {
    spent.set(stage, (spent.get(stage) ?? 0) + ms)
    if (!sample) return
    const seen = calls.get(stage)
    if (seen) seen.push(ms)
    else calls.set(stage, [ms])
  }

  return {
    around(stage, step) {
      return async (...args) => {
        const at = now()
        try {
          return await step(...args)
        } finally {
          // In a `finally`, so a step that throws or is cancelled still reports what it spent.
          // A run that failed slowly is exactly the one somebody wants the split for.
          add(stage, now() - at)
        }
      }
    },
    aroundQueue(stage, step) {
      return async (...args) => {
        // Per stage, not per wrapper, so two wrappers of one queue still share its clock.
        const queue = queues.get(stage) ?? { outstanding: 0, since: 0 }
        queues.set(stage, queue)
        if (queue.outstanding++ === 0) queue.since = now()
        try {
          return await step(...args)
        } finally {
          queue.outstanding -= 1
          const at = now()
          // Charged but not sampled: a gap between two answers is no call's cost, and answers
          // that arrive together would read as calls of 0 ms in `shapeOf`.
          add(stage, at - queue.since, false)
          queue.since = at
        }
      }
    },
    spend: add,
    spent: (stage) => spent.get(stage) ?? 0,
    report({ ends, patches, reads }) {
      const elapsed = now() - startedAt
      let total = 0
      for (const ms of spent.values()) total += ms
      /*
       * Gated on the **wait**, not on the sum of the stages: the wait is what a reader sat
       * through, and under overlap the sum is the larger of the two and would let a run speak
       * about half a minute it never spent.
       */
      if (elapsed < TIMING_WORTH_REPORTING_SECONDS * 1000 || ends === 0 || total === 0) {
        return undefined
      }
      const named = [...spent]
        .filter(([, ms]) => ms / total >= WORTH_NAMING)
        .sort((a, b) => b[1] - a[1])
        .map(([stage, ms]) => {
          const share = `${stage} ${Math.round((100 * ms) / total)}%`
          /*
           * **The rate, where there is one.** A share says how the run divided; it does not say
           * whether the number is the work, the machine or the browser. The same 25 ends on one
           * laptop once put the same network at 27 ms a patch in Chrome and 98 in Firefox — a
           * difference that decided whether `Assess top` was worth anything, and that nothing
           * else on screen revealed.
           */
          const shape = shapeOf(calls.get(stage) ?? [])
          /*
           * The rate is the network's alone — it is per *patch*, and `patches` is the only
           * denominator a reader can compare against another machine. Every stage gets its
           * shape, which is what says whether a stage is big or merely waiting.
           */
          if (stage !== 'running the network' || patches === 0) {
            return shape ? `${share} (${shape.replace(/^, /, '')})` : share
          }
          return `${share} (${Math.round(ms / patches)} ms a patch${shape})`
        })
      /*
       * **How much of the work ran alongside something else**, said only where there is some.
       * The timed stages are most of a run but not all of it, so a serial run has a sum a little
       * *under* the wait and this stays quiet; a pipelined one has a sum above it, and the
       * excess is the part a reader must not try to optimise twice. `OVERLAP_WORTH_SAYING`
       * keeps a percent or two of measurement noise from reading as a claim.
       */
      const overlap = 1 - elapsed / total
      const alongside =
        overlap >= OVERLAP_WORTH_SAYING
          ? `, ${Math.round(100 * overlap)}% of it alongside something else`
          : ''
      const each = `${plural(ends, 'end')} took ${(elapsed / 1000 / ends).toFixed(1)} s each`
      const most = [...spent]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .filter(([, ms]) => ms / total >= WORTH_NAMING)
        .map(([stage, ms]) => `${stage} (${Math.round((100 * ms) / total)}%)`)
      return {
        said:
          `${each}, mostly ${most.join(' and ')}${cacheClause(reads)}. To speed this up, ` +
          // `Assess top` only where something was assessed: it is hidden otherwise.
          (patches > 0
            ? 'raise `Chunk cache`, lower `Assess top`, or filter the ends above this node.'
            : 'raise `Chunk cache`, or filter the ends above this node.'),
        detail:
          `${each}. The stages this node times come to ` +
          `${(total / 1000 / ends).toFixed(1)} s of work an end${alongside}, in ms: ` +
          `${named.join(', ')}.`,
      }
    },
  }
}
