/**
 * Fitting a model's passive membrane to a current-clamp recording: Rm, Cm, Ra, E_leak and a
 * membrane-area factor, by least squares on the recorded voltage (`biophys/leastSquares.ts`).
 * See `docs/biophys.md`, Fitting.
 *
 * **The model is rescaled, never rebuilt.** The membrane reaches the solver as a leak density
 * `1/Rm`, a reversal `E_leak`, a capacitance `cm` and the axial conductances, which scale as `1/Ra`
 * for a uniform Ra (`solverInputs.ts`); so an evaluation rescales those, and the compartment tree —
 * d_lambda's count included — is the one the model was built with, fixed for the whole fit.
 *
 * **The area factor** scales the membrane's area and nothing else: capacitance and leak both by
 * it, the axial path untouched. It is the usual correction for membrane a reconstruction misses
 * (spines, fine branches), so that Cm and Rm can keep specific values a cell could have. The model
 * sees only `Cm × area` and `area / Rm`, so the three cannot all be free — **the factor is fitted
 * against a pinned Cm**, 1 µF/cm² being the usual, and a fit freeing all three is refused.
 *
 * **Each sweep gets the current the cell got**: its own command replayed sample by sample at the
 * soma (`ClampShape` `samples`). **A passive response is linear**, so sweeps whose commands are
 * scaled copies of one waveform — an I–V's steps — share one simulation, the response scaled per
 * sweep (`V = E_leak + (a / a₀)(V₀ − E_leak)`); a sweep with no command sits at E_leak, and any other
 * sweep is simulated on its own. A model with channels is fitted as its **passive copy**.
 *
 * **The electrode's seal can be a parameter** (Gouwens & Wilson 2009): a leak at the soma to 0 mV,
 * which a whole-cell recording adds and the cell does not have. Left out, a fitted E_leak absorbs it
 * and reads depolarised, and Rm reads low. It keeps the cell linear but moves rest off E_leak, so
 * responses are scaled about rest (`restAt`), and the fitted model leaves the seal behind.
 *
 * **The positive parameters are fitted in log space** — a step is a ratio, and they stay positive —
 * and E_leak in mV. Residuals are model minus recording at the recorded times inside the window,
 * leaving out the first `skipAfterSteps` ms after every command edge: a current-clamp recording
 * carries the bridge-balance and capacitance-compensation artefact there, which no model has.
 *
 * **Where an evaluation runs is the caller's** (`Evaluator`): `prepareFit` makes a plain setup a
 * worker can be handed once, `residualsAt` is the pure evaluation every worker runs, and
 * `fitPassive` drives the optimiser over whichever evaluator it is given — this thread's when none.
 */

import type { ClampShape } from '../../biophys/solver'
import { Simulation } from '../../biophys/solver'
import type { IterationRecord } from '../../biophys/leastSquares'
import { dot, leastSquares } from '../../biophys/leastSquares'
import { sliced } from '../../core/slice'
import type { CellModelValue, CellValue } from '../../core/values'
import type { FitMembrane, Membrane, PassiveBase } from './passive'
import { passiveBase, passiveModel, restAt, startMembrane, steadyUnder } from './passive'
import { resample } from './resample'

/** The passive parameters a fit can vary: the membrane's, and the recording electrode's seal. */
export type MembraneKey = 'rm' | 'cm' | 'ra' | 'eLeak' | 'area' | 'seal'

export interface MembraneParameter {
  readonly key: MembraneKey
  readonly label: string
  readonly unit: string
  /** Fitted as a logarithm: positive, and a step a ratio. */
  readonly log: boolean
  /** The finite-difference step: of the logarithm for a log parameter, in its unit otherwise. */
  readonly step: number
  /** The box a fit keeps it in, unless the caller narrows it. */
  readonly lower: number
  readonly upper: number
  /** What its `Fit` tick says, where more than that an unticked one stays at the model's value. */
  readonly tickHelp?: string
}

/** A log parameter's step: 0.1%. */
const LOG_STEP = 1e-3

