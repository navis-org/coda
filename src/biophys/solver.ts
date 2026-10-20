/**
 * Backward Euler on a compartment tree — NEURON's fixed-step method, step for step.
 *
 * ## One step, in NEURON's order
 *
 * From `t` to `t + dt`, with `tm = t + dt/2`:
 *
 * 1. synaptic events due by `tm` are delivered (each adds its weight to its slot's two states);
 * 2. every conductance — leak, gated channels, synapses — and every clamp is evaluated at the
 *    present state, and the membrane equation is solved implicitly for `v(t + dt)`;
 * 3. the gates advance by exponential Euler using the **new** voltage, and the synaptic states
 *    decay.
 *
 * That is NEURON's `fadvance` with `secondorder = 0`, including where it reads the clock, so a
 * comparison against NEURON measures arithmetic rather than two different schemes. Every current
 * here is a conductance times a driving force, so NEURON's numerical Jacobian is exactly the
 * conductance and the linearised system is the one solved below.
 *
 * ## The solve is two sweeps
 *
 * A compartment's parent always has a lower index (`discretize`'s ordering), so the matrix is
 * Hines': eliminate from the leaves up, substitute from the root down. O(n) per step.
 *
 * ## Units
 *
 * mV, ms, nA, µS, nF, µm². A density in S/cm² over an area in µm² is `g · area · 1e-2` µS; a
 * capacitance in µF/cm² is `cm · area · 1e-5` nF.
 */

import type { ChannelSpec, CompiledChannel } from './channels'
import { compileChannel } from './channels'
import type { CompartmentTree } from './discretize'

/** S/cm² × µm² → µS. */
const US_PER_SCM2_UM2 = 1e-2
/** µF/cm² × µm² → nF. */
const NF_PER_UFCM2_UM2 = 1e-5

/** A channel and its density in every compartment. Zero means absent there. */
export interface ChannelPlacement {
  readonly spec: ChannelSpec
  /** S/cm², one per compartment. */
  readonly gbar: Float64Array
}

/**
 * Everything about the cell — its cable, membrane, channels, temperature and where its synapses
 * sit — and nothing about how a run drives it, so one model serves many runs. The planned
 * Compartment Model and Simulate nodes split there too.
 *
 * **Immutable once run.** What a run derives from a model alone — channels bound to the
 * temperature, capacitances, the constant part of the matrix — is prepared once per model and
 * `dt` and reused by every later run of it, so writing into a model's arrays afterwards is not
 * seen. Build a new model instead.
 */
export interface CellModel {
  readonly tree: Pick<CompartmentTree, 'count' | 'parent' | 'area' | 'gAxial'>
  /** µF/cm², one per compartment. */
  readonly cm: Float64Array
  /** The leak included: it is a channel with no gates. */
  readonly channels: readonly ChannelPlacement[]
  /** °C. Channel kinetics scale with it; the passive cable does not. */
  readonly temperature: number
  /** No slots means no synapses: `NO_SYNAPSES`. */
  readonly synapses: SynapseSlots
}

/**
 * A synapse's kinetics. One scheme today — NEURON's Exp2Syn, conductance `B − A` from two states
 * decaying at the rise and decay constants — named so a persisted model can carry a second one
 * (graded transmission) without changing shape.
 */
export interface SynapseKind {
  readonly scheme: 'exp2syn'
  /** Rise, ms. */
  readonly tau1: number
  /** Decay, ms. */
  readonly tau2: number
  /** Reversal, mV. */
  readonly eRev: number
}

/** Where synaptic conductance lives: one slot per (kind, compartment), as `synapseSlots` builds. */
export interface SynapseSlots {
  readonly kinds: readonly SynapseKind[]
  /** Per slot, its index into `kinds`. */
  readonly kindOf: Int32Array
  readonly compartment: Int32Array
}

export const NO_SYNAPSES: SynapseSlots = {
  kinds: [],
  kindOf: new Int32Array(),
  compartment: new Int32Array(),
}

/**
 * Arrivals at slots: delivery time (delay included), slot, and the peak conductance the arrival
 * adds in µS — one synapse's peak times the site's count.
 */
export interface SynapticEvents {
  /** ms, ascending. */
  readonly time: Float64Array
  readonly slot: Int32Array
  readonly weight: Float64Array
}

export const NO_EVENTS: SynapticEvents = {
  time: new Float64Array(),
  slot: new Int32Array(),
  weight: new Float64Array(),
}

