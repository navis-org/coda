/**
 * Simulate's work on the main thread: the job a card's params and inputs make (`planRun`) — where
 * to record, which partners fire — and the three tables and the arbour the run becomes — each table's schema beside the function that fills it (invariant 3).
 */

import { ID_COLUMN_NAME, idText } from '../../core/ids'
import type { ParamValues } from '../../core/node'
import { refuseIfOverCrashFloor } from '../../core/limits'
import { namedFew } from '../../core/prose'
import type { DType, TableSchema } from '../../core/types'
import { column, findColumn, tableSchema, uniqueName } from '../../core/types'
import type {
  CellModelValue,
  CellValue,
  ColumnData,
  PointsValue,
  SkeletonGeometry,
  SkeletonsValue,
  TableValue,
  Value,
} from '../../core/values'
import {
  boundsOf,
  getColumn,
  isPointsValue,
  isTableValue,
  makeTable,
  partnerSign,
} from '../../core/values'
import { agree, formatNumber, formatSigned, plural } from '../../style/format'
import type { Arbor } from '../../nodes/lib/arborOps'
import { orientPlacement, rootNodeFor } from '../../nodes/lib/arborOps'
import { orderByScores } from '../../nodes/lib/matrixShape'
import type { ManualPoint } from '../../nodes/lib/skeletonPoints'
import { projectManual, readManualPoints } from '../../nodes/lib/skeletonPoints'
import { splitArbor } from '../../nodes/lib/splitCorrections'
import { NO_PARTNER, placePoints } from './build'
import { PEAK_VOLTAGE } from './nodeValues'
import type { ClampShape, ClampWaveform, CurrentClamp, Settled } from '../../biophys/solver'
import { clampCurrent, clampWindow } from '../../biophys/solver'
import type { SimulateJob, SimulateResult } from './simulateJob'
import {
  MOVIE_SWEEP,
  jobSteps,
  reachesInWindow,
  restOf,
  sweepClamps,
  sweepCount,
  traceBytes,
} from './simulateJob'
import { partnerDelays, solverPart } from './solverInputs'
import { partnerTrain } from './stimulus'
import { held, rowsBySweep } from './resample'
import { columnScale, unsetAmbiguity } from './unitColumns'
import { isNameableRegion } from './channelRows'

/** Every table of traces' time column, in ms: Simulate's, Load Recording's, Combine Traces'. */
export const TIME_COLUMN = 't'
export const SOMA_COLUMN = 'soma'
/** The column every output of a run over sweeps names them by. */
export const SWEEP_COLUMN = 'sweep'
/** Column names the traces table owns; a record site's label, a trace's or the current's may not take them. */
const RESERVED_COLUMNS = [TIME_COLUMN, SWEEP_COLUMN]

/**
 * Whether a card injects current at all: `Inject current` ticked or a Current table wired. The one
 * rule for the Traces output's `injected` column, read by inference and by the run, so the column
 * follows the card rather than whether any clamp landed on a record site.
 */
export function injects(p: ParamValues, currentWired: boolean): boolean {
  return p.clamp === true || currentWired
}

/**
 * Compartment-steps a second, the slow end of what the Phase 0 probe measured on hemibrain PNs
 * (6.4 × 10⁷ passive, 7.4 × 10⁷ with an HH soma) rounded down. The estimate is a wait.
 */
const COMPARTMENT_STEPS_PER_SECOND = 5e7
/** Warn above this wait — about where a run stops being something you sit through. */
const SIM_WARN_SECONDS = 60

/**
 * The traces added on Playback's dendrogram, each a position on the neuron with a name
 * (`ManualPoint` as JSON). Record sites, so in the key — each is a column of the Traces output —
 * and never drawn as a row, the dendrogram being where it is edited.
 */
export const TRACES_PARAM = 'traces'
/** Whether Playback draws the traces under its scrubber: a layout preference, `presentational`. */
export const SHOW_TRACES_PARAM = 'showTraces'

/** The partners that do not fire: the param the expanded view's partner table edits. */
export const SILENCED_PARAM = 'silenced'

/** How many of the partners not silenced fire, under `Fire` = "the top N by synapses"; else all. */
export function firingTop(p: ParamValues): number | undefined {
  return p.fire === 'top' ? Math.max(1, Number(p.top)) : undefined
}

/**
 * Which partners fire, by index in the model's order: every partner whose id is not silenced, and
 * with `top` only the `top` of those with most synapses, ties to the partner listed first. One
 * rule for the run and for the Partners tab's ticks and count.
 */
export function firingIndices(
  partners: Pick<CellModelValue['partners'], 'id' | 'synapses'>,
  silenced: readonly string[],
  top: number | undefined,
): number[] {
  const off = new Set(silenced)
  const eligible = partners.id.flatMap((id, p) => (off.has(id) ? [] : [p]))
  if (top === undefined || eligible.length <= top) return eligible
  // `orderByScores`' stable ranking: equal counts keep the model's order.
  const ranked = orderByScores(Float64Array.from(eligible, (p) => partners.synapses[p]!))
  return Array.from(ranked.subarray(0, top), (k) => eligible[k]!).sort((a, b) => a - b)
}

/** Said where a spike table is wired and its Partner or Time picker names no column of it. */
const NO_SPIKE_COLUMNS =
  'The table in Input spikes has no column chosen for Partner or Time: pick the column naming ' +
  'each spike’s partner, and the one with its time in ms.'

/** Said when Drive is a spike table and none is wired: at edit time and at Run. */
export const NO_SPIKE_TABLE =
  'Drive is Input spikes: wire a table into Input spikes, with a partner and a time column.'

/**
 * Where a model with channels came to rest, per `dt`, from its last run: the worker keeps nothing
 * between jobs, so the page keeps this and hands it to the next one (`SimulateJob.rest`).
 */
const RESTS = new WeakMap<CellModelValue, Map<number, Settled>>()

/** Keep where a run's model settled, for the next run at that `dt`. */
export function keepRest(
  value: CellModelValue,
  dt: number,
  settled: Settled | undefined,
): void {
  if (!settled) return
  let byDt = RESTS.get(value)
  if (!byDt) RESTS.set(value, (byDt = new Map()))
  byDt.set(dt, settled)
}

/**
 * A table of injected current as the Current socket's pickers read it: time and current, each with
 * its factor into ms and nA, and optionally the site each row goes into and the sweep it belongs to.
 */
export interface CurrentInput {
  readonly time: ColumnData
  readonly current: ColumnData
  readonly scale: { readonly time: number; readonly current: number }
  readonly site?: ColumnData
  readonly sweep?: SweepLabels
}