export const MEMBRANE_PARAMETERS: readonly MembraneParameter[] = [
  { key: 'rm', label: 'Rm', unit: 'Ω·cm²', log: true, step: LOG_STEP, lower: 1e3, upper: 1e6 },
  { key: 'cm', label: 'Cm', unit: 'µF/cm²', log: true, step: LOG_STEP, lower: 0.2, upper: 5 },
  { key: 'ra', label: 'Ra', unit: 'Ω·cm', log: true, step: LOG_STEP, lower: 20, upper: 2000 },
  {
    key: 'eLeak',
    label: 'E leak',
    unit: 'mV',
    log: false,
    step: 0.01,
    lower: -100,
    upper: -20,
  },
  {
    key: 'area',
    label: 'Area factor',
    unit: '×',
    log: true,
    step: LOG_STEP,
    lower: 0.5,
    upper: 5,
    tickHelp:
      'How much more membrane the cell has than the reconstruction: spines and fine branches it misses. The Compartment Model’s own Area factor, which Apply writes back. Scales capacitance and leak together, so it is fitted against a fixed Cm.',
  },
  /*
   * Linear, not log, because none is a value it can take. Günay et al. 2015 fitted 0.20 ± 0.03 nS
   * on a larval motoneuron (their Table 2); 0.001 nS a step.
   */
  {
    key: 'seal',
    label: 'Seal',
    unit: 'nS',
    log: false,
    step: 1e-3,
    lower: 0,
    upper: 20,
    tickHelp:
      'The electrode’s seal: a leak at the soma to 0 mV, which a whole-cell recording adds and the cell does not have. Unticked, it stays at Seal (nS). The fitted model leaves it out.',
  },
]

/** One recorded sweep, in the solver's units. */
export interface RecordedSweep {
  readonly sweep: CellValue
  /** ms, ascending and evenly spaced. */
  readonly t: Float64Array
  /** mV. */
  readonly v: Float64Array
  /** The injected current at each sample, nA. */
  readonly command: Float64Array
}

export interface PassiveFitOptions {
  /** Which parameters vary; the rest stay where `startMembrane` puts them. */
  readonly free: readonly MembraneKey[]
  /** The seal a fit starts from, or holds where it is not free, nS; none where absent. */
  readonly seal?: number
  /** Narrower boxes than `MEMBRANE_PARAMETERS`' where given. */
  readonly bounds?: Partial<Record<MembraneKey, { lower: number; upper: number }>>
  /** The part of each sweep compared, ms; the whole sweep where absent. */
  readonly window?: { readonly start: number; readonly end: number }
  /** ms left out after every command edge. */
  readonly skipAfterSteps: number
  /** The solver's step, ms. */
  readonly dt: number
  readonly maxIterations?: number
  readonly signal?: AbortSignal
  readonly onIteration?: (record: FitIteration) => void
}

export interface FitIteration {
  readonly iteration: number
  /** RMS of the residuals, mV. */
  readonly rms: number
  readonly membrane: FitMembrane
}

export interface FittedParameter extends MembraneParameter {
  readonly free: boolean
  readonly start: number
  readonly fitted: number
  /** Standard error in the parameter's own unit; undefined for a fixed one, one on a bound, or a singular fit. */
  readonly standardError: number | undefined
  /** Ended on a bound: the data would have taken it further, so its value is the bound's. */
  readonly atBound: boolean
}

export interface PassiveFitResult {
  readonly membrane: FitMembrane
  readonly parameters: readonly FittedParameter[]
  /** Correlations between the free parameters, in `MEMBRANE_PARAMETERS`' order; undefined where singular. */
  readonly correlations: number[][] | undefined
  /** RMS of the residuals at the start and at the end, mV. */
  readonly startRms: number
  readonly rms: number
  readonly iterations: readonly FitIteration[]
  readonly reason: 'converged' | 'max-iterations' | 'stalled'
  /** The fitted model's voltage at every recorded time inside the window, per sweep. */
  readonly traces: readonly {
    sweep: CellValue
    t: Float64Array
    recorded: Float64Array
    fitted: Float64Array
  }[]
  /** How many simulations one evaluation took: the commands' distinct shapes. */
  readonly simulationsPerEvaluation: number
  /** Sweeps whose current changes at most samples — a measurement, not a command — so nothing was skipped. */
  readonly unsteppedSweeps: number
}