/** One place synapses sit: a compartment, how many, how strong each is, and when they fire. */
export interface SynapseSite {
  readonly compartment: number
  /** Index into the kinds handed to `synapseSlots`. */
  readonly kind: number
  readonly count: number
  /** Peak conductance of one synapse, µS. */
  readonly weight: number
  /** Arrival times, ms, delay included. A partner's sites share its train. */
  readonly times: readonly number[]
}

/**
 * Synapse sites as slots: one per (kind, compartment) — sites sharing both share a state, since
 * they decay alike — and each site's slot. Depends on where synapses are and nothing about when
 * they fire, so a model builds it once and every run reuses it (`synapticEvents`).
 */
export function synapseSlots(
  kinds: readonly SynapseKind[],
  sites: readonly Pick<SynapseSite, 'compartment' | 'kind'>[],
): { synapses: SynapseSlots; slotOf: Int32Array } {
  const slotByKey = new Map<string, number>()
  const kindOf: number[] = []
  const compartment: number[] = []
  const slotOf = new Int32Array(sites.length)
  sites.forEach((site, i) => {
    const key = `${site.kind}:${site.compartment}`
    let slot = slotByKey.get(key)
    if (slot === undefined) {
      slot = kindOf.length
      slotByKey.set(key, slot)
      kindOf.push(site.kind)
      compartment.push(site.compartment)
    }
    slotOf[i] = slot
  })
  return {
    synapses: {
      kinds,
      kindOf: Int32Array.from(kindOf),
      compartment: Int32Array.from(compartment),
    },
    slotOf,
  }
}

/**
 * Every arrival at every site as an event on its slot, weighted by the site's **count** so
 * multiplicity is never collapsed. Time order out, ties in the order the sites were listed, as
 * NEURON's queue delivers them.
 */
export function synapticEvents(
  slotOf: Int32Array,
  sites: readonly Pick<SynapseSite, 'count' | 'weight' | 'times'>[],
): SynapticEvents {
  const events: { time: number; slot: number; weight: number }[] = []
  sites.forEach((site, i) => {
    const weight = site.weight * site.count
    for (const time of site.times) events.push({ time, slot: slotOf[i]!, weight })
  })
  events.sort((a, b) => a.time - b.time)
  return {
    time: Float64Array.from(events, (e) => e.time),
    slot: Int32Array.from(events, (e) => e.slot),
    weight: Float64Array.from(events, (e) => e.weight),
  }
}

/** Slots and events together, for a model run once with one set of trains. */
export function synapticInput(
  kinds: readonly SynapseKind[],
  sites: readonly SynapseSite[],
): { synapses: SynapseSlots; events: SynapticEvents } {
  const { synapses, slotOf } = synapseSlots(kinds, sites)
  return { synapses, events: synapticEvents(slotOf, sites) }
}

/**
 * NEURON's IClamp: `amplitude` nA from `delay` for `duration` ms — a step, or shaped over that
 * window (`ClampShape`). On and off by `stepAt`'s rule, as an event is; zero outside the window.
 */
export interface CurrentClamp {
  readonly compartment: number
  readonly delay: number
  readonly duration: number
  readonly amplitude: number
  /** How the current runs inside the window; a step when absent. */
  readonly shape?: ClampShape
}

/**
 * A clamp's waveform, read at each step's half-step time `tm` — the time NEURON evaluates an
 * IClamp's current at — so an IClamp whose `amp` is set to it before every step is the same run.
 * Times are from the clamp's start, in ms.
 *
 * - `ramp`: linear from `from` nA at the start to `amplitude` at the end.
 * - `sine`: `offset + amplitude · sin(2π · frequency · t)`, frequency in Hz, rising from the start.
 * - `pulses`: `amplitude` for `width` ms every `interval` ms, each pulse on and off by `stepAt`.
 * - `samples`: a recorded waveform replayed — `values[k]` (nA) held from `k · every` ms after the
 *   start to the next sample, times `amplitude` (1 replays it as recorded), zero past the last.
 *   What a fit drives a model with, so every sweep gets the current the cell got.
 */
export type ClampShape =
  | { readonly kind: 'step' }
  | { readonly kind: 'ramp'; readonly from: number }
  | { readonly kind: 'sine'; readonly frequency: number; readonly offset: number }
  | { readonly kind: 'pulses'; readonly width: number; readonly interval: number }
  | { readonly kind: 'samples'; readonly every: number; readonly values: ArrayLike<number> }

/** A clamp's waveform and window — everything but where it injects. */
export type ClampWaveform = Omit<CurrentClamp, 'compartment'>

