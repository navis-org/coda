/**
 * Fit Model's tables and its two conversions, schema beside value (invariant 3): a recording's long
 * table read into sweeps in the solver's units, the fit read back out as Parameters, Traces and
 * Iterations, and the fitted membrane folded into a Compartment Model.
 */

import type { DType, TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { CellModelValue, CellValue, TableValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
import type { MembraneKey, PassiveFitResult, RecordedSweep } from './fit'
import { MEMBRANE_PARAMETERS } from './fit'
import { rescaledAxial } from './passive'
import { rowsBySweep } from './resample'
import { onSameCable } from './build'
import { agree, formatNumber, formatSignificant, plural } from '../../style/format'
import { CUSTOM } from './presets'
import { TIME_COLUMN } from './simulateOps'

export interface RecordingColumns {
  readonly time: string
  /** One sweep where absent. */
  readonly sweep: string | undefined
  readonly voltage: string
  readonly command: string
  /** Each column's factor into ms, mV and nA. */
  readonly scale: { readonly time: number; readonly voltage: number; readonly current: number }
}

/**
 * A long table's sweeps, in the order each first appears, each in time order and in the solver's
 * units. A missing command is no current; a missing voltage is a sample not compared. Throws where
 * a sweep's times are not evenly spaced, the command being replayed sample by sample.
 */
export function recordedSweeps(table: TableValue, cols: RecordingColumns): RecordedSweep[] {
  const t = getColumn(table, cols.time)
  const v = getColumn(table, cols.voltage)
  const c = getColumn(table, cols.command)
  const s = cols.sweep === undefined ? undefined : getColumn(table, cols.sweep)
  const number = (x: CellValue, otherwise: number) =>
    typeof x === 'number' && Number.isFinite(x) ? x : otherwise
  return rowsBySweep(t, s).map(({ cell, rows: list }) => {
    // No sweep column is one sweep, called 1.
    const sweep = s ? cell : 1
    const times = Float64Array.from(list, (i) => (t[i] as number) * cols.scale.time)
    const step =
      times.length > 1 ? (times[times.length - 1]! - times[0]!) / (times.length - 1) : 1
    for (let k = 1; k < times.length; k++) {
      if (Math.abs(times[k]! - times[k - 1]! - step) > 1e-3 * step) {
        throw new Error(
          `Sweep ${String(sweep)}'s times are not evenly spaced (near ${times[k - 1]!.toFixed(3)} ms). ` +
            'Fit Model Passive replays the command sample by sample, so it needs a recording as it was sampled.',
        )
      }
    }
    return {
      sweep,
      t: times,
      v: Float64Array.from(list, (i) => number(v[i]!, Number.NaN) * cols.scale.voltage),
      command: Float64Array.from(list, (i) => number(c[i]!, 0) * cols.scale.current),
    }
  })
}

/** What `fittedModel` reads of a fit: its membrane and how it ended. */
export type FitOutcome = Pick<
  PassiveFitResult,
  'membrane' | 'reason' | 'iterations' | 'startRms' | 'rms'
>

/**
 * The fitted membrane in a Compartment Model: `gAxial` rescaled to the fitted Ra, and the fitted
 * area factor applied as the build applies one — every compartment's area scaled by its share of the
 * start model's, and `areaFactor` set — so channel densities stay as placed and their conductances
 * follow the membrane.
 * The fit itself is kept (`CellModelValue.fit`). On the start model's cable (`onSameCable`), so
 * Simulate places record points on it as on that one.
 */
export function fittedModel(value: CellModelValue, outcome: FitOutcome): CellModelValue {
  // The seal is the electrode's: the fitted cell is the one without it.
  const { area: areaFactor, seal: _seal, ...membrane } = outcome.membrane
  const area = areaFactor / (value.areaFactor ?? 1)
  return onSameCable(value, {
    ...value,
    compartments: {
      ...value.compartments,
      area: area === 1 ? value.compartments.area : value.compartments.area.map((a) => a * area),
      gAxial: rescaledAxial(value.compartments.gAxial, value.membrane.ra, membrane.ra),
    },
    areaFactor,
    membrane,
    // Fitted numbers are no published set: what a preview and Simulate name the membrane by.
    preset: { id: CUSTOM.id, label: 'Fitted' },
    fit: {
      reason: outcome.reason,
      iterations: outcome.iterations.at(-1)?.iteration ?? 0,
      startRms: outcome.startRms,
      rms: outcome.rms,
    },
  })
}

/** Significant figures Apply writes: past a fit's own error, more digits are noise in a field. */
const APPLIED_DIGITS = 4

/**
 * What Apply to Compartment Model writes into that card, keyed by its param ids: Custom and the
 * fitted model's membrane and area factor, rounded for the card's fields — read off the fitted
 * model, never off the card, which after one Apply already holds them. Undefined for a model no fit
 * made.
 */
export function appliedParams(
  fitted: CellModelValue,
): Record<string, string | number> | undefined {
  if (!fitted.fit) return undefined
  const round = (x: number) => Number(x.toPrecision(APPLIED_DIGITS))
  const { rm, cm, ra, eLeak } = fitted.membrane
  return {
    preset: CUSTOM.id,
    rm: round(rm),
    cm: round(cm),
    ra: round(ra),
    eLeak: round(eLeak),
    areaFactor: round(fitted.areaFactor ?? 1),
  }
}

/** Parameters: one row per membrane parameter, fitted or held. */
export function fitParametersSchema(): TableSchema {
  return tableSchema(
    column('parameter', 'str'),
    column('value', 'f64'),
    column('standardError', 'f64'),
    column('unit', 'str'),
    column('start', 'f64'),
    column('free', 'bool'),
    column('atBound', 'bool'),
  )
}

export function fitParametersTable(result: PassiveFitResult): TableValue {
  const ps = result.parameters
  return makeTable(fitParametersSchema(), {
    parameter: ps.map((p) => p.label),
    value: ps.map((p) => p.fitted),
    standardError: ps.map((p) => p.standardError ?? null),
    unit: ps.map((p) => p.unit),
    start: ps.map((p) => p.start),
    free: ps.map((p) => p.free),
    atBound: ps.map((p) => p.atBound),
  })
}

/** Traces: long, a row per recorded time inside the window, the recording beside the fit. */
export function fitTracesSchema(sweepDtype: DType): TableSchema {
  return tableSchema(
    column(TIME_COLUMN, 'f64', 'ms'),
    column('sweep', sweepDtype),
    column('recorded', 'f64', 'mV'),
    column('fitted', 'f64', 'mV'),
  )
}

export function fitTracesTable(result: PassiveFitResult, sweepDtype: DType): TableValue {
  const t: number[] = []
  const sweep: CellValue[] = []
  const recorded: (number | null)[] = []
  const fitted: number[] = []
  for (const trace of result.traces) {
    for (let i = 0; i < trace.t.length; i++) {
      t.push(trace.t[i]!)
      sweep.push(trace.sweep)
      recorded.push(Number.isFinite(trace.recorded[i]!) ? trace.recorded[i]! : null)
      fitted.push(trace.fitted[i]!)
    }
  }
  return makeTable(fitTracesSchema(sweepDtype), { [TIME_COLUMN]: t, sweep, recorded, fitted })
}

/** Iterations: the RMS and every membrane parameter at each accepted step, the start as 0. */
export function fitIterationsSchema(): TableSchema {
  return tableSchema(
    column('iteration', 'i64'),
    column('rms', 'f64', 'mV'),
    ...MEMBRANE_PARAMETERS.map((p) => column(p.key, 'f64', p.unit)),
  )
}

export function fitIterationsTable(result: PassiveFitResult): TableValue {
  const its = result.iterations
  const values: Record<string, CellValue[]> = {
    iteration: its.map((it) => it.iteration),
    rms: its.map((it) => it.rms),
  }
  for (const p of MEMBRANE_PARAMETERS) values[p.key] = its.map((it) => it.membrane[p.key])
  return makeTable(fitIterationsSchema(), values)
}

/** A length constant this share of the built one or less is worth a rebuild. */
const RECUT_BELOW = 0.8

/**
 * The fitted cable's high-frequency length constant over the start model's: λ scales as
 * 1/√(Ra·Cm), and Cm here is the folded one, Cm × area. What d_lambda cut the compartments by.
 */
function recutShare(parameters: PassiveFitResult['parameters']): number {
  const value = (key: MembraneKey, which: 'start' | 'fitted') =>
    parameters.find((p) => p.key === key)?.[which] ?? 1
  const built = value('ra', 'start') * value('cm', 'start') * value('area', 'start')
  const fitted = value('ra', 'fitted') * value('cm', 'fitted') * value('area', 'fitted')
  return Math.sqrt(built / fitted)
}

/** A share of its value above which a free parameter's error says the recording did not set it. */
const LOOSE_SHARE = 0.5
/** A correlation past which two free parameters say they were traded against each other. */
const TRADED = 0.95

/** How far the fitted area factor must move from the model's before its channels are said to follow. */
const AREA_MOVED = 0.01

/**
 * What a fitted area factor does to a model's channels, or undefined where it did nothing: their
 * densities are kept (`fittedModel`), so their total conductance follows the membrane. Not that
 * they were left out of the fit — the node's name says that — and nothing at all where the factor
 * was held or settled where it started, which is when there is nothing to know.
 */
export function channelAreaNote(
  channels: number,
  result: PassiveFitResult,
): string | undefined {
  const area = result.parameters.find((p) => p.key === 'area')
  if (channels === 0 || !area) return undefined
  const ratio = area.fitted / area.start
  if (Math.abs(ratio - 1) < AREA_MOVED) return undefined
  return (
    `The model’s ${plural(channels, 'channel')} ${agree(channels, 'keeps', 'keep')} ` +
    `${agree(channels, 'its density', 'their densities')}, so at the fitted area factor ` +
    `(${formatSignificant(area.fitted, 3)}, from ${formatSignificant(area.start, 3)}) ` +
    `${agree(channels, 'it carries', 'they carry')} ${formatSignificant(ratio, 3)}× the conductance.`
  )
}

/**
 * What a reader should know about a fit before trusting it, one sentence each: a parameter on its
 * bound, one the recording left loose, a pair it traded, and a fit that did not settle.
 */
export function fitNotes(result: PassiveFitResult): string[] {
  const notes: string[] = []
  const free = result.parameters.filter((p) => p.free)
  const bounded = free.filter((p) => p.atBound)
  for (const p of bounded) {
    const side =
      Math.abs(p.fitted - p.lower) <= Math.abs(p.fitted - p.upper) ? 'lower' : 'upper'
    notes.push(
      `${p.label} ended on its ${side} bound (${formatNumber(p.fitted)} ${p.unit}): the recording asks ` +
        'for a value outside the box, so this one is the bound’s and not a measurement.',
    )
  }
  if (bounded.some((p) => p.key === 'ra' || p.key === 'cm' || p.key === 'area')) {
    const isFree = (key: MembraneKey) => free.some((p) => p.key === key)
    const remedy = isFree('cm')
      ? 'Fix Cm (1 µF/cm² is the usual) and fit the area factor instead.'
      : !isFree('area')
        ? 'Tick Fit area factor to let the membrane area differ from the reconstruction’s.'
        : 'More than an area factor can take up: check the soma diameter and the radii the model was built with.'
    notes.push(
      'A bound reached by Ra, Cm or the area factor usually means the reconstruction’s geometry ' +
        `differs from the recorded cell’s. ${remedy}`,
    )
  }
  const recut = recutShare(result.parameters)
  if (recut < RECUT_BELOW) {
    notes.push(
      `The fitted values shorten the cable’s length constant to ${Math.round(recut * 100)}% of ` +
        'the one the model’s compartments were cut for, and the fitted Model keeps those ' +
        'compartments. Before simulating fast events, rebuild the Compartment Model at these ' +
        'values so d_lambda can cut it finer.',
    )
  }
  for (const p of free) {
    if (p.atBound || p.standardError === undefined) continue
    const share = p.log ? p.standardError / p.fitted : undefined
    if (share !== undefined && share > LOOSE_SHARE) {
      notes.push(
        `${p.label} is poorly constrained (± ${Math.round(share * 100)}%): the recording says ` +
          'little about it.',
      )
    }
  }
  if (result.correlations) {
    // A pair with a member on its bound has no correlation (NaN), and is passed over by `>`.
    free.forEach((p, a) =>
      free.slice(a + 1).forEach((q, k) => {
        const r = result.correlations![a]![a + 1 + k]!
        if (Math.abs(r) > TRADED) {
          notes.push(
            `${p.label} and ${q.label} trade against each other (r = ${r.toFixed(2)}): ` +
              'the recording sets a combination of the two better than either.',
          )
        }
      }),
    )
  } else if (free.some((p) => !p.atBound)) {
    notes.push(
      'The fit is singular, so it has no standard errors: a free parameter changes nothing.',
    )
  }
  if (result.unsteppedSweeps > 0) {
    notes.push(
      `The current in ${plural(result.unsteppedSweeps, 'sweep')} changes at nearly every sample, ` +
        'so it is a measured current rather than a stepped command, and Skip after steps found no ' +
        'steps to skip after. Pick the command if the recording has one: a measured current is noisy.',
    )
  }
  if (result.reason === 'max-iterations') {
    notes.push(
      'The fit stopped at Max iterations before it settled. Raise it, or fix a parameter.',
    )
  } else if (result.reason === 'stalled') {
    notes.push('The fit stopped where no step lowered the error any further.')
  }
  return notes
}

/** The free parameters a card's ticks name, in `MEMBRANE_PARAMETERS`' order. */
export function freeKeys(ticked: (key: MembraneKey) => boolean): MembraneKey[] {
  return MEMBRANE_PARAMETERS.map((p) => p.key).filter(ticked)
}
