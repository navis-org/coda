/**
 * Simulate's work on the main thread: the job a card's params and inputs make (`planRun`) — where
 * to record, which partners fire — and the three tables and the arbour the run becomes — each table's schema beside the function that fills it (invariant 3).
 */

import { ID_COLUMN_NAME, idText } from '../../core/ids'
import type { ParamValues } from '../../core/node'
import { refuseIfOverCrashFloor } from '../../core/limits'
import { namedFew } from '../../core/prose'
import type { TableSchema } from '../../core/types'
import { column, tableSchema, uniqueName } from '../../core/types'
import type {
  CellModelValue,
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
import { clampCurrent, clampTrace, clampWindow } from '../../biophys/solver'
import type { SimulateJob, SimulateResult } from './simulateJob'
import { jobSteps, reachesInWindow, restOf, traceBytes } from './simulateJob'
import { partnerDelays, solverPart } from './solverInputs'
import { partnerTrain } from './stimulus'
import { isNameableRegion } from './channelRows'

/** Column names the traces table owns; a record site's label may not take them. */
/** Every table of traces' time column, in ms: Simulate's, Load Recording's, Combine Traces'. */
export const TIME_COLUMN = 't'
export const SOMA_COLUMN = 'soma'

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

/** What a run reads besides its params: the points to record at, and a spike table. */
export interface RunInputs {
  readonly record?: { readonly points: PointsValue; readonly label?: ColumnData }
  readonly spikes?: { readonly partner: ColumnData; readonly time: ColumnData }
  /** A table is wired to Input spikes and a column picker is not resolved: a different fix. */
  readonly spikesUnresolved?: true
}

export interface RunPlan {
  readonly job: SimulateJob
  /** One per record site, the soma's first: the traces table's columns. */
  readonly labels: readonly string[]
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
export function planRun(value: CellModelValue, p: ParamValues, inputs: RunInputs): RunPlan {
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
  const job: SimulateJob = {
    model: solverPart(value),
    dt,
    duration,
    sampleEvery: Number(p.sampleEvery),
    record,
    threshold: Number(p.threshold),
    firing: [...firing],
    clamps: plannedClamps(p, { compartments: record, labels }, notes),
    rest: RESTS.get(value)?.get(dt),
    summary:
      p.perPartner === true
        ? { onset: Number(p.summaryOnset), window: Number(p.window) }
        : undefined,
  }

  refuseIfOverCrashFloor(
    `${plural(job.record.length, 'trace')} sampled every ${formatNumber(job.sampleEvery)} ms for ${formatNumber(job.duration)} ms`,
    traceBytes(job),
    'Raise Sample every, shorten Duration, or record at fewer points.',
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
  return { job, labels, traces, notes }
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
    const taken = new Set([TIME_COLUMN, SOMA_COLUMN])
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
        `${plural(off, 'record point')} on fragments the model left out ` +
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
  const taken = new Set([TIME_COLUMN, ...siteLabels])
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
 * The Traces output's last column while current is injected: the current, nA, at each sample —
 * one waveform for every injected site, so one column.
 */
const INJECTED_COLUMN = 'injected'

/** The injected column's name: `injected`, unless a record site is already called that. */
export function injectedColumn(labels: readonly string[]): string {
  return uniqueName(new Set([TIME_COLUMN, ...labels]), INJECTED_COLUMN, (n) => ` (${n})`)
}

/**
 * Time, then one column per record site — the soma first — in mV, then the injected current in nA
 * when there is one. Wide, for ZapBench's memory reason.
 */
export function tracesSchema(labels: readonly string[], injected?: string): TableSchema {
  return tableSchema(
    column(TIME_COLUMN, 'f64', 'ms'),
    ...labels.map((name) => column(name, 'f64', 'mV')),
    ...(injected ? [column(injected, 'f64', 'nA')] : []),
  )
}

export function tracesTable(
  labels: readonly string[],
  result: SimulateResult,
  job: Pick<SimulateJob, 'clamps' | 'dt'>,
): TableValue {
  const data: Record<string, number[]> = { [TIME_COLUMN]: Array.from(result.t) }
  labels.forEach((name, i) => (data[name] = Array.from(result.traces[i]!)))
  const clamp = job.clamps[0]
  const injected = clamp && injectedColumn(labels)
  if (injected) data[injected] = Array.from(clampTrace(clamp, result.t, job.dt))
  return makeTable(tracesSchema(labels, injected), data)
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
): TableSchema {
  const labels = observed
    ? observed.columns.filter((c) => c.unit === 'mV').map((c) => c.name)
    : [SOMA_COLUMN]
  return tracesSchema(labels, injecting ? injectedColumn(labels) : undefined)
}

/** The Output spikes output: threshold crossings at each record site. */
export const OUTPUT_SPIKES_SCHEMA: TableSchema = tableSchema(
  column('site', 'str'),
  column('time', 'f64'),
)

export function outputSpikesTable(
  labels: readonly string[],
  result: SimulateResult,
): TableValue {
  const site: string[] = []
  const time: number[] = []
  result.spikes.forEach((times, i) => {
    for (const t of times) {
      site.push(labels[i]!)
      time.push(t)
    }
  })
  return makeTable(OUTPUT_SPIKES_SCHEMA, { site, time })
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

/**
 * What a Simulate card's inputs hand `planRun`, read off its wires and column pickers — one reading
 * for the node's `evaluate` and for Playback, which rebuilds the same job to replay it.
 */
export function runInputs(
  record: Value | undefined,
  spikes: Value | undefined,
  column: (paramId: string) => string | undefined,
): RunInputs {
  const label = column('recordLabel')
  const partner = column('spikePartner')
  const time = column('spikeTime')
  return {
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
  job: Pick<SimulateJob, 'firing' | 'duration' | 'clamps'>,
  final: ArrayLike<number>,
  settle: Settled | undefined,
): string | undefined {
  if (settle && !settle.converged) return undefined
  // When the last spike reaches its last synapse: each partner's latest spike plus its longest
  // delay.
  const { max: delay } = partnerDelays(value)
  let lastDrive = 0
  for (const clamp of job.clamps) lastDrive = Math.max(lastDrive, clamp.delay + clamp.duration)
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