/**
 * The current a clamp injects over the step from `step · dt`, nA: zero outside its window, which
 * opens and closes by `stepAt` as an event does. The one rule for the run, the Traces output's
 * `injected` column and every drawing of a stimulus.
 */
export function clampCurrent(clamp: ClampWaveform, step: number, dt: number): number {
  const { shape, delay, amplitude, duration } = clamp
  const [from, to] = clampWindow(clamp, dt)
  if (step < from || step >= to) return 0
  if (!shape || shape.kind === 'step') return amplitude
  // The step's half-step time from the clamp's start: where NEURON reads an IClamp.
  const since = (step + 0.5) * dt - delay
  if (shape.kind === 'ramp') {
    return duration > 0
      ? shape.from + ((amplitude - shape.from) * since) / duration
      : shape.from
  }
  if (shape.kind === 'sine') {
    return shape.offset + amplitude * Math.sin((2 * Math.PI * shape.frequency * since) / 1000)
  }
  if (shape.kind === 'samples') {
    const k = Math.floor(since / shape.every)
    return k >= 0 && k < shape.values.length ? amplitude * shape.values[k]! : 0
  }
  const { width, interval } = shape
  if (!(interval > 0 && width > 0)) return 0
  if (width >= interval) return amplitude
  // Each pulse on and off by `stepAt`, as a step clamp of its own would be: the latest pulse to
  // start is the only one that can be on, its neighbours asked too for the rounding at an edge.
  const k = Math.floor(since / interval)
  for (let n = Math.max(0, k - 1); n <= k + 1; n++) {
    const start = delay + n * interval
    if (step >= stepAt(start, dt) && step < stepAt(start + width, dt)) return amplitude
  }
  return 0
}

/** The half-open range of steps a clamp is on for, by `stepAt`: outside it, no current. */
export function clampWindow(clamp: ClampWaveform, dt: number): [number, number] {
  return [stepAt(clamp.delay, dt), stepAt(clamp.delay + clamp.duration, dt)]
}

/**
 * The voltage and every gate: what `settle` hands a run to start from. Synaptic conductance and
 * pending events are deliberately not in it — a run that starts here starts with every synapse
 * closed, which is what a resting state means.
 */
export interface CellState {
  readonly v: Float64Array
  /** Per channel, per gate, one value per compartment (meaningful only where the channel is). */
  readonly gates: readonly (readonly Float64Array[])[]
}

/** A model, how it is driven, and what is read out. */
export interface SimulationRequest {
  readonly model: CellModel
  /** ms. */
  readonly dt: number
  /** ms. */
  readonly duration: number
  /** A uniform voltage with every gate at its steady state there, or a state to resume from. */
  readonly initial: { readonly v: number } | CellState
  /** Arrivals at the model's synapse slots. */
  readonly events?: SynapticEvents
  readonly clamps?: readonly CurrentClamp[]
  /** Compartments to record. */
  readonly record: Int32Array
  /** Record every this many steps; 1 by default. */
  readonly sampleEvery?: number
  /** Keep every compartment's highest voltage, read every step — not from the samples. */
  readonly peaks?: boolean
  /**
   * Record every compartment's voltage every this many steps, the start included: a movie of the
   * run, frames × compartments. Per compartment, never per skeleton node — a caller maps nodes
   * onto compartments when it draws.
   */
  readonly frames?: number
  /** Detect upward crossings of this voltage (mV) at the record sites, read every step. */
  readonly threshold?: number
}

export interface SimulationResult {
  /** ms, one per sample, starting at 0. */
  readonly t: Float64Array
  /** One trace per recorded compartment, mV. */
  readonly v: readonly Float64Array[]
  /**
   * Per record site, the highest voltage, read every step rather than from the samples — what a
   * peak at a few sites needs without `peaks`' pass over every compartment.
   */
  readonly recordPeak: Float64Array
  /** Per record site, the lowest voltage, read the same way: what an inhibitory input moves. */
  readonly recordTrough: Float64Array
  /** When each site reached its peak and its trough, ms: whether a response was over by the end. */
  readonly recordPeakAt: Float64Array
  readonly recordTroughAt: Float64Array
  /** With `peaks`: per compartment, the highest voltage, the starting one included. */
  readonly peak?: Float64Array
  /**
   * With `frames`: every compartment's voltage at every frame, mV, frame-major (frame `f`,
   * compartment `c` at `f · count + c`); frame `f` is at `f · frames · dt` ms.
   */
  readonly frames?: Float32Array
  /**
   * With `threshold`: per record site, every upward crossing, ms, placed by linear interpolation
   * within the step it happened in — a crossing seen only in the samples would be late by up to a
   * sampling interval, and missed entirely when a spike fits between two samples.
   */
  readonly spikes?: readonly Float64Array[]
}