/** What a run reads besides its params: the points to record at, a spike table, a current table. */
export interface RunInputs {
  readonly record?: { readonly points: PointsValue; readonly label?: ColumnData }
  readonly spikes?: { readonly partner: ColumnData; readonly time: ColumnData }
  /** A table is wired to Input spikes and a column picker is not resolved: a different fix. */
  readonly spikesUnresolved?: true
  readonly current?: CurrentInput
  /** A table is wired to Current and cannot be read: why, in the card's words. */
  readonly currentRefusal?: string
}

export interface RunPlan {
  readonly job: SimulateJob
  /** One per record site, the soma's first: the traces table's columns. */
  readonly labels: readonly string[]
  /** A current table's sweeps, in the job's order, where it names them: the tables' `sweep` column. */
  readonly sweeps?: SweepLabels
  /** Whether the card injects at all (`injects`): the Traces output's `injected` column. */
  readonly injecting: boolean
  /**
   * Playback's traces as this run records them, the tail of `labels`: what Playback draws and
   * names, so a line under its scrubber and its column of the Traces output are one.
   */
  readonly traces: PlacedTraces
  /** Everything worth saying before the run: points not recorded, spikes reaching nothing, the wait. */
  readonly notes: readonly string[]
}

/**
 * Bytes one synaptic event costs at its peak: a time, a slot and a weight (20), the sort's index
 * and its reordered copy when partners interleave (24 more), and the solver's own copy (20).
 */
const EVENT_BYTES = 64

/** What shrinks a train drive's events, in the controls that drive shows. */
const TRAIN_REMEDY = 'Fire fewer partners, fewer Spikes each, or at a longer Interval.'

/** "N partners are left out of the per-partner summary: why" — the plan's note and the run's. */
export function summaryLeftOut(n: number, why: string): string {
  return `${plural(n, 'partner')} ${agree(n, 'is', 'are')} left out of the per-partner summary: ${why}`
}

/**
 * Every record site of a run, in the Traces output's order: the soma, `Record at`'s points, then
 * Playback's traces. One list for the run, Playback's lines and the Sites tab's picks, so a name
 * means one compartment wherever it is read.
 */
export interface RecordSites {
  readonly compartments: Int32Array
  readonly labels: readonly string[]
  /** How many lead the list from the soma and `Record at`; Playback's traces are the rest. */
  readonly recorded: number
  /** Playback's traces as placed, the tail of `labels`. */
  readonly traces: PlacedTraces
}

export function runRecordSites(
  value: CellModelValue,
  record: RunInputs['record'],
  /** `Record distance`, µm, and Playback's traces as stored (`TRACES_PARAM`). */
  { snap, stored }: { readonly snap: number; readonly stored: readonly ManualPoint[] },
  notes: string[],
): RecordSites {
  const sites = recordSites(value, record, snap, notes)
  // Then Playback's traces, after `Record at`'s, named apart from every column before them.
  // With none stored, no arbour: `splitArbor` is several passes over the skeleton, every evaluate.
  const traces =
    stored.length > 0
      ? placeTraces(value, splitArbor(value.skeleton), stored, sites.labels)
      : { placed: [], off: 0 }
  return {
    compartments: Int32Array.from([
      ...sites.compartments,
      ...traces.placed.map((t) => t.compartment),
    ]),
    labels: [...sites.labels, ...traces.placed.map((t) => t.label)],
    recorded: sites.labels.length,
    traces,
  }
}

/** Where `Inject at` reads its sites from, and what a fresh card injects at. */
export const CLAMP_SITES_PARAM = 'clampSites'

/** The card's waveform, as the solver takes it. */
function clampShapeOf(p: ParamValues): ClampShape {
  switch (p.clampShape) {
    case 'ramp':
      return { kind: 'ramp', from: Number(p.rampFrom) }
    case 'sine':
      return { kind: 'sine', frequency: Number(p.sineFrequency), offset: Number(p.sineOffset) }
    case 'pulses':
      return { kind: 'pulses', width: Number(p.pulseWidth), interval: Number(p.pulseInterval) }
    default:
      return { kind: 'step' }
  }
}

/** The card's injection in words, for the Sites tab: "a ramp from 0 to 0.2 nA from 10 ms for 50 ms". */
export function describeClamp(p: ParamValues): string {
  // Currents may be negative, so with a proper minus.
  const nA = (key: string) => `${formatSigned(Number(p[key]))} nA`
  const ms = (key: string) => `${formatNumber(Number(p[key]))} ms`
  const shape = clampShapeOf(p)
  const what =
    shape.kind === 'ramp'
      ? `a ramp from ${nA('rampFrom')} to ${nA('amplitude')}`
      : shape.kind === 'sine'
        ? `a ${formatNumber(shape.frequency)} Hz sine of ${nA('amplitude')} about ${nA('sineOffset')}`
        : shape.kind === 'pulses'
          ? `${nA('amplitude')} pulses of ${ms('pulseWidth')} every ${ms('pulseInterval')}`
          : `a ${nA('amplitude')} step`
  return `${what} from ${ms('clampDelay')} for ${ms('clampDuration')}`
}

/**
 * One clamp per compartment `Inject at` names, each the card's waveform. A name no site has — a
 * `Record at` point gone, a trace renamed — injects nothing and is said; two names on one
 * compartment inject there once, and that is said too.
 */
function plannedClamps(
  p: ParamValues,
  sites: Pick<RecordSites, 'compartments' | 'labels'>,
  notes: string[],
): CurrentClamp[] {
  if (p.clamp !== true) return []
  const names = [...new Set(p[CLAMP_SITES_PARAM] as string[])]
  const missing: string[] = []
  const at = new Map<number, string[]>()
  for (const name of names) {
    const i = sites.labels.indexOf(name)
    if (i < 0) missing.push(name)
    else at.set(sites.compartments[i]!, [...(at.get(sites.compartments[i]!) ?? []), name])
  }
  if (missing.length > 0) {
    notes.push(
      `Inject at names ${namedFew(missing.map((m) => `"${m}"`))}, which no record site is called ` +
        `now, so nothing is injected there. Pick the sites again in the Sites tab.`,
    )
  }
  if (names.length === 0) {
    notes.push('Current injection is on, but no site is ticked in the Sites tab.')
  }
  for (const shared of at.values()) {
    if (shared.length > 1) {
      notes.push(
        `${namedFew(shared.map((n) => `"${n}"`))} are one compartment, so the current is injected ` +
          'there once.',
      )
    }
  }
  const waveform = clampWaveformOf(p)
  return [...at.keys()].map((compartment) => ({ compartment, ...waveform }))
}