/** Whether a time is inside a fit window, start included, end not; everywhere without one. */
export function inWindow(at: number, window: PassiveFitOptions['window']): boolean {
  return !window || (at >= window.start && at < window.end)
}

/**
 * Why a set of free parameters cannot be fitted, or undefined: none at all, or the area factor
 * beside both Cm and Rm, which the model sees only as Cm × area and area ÷ Rm. The one sentence for
 * the card and the fit alike.
 */
export function freeParameterRefusal(free: readonly MembraneKey[]): string | undefined {
  if (free.length === 0) return 'No parameter is free: tick at least one to fit.'
  if (free.includes('area') && free.includes('cm') && free.includes('rm')) {
    return 'The area factor, Cm and Rm cannot all be fitted: the model sees only Cm × area and area ÷ Rm. Untick Cm (1 µF/cm² is the usual) to fit the area factor.'
  }
  return undefined
}

/**
 * A replay of a sweep's command, run from the sweep's first sample to `until` ms: started from the
 * steady state under that first sample's current — a recording opens on a cell long settled under
 * its holding current, not on one at rest — and read at the sweep's times.
 */
function replaying(
  base: PassiveBase,
  m: FitMembrane,
  sweep: RecordedSweep,
  until: number,
  dt: number,
  rest: number,
) {
  const { t, command } = sweep
  const t0 = t[0] ?? 0
  // The mean step, which `recordedSweeps` held every interval to: the first interval alone may be
  // off it by its tolerance, and replayed sample by sample that drifts the command along the sweep.
  const every = t.length > 1 ? (t[t.length - 1]! - t0) / (t.length - 1) : 1
  const model = passiveModel(base, m)
  const run = new Simulation({
    model,
    dt,
    duration: Math.max(0, until - t0) + dt,
    initial: {
      v: steadyUnder(model, base.soma, command[0] ?? 0, m.eLeak),
      gates: model.channels.map(() => []),
    },
    clamps: [
      {
        compartment: base.soma,
        delay: 0,
        duration: command.length * every,
        amplitude: 1,
        shape: { kind: 'samples', every, values: command } satisfies ClampShape,
      },
    ],
    record: Int32Array.of(base.soma),
  })
  const read = (): Float64Array => {
    const result = run.result()
    const times = result.t.map((x) => x + t0)
    // A time past where the run stopped is never compared; it reads as the cell at rest.
    return Float64Array.from(resample(times, result.v[0]!, t), (v) => v ?? rest)
  }
  return { run, read }
}

/** `replaying`, run to the end at once: a worker's evaluation, where nothing waits on the thread. */
function replay(
  base: PassiveBase,
  m: FitMembrane,
  sweep: RecordedSweep,
  until: number,
  dt: number,
  rest: number,
): Float64Array {
  const { run, read } = replaying(base, m, sweep, until, dt, rest)
  run.advance(run.steps)
  return read()
}

/**
 * Sweeps sharing a command shape: one simulation of `reference`, each member that response scaled
 * by `scale` about rest. A sweep with no command is in none, sitting at rest.
 */
interface ShapeGroup {
  readonly reference: number
  readonly members: readonly { readonly sweep: number; readonly scale: number }[]
}

function shapeGroups(sweeps: readonly RecordedSweep[]): ShapeGroup[] {
  const groups: { reference: number; members: { sweep: number; scale: number }[] }[] = []
  sweeps.forEach((s, k) => {
    const peak = maxAbs(s.command)
    if (peak <= 1e-12) return
    for (const group of groups) {
      const reference = sweeps[group.reference]!
      // One simulation read by index for every member: the members must share its time grid.
      if (!sameGrid(reference.t, s.t)) continue
      const ref = reference.command
      const a = dot(s.command, ref) / dot(ref, ref)
      let worst = 0
      for (let i = 0; i < ref.length; i++)
        worst = Math.max(worst, Math.abs(s.command[i]! - a * ref[i]!))
      if (worst <= 1e-6 * peak) {
        group.members.push({ sweep: k, scale: a })
        return
      }
    }
    groups.push({ reference: k, members: [{ sweep: k, scale: 1 }] })
  })
  return groups
}