/**
 * Exp2Syn's peak normalisation, with NEURON's guards on the rise constant — which is why the rise
 * comes back too: the guarded value is the one to decay by.
 */
export function exp2synNorm(kind: SynapseKind): { tau1: number; factor: number } {
  let { tau1 } = kind
  const { tau2 } = kind
  // Exp2Syn.mod: equal constants make the normalisation divide by zero.
  if (tau1 / tau2 > 0.9999) tau1 = 0.9999 * tau2
  if (tau1 / tau2 < 1e-9) tau1 = tau2 * 1e-9
  const tp = ((tau1 * tau2) / (tau2 - tau1)) * Math.log(tau2 / tau1)
  const factor = 1 / (-Math.exp(-tp / tau1) + Math.exp(-tp / tau2))
  return { tau1, factor }
}

interface Placed {
  readonly channel: CompiledChannel
  /** Compartments where the channel is present. */
  readonly where: Int32Array
  /** Maximal conductance there, µS. */
  readonly gmax: Float64Array
}

/** Each channel bound to the model's temperature and stripped to where it is. */
function place(model: CellModel): Placed[] {
  const { area } = model.tree
  return model.channels.map((placement) => {
    const where: number[] = []
    for (let c = 0; c < placement.gbar.length; c++) if (placement.gbar[c]! > 0) where.push(c)
    return {
      channel: compileChannel(placement.spec, model.temperature),
      where: Int32Array.from(where),
      gmax: Float64Array.from(where, (c) => placement.gbar[c]! * area[c]! * US_PER_SCM2_UM2),
    }
  })
}

/** Every gate at its steady state for the voltage it sits at. */
function steadyGates(placed: readonly Placed[], v: Float64Array): Float64Array[][] {
  return placed.map(({ channel, where }) =>
    channel.gates.map((gate) => {
      const x = new Float64Array(v.length)
      for (const c of where) x[c] = gate.inf(v[c]!)
      return x
    }),
  )
}

/**
 * Add every channel with no gates — the leak — to a diagonal and right-hand side. Constant for a
 * run, so the stepper adds it once and `steadyState` once.
 */
function addPassive(placed: readonly Placed[], d: Float64Array, rhs: Float64Array): void {
  for (const { channel, where, gmax } of placed) {
    if (channel.gates.length > 0) continue
    for (let i = 0; i < where.length; i++) {
      d[where[i]!]! += gmax[i]!
      rhs[where[i]!]! += gmax[i]! * channel.spec.eRev
    }
  }
}

/**
 * The step whose half-step time first reaches `time`: an event is delivered, and a clamp switches,
 * at the step from `t` with `time ≤ t + dt/2` — NEURON's rule. One rule for both, computed once.
 * The margin only absorbs the rounding of the division; `t` itself is never accumulated.
 */
function stepAt(time: number, dt: number): number {
  return Math.max(0, Math.ceil(time / dt - 0.5 - 1e-9))
}

/** Sum of axial conductances at each compartment, to its parent and its children alike. */
function axialSums(tree: CellModel['tree']): Float64Array {
  const { count, parent, gAxial } = tree
  const sum = new Float64Array(count)
  for (let c = 1; c < count; c++) {
    sum[c]! += gAxial[c]!
    sum[parent[c]!]! += gAxial[c]!
  }
  return sum
}

/**
 * Solve the tree system in place: `d` is the diagonal, the off-diagonal between a compartment
 * and its parent is `−gAxial`, and `v` receives the answer. Eliminate from the leaves up, then
 * substitute from the root down — every parent having the lower index is what makes that order
 * exist. `d` and `rhs` are consumed.
 */
function hinesSolve(
  tree: CellModel['tree'],
  d: Float64Array,
  rhs: Float64Array,
  v: Float64Array,
): void {
  const { count, parent, gAxial } = tree
  for (let c = count - 1; c >= 1; c--) {
    const p = parent[c]!
    const f = gAxial[c]! / d[c]!
    d[p]! -= f * gAxial[c]!
    rhs[p]! += f * rhs[c]!
  }
  v[0] = rhs[0]! / d[0]!
  for (let c = 1; c < count; c++) v[c] = (rhs[c]! + gAxial[c]! * v[parent[c]!]!) / d[c]!
}