/** The card's waveform and window, wherever it is injected: one for every ticked site. */
export function clampWaveformOf(p: ParamValues): ClampWaveform {
  const shape = clampShapeOf(p)
  return {
    delay: Number(p.clampDelay),
    duration: Number(p.clampDuration),
    amplitude: Number(p.amplitude),
    ...(shape.kind === 'step' ? {} : { shape }),
  }
}

/**
 * A waveform over a run of `duration` ms, folded into `buckets` columns, each its least and
 * greatest current over the steps it holds — so a pulse narrower than a column is still drawn,
 * which sampling at the columns would lose. For the Clamp tab's preview.
 */
export function clampEnvelope(
  clamp: ClampWaveform,
  dt: number,
  duration: number,
  buckets: number,
): { lo: Float64Array; hi: Float64Array } {
  const lo = new Float64Array(buckets).fill(Infinity)
  const hi = new Float64Array(buckets).fill(-Infinity)
  const take = (b: number, current: number) => {
    if (current < lo[b]!) lo[b] = current
    if (current > hi[b]!) hi[b] = current
  }
  const steps = Math.max(1, Math.round(duration / dt))
  // Column `b` holds the steps with `floor(step · buckets / steps) = b`.
  const first = (b: number) => Math.ceil((b * steps) / buckets)
  const bucketOf = (step: number) => Math.min(buckets - 1, Math.floor((step * buckets) / steps))
  const [on, off] = clampWindow(clamp, dt)
  const from = Math.max(0, on)
  const to = Math.min(steps, off)
  // Outside the window the current is zero: every column holding a step outside it has a zero.
  for (let b = 0; b < buckets; b++) {
    const s0 = first(b)
    const s1 = first(b + 1)
    if (s0 < s1 && (s0 < from || s1 > to)) take(b, 0)
  }
  if (to > from) {
    if (!clamp.shape || clamp.shape.kind === 'step') {
      // Constant inside: no step needs asking.
      for (let b = bucketOf(from); b <= bucketOf(to - 1); b++) take(b, clamp.amplitude)
    } else {
      // Past a few hundred thousand steps a column's extremes are read at that many, not all.
      const stride = Math.max(1, Math.floor((to - from) / ENVELOPE_STEPS))
      for (let step = from; step < to; step += stride) {
        take(bucketOf(step), clampCurrent(clamp, step, dt))
      }
    }
  }
  // A column no step fell in — more columns than steps — takes its neighbour's.
  for (let b = 0; b < buckets; b++) {
    if (lo[b] === Infinity) {
      lo[b] = b > 0 ? lo[b - 1]! : 0
      hi[b] = b > 0 ? hi[b - 1]! : 0
    }
  }
  return { lo, hi }
}

/** Steps `clampEnvelope` reads at most. */
const ENVELOPE_STEPS = 400_000

/** A Simulate card's params and inputs as the job its worker runs — everything but the run. */
export function planRun(
  value: CellModelValue,
  p: ParamValues,
  inputs: RunInputs,
  /** Playback's replan: a current table's held only for the sweep the movie replays. */
  options: { readonly replay?: boolean } = {},
): RunPlan {
  const notes: string[] = []
  const {
    compartments: record,
    labels,
    traces,
  } = runRecordSites(
    value,
    inputs.record,
    { snap: Number(p.recordSnap), stored: readManualPoints(p[TRACES_PARAM]) },
    notes,
  )
  // The solver's own refusals, said here before anything below divides or multiplies by them: a
  // hand-edited file is the only way to them, and "would allocate NaN" would be the wrong sentence.
  if (!(Number(p.dt) > 0)) throw new Error('dt must be a positive number of milliseconds.')
  if (!(Number(p.duration) >= 0) || !Number.isFinite(Number(p.duration))) {
    throw new Error('Duration must be a finite number of milliseconds, 0 or more.')
  }
  if (!(Number(p.sampleEvery) > 0))
    throw new Error('Sample every must be a positive number of milliseconds.')

  // Who fires, and when: every partner not silenced, on its own train or the table's times.
  const silenced = p[SILENCED_PARAM] as string[]
  const allowed = firingPartners(value, silenced, notes, firingTop(p))
  let firing = new Map<number, number[]>()
  // A spike arriving at or after the end — its time plus its partner's shortest delay — cannot reach
  // the run: every drive stops there as it is built, so Input spikes, Playback's ticks and the "not
  // back at rest" note list only what happened, and a long train is not paid for in events that fall
  // off the end (99% of them, at 1,000 spikes over 100 ms).
  const duration = Number(p.duration)
  const { min: firstDelay } = partnerDelays(value)
  const spikesBefore = (partner: number) => duration - firstDelay[partner]!
  if (p.drive !== 'none' && value.partners.id.length === 0) {
    // A model built without synapses: nothing a train or a table names can reach it.
    notes.push(
      `This model has no synapses, so ${p.drive === 'table' ? 'the spike table drives' : 'spike trains drive'} ` +
        'nothing: wire Synapses into its Compartment Model, or inject current (the Clamp tab).',
    )
  } else if (p.drive === 'trains') {
    const shape = {
      start: Number(p.start),
      number: Number(p.number),
      interval: Number(p.interval),
      noise: Number(p.noise),
    }
    // The trains' size from their shape, before building them: a 10 kHz train over minutes is
    // gigabytes of plain numbers on this thread before the exact count below could refuse it.
    let expected = 0
    for (const partner of allowed) {
      const span = spikesBefore(partner) - shape.start
      const spikes =
        span <= 0
          ? 0
          : Math.min(
              shape.number,
              shape.interval > 0 ? span / shape.interval + 1 : shape.number,
            )
      expected += spikes * value.partners.synapses[partner]!
    }
    refuseIfOverCrashFloor(
      `${formatNumber(Math.round(expected))} synaptic events`,
      expected * EVENT_BYTES,
      TRAIN_REMEDY,
    )
    for (const partner of allowed) {
      const id = value.partners.id[partner]!
      firing.set(partner, partnerTrain(shape, Number(p.seed), id, spikesBefore(partner)))
    }
  } else if (p.drive === 'table') {
    if (inputs.spikesUnresolved) throw new Error(NO_SPIKE_COLUMNS)
    if (!inputs.spikes) throw new Error(NO_SPIKE_TABLE)
    firing = trainsFromTable(
      value,
      inputs.spikes.partner,
      inputs.spikes.time,
      allowed,
      notes,
      spikesBefore,
    )
  }
  // Spikes × synapses, each event a time, a slot and a weight — then a sort index and the solver's
  // own copy. Two independently set numbers multiply here, so it is checked before the run.
  let events = 0
  for (const [partner, times] of firing)
    events += times.length * value.partners.synapses[partner]!
  refuseIfOverCrashFloor(
    `${formatNumber(events)} synaptic events`,
    events * EVENT_BYTES,
    p.drive === 'table'
      ? 'Fire fewer partners, or wire a table with fewer spikes.'
      : TRAIN_REMEDY,
  )

  const dt = Number(p.dt)
  if (inputs.currentRefusal) throw new Error(inputs.currentRefusal)
  const table = inputs.current
    ? tableSweeps(
        inputs.current,
        { compartments: record, labels },
        { dt, duration, replay: options.replay === true },
        notes,
      )
    : undefined
  const job: SimulateJob = {
    model: solverPart(value),
    dt,
    duration,
    sampleEvery: Number(p.sampleEvery),
    record,
    threshold: Number(p.threshold),
    firing: [...firing],
    clamps: plannedClamps(p, { compartments: record, labels }, notes),
    sweeps: table?.clamps,
    rest: RESTS.get(value)?.get(dt),
    summary:
      p.perPartner === true
        ? { onset: Number(p.summaryOnset), window: Number(p.window) }
        : undefined,
  }

  refuseIfOverCrashFloor(
    `${plural(job.record.length, 'trace')} sampled every ${formatNumber(job.sampleEvery)} ms for ` +
      `${formatNumber(job.duration)} ms` +
      (sweepCount(job) > 1 ? `, in each of ${formatNumber(sweepCount(job))} sweeps` : ''),
    traceBytes(job),
    sweepCount(job) > 1
      ? 'Wire fewer sweeps, raise Sample every, shorten Duration, or record at fewer points.'
      : 'Raise Sample every, shorten Duration, or record at fewer points.',
  )
  if (job.summary) {
    const { onset, window } = job.summary
    const late = job.firing.filter(
      ([p]) => !reachesInWindow(job.summary!, firstDelay[p]!),
    ).length
    if (late > 0) {
      notes.push(
        summaryLeftOut(
          late,
          `a spike at ${formatNumber(onset)} ms reaches no synapse before the ` +
            `${formatNumber(window)} ms window ends. Lengthen Summary window, or bring Summary onset forward.`,
        ),
      )
    }
  }

  const steps = jobSteps(job)
  const seconds = (value.compartments.count * steps) / COMPARTMENT_STEPS_PER_SECOND
  if (seconds > SIM_WARN_SECONDS) {
    notes.push(
      `This run is about ${formatNumber(Math.round(seconds / 60))} minutes: ` +
        `${formatNumber(value.compartments.count)} compartments over ` +
        `${formatNumber(steps)} steps.`,
    )
  }
  return {
    job,
    labels,
    traces,
    notes,
    sweeps: table?.labels,
    injecting: injects(p, inputs.current !== undefined),
  }
}