/** A command changing at more than this share of its samples is not a stepped one. */
const STEPPED_AT_MOST = 0.05

/**
 * The times a sweep's command steps, or undefined where it is no stepped command at all: a measured
 * current — an amplifier's monitor — changes at nearly every sample, and reading each change as an
 * edge would skip every sample there is.
 */
function commandEdges(sweep: RecordedSweep): number[] | undefined {
  const { t, command } = sweep
  const peak = maxAbs(command)
  const edges: number[] = []
  for (let i = 1; i < command.length; i++) {
    if (Math.abs(command[i]! - command[i - 1]!) > 1e-9 * Math.max(peak, 1e-12))
      edges.push(t[i]!)
  }
  return edges.length > STEPPED_AT_MOST * command.length ? undefined : edges
}

/** Per sweep, the indices compared: inside the window, recorded, and clear of every command edge's skip. */
export function comparedSamples(
  sweep: RecordedSweep,
  window: PassiveFitOptions['window'],
  skipAfterSteps: number,
  edges: readonly number[] = commandEdges(sweep) ?? [],
): Int32Array {
  const { t } = sweep
  const keep: number[] = []
  // The latest edge at or before each sample, walked forward with it: times ascend.
  let e = -1
  for (let i = 0; i < t.length; i++) {
    const at = t[i]!
    while (e + 1 < edges.length && edges[e + 1]! <= at) e++
    if (!inWindow(at, window)) continue
    if (!Number.isFinite(sweep.v[i]!)) continue
    if (e >= 0 && at < edges[e]! + skipAfterSteps) continue
    keep.push(i)
  }
  return Int32Array.from(keep)
}

/**
 * A fit's fixed part — the model, the sweeps, which samples count, which share a simulation — as
 * plain data: made once, handed to every worker once, and read by every evaluation.
 */
export interface FitSetup {
  readonly base: PassiveBase
  readonly sweeps: readonly RecordedSweep[]
  readonly groups: readonly ShapeGroup[]
  /** Per group, the last time any member compares, ms: where its simulation can stop. */
  readonly until: Float64Array
  /** Sweeps whose current is no stepped command, so the step skip left nothing out of them. */
  readonly unstepped: number
  readonly compared: readonly Int32Array[]
  /** Per sweep, where its residuals start. */
  readonly offset: Int32Array
  /** How many residuals an evaluation gives: the compared samples, all sweeps. */
  readonly total: number
  readonly dt: number
}

/** Membranes in, residual vectors out, in order: where they are worked out is the caller's. */
export type Evaluator = (membranes: readonly FitMembrane[]) => Promise<Float64Array[]>

export function prepareFit(
  value: CellModelValue,
  sweeps: readonly RecordedSweep[],
  options: Pick<PassiveFitOptions, 'window' | 'skipAfterSteps' | 'dt'>,
): FitSetup {
  if (sweeps.length === 0) throw new Error('No sweep to fit.')
  const edges = sweeps.map(commandEdges)
  const compared = sweeps.map((s, k) =>
    comparedSamples(s, options.window, options.skipAfterSteps, edges[k] ?? []),
  )
  const groups = shapeGroups(sweeps)
  const offset = new Int32Array(sweeps.length)
  let total = 0
  compared.forEach((c, k) => {
    offset[k] = total
    total += c.length
  })
  // −∞ for a group nothing compares, which then is never simulated.
  const until = Float64Array.from(groups, (g) =>
    Math.max(
      -Infinity,
      ...g.members.map(({ sweep }) => {
        const c = compared[sweep]!
        return c.length ? sweeps[sweep]!.t[c[c.length - 1]!]! : -Infinity
      }),
    ),
  )
  return {
    base: passiveBase(value),
    sweeps,
    groups,
    until,
    unstepped: edges.filter((e) => e === undefined).length,
    compared,
    offset,
    total,
    dt: options.dt,
  }
}