/** Everything a run needs that depends only on the model and `dt`: shared by every run of it. */
interface Prepared {
  readonly placed: readonly Placed[]
  /** C/dt per compartment, nF/ms. */
  readonly cdt: Float64Array
  /**
   * What the diagonal and right-hand side start from every step: C/dt, the axial sums and every
   * channel with no gates — the leak — none of which change during a run.
   */
  readonly dBase: Float64Array
  readonly rhsBase: Float64Array
  /** Per synapse slot: Exp2Syn's normalisation, the two decays over one step, the reversal. */
  readonly synFactor: Float64Array
  readonly synDecay1: Float64Array
  readonly synDecay2: Float64Array
  readonly synERev: Float64Array
}

/**
 * Per model, per `dt`. Weak, so a model nothing else holds takes its preparation with it; reused,
 * so Phase 2's run per partner — one model, many short drives — binds channels and builds the
 * matrix base once rather than once per partner.
 */
const PREPARED = new WeakMap<CellModel, Map<number, Prepared>>()

function prepare(model: CellModel, dt: number): Prepared {
  let byDt = PREPARED.get(model)
  if (!byDt) PREPARED.set(model, (byDt = new Map()))
  const cached = byDt.get(dt)
  if (cached) return cached

  const { count, area } = model.tree
  const placed = place(model)
  const cdt = Float64Array.from(area, (a, c) => (model.cm[c]! * a * NF_PER_UFCM2_UM2) / dt)
  const dBase = axialSums(model.tree)
  const rhsBase = new Float64Array(count)
  for (let c = 0; c < count; c++) dBase[c]! += cdt[c]!
  addPassive(placed, dBase, rhsBase)

  const { synapses } = model
  const slots = synapses.kindOf.length
  const synFactor = new Float64Array(slots)
  const synDecay1 = new Float64Array(slots)
  const synDecay2 = new Float64Array(slots)
  const synERev = new Float64Array(slots)
  for (let s = 0; s < slots; s++) {
    const kind = synapses.kinds[synapses.kindOf[s]!]!
    const { tau1, factor } = exp2synNorm(kind)
    synFactor[s] = factor
    synDecay1[s] = Math.exp(-dt / tau1)
    synDecay2[s] = Math.exp(-dt / kind.tau2)
    synERev[s] = kind.eRev
  }

  const prepared = { placed, cdt, dBase, rhsBase, synFactor, synDecay1, synDecay2, synERev }
  byDt.set(dt, prepared)
  return prepared
}

/** How many frames a run of `steps` steps records with a frame every `every` steps, the start included. */
export function frameCount(steps: number, every: number): number {
  return Math.floor(steps / every) + 1
}

/**
 * A run in progress. `advance` takes a bounded number of steps so a caller — a worker checking for
 * Cancel, a test — decides how the work is sliced; nothing here yields or reads a clock.
 */
export class Simulation {
  readonly steps: number
  private readonly dt: number
  private readonly tree: CellModel['tree']
  private readonly prepared: Prepared
  private readonly synCompartment: Int32Array
  private readonly record: Int32Array
  private readonly v: Float64Array
  private readonly gates: Float64Array[][]
  private readonly synA: Float64Array
  private readonly synB: Float64Array
  /** Each event's delivery step (ascending), slot, and weight already scaled by Exp2Syn's factor. */
  private readonly eventStep: Int32Array
  private readonly eventSlot: Int32Array
  private readonly eventWeight: Float64Array
  /** Each clamp, and the half-open range of steps it is on for: outside it, nothing to ask. */
  private readonly clampSteps: readonly {
    readonly clamp: CurrentClamp
    readonly from: number
    readonly to: number
  }[]
  private readonly d: Float64Array
  private readonly rhs: Float64Array
  private readonly sampleEvery: number
  private readonly time: Float64Array
  private readonly traces: Float64Array[]
  private readonly peak: Float64Array | undefined
  /** With `frames`: the movie, and the steps between its frames. */
  private readonly movie: Float32Array | undefined
  private readonly frameEvery: number
  private readonly threshold: number | undefined
  private readonly recordPeak: Float64Array
  private readonly recordTrough: Float64Array
  private readonly recordPeakAt: Float64Array
  private readonly recordTroughAt: Float64Array
  /** With `threshold`: the voltage at each record site one step ago, and the crossings so far. */
  private readonly before: Float64Array
  private readonly crossings: number[][]
  /**
   * The slots some event reaches, ascending: every other slot stays zero for the whole run, so the
   * synapse loops skip them — a partner run alone touches a handful of a model's slots.
   */
  private readonly liveSlots: Int32Array
  private step = 0
  private nextEvent = 0

