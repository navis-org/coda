/**
 * One Simulate run, in a worker where there is one: settle once, the main run, then each summary
 * partner alone — one job, because the solver's memos are keyed by object identity and a model
 * arrives in the worker as a clone, so they pay off only inside a single job.
 *
 * Headless and free of anything the worker should not load: the solver, the bridge to it, and the
 * job helper. What maps results back onto the skeleton stays on the main thread.
 */

import { SLICE_MS, throwIfAborted, yieldToBrowser } from '../../core/slice'
import { hashValue } from '../../core/hash'
import type { JobRunOptions } from '../../data/workerJob'
import type { CurrentClamp, Settled } from '../../biophys/solver'
import type { SimulationRequest } from '../../biophys/solver'
import { Simulation, frameCount, settle, settleSliced } from '../../biophys/solver'
import type { SolverModelValue } from './solverInputs'
import { cellModelOf, eventsFor, partnerCompartments, partnerDelays } from './solverInputs'

export interface SimulateJob {
  readonly model: SolverModelValue
  /** ms */
  readonly dt: number
  readonly duration: number
  readonly sampleEvery: number
  /** Compartments to record; the soma first. */
  readonly record: Int32Array
  /** Upward crossings of this voltage, mV, count as spikes at the record sites. */
  readonly threshold: number
  /** Partner index → spike times, ms, for the main run. */
  readonly firing: readonly (readonly [number, readonly number[]])[]
  /** Current injected at record sites, one clamp per compartment; none when off. */
  readonly clamps: readonly CurrentClamp[]
  /**
   * A model with channels at rest, from an earlier run at this `dt`: settling depends on nothing
   * else, and a worker keeps nothing between jobs, so the page hands it back rather than have
   * every Run settle again.
   */
  readonly rest?: Settled
  /** Also run every firing partner alone, one spike at `onset`, for `window` ms. */
  readonly summary?: { readonly onset: number; readonly window: number }
}

export interface SimulateResult {
  readonly t: Float64Array
  /** One trace per record site, mV. */
  readonly traces: Float64Array[]
  /** Per record site, the spike times, ms. */
  readonly spikes: Float64Array[]
  /** Per compartment, the highest membrane voltage over the main run, mV, the start included. */
  readonly peak: Float64Array
  /** Per compartment, the voltage the main run ended on, mV: whether the cell came back to rest. */
  readonly final: Float64Array
  /** A model with channels: the state it settled to before t = 0, and how long that took. */
  readonly settle?: Settled
  /**
   * Indexed by partner: peak ΔV at the soma and at its own synapses (mV), signed — the larger of
   * the rise and the fall from rest, so an inhibitory partner's is negative — `NaN` for a partner
   * that did not run alone, and whether the soma spiked.
   */
  readonly summary?: {
    readonly somaPeak: Float64Array
    readonly localPeak: Float64Array
    readonly spiked: Uint8Array
    /** Partners left unmeasured because the soma was still rising when the window closed. */
    readonly cut: number
  }
}

/**
 * What a movie is a replay of: everything about a job that moves a compartment's voltage — its
 * timing and its drive — and nothing that only says where the run records. Two jobs with one basis
 * (on one model) give one movie, so a record site added since the run, a Playback trace clicked,
 * leaves the movie Playback has as true as it was.
 */
export function movieBasis(job: SimulateJob): string {
  // What is left out is named, not what is kept, so a field added to the job counts by default.
  // The model is the caller's to compare (this is its solver form), and `rest` follows from it.
  const {
    model: _model,
    record: _record,
    threshold: _threshold,
    rest: _rest,
    summary: _summary,
    ...basis
  } = job
  return hashValue(basis)
}

/**
 * Whether a partner's spike at the summary's onset reaches a synapse before its window closes —
 * the job's test for running it alone, and the plan's for saying it will not be.
 */
export function reachesInWindow(
  summary: NonNullable<SimulateJob['summary']>,
  firstDelay: number,
): boolean {
  return summary.onset + firstDelay < summary.window
}

/** Solver steps the main run takes. */
function mainSteps(job: Pick<SimulateJob, 'duration' | 'dt'>): number {
  return Math.round(job.duration / job.dt)
}

/**
 * Bytes the traces take: a float64 per record site per sample, twice — the worker's arrays, then the
 * table's columns on the page. Two independently set numbers multiply here (sites and samples), so
 * the product is checked before anything is allocated (`planRun`).
 */
export function traceBytes(
  job: Pick<SimulateJob, 'record' | 'duration' | 'dt' | 'sampleEvery'>,
): number {
  const samples = Math.floor(mainSteps(job) / sampleSteps(job)) + 1
  // One column per record site, and the time column beside them.
  return 2 * 8 * (job.record.length + 1) * samples
}