/** Model minus recording at every compared sample: one evaluation, pure. */
export function residualsAt(setup: FitSetup, m: FitMembrane): Float64Array {
  const { sweeps, compared, offset } = setup
  const r = new Float64Array(setup.total)
  const rest = restAt(setup.base, m)
  // Every sweep at rest first; a simulated group writes over its members.
  sweeps.forEach((s, k) => {
    let at = offset[k]!
    for (const i of compared[k]!) r[at++] = rest - s.v[i]!
  })
  setup.groups.forEach((group, g) => {
    if (setup.until[g]! === -Infinity) return
    const v = replay(setup.base, m, sweeps[group.reference]!, setup.until[g]!, setup.dt, rest)
    for (const { sweep, scale } of group.members) {
      const recorded = sweeps[sweep]!.v
      let at = offset[sweep]!
      for (const i of compared[sweep]!) r[at++] = rest + scale * (v[i]! - rest) - recorded[i]!
    }
  })
  return r
}

/** Every evaluation on this thread, one after another: tests, and where there are no workers. */
export function evaluatorHere(setup: FitSetup): Evaluator {
  return async (membranes) => membranes.map((m) => residualsAt(setup, m))
}

export async function fitPassive(
  value: CellModelValue,
  sweeps: readonly RecordedSweep[],
  options: PassiveFitOptions,
  evaluatorFor: (setup: FitSetup) => Evaluator = evaluatorHere,
): Promise<PassiveFitResult> {
  const setup = prepareFit(value, sweeps, options)
  const start = startMembrane(value, options.seal)
  const refusal = freeParameterRefusal(options.free)
  if (refusal) throw new Error(refusal)
  const free = MEMBRANE_PARAMETERS.filter((p) => options.free.includes(p.key))
  if (setup.total <= free.length) {
    throw new Error(
      'Too few samples left to fit once the window and the step skips are applied.',
    )
  }
  const evaluate = evaluatorFor(setup)

  const toTheta = (m: FitMembrane) =>
    Float64Array.from(free, (p) => (p.log ? Math.log(m[p.key]) : m[p.key]))
  const toMembrane = (theta: Float64Array): FitMembrane => {
    const m = { ...start }
    free.forEach((p, j) => (m[p.key] = p.log ? Math.exp(theta[j]!) : theta[j]!))
    return m
  }
  const box = (p: MembraneParameter) => options.bounds?.[p.key] ?? p
  const lower = free.map((p) => (p.log ? Math.log(box(p).lower) : box(p).lower))
  const upper = free.map((p) => (p.log ? Math.log(box(p).upper) : box(p).upper))

  const iterations: FitIteration[] = []
  const fit = await leastSquares(toTheta(start), (points) => evaluate(points.map(toMembrane)), {
    lower,
    upper,
    steps: free.map((p) => p.step),
    maxIterations: options.maxIterations ?? 50,
    signal: options.signal,
    onIteration: (record: IterationRecord) => {
      const item = {
        iteration: record.iteration,
        rms: Math.sqrt(record.cost / setup.total),
        membrane: toMembrane(record.theta),
      }
      iterations.push(item)
      options.onIteration?.(item)
    },
  })

  const membrane = toMembrane(fit.theta)
  const se = fit.covariance?.map((row, j) =>
    Number.isNaN(row[j]!) ? undefined : Math.sqrt(Math.max(0, row[j]!)),
  )
  const parameters = MEMBRANE_PARAMETERS.map((p): FittedParameter => {
    const j = free.indexOf(p)
    const fitted = membrane[p.key]
    // A log parameter's error is relative: the delta method turns it back into the unit.
    const error = j >= 0 ? se?.[j] : undefined
    const standardError = error === undefined ? undefined : p.log ? fitted * error : error
    return {
      ...p,
      lower: box(p).lower,
      upper: box(p).upper,
      free: j >= 0,
      atBound: j >= 0 && fit.atBound[j]!,
      start: start[p.key],
      fitted,
      standardError,
    }
  })
  const correlations = fit.covariance?.map((row, a) =>
    Array.from(row, (v, b) => v / Math.sqrt(fit.covariance![a]![a]! * fit.covariance![b]![b]!)),
  )
  const model = await responsesSliced(setup, membrane, options.signal)
  const traces = sweeps.map((s, k) => {
    const inside: number[] = []
    for (let i = 0; i < s.t.length; i++) if (inWindow(s.t[i]!, options.window)) inside.push(i)
    return {
      sweep: s.sweep,
      t: Float64Array.from(inside, (i) => s.t[i]!),
      recorded: Float64Array.from(inside, (i) => s.v[i]!),
      fitted: Float64Array.from(inside, (i) => model[k]![i]!),
    }
  })
  return {
    membrane,
    parameters,
    correlations,
    startRms: iterations[0]?.rms ?? Number.NaN,
    rms: Math.sqrt(fit.cost / setup.total),
    iterations,
    reason: fit.reason,
    traces,
    simulationsPerEvaluation: setup.groups.length,
    unsteppedSweeps: setup.unstepped,
  }
}