  constructor(request: SimulationRequest) {
    const { model, dt, duration } = request
    const { count } = model.tree
    if (!(dt > 0) || !Number.isFinite(dt)) throw new Error('dt must be a positive number.')
    if (!(duration >= 0)) throw new Error('The duration must not be negative.')
    // No membrane anywhere is no capacitance to integrate: the Hines pass would divide by a zero
    // diagonal and every trace come back NaN. Said here for every caller, the build saying it first.
    if (!model.tree.area.some((a) => a > 0)) {
      throw new Error('A cable with no membrane cannot be simulated.')
    }
    this.dt = dt
    this.tree = model.tree
    this.record = request.record
    this.steps = Math.round(duration / dt)
    this.prepared = prepare(model, dt)
    this.synCompartment = model.synapses.compartment

    if ('gates' in request.initial) {
      this.v = request.initial.v.slice()
      this.gates = request.initial.gates.map((g) => g.map((x) => x.slice()))
    } else {
      this.v = new Float64Array(count).fill(request.initial.v)
      this.gates = steadyGates(this.prepared.placed, this.v)
    }

    const slots = model.synapses.kindOf.length
    this.synA = new Float64Array(slots)
    this.synB = new Float64Array(slots)
    const events = request.events ?? NO_EVENTS
    for (let e = 0; e < events.time.length; e++) {
      if (e > 0 && events.time[e]! < events.time[e - 1]!) {
        throw new Error('Events must be in time order.')
      }
      if (!(events.slot[e]! >= 0 && events.slot[e]! < slots)) {
        throw new Error(`Event ${e} names slot ${events.slot[e]}, and the model has ${slots}.`)
      }
    }
    this.eventStep = Int32Array.from(events.time, (time) => stepAt(time, dt))
    this.eventSlot = Int32Array.from(events.slot)
    this.liveSlots = Int32Array.from(new Set(events.slot)).sort()
    this.eventWeight = Float64Array.from(
      events.weight,
      (w, e) => w * this.prepared.synFactor[events.slot[e]!]!,
    )
    this.clampSteps = (request.clamps ?? []).map((clamp) => {
      const [from, to] = clampWindow(clamp, dt)
      return { clamp, from, to }
    })

    this.d = new Float64Array(count)
    this.rhs = new Float64Array(count)
    this.sampleEvery = Math.max(1, Math.floor(request.sampleEvery ?? 1))
    // Nothing recorded, nothing allocated: `settle` runs for up to seconds of simulated time.
    const samples = request.record.length > 0 ? frameCount(this.steps, this.sampleEvery) : 0
    this.time = new Float64Array(samples)
    this.traces = Array.from(request.record, () => new Float64Array(samples))
    this.peak = request.peaks ? this.v.slice() : undefined
    this.frameEvery = Math.max(1, Math.floor(request.frames ?? 1))
    this.movie = request.frames
      ? new Float32Array(frameCount(this.steps, this.frameEvery) * count)
      : undefined
    this.movie?.set(this.v, 0)
    this.threshold = request.threshold
    this.before = Float64Array.from(request.record, (c) => this.v[c]!)
    this.recordPeak = this.before.slice()
    this.recordTrough = this.before.slice()
    this.recordPeakAt = new Float64Array(request.record.length)
    this.recordTroughAt = new Float64Array(request.record.length)
    this.crossings = Array.from(request.record, () => [])
    this.recordSample(0)
  }

  get done(): boolean {
    return this.step >= this.steps
  }

  get stepsDone(): number {
    return this.step
  }

  /** Take up to `maxSteps` steps; true once the run is complete. */
  advance(maxSteps: number): boolean {
    const end = Math.min(this.steps, this.step + Math.max(0, Math.floor(maxSteps)))
    while (this.step < end) this.takeStep()
    return this.done
  }

  result(): SimulationResult {
    return {
      t: this.time,
      v: this.traces,
      recordPeak: this.recordPeak,
      recordTrough: this.recordTrough,
      recordPeakAt: this.recordPeakAt,
      recordTroughAt: this.recordTroughAt,
      ...(this.peak ? { peak: this.peak } : {}),
      ...(this.movie ? { frames: this.movie } : {}),
      ...(this.threshold !== undefined
        ? { spikes: this.crossings.map((times) => Float64Array.from(times)) }
        : {}),
    }
  }

  /** A copy of the voltage and gates now, to start another run from. */
  state(): CellState {
    return { v: this.v.slice(), gates: this.gates.map((g) => g.map((x) => x.slice())) }
  }