/** A current table's sweeps as the output tables name them: each sweep's own cell, and its dtype. */
export interface SweepLabels {
  readonly cells: readonly CellValue[]
  readonly dtype: DType
}

/**
 * A table of injected current as clamps, one set per sweep (`rowsBySweep`): each site's rows held
 * onto the run's steps (`held`, read at each step's half-step time as every clamp is) and played as
 * a sampled clamp of 1×, so they add to the Clamp tab's. Each clamp spans only the steps carrying
 * current, so its window says when its current starts and stops, as any clamp's does. A row names a
 * record site by its label, the soma when it names none; a name no site has injects nothing and is
 * said. Two names on one compartment add.
 */
function tableSweeps(
  input: CurrentInput,
  sites: Pick<RecordSites, 'compartments' | 'labels'>,
  /** `replay`: only `MOVIE_SWEEP`'s clamps, every sweep still read for the notes and the labels. */
  { dt, duration, replay }: { dt: number; duration: number; replay: boolean },
  notes: string[],
): { clamps: CurrentClamp[][]; labels?: SweepLabels } {
  const steps = Math.max(0, Math.round(duration / dt))
  const { time, current, site, sweep } = input
  // Each sweep's rows by site name, in time order.
  const grouped = rowsBySweep(time, sweep?.cells)
  if (grouped.length === 0) {
    // Nothing to inject is a run without it, said — not a run of no sweeps at all.
    notes.push('The current table has no row with a time, so no current is injected.')
    grouped.push({ cell: null, rows: [] })
  }
  const sweeps = grouped.map(({ cell, rows }) => {
    const bySite = new Map<string, number[]>()
    for (const row of rows) {
      // Spelled as a record site's label is (`idText`): trimmed, and blank is the soma.
      const name = (site ? idText(site[row]) : null) ?? SOMA_COLUMN
      const list = bySite.get(name)
      if (list) list.push(row)
      else bySite.set(name, [row])
    }
    return { cell, bySite }
  })
  refuseIfOverCrashFloor(
    `the current table held over ${formatNumber(steps)} steps`,
    sweeps.reduce((n, g) => n + g.bySite.size, 0) * steps * 8,
    'Shorten Duration, raise dt, or wire fewer sweeps or sites.',
  )
  // Each step's half-step time, where a clamp is read.
  const grid = new Float64Array(steps)
  for (let k = 0; k < steps; k++) grid[k] = (k + 0.5) * dt
  const unknown = new Set<string>()
  // Sweep-sites whose last row is not zero: held for one step of the table, then cut off.
  let cutShort = 0
  const clamps = sweeps.map(({ bySite }, s) => {
    const at = new Map<number, Float64Array>()
    for (const [name, rows] of bySite) {
      const i = sites.labels.indexOf(name)
      if (i < 0) {
        unknown.add(name)
        continue
      }
      const lastValue = current[rows.at(-1)!]
      if (typeof lastValue === 'number' && lastValue !== 0) cutShort++
      if (replay && s !== MOVIE_SWEEP) continue
      const values = held(
        Float64Array.from(rows, (r) => (time[r] as number) * input.scale.time),
        Float64Array.from(rows, (r) => {
          const v = current[r]
          return typeof v === 'number' ? v * input.scale.current : Number.NaN
        }),
        grid,
      )
      const compartment = sites.compartments[i]!
      const sum = at.get(compartment)
      if (sum) for (let k = 0; k < steps; k++) sum[k]! += values[k]!
      else at.set(compartment, values)
    }
    return [...at].flatMap(([compartment, values]): CurrentClamp[] => {
      let first = 0
      while (first < steps && values[first] === 0) first++
      let last = steps - 1
      while (last >= first && values[last] === 0) last--
      if (last < first) return []
      return [
        {
          compartment,
          delay: first * dt,
          duration: (last + 1 - first) * dt,
          amplitude: 1,
          shape: { kind: 'samples', every: dt, values: values.slice(first, last + 1) },
        },
      ]
    })
  })
  if (cutShort > 0) {
    notes.push(
      `The current table ends on a current that is not zero ${cutShort === 1 ? 'once' : `${formatNumber(cutShort)} times`}: ` +
        'a last row is held only as long as the step before it, or not at all when it is the only ' +
        'row. Add a row where the current should stop.',
    )
  }
  if (unknown.size > 0) {
    notes.push(
      `The current table names ${namedFew([...unknown].map((n) => `"${n}"`))}, which no record ` +
        'site is called, so nothing is injected there. Name the soma or a Record at point.',
    )
  }
  return {
    clamps: replay ? clamps.slice(MOVIE_SWEEP, MOVIE_SWEEP + 1) : clamps,
    labels: sweep && { cells: sweeps.map((g) => g.cell), dtype: sweep.dtype },
  }
}