/** Solver steps between the traces' samples: `Sample every` in whole steps of `dt`, at least one. */
function sampleSteps(job: Pick<SimulateJob, 'sampleEvery' | 'dt'>): number {
  return Math.max(1, Math.round(job.sampleEvery / job.dt))
}

/** Solver steps a job takes: the main run, then one window per firing partner. */
export function jobSteps(job: SimulateJob): number {
  const main = mainSteps(job)
  return job.summary ? main + Math.round(job.summary.window / job.dt) * job.firing.length : main
}

/** Compartment-steps between progress reports and cancel checks: a few dozen ms of work. */
const WORK_PER_SLICE = 2e6

/**
 * Each compartment's rest: where the model settled, or its leak reversal for a passive one, which
 * rests there exactly. The one definition, for the job's own deflections and the card's note.
 */
export function restOf(
  value: Pick<SimulateJob['model'], 'membrane'>,
  settled: Settled | undefined,
): (compartment: number) => number {
  const { eLeak } = value.membrane
  return (c) => settled?.state.v[c] ?? eLeak
}

/** The model at rest before anything happens: exact for a passive cell, settled where channels move it. */
async function startOf(job: SimulateJob, options: JobRunOptions) {
  const { model: value, dt } = job
  const model = cellModelOf(value)
  const { eLeak } = value.membrane
  let settled = job.rest
  if (!settled && value.channels.length > 0) {
    options.onProgress?.(0, 'settling')
    // On the page's own thread (a signal and no worker to terminate), up to two seconds of
    // simulated settling must yield to see a Cancel, as the run after it does; in a worker, not.
    let last = performance.now()
    settled = options.signal
      ? await settleSliced(
          model,
          eLeak,
          async () => {
            throwIfAborted(options.signal)
            // A frame's worth of work between yields, not a timer per millisecond of settling.
            if (performance.now() - last < SLICE_MS) return
            await yieldToBrowser()
            last = performance.now()
          },
          { dt },
        )
      : settle(model, eLeak, { dt })
  }
  return {
    model,
    settled,
    initial: settled?.state ?? { v: eLeak },
    restAt: restOf(value, settled),
  }
}

/**
 * The main run's request, everything but what it records: one builder for the card's run and the
 * movie's replay, so the replay cannot drift from the run it claims to be.
 */
function mainRequest(
  job: SimulateJob,
  model: SimulationRequest['model'],
  initial: SimulationRequest['initial'],
) {
  return {
    model,
    dt: job.dt,
    duration: job.duration,
    initial,
    events: eventsFor(job.model, new Map(job.firing)),
    clamps: job.clamps,
  }
}

/** Runs advanced a slice at a time, reporting progress over `total` steps and seeing a cancel. */
function slicer(job: SimulateJob, total: number, options: JobRunOptions) {
  const perSlice = Math.max(20, Math.ceil(WORK_PER_SLICE / job.model.compartments.count))
  let done = 0
  return async (run: Simulation, label: string) => {
    while (!run.done) {
      throwIfAborted(options.signal)
      const before = run.stepsDone
      run.advance(perSlice)
      done += run.stepsDone - before
      options.onProgress?.(done / Math.max(1, total), label)
      // A signal means this thread, with no worker to terminate: yield so a cancel can be seen.
      // In a worker there is none, and a yield would only cost a timer per slice.
      if (options.signal) await yieldToBrowser()
    }
  }
}