  /** The voltage now, live: valid until the next `advance`, and not to be written. */
  voltage(): Readonly<Float64Array> {
    return this.v
  }

  /** The gates now, as `CellState.gates`, live: valid until the next `advance`, and not to be written. */
  gateValues(): readonly (readonly Float64Array[])[] {
    return this.gates
  }

  private takeStep(): void {
    const { dt, tree, v, d, rhs, step } = this
    const { placed, cdt, dBase, rhsBase, synERev, synDecay1, synDecay2 } = this.prepared
    const { count } = tree

    // 1. Events due by the half step (`stepAt`).
    while (this.nextEvent < this.eventStep.length && this.eventStep[this.nextEvent]! <= step) {
      const s = this.eventSlot[this.nextEvent]!
      const w = this.eventWeight[this.nextEvent]!
      this.synA[s]! += w
      this.synB[s]! += w
      this.nextEvent++
    }

    // 2. Assemble (C/dt + G) v' − Σ g_axial v'_neighbour = C v / dt + Σ g E + I.
    d.set(dBase)
    for (let c = 0; c < count; c++) rhs[c] = rhsBase[c]! + cdt[c]! * v[c]!
    for (let k = 0; k < placed.length; k++) {
      const { channel, where, gmax } = placed[k]!
      const gateSpecs = channel.gates
      // Gateless channels are already in the base.
      if (gateSpecs.length === 0) continue
      const gates = this.gates[k]!
      const e = channel.spec.eRev
      for (let i = 0; i < where.length; i++) {
        const c = where[i]!
        let g = gmax[i]!
        for (let j = 0; j < gateSpecs.length; j++) {
          const x = gates[j]![c]!
          for (let p = gateSpecs[j]!.power; p > 0; p--) g *= x
        }
        d[c]! += g
        rhs[c]! += g * e
      }
    }
    const { liveSlots } = this
    for (let i = 0; i < liveSlots.length; i++) {
      const s = liveSlots[i]!
      const g = this.synB[s]! - this.synA[s]!
      if (g === 0) continue
      const c = this.synCompartment[s]!
      d[c]! += g
      rhs[c]! += g * synERev[s]!
    }
    for (const { clamp, from, to } of this.clampSteps) {
      // A few flops beside the solve: no waveform is stored, whatever its shape.
      if (step >= from && step < to) rhs[clamp.compartment]! += clampCurrent(clamp, step, dt)
    }
    hinesSolve(tree, d, rhs, v)

    // 3. Gates follow the new voltage; synaptic states decay.
    for (let k = 0; k < placed.length; k++) {
      const { channel, where } = placed[k]!
      const gates = this.gates[k]!
      for (let j = 0; j < channel.gates.length; j++) {
        const gate = channel.gates[j]!
        const x = gates[j]!
        for (let i = 0; i < where.length; i++) {
          const c = where[i]!
          x[c] = gate.advance(x[c]!, v[c]!, dt)
        }
      }
    }
    for (let i = 0; i < liveSlots.length; i++) {
      const s = liveSlots[i]!
      this.synA[s]! *= synDecay1[s]!
      this.synB[s]! *= synDecay2[s]!
    }

    // 4. Read-outs that need every step, not every sample.
    if (this.peak) {
      const { peak } = this
      for (let c = 0; c < count; c++) if (v[c]! > peak[c]!) peak[c] = v[c]!
    }
    const { record, recordPeak, recordTrough, before, threshold: theta } = this
    for (let r = 0; r < record.length; r++) {
      const now = v[record[r]!]!
      if (now > recordPeak[r]!) {
        recordPeak[r] = now
        this.recordPeakAt[r] = (step + 1) * dt
      }
      if (now < recordTrough[r]!) {
        recordTrough[r] = now
        this.recordTroughAt[r] = (step + 1) * dt
      }
      if (theta === undefined) continue
      const was = before[r]!
      if (was < theta && now >= theta) {
        this.crossings[r]!.push((step + (theta - was) / (now - was)) * dt)
      }
      before[r] = now
    }

    this.step++
    if (this.step % this.sampleEvery === 0) this.recordSample(this.step / this.sampleEvery)
    if (this.movie && this.step % this.frameEvery === 0) {
      this.movie.set(v, (this.step / this.frameEvery) * count)
    }
  }

  private recordSample(index: number): void {
    if (this.time.length === 0) return
    this.time[index] = this.step * this.dt
    const { record } = this
    for (let r = 0; r < record.length; r++) this.traces[r]![index] = this.v[record[r]!]!
  }
}