/**
 * The soma, then each point of a record cloud on the arbour, placed by the rule the model's
 * synapses were (`placePoints`). A point further than `maxSnap` µm, or on a piece the model left
 * out, is not recorded and is counted.
 */
export function recordSites(
  value: CellModelValue,
  record: RunInputs['record'],
  maxSnap: number,
  notes: string[],
): { compartments: Int32Array; labels: string[] } {
  const compartments = [value.soma.compartment]
  const labels = [SOMA_COLUMN]
  if (record) {
    const placed = placePoints(value, record.points)
    const taken = new Set([...RESERVED_COLUMNS, SOMA_COLUMN])
    let far = 0
    let off = 0
    placed.compartment.forEach((compartment, i) => {
      if (placed.distance[i]! > maxSnap) far++
      else if (compartment < 0) off++
      else {
        const base = (record.label ? idText(record.label[i]) : null) ?? `site ${labels.length}`
        compartments.push(compartment)
        labels.push(uniqueName(taken, base, (n) => ` (${n})`))
      }
    })
    if (far > 0) {
      notes.push(
        `${plural(far, 'record point')} more than ${formatNumber(maxSnap)} µm from the arbour ` +
          `${agree(far, 'was', 'were')} not recorded.`,
      )
    }
    if (off > 0) {
      notes.push(
        `${plural(off, 'record point')} on fragments or ignored branches the model left out ` +
          `${agree(off, 'was', 'were')} not recorded.`,
      )
    }
  }
  return { compartments: Int32Array.from(compartments), labels }
}

/*
 * Playback's traces — branches clicked on its dendrogram, kept on the node as positions — are
 * record sites too, so each is a column of the Traces output beside the soma and `Record at`'s.
 * Placed here, by the one rule Playback draws them with, so the output's trace and the one under
 * the scrubber are the same compartment.
 */

/** One trace to draw under the scrubber: a name, and the compartment it reads. */
export interface MovieTrace {
  readonly label: string
  readonly compartment: number
}

/** Playback's stored traces as placed on a model, and how many of them did not land on it. */
export interface PlacedTraces {
  readonly placed: readonly PlacedTrace[]
  readonly off: number
}

/** A trace added on the dendrogram, as it lands on this model: what it reads, and where it sits. */
export interface PlacedTrace extends MovieTrace {
  /** As stored on the node: a position on the neuron, and its name. */
  readonly point: ManualPoint
  /** On `arbor`: the node at the far end of its edge, and the share of the way along it. */
  readonly node: number
  readonly t: number
}

/**
 * The compartment a point on the arbour is traced at — its edge's nearer end, as it decides a root
 * (`rootNodeFor`) — or undefined off the modelled cable or at the soma, which is always drawn. One
 * rule for a click and for a stored trace placed again.
 */
export function traceCompartment(
  model: CellModelValue,
  arbor: Arbor,
  on: { readonly node: number; readonly t: number },
): number | undefined {
  const compartment = model.nodeCompartment[rootNodeFor(on, arbor.parent)]!
  return compartment < 0 || compartment === model.soma.compartment ? undefined : compartment
}

/**
 * The stored traces (`TRACES_PARAM`) placed on this model, read by the rule a click is
 * (`rootNodeFor`'s nearer end of the edge). Kept as positions, so they survive a re-run and a
 * rebuilt model; a trace of another neuron, too far from this one's cable, or at the soma (which
 * is always drawn) is counted in `off` rather than placed.
 */
export function placeTraces(
  model: CellModelValue,
  arbor: Arbor,
  stored: readonly ManualPoint[],
  /**
   * The record sites' labels (`recordSites`), the soma's first: the traces follow them in the
   * Traces output, so each is named apart from them and from the time column.
   */
  siteLabels: readonly string[],
): PlacedTraces {
  const taken = new Set([...RESERVED_COLUMNS, ...siteLabels])
  const mine = stored.filter((point) => point.neuron === model.neuronId)
  const at = orientPlacement(arbor, projectManual(model.skeleton, mine))
  const placed: PlacedTrace[] = []
  // Labels are the traces table's columns, so each is once — the soma's included.
  mine.forEach((point, i) => {
    const node = at.node[i]!
    if (node < 0) return
    const t = at.t[i]!
    const compartment = traceCompartment(model, arbor, { node, t })
    if (compartment === undefined) return
    const label = uniqueName(taken, point.name ?? `branch ${i + 1}`, (n) => ` (${n})`)
    placed.push({ label, compartment, point, node, t })
  })
  return { placed, off: stored.length - placed.length }
}

/**
 * Which partners fire, by index (`firingIndices`): every partner not silenced — all of them by
 * default, which is what a model with its synapses wired in is for — or the `top` strongest of
 * them. A silenced id the model has no partner by is counted: a list kept from another model
 * silences nothing here.
 */
export function firingPartners(
  value: CellModelValue,
  silenced: readonly string[],
  notes: string[],
  top: number | undefined,
): number[] {
  const firing = firingIndices(value.partners, silenced, top)
  const known = new Set(value.partners.id)
  const stale = [...new Set(silenced)].filter((id) => !known.has(id))
  if (stale.length > 0) {
    notes.push(
      `${plural(stale.length, 'silenced partner')} ${agree(stale.length, 'is', 'are')} not a ` +
        `partner of this model: ${namedFew(stale)}.`,
    )
  }
  return firing
}

/**
 * Spike trains from a table: rows of (partner id, time), for the `allowed` partners only.
 * Partners the model has no synapses from are counted and named — a train nothing receives is a
 * request the run cannot honour.
 */