export async function runSimulateJob(
  job: SimulateJob,
  options: JobRunOptions = {},
): Promise<SimulateResult> {
  const { model: value, dt, threshold } = job
  const soma = job.record[0]!
  const { model, settled, initial, restAt } = await startOf(job, options)
  const advance = slicer(job, jobSteps(job), options)

  const main = new Simulation({
    ...mainRequest(job, model, initial),
    record: job.record,
    sampleEvery: sampleSteps(job),
    threshold,
    // Every compartment's highest voltage, read every step: the Arbour output. Measured at about
    // 6% of a run (8,077 compartments), on the main run only.
    peaks: true,
  })
  await advance(main, 'simulating')
  const result = main.result()

  let summary: SimulateResult['summary']
  if (job.summary) {
    const { onset, window } = job.summary
    const partners = value.partners.id.length
    const somaPeak = new Float64Array(partners).fill(NaN)
    const localPeak = new Float64Array(partners).fill(NaN)
    const spiked = new Uint8Array(partners)
    let cut = 0
    // A partner whose spike reaches none of its synapses inside the window is not measured: its
    // peaks would be the solver's noise, and their ratio a plausible attenuation (`planRun` says so).
    const { min: firstDelay } = partnerDelays(value)
    // Record only the soma and the partner's own synapses: their peaks are read every step.
    for (const [i, [p]] of job.firing.entries()) {
      if (!reachesInWindow(job.summary, firstDelay[p]!)) continue
      const record = Int32Array.of(soma, ...partnerCompartments(value, p))
      const run = new Simulation({
        model,
        dt,
        duration: window,
        initial,
        events: eventsFor(value, new Map([[p, [onset]]])),
        record,
        sampleEvery: Math.max(1, Math.round(window / dt)),
        threshold,
      })
      await advance(run, `partner ${i + 1} of ${job.firing.length}`)
      const { recordPeak, recordTrough, recordPeakAt, recordTroughAt, spikes } = run.result()
      // The larger of the rise and the fall from rest at record site `r`, signed, and when it was.
      const extreme = (r: number) => {
        const rest = restAt(record[r]!)
        const up = recordPeak[r]! - rest
        const down = recordTrough[r]! - rest
        return up >= -down
          ? { d: up, at: recordPeakAt[r]! }
          : { d: down, at: recordTroughAt[r]! }
      }
      const atSoma = extreme(0)
      // Its peak on the window's last step: the response was still rising when the window closed,
      // so the peak — and the attenuation — would be a cut-off one, plausible and wrong. A response
      // that peaked earlier and is still decaying is over, and measured.
      if (atSoma.d !== 0 && atSoma.at >= window - dt / 2) {
        cut++
        continue
      }
      somaPeak[p] = atSoma.d
      let local = 0
      for (let r = 1; r < record.length; r++) {
        const { d } = extreme(r)
        if (Math.abs(d) > Math.abs(local)) local = d
      }
      localPeak[p] = local
      spiked[p] = spikes![0]!.length > 0 ? 1 : 0
    }
    summary = { somaPeak, localPeak, spiked, cut }
  }

  return {
    t: result.t,
    traces: [...result.v],
    spikes: [...(result.spikes ?? [])],
    peak: result.peak!,
    final: Float64Array.from(main.voltage()),
    settle: settled,
    summary,
  }
}

/**
 * The most a movie may hold, bytes. Past it the frames are spaced further apart than `Sample
 * every` asks, and the view says so: a quarter of `CRASH_FLOOR_BYTES`, since the movie sits beside
 * everything else the tab holds.
 */
export const MOVIE_BUDGET_BYTES = 128 * 1024 ** 2

/**
 * Steps between a movie's frames: the run's own `Sample every`, so the movie is as fine as the
 * traces — or, where that would hold more than `MOVIE_BUDGET_BYTES`, the closest spacing that fits.
 */
export function movieFrameSteps(
  job: Pick<SimulateJob, 'duration' | 'dt' | 'sampleEvery' | 'model'>,
): number {
  const steps = mainSteps(job)
  const asked = sampleSteps(job)
  const fit = Math.floor(
    MOVIE_BUDGET_BYTES / (job.model.compartments.count * Float32Array.BYTES_PER_ELEMENT),
  )
  if (frameCount(steps, asked) <= fit) return asked
  // The fewest steps between frames that keeps `frameCount` within `fit`.
  return Math.max(asked, Math.ceil(steps / Math.max(1, fit - 1)))
}

/** Every compartment's voltage through a run, frame by frame. */
export interface Movie {
  /** Frame-major: frame `f`, compartment `c` at `f · count + c`, mV. */
  readonly frames: Float32Array
  readonly count: number
  /** How many frames: `frames.length / count`, said once. */
  readonly length: number
  /** ms between frames; frame `f` is at `f · frameMs`. */
  readonly frameMs: number
  /** Whether the frames are further apart than the traces' samples, the movie being too large. */
  readonly coarse: boolean
}

/**
 * The main run of a job again, every compartment recorded every `movieFrameSteps` — what Playback
 * shows. Its size is bounded by `MOVIE_BUDGET_BYTES` through that spacing, so it needs no check
 * of its own. The same run to the bit as the one behind the card's traces: the trains are seeded, the
 * rest is the job's own (`rest`, kept by the page), and nothing else differs. None of the summary
 * runs, and no record sites or threshold: only the movie.
 */
export async function runMovieJob(
  job: SimulateJob,
  options: JobRunOptions = {},
): Promise<Movie> {
  const { model, initial } = await startOf(job, options)
  const every = movieFrameSteps(job)
  const run = new Simulation({
    ...mainRequest(job, model, initial),
    record: new Int32Array(),
    frames: every,
  })
  await slicer(job, run.steps, options)(run, 'recording')
  return {
    frames: run.result().frames!,
    count: job.model.compartments.count,
    length: frameCount(run.steps, every),
    frameMs: every * job.dt,
    coarse: every > sampleSteps(job),
  }
}