/** Run to the end in one go. For tests and small models; a worker slices with `advance`. */
export function simulate(request: SimulationRequest): SimulationResult {
  const run = new Simulation(request)
  run.advance(run.steps)
  return run.result()
}

/**
 * The steady state of a **passive** model under constant injected currents (nA per compartment):
 * the same system with the capacitive term gone, solved once. What input resistance and
 * attenuation are read from. A gated channel's steady state is nonlinear in `v`, which is
 * `settle`'s business.
 */
export function steadyState(model: CellModel, injection: Float64Array): Float64Array {
  if (model.channels.some((c) => c.spec.gates.length > 0)) {
    throw new Error('steadyState is for passive models only.')
  }
  const d = axialSums(model.tree)
  const rhs = Float64Array.from(injection)
  addPassive(place(model), d, rhs)
  const v = new Float64Array(model.tree.count)
  hinesSolve(model.tree, d, rhs, v)
  return v
}

export interface Settled {
  readonly state: CellState
  /** ms of simulated time it took. */
  readonly time: number
  /** Whether the voltage and every gate stopped moving before `maxTime`. */
  readonly converged: boolean
}

/**
 * Let an unstimulated model come to rest.
 *
 * A passive model rests at its leak reversal exactly and needs none of this. With gated channels
 * the rest is wherever the currents balance, which is not the leak reversal; starting a run
 * anywhere else opens it with a drift that reads as a response (navis's `v_init = −65` against an
 * `e_pas` of −60 is that bug). So: start at `v`, gates at their steady state, and integrate with no
 * input until no compartment's voltage moves faster than `tolerance` mV/ms, nor any gate faster than
 * `tolerance` per ms.
 */
export function settle(
  model: CellModel,
  v: number,
  options: { dt?: number; tolerance?: number; maxTime?: number } = {},
): Settled {
  const steps = settling(model, v, options)
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}

/**
 * `settle`, handing control back between its one-millisecond chunks — so a run on the page's own
 * thread can see a Cancel, and report that it is settling, while up to `maxTime` of simulated time
 * goes by. `between` is awaited after each chunk; it throws to stop.
 */
export async function settleSliced(
  model: CellModel,
  v: number,
  between: () => Promise<void> | void,
  options: { dt?: number; tolerance?: number; maxTime?: number } = {},
): Promise<Settled> {
  const steps = settling(model, v, options)
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
    await between()
  }
}

/** The largest change between `now` and `previous`, which then takes `now`'s values. */
function maxChange(now: ArrayLike<number>, previous: Float64Array): number {
  let moved = 0
  for (let c = 0; c < now.length; c++) {
    moved = Math.max(moved, Math.abs(now[c]! - previous[c]!))
    previous[c] = now[c]!
  }
  return moved
}

/** The settling loop, a chunk per step of the generator: one loop for `settle` and `settleSliced`. */
function* settling(
  model: CellModel,
  v: number,
  options: { dt?: number; tolerance?: number; maxTime?: number },
): Generator<void, Settled> {
  const dt = options.dt ?? 0.025
  const tolerance = options.tolerance ?? 1e-6
  const maxTime = options.maxTime ?? 2000
  // One millisecond at a time, then compare — the gates as well as the voltage: a slow gate carrying
  // little current at rest (Günay's NaT h, τ ≈ 110 ms at −70 mV and nearly 2 s at −100) moves the
  // voltage by less than the tolerance while it is still far from its own steady state.
  const chunk = Math.max(1, Math.round(1 / dt))
  const run = new Simulation({
    model,
    dt,
    duration: maxTime,
    initial: { v },
    record: new Int32Array(),
  })
  const previous = Float64Array.from(run.voltage())
  const previousGates = run.gateValues().map((g) => g.map((x) => Float64Array.from(x)))
  while (!run.done) {
    const before = run.stepsDone
    run.advance(chunk)
    const elapsed = (run.stepsDone - before) * dt
    const moved = maxChange(run.voltage(), previous)
    let gateMoved = 0
    run.gateValues().forEach((channel, i) =>
      channel.forEach((gate, j) => {
        gateMoved = Math.max(gateMoved, maxChange(gate, previousGates[i]![j]!))
      }),
    )
    // A gate is a fraction, so the same tolerance per ms reads as 1e-6 of fully open.
    if (moved / elapsed < tolerance && gateMoved / elapsed < tolerance) {
      return { state: run.state(), time: run.stepsDone * dt, converged: true }
    }
    yield
  }
  return { state: run.state(), time: run.stepsDone * dt, converged: false }
}