export function trainsFromTable(
  value: CellModelValue,
  partner: ColumnData,
  time: ColumnData,
  allowed: readonly number[],
  notes: string[],
  /** Per partner, the time a spike must be before to arrive within the run. */
  spikesBefore: (partner: number) => number = () => Infinity,
): Map<number, number[]> {
  const index = new Map(value.partners.id.map((id, p) => [id, p]))
  const fires = new Set(allowed)
  const firing = new Map<number, number[]>()
  const unknown = new Set<string>()
  for (let row = 0; row < partner.length; row++) {
    const id = idText(partner[row]) ?? NO_PARTNER
    const t = Number(time[row])
    if (!Number.isFinite(t)) continue
    const p = index.get(id)
    if (p === undefined) {
      unknown.add(id)
      continue
    }
    if (!fires.has(p) || !(t < spikesBefore(p))) continue
    const list = firing.get(p)
    if (list) list.push(t)
    else firing.set(p, [t])
  }
  for (const list of firing.values()) list.sort((a, b) => a - b)
  if (unknown.size > 0) {
    notes.push(
      `${plural(unknown.size, 'partner')} in the spike table ${agree(unknown.size, 'has', 'have')} ` +
        `no synapses on this model, so ${agree(unknown.size, 'its', 'their')} spikes reach ` +
        `nothing: ${namedFew([...unknown])}.`,
    )
  }
  return firing
}

/* ------------------------------------------------------------------------------------------
 * The three tables, schema beside value.
 * ---------------------------------------------------------------------------------------- */

/**
 * The Traces output's last column while current is injected: the current, nA, at each sample, into
 * the first record site that takes any — the soma, where a recording is replayed. The Clamp tab's
 * waveform is one for every ticked site, so that column is all of it; a table naming several sites
 * says only the first one's here.
 */
const INJECTED_COLUMN = 'injected'

/** The injected column's name: `injected`, unless a record site is already called that. */
export function injectedColumn(labels: readonly string[]): string {
  return uniqueName(
    new Set([...RESERVED_COLUMNS, ...labels]),
    INJECTED_COLUMN,
    (n) => ` (${n})`,
  )
}

/**
 * Time, the sweep where a current table names them, then one column per record site — the soma
 * first — in mV, then the injected current in nA when there is one. Wide over sites, for ZapBench's
 * memory reason; long over sweeps, which a Line Chart's Series and Fit Model Passive read as they are.
 */
export function tracesSchema(
  labels: readonly string[],
  injected?: string,
  sweepDtype?: DType,
): TableSchema {
  return tableSchema(
    column(TIME_COLUMN, 'f64', 'ms'),
    ...(sweepDtype ? [column(SWEEP_COLUMN, sweepDtype)] : []),
    ...labels.map((name) => column(name, 'f64', 'mV')),
    ...(injected ? [column(injected, 'f64', 'nA')] : []),
  )
}

/**
 * The compartment whose injected current the Traces output carries: the first record site, in
 * record order, that any sweep injects into; undefined where nothing is injected.
 */
export function injectedCompartment(
  job: Pick<SimulateJob, 'clamps' | 'sweeps' | 'record'>,
): number | undefined {
  const into = new Set<number>()
  for (let s = 0; s < sweepCount(job); s++) {
    for (const clamp of sweepClamps(job, s)) into.add(clamp.compartment)
  }
  return Array.from(job.record).find((c) => into.has(c))
}

/**
 * The current into compartment `c` at each of `times` (ms), nA: every clamp there summed, each read
 * at the step starting at that time. What the Traces output's `injected` column and Playback's strip
 * draw.
 */
export function injectedTrace(
  clamps: readonly CurrentClamp[],
  c: number,
  times: ArrayLike<number>,
  dt: number,
): Float64Array {
  const sum = new Float64Array(times.length)
  for (const clamp of clamps) {
    if (clamp.compartment !== c) continue
    for (let i = 0; i < sum.length; i++)
      sum[i]! += clampCurrent(clamp, Math.round(times[i]! / dt), dt)
  }
  return sum
}

export function tracesTable(
  labels: readonly string[],
  result: SimulateResult,
  job: Pick<SimulateJob, 'clamps' | 'sweeps' | 'record' | 'dt'>,
  sweeps: SweepLabels | undefined,
  /** `RunPlan.injecting`. */
  injecting: boolean,
): TableValue {
  const into = injectedCompartment(job)
  // Zeros where the card injects and nothing reached a record site: the column inference promised.
  const injected = injecting ? injectedColumn(labels) : undefined
  const schema = tracesSchema(labels, injected, sweeps?.dtype)
  // Every column sized once and filled by index: a run is easily 100,000 samples a sweep, past
  // what a spread into `push` can pass as arguments.
  const n = result.t.length
  const data: Record<string, CellValue[]> = Object.fromEntries(
    schema.columns.map((c) => [c.name, new Array<CellValue>(n * result.runs.length)]),
  )
  result.runs.forEach((run, s) => {
    const at = s * n
    const current =
      injected &&
      (into === undefined
        ? new Float64Array(n)
        : injectedTrace(sweepClamps(job, s), into, result.t, job.dt))
    for (let i = 0; i < n; i++) {
      data[TIME_COLUMN]![at + i] = result.t[i]!
      if (sweeps) data[SWEEP_COLUMN]![at + i] = sweeps.cells[s]!
      if (current) data[injected!]![at + i] = current[i]!
    }
    labels.forEach((name, r) => {
      const trace = run.traces[r]!
      const column = data[name]!
      for (let i = 0; i < n; i++) column[at + i] = trace[i]!
    })
  })
  return makeTable(schema, data)
}

/**
 * The Traces schema as inference can know it: the record sites from the last run's own schema
 * (its `mV` columns — sites are named by the data), the soma alone before one; the injected
 * column from the params as they are now, so ticking `Inject current` reaches a picker downstream
 * before the next run, by the name the run will give it.
 */
export function inferredTracesSchema(
  observed: TableSchema | undefined,
  injecting: boolean,
  sweepDtype?: DType,
): TableSchema {
  const labels = observed
    ? observed.columns.filter((c) => c.unit === 'mV').map((c) => c.name)
    : [SOMA_COLUMN]
  return tracesSchema(labels, injecting ? injectedColumn(labels) : undefined, sweepDtype)
}

/** The Output spikes output: threshold crossings at each record site, and the sweep, where named. */
export function outputSpikesSchema(sweepDtype?: DType): TableSchema {
  return tableSchema(
    ...(sweepDtype ? [column(SWEEP_COLUMN, sweepDtype)] : []),
    column('site', 'str'),
    column('time', 'f64'),
  )
}