/**
 * The model's voltage at every recorded time of every sweep, each replaying its own command, at a
 * membrane — from one simulation per command shape. What a fit's Traces show.
 */
export function passiveResponses(
  value: CellModelValue,
  membrane: Membrane | FitMembrane,
  sweeps: readonly RecordedSweep[],
  dt: number,
): Float64Array[] {
  const m = { area: value.areaFactor ?? 1, seal: 0, ...membrane }
  const groups = shapeGroups(sweeps)
  const base = passiveBase(value)
  const rest = restAt(base, m)
  const runs = wholeRuns(base, groups, sweeps, m, dt, rest)
  for (const { run } of runs) run.advance(run.steps)
  return scaled(groups, sweeps, rest, runs)
}

/** Steps between the clock reads `sliced` paces itself by. */
const STEPS_PER_CHUNK = 100

/** The same on the page: through `sliced`, so the browser gets its turns and Cancel is obeyed. */
async function responsesSliced(
  setup: FitSetup,
  m: FitMembrane,
  signal: AbortSignal | undefined,
): Promise<Float64Array[]> {
  const rest = restAt(setup.base, m)
  const runs = wholeRuns(setup.base, setup.groups, setup.sweeps, m, setup.dt, rest)
  const chunks = runs.flatMap(({ run }) =>
    Array.from({ length: Math.ceil(run.steps / STEPS_PER_CHUNK) }, () => run),
  )
  await sliced(chunks.length, { signal }, (i) => chunks[i]!.advance(STEPS_PER_CHUNK))
  return scaled(setup.groups, setup.sweeps, rest, runs)
}

/** One replay per command shape, over the reference's whole sweep: what Traces show. */
function wholeRuns(
  base: PassiveBase,
  groups: readonly ShapeGroup[],
  sweeps: readonly RecordedSweep[],
  m: FitMembrane,
  dt: number,
  rest: number,
) {
  return groups.map((group) => {
    const ref = sweeps[group.reference]!
    return replaying(base, m, ref, ref.t[ref.t.length - 1] ?? 0, dt, rest)
  })
}

/** Each group's run, read and scaled about `rest` onto its members; a sweep in no group at rest. */
function scaled(
  groups: readonly ShapeGroup[],
  sweeps: readonly RecordedSweep[],
  rest: number,
  runs: readonly { read: () => Float64Array }[],
): Float64Array[] {
  const out = sweeps.map((s) => new Float64Array(s.t.length).fill(rest))
  groups.forEach((group, g) => {
    const v = runs[g]!.read()
    for (const { sweep, scale } of group.members) {
      const into = out[sweep]!
      for (let i = 0; i < into.length; i++) into[i] = rest + scale * (v[i]! - rest)
    }
  })
  return out
}

/** Two sweeps sampled at the same times, near enough for one simulation to be read by index for both. */
function sameGrid(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false
  if (a.length < 2) return a[0] === b[0]
  const every = a[1]! - a[0]!
  const tolerance = 1e-6 * Math.abs(every)
  return Math.abs(a[0]! - b[0]!) <= tolerance && Math.abs(b[1]! - b[0]! - every) <= tolerance
}

function maxAbs(a: Float64Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]!))
  return m
}