export function outputSpikesTable(
  labels: readonly string[],
  result: SimulateResult,
  sweeps?: SweepLabels,
): TableValue {
  const sweep: CellValue[] = []
  const site: string[] = []
  const time: number[] = []
  result.runs.forEach((run, s) => {
    run.spikes.forEach((times, i) => {
      for (const t of times) {
        if (sweeps) sweep.push(sweeps.cells[s]!)
        site.push(labels[i]!)
        time.push(t)
      }
    })
  })
  return makeTable(outputSpikesSchema(sweeps?.dtype), {
    ...(sweeps ? { [SWEEP_COLUMN]: sweep } : {}),
    site,
    time,
  })
}

/** One row per partner; with the summary, each one's effect alone. */
export const PARTNER_ID_COLUMN = 'partnerId'

/**
 * Which socket a partner's synapses came on — `excitatory`, `inhibitory`, or `mixed` for one on
 * both (`partnerSign`) — on the Partners and Input spikes tables alike.
 */
export const SIGN_COLUMN = 'sign'

/**
 * The Input spikes output: the columns a spike table is read by (`partnerId`, `time` — the
 * Partner and Time pickers' defaults), so one run's drive can be wired into another Simulate.
 */
export const INPUT_SPIKES_SCHEMA: TableSchema = tableSchema(
  column(PARTNER_ID_COLUMN, 'str'),
  column('partnerType', 'str'),
  column(SIGN_COLUMN, 'str'),
  column('time', 'f64'),
  column('arrival', 'f64'),
)

export function inputSpikesTable(
  value: CellModelValue,
  firing: SimulateJob['firing'],
): TableValue {
  // One row per spike, its `arrival` the first: a row per delay would be read back as that many
  // spikes when the table is wired into another Simulate, doubling the drive of a partner whose
  // synapses carry two delays (one on each socket). Playback's ticks keep every arrival
  // (`inputArrivals`, from `partnerDelays`' `each`).
  const { min } = partnerDelays(value)
  const rows = firing
    .flatMap(([partner, times]) =>
      times.map((time) => ({ partner, time, arrival: time + min[partner]! })),
    )
    .sort((a, b) => a.time - b.time || a.partner - b.partner)
  return makeTable(INPUT_SPIKES_SCHEMA, {
    [PARTNER_ID_COLUMN]: rows.map((r) => value.partners.id[r.partner]!),
    partnerType: rows.map((r) => value.partners.type[r.partner] ?? null),
    [SIGN_COLUMN]: rows.map((r) => partnerSign(value.partners, r.partner)),
    time: rows.map((r) => r.time),
    arrival: rows.map((r) => r.arrival),
  })
}

/**
 * mV under which a local change is not a measurement: a ratio of two numbers this small is the
 * solver's rounding, and would read as a plausible attenuation.
 */
const MEASURABLE_MV = 1e-3

/** The summary's columns, in order; read by name by the expanded view's partner table too. */
export const SUMMARY_COLUMNS = ['somaPeak', 'localPeak', 'attenuation', 'somaSpike'] as const

export function partnersSchema(summary: boolean): TableSchema {
  const [soma, local, attenuation, spike] = SUMMARY_COLUMNS
  return tableSchema(
    column(PARTNER_ID_COLUMN, 'str'),
    column('partnerType', 'str'),
    column(SIGN_COLUMN, 'str'),
    column('synapses', 'i64'),
    column('fires', 'bool'),
    ...(summary
      ? [
          column(soma, 'f64'),
          column(local, 'f64'),
          column(attenuation, 'f64'),
          column(spike, 'bool'),
        ]
      : []),
  )
}

export function partnersTable(
  value: CellModelValue,
  firing: readonly number[],
  summary: SimulateResult['summary'],
): TableValue {
  const fires = new Set(firing)
  // A partner that did not run alone is NaN in the summary, and an empty cell here.
  const cell = (x: number) => (Number.isNaN(x) ? null : x)
  const [somaPeak, localPeak, attenuation, somaSpike] = SUMMARY_COLUMNS
  return makeTable(partnersSchema(summary !== undefined), {
    [PARTNER_ID_COLUMN]: [...value.partners.id],
    partnerType: [...value.partners.type],
    [SIGN_COLUMN]: value.partners.id.map((_, p) => partnerSign(value.partners, p)),
    synapses: Array.from(value.partners.synapses),
    fires: value.partners.id.map((_, p) => fires.has(p)),
    ...(summary
      ? {
          [somaPeak]: Array.from(summary.somaPeak, cell),
          [localPeak]: Array.from(summary.localPeak, cell),
          // Soma over local: the share of the local deflection that reaches the soma, which for an
          // inhibitory partner is two falls, so a positive share too.
          [attenuation]: Array.from(summary.somaPeak, (soma, p) => {
            const local = summary.localPeak[p]!
            return cell(Math.abs(local) >= MEASURABLE_MV ? soma / local : NaN)
          }),
          [somaSpike]: Array.from(summary.somaPeak, (soma, p) =>
            Number.isNaN(soma) ? null : summary.spiked[p] === 1,
          ),
        }
      : {}),
  })
}

/** The Arbour output's attributes: the one neuron, by id. */
export const ARBOUR_SCHEMA: TableSchema = tableSchema(column(ID_COLUMN_NAME, 'str'))

/**
 * The model's neuron as a skeleton, each node carrying the highest voltage its compartment reached
 * (`PEAK_VOLTAGE`, mV) — what a 3D View colours "by node value". The skeleton is the one the model
 * was built from, every node of it; a node off the modelled piece of the arbour is NaN, which the
 * shading draws grey rather than as a voltage.
 */
export function arbourValue(value: CellModelValue, peak: Float64Array): SkeletonsValue {
  const { skeleton, nodeCompartment } = value
  const voltage = Float32Array.from(nodeCompartment, (c) => (c < 0 ? Number.NaN : peak[c]!))
  return modelSkeletons(value, {
    ...skeleton,
    nodeValues: { ...skeleton.nodeValues, [PEAK_VOLTAGE]: voltage },
  })
}

/**
 * The model's neuron as a one-item Skeletons value — the skeleton it was built from, or `item` in
 * its place — in the frame it came in: nanometres, and its template space where it named one.
 */
export function modelSkeletons(
  value: CellModelValue,
  item: SkeletonGeometry = value.skeleton,
): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [item],
    attributes: makeTable(ARBOUR_SCHEMA, { [ID_COLUMN_NAME]: [value.neuronId] }),
    bounds: boundsOf([value.skeleton.positions]),
    units: 'nm',
    ...(value.space ? { space: value.space } : {}),
  }
}

/** The Current socket's pickers that are never the current, whatever the unit says. */
export const CURRENT_TAKEN = ['currentTime', 'currentSweep', 'currentSite']

/**
 * A current table's columns and units, resolved through the card's pickers (invariant 5): the one
 * statement of the choice for `validate`, inference and the run. Issues where it cannot be read.
 */
export function resolveCurrent(
  schema: TableSchema,
  column: (paramId: string) => string | undefined,
  params: ParamValues,
):
  | {
      readonly time: string
      readonly current: string
      readonly site?: string
      readonly sweep?: { readonly name: string; readonly dtype: DType }
      readonly scale: CurrentInput['scale']
    }
  | { readonly issues: string[] } {
  const issues: string[] = []
  const said = unsetAmbiguity({ column, params }, schema, {
    id: 'currentValue',
    quantity: 'current',
    unitId: 'currentUnit',
    takenIds: CURRENT_TAKEN,
    ask: 'Pick the injected current',
    after: 'A command is usually the right one; a current monitor is noisy.',
  })
  if (said) issues.push(said)
  const time = column('currentTime')
  const current = column('currentValue')
  if (!time) issues.push('The current table has no numeric column to use as time.')
  if (!current && !said) {
    issues.push(
      'No column of the current table is in pA or nA: set Current unit to pick one from any column.',
    )
  }
  const timeScale = columnScale(schema, 'time', time, 'auto', issues)
  const currentScale = columnScale(schema, 'current', current, params.currentUnit, issues)
  if (issues.length || !time || !current) return { issues }
  const site = column('currentSite')
  const sweep = column('currentSweep')
  const sweepDtype = sweep === undefined ? undefined : findColumn(schema, sweep)?.dtype
  return {
    time,
    current,
    site,
    sweep: sweep && sweepDtype ? { name: sweep, dtype: sweepDtype } : undefined,
    scale: { time: timeScale, current: currentScale },
  }
}

/** The Current socket's table as `planRun` reads it, or why it cannot be read. */
function currentInput(
  table: TableValue,
  column: (paramId: string) => string | undefined,
  params: ParamValues,
): Pick<RunInputs, 'current' | 'currentRefusal'> {
  const read = resolveCurrent(table.schema, column, params)
  if ('issues' in read) return { currentRefusal: read.issues[0] }
  return {
    current: {
      time: getColumn(table, read.time),
      current: getColumn(table, read.current),
      scale: read.scale,
      site: read.site === undefined ? undefined : getColumn(table, read.site),
      sweep:
        read.sweep === undefined
          ? undefined
          : { cells: getColumn(table, read.sweep.name), dtype: read.sweep.dtype },
    },
  }
}

/**
 * What a Simulate card's inputs hand `planRun`, read off its wires and column pickers — one reading
 * for the node's `evaluate` and for Playback, which rebuilds the same job to replay it.
 */
export function runInputs(
  wired: {
    readonly record?: Value | undefined
    readonly spikes?: Value | undefined
    readonly current?: Value | undefined
  },
  column: (paramId: string) => string | undefined,
  params: ParamValues,
): RunInputs {
  const { record, spikes, current } = wired
  const label = column('recordLabel')
  const partner = column('spikePartner')
  const time = column('spikeTime')
  return {
    ...(isTableValue(current) ? currentInput(current, column, params) : {}),
    record: isPointsValue(record)
      ? { points: record, label: label ? getColumn(record.attributes, label) : undefined }
      : undefined,
    spikes:
      isTableValue(spikes) && partner && time
        ? { partner: getColumn(spikes, partner), time: getColumn(spikes, time) }
        : undefined,
    ...(isTableValue(spikes) && !(partner && time) ? { spikesUnresolved: true as const } : {}),
  }
}

/** mV from rest that still counts as rest at a run's end; under it, a slow tail is just a tail. */
const UNRESTED_MV = 5

/** Membrane time constants after the last input a passive cell needs to be back within that. */
const QUIET_TAUS = 3

/**
 * A sentence for a run that ended with the cell still well away from rest, long after anything
 * drove it — or undefined. For a cell stuck depolarised or firing on its own (`docs/biophys.md`).
 * Silent unless the last input and any clamp ended `QUIET_TAUS` membrane time constants before
 * the end, so a slow tail is not mistaken for one, and silent when the model never settled, there
 * being no rest to measure from. Names the compartment furthest from its rest.
 */
export function unrestedNote(
  value: CellModelValue,
  job: Pick<SimulateJob, 'firing' | 'duration'>,
  /** The run's clamps: its sweep's (`sweepClamps`). */
  clamps: readonly CurrentClamp[],
  final: ArrayLike<number>,
  settle: Settled | undefined,
): string | undefined {
  if (settle && !settle.converged) return undefined
  // When the last spike reaches its last synapse: each partner's latest spike plus its longest
  // delay.
  const { max: delay } = partnerDelays(value)
  let lastDrive = 0
  for (const clamp of clamps) lastDrive = Math.max(lastDrive, clamp.delay + clamp.duration)
  for (const [partner, times] of job.firing) {
    for (const time of times) lastDrive = Math.max(lastDrive, time + delay[partner]!)
  }
  // Rm·Cm: Ω·cm² × µF/cm² is µs.
  const tau = (value.membrane.rm * value.membrane.cm) / 1000
  const quiet = job.duration - lastDrive
  if (quiet < QUIET_TAUS * tau) return undefined
  const rest = restOf(value, settle)
  let worst = -1
  let off = 0
  for (let c = 0; c < final.length; c++) {
    const d = final[c]! - rest(c)
    if (Math.abs(d) > Math.abs(off)) {
      off = d
      worst = c
    }
  }
  if (Math.abs(off) <= UNRESTED_MV) return undefined
  const region = value.regionNames[value.compartments.region[worst]!] ?? ''
  const where =
    worst === value.soma.compartment
      ? 'the soma'
      : isNameableRegion(region)
        ? `the ${region}`
        : 'part of the cell'
  return (
    `The cell has not come back to rest: ${where} ends the run at ` +
    `${formatSigned(Math.round(final[worst]!))} mV, ${formatNumber(Math.round(Math.abs(off)))} mV ` +
    `${off > 0 ? 'above' : 'below'} its rest, ${formatNumber(Math.round(quiet))} ms after the last input.` +
    // Stuck above rest is what too little potassium does; below rest is another story.
    (value.channels.length > 0 && off > 0
      ? ' An active cell with too little potassium for its sodium can stay depolarised or keep firing on its own.'
      : '')
  )
}
