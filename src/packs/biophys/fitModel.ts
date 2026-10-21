/**
 * Fit Model: a Compartment Model's passive membrane — Rm, Cm, Ra, E leak and an area factor —
 * fitted to a current-clamp recording, each sweep replaying the current the cell got. See
 * `docs/biophys.md`, Fitting; the method and its shortcuts are `fit.ts`'.
 *
 * **`expensive`**: a fit is tens to hundreds of simulations, seconds to minutes. Its evaluations
 * run in a pool of workers kept for the length of the fit (`fitPool.ts`), the Jacobian's in
 * parallel; Cancel ends them.
 *
 * **A model with channels is fitted as its passive copy**, as the name says, and the fitted model
 * keeps the channels at their densities — said on the card only where a fitted area factor has
 * changed what they carry (`channelAreaNote`). A passive fit says what the membrane is with the
 * channels left out, which is only the cell where they are closed.
 */

import type { InferContext, ParamDef, ParamValues } from '../../core/node'
import { packNode } from '../../core/registry'
import type { DType, TableSchema } from '../../core/types'
import { NUMERIC_DTYPES, T, findColumn } from '../../core/types'
import { isCellModelValue, isTableValue } from '../../core/values'
import { formatNumber } from '../../style/format'
import type { MembraneKey } from './fit'
import { MEMBRANE_PARAMETERS, fitPassive, freeParameterRefusal } from './fit'
import { fitPool } from './fitPool'
import type { RecordingColumns } from './fitOps'
import {
  channelAreaNote,
  fitIterationsSchema,
  fitIterationsTable,
  fitNotes,
  fitParametersSchema,
  fitParametersTable,
  fitTracesSchema,
  fitTracesTable,
  fittedModel,
  freeKeys,
  recordedSweeps,
} from './fitOps'
import { columnScale, columnsInUnit, unitParam, unsetAmbiguity } from './unitColumns'
import { AREA_FACTOR_MIN } from './model'
import { TIME_COLUMN } from './simulateOps'

const tickId = (key: MembraneKey) => `fit${key[0]!.toUpperCase()}${key.slice(1)}`
const lowerId = (key: MembraneKey) => `${key}Lower`
const upperId = (key: MembraneKey) => `${key}Upper`

/** Ticked by default: everything but the area factor, which is fitted against a pinned Cm. */
const FREE_BY_DEFAULT: readonly MembraneKey[] = ['rm', 'cm', 'ra', 'eLeak']

const freeOf = (p: ParamValues) => freeKeys((key) => p[tickId(key)] === true)
const windowed = (p: ParamValues) => p.crop === true

/** The recording's time and sweep pickers: never a voltage or a current, whatever the unit says. */
const TAKEN = ['time', 'sweep']

/**
 * An unset picker with more than one column to mean, said rather than guessed: a Clampex file
 * records the amplifier's current monitor in pA beside the command, and the first column in pA is
 * the monitor — noisy, and a simulation per sweep where the command shares one.
 */
function ambiguity(
  ctx: Pick<InferContext, 'column' | 'params'>,
  schema: TableSchema,
  id: 'voltage' | 'command',
): string | undefined {
  return id === 'voltage'
    ? unsetAmbiguity(ctx, schema, {
        id,
        quantity: 'voltage',
        unitId: 'voltageUnit',
        takenIds: TAKEN,
        ask: 'Pick the recorded voltage',
      })
    : unsetAmbiguity(ctx, schema, {
        id,
        quantity: 'current',
        unitId: 'commandUnit',
        takenIds: TAKEN,
        ask: 'Pick the injected current',
        after: 'The command is usually the right one; a current monitor is noisy.',
      })
}

/**
 * The recording's columns and units, resolved through the context (invariant 5). Issues where it
 * cannot; the one statement of the choice for validate, infer and evaluate.
 */
function recordingColumns(
  ctx: Pick<InferContext, 'column' | 'params'>,
  schema: TableSchema,
): { cols: RecordingColumns; sweepDtype: DType } | { issues: string[] } {
  const time = ctx.column('time')
  const sweep = ctx.column('sweep')
  const voltage = ctx.column('voltage')
  const command = ctx.column('command')
  const issues: string[] = []
  for (const id of ['voltage', 'command'] as const) {
    const said = ambiguity(ctx, schema, id)
    if (said) issues.push(said)
  }
  if (!time) issues.push('The recording has no numeric column to use as time.')
  if (!voltage)
    issues.push(
      'No column is in mV or V: set Voltage unit to pick the voltage from any column.',
    )
  if (!command)
    issues.push(
      'No column is in pA or nA: set Current unit to pick the current from any column.',
    )
  const timeScale = columnScale(schema, 'time', time, 'auto', issues)
  const voltageScale = columnScale(schema, 'voltage', voltage, ctx.params.voltageUnit, issues)
  const currentScale = columnScale(schema, 'current', command, ctx.params.commandUnit, issues)
  if (issues.length || !time || !voltage || !command) return { issues }
  return {
    cols: {
      time,
      sweep,
      voltage,
      command,
      scale: { time: timeScale, voltage: voltageScale, current: currentScale },
    },
    sweepDtype: (sweep === undefined ? undefined : findColumn(schema, sweep))?.dtype ?? 'i64',
  }
}

function settingIssues(p: ParamValues): string[] {
  const issues: string[] = []
  const free = freeOf(p)
  const refusal = freeParameterRefusal(free)
  if (refusal) issues.push(refusal)
  // Only a fitted parameter's bounds are read, and shown: a fixed one's box is no setting at all.
  for (const m of MEMBRANE_PARAMETERS.filter((q) => free.includes(q.key))) {
    const lo = Number(p[lowerId(m.key)])
    const hi = Number(p[upperId(m.key)])
    if (!(lo < hi)) issues.push(`${m.label}’s lower bound must be below its upper bound.`)
    else if (m.log && !(lo > 0)) issues.push(`${m.label}’s bounds must be positive.`)
    // Apply writes the fitted factor into the card, whose param refuses less.
    else if (m.key === 'area' && lo < AREA_FACTOR_MIN) {
      issues.push(
        `Area factor’s lower bound must be at least ${AREA_FACTOR_MIN}, the Compartment Model’s smallest.`,
      )
    }
  }
  if (windowed(p) && !(Number(p.windowEnd) > Number(p.windowStart))) {
    issues.push('The fit window must end after it starts.')
  }
  return issues
}

export const fitModelNode = packNode({
  type: 'biophys:fit',
  label: 'Fit Model Passive',
  category: 'analysis',
  description:
    'Fits a Compartment Model’s passive membrane (Rm, Cm, Ra, E leak and an area factor) to a ' +
    'current-clamp recording; the fitted model, its parameters with standard errors, and the ' +
    'recorded and fitted traces.',
  guide:
    'Fits the passive membrane of a compartment model to a current-clamp recording from Load ' +
    'Recording by least squares: every sweep replays its own recorded command at the soma and the ' +
    'voltage is compared within a window. Says how well each parameter was determined. Plot ' +
    'Traces in a Line Chart to see the fit; wire Model into Simulate Model to run the fitted cell.',
  cost: 'expensive',
  inputs: [
    { id: 'model', label: 'Model', type: T.cellModel() },
    { id: 'recording', label: 'Recording', type: T.table() },
  ],
  outputs: [
    { id: 'model', label: 'Model', type: T.cellModel() },
    { id: 'parameters', label: 'Parameters', type: T.table() },
    { id: 'traces', label: 'Traces', type: T.table() },
    { id: 'iterations', label: 'Iterations', type: T.table() },
  ],
  paramGroups: [
    { id: 'data', label: 'Recording', affectsData: true },
    { id: 'fit', label: 'Fit', affectsData: true },
    { id: 'bounds', label: 'Bounds', affectsData: true },
  ],
  params: [
    {
      id: 'time',
      kind: 'column',
      label: 'Time',
      group: 'data',
      from: 'recording',
      default: TIME_COLUMN,
      dtypes: NUMERIC_DTYPES,
      advanced: true,
      help: 'The column of times; in ms unless the column says otherwise.',
    },
    {
      id: 'sweep',
      kind: 'column',
      label: 'Sweep',
      group: 'data',
      from: 'recording',
      default: 'sweep',
      optional: true,
      advanced: true,
      help: 'The column naming each row’s sweep. None fits the table as one sweep.',
    },
    {
      id: 'voltage',
      kind: 'column',
      label: 'Voltage',
      group: 'data',
      from: 'recording',
      schemaFrom: columnsInUnit('recording', 'voltage', 'voltageUnit', TAKEN),
      default: '',
      dtypes: NUMERIC_DTYPES,
      help: 'The recorded membrane voltage. Lists the columns in mV or V; set Voltage unit to choose any column.',
    },
    {
      id: 'command',
      kind: 'column',
      label: 'Current',
      group: 'data',
      from: 'recording',
      schemaFrom: columnsInUnit('recording', 'current', 'commandUnit', TAKEN),
      default: '',
      dtypes: NUMERIC_DTYPES,
      help: 'The current injected at the soma, replayed into the model sample by sample. Lists the columns in pA or nA; set Current unit to choose any column.',
    },
    unitParam('voltageUnit', 'Voltage unit', 'voltage', ['mV', 'V'], { group: 'data' }),
    unitParam('commandUnit', 'Current unit', 'current', ['pA', 'nA'], { group: 'data' }),
    ...MEMBRANE_PARAMETERS.map((m): ParamDef => ({
      id: tickId(m.key),
      kind: 'boolean',
      label: `Fit ${m.label}`,
      group: 'fit',
      default: FREE_BY_DEFAULT.includes(m.key),
      help: m.tickHelp ?? `Unticked, ${m.label} stays at the model’s value.`,
    })),
    {
      id: 'seal',
      kind: 'number',
      label: 'Seal (nS)',
      group: 'fit',
      default: 0,
      min: 0,
      help: 'The recording electrode’s seal conductance: held at this while Fit Seal is unticked, and where its fit starts otherwise. Günay et al. (2015) fitted 0.2 nS on a larval motoneuron. Left at 0, a fitted E leak absorbs the seal and reads depolarised (Gouwens & Wilson 2009).',
    },
    {
      id: 'crop',
      kind: 'boolean',
      label: 'Fit window',
      group: 'fit',
      default: false,
      help: 'Compare only part of each sweep. The model still replays the command from the start of the sweep, so start the window after the cell has settled.',
    },
    {
      id: 'windowStart',
      kind: 'number',
      label: 'From (ms)',
      group: 'fit',
      default: 0,
      visibleIf: windowed,
    },
    {
      id: 'windowEnd',
      kind: 'number',
      label: 'To (ms)',
      group: 'fit',
      default: 1000,
      visibleIf: windowed,
    },
    {
      id: 'skipAfterSteps',
      kind: 'number',
      label: 'Skip after steps (ms)',
      group: 'fit',
      default: 1,
      min: 0,
      advanced: true,
      help: 'Leave out this long after every change in the injected current, where a recording carries the bridge-balance and capacitance-compensation artefact no model has.',
    },
    {
      id: 'dt',
      kind: 'number',
      label: 'dt (ms)',
      group: 'fit',
      default: 0.1,
      min: 0.001,
      advanced: true,
      help: 'The solver’s step during the fit. A passive membrane is smooth, so a coarser step than Simulate Model’s usually fits the same.',
    },
    {
      id: 'maxIterations',
      kind: 'int',
      label: 'Max iterations',
      group: 'fit',
      default: 50,
      min: 1,
      max: 500,
      advanced: true,
    },
    ...MEMBRANE_PARAMETERS.flatMap((m): ParamDef[] => [
      {
        id: lowerId(m.key),
        kind: 'number',
        label: `${m.label} from (${m.unit})`,
        group: 'bounds',
        default: m.lower,
        advanced: true,
        visibleIf: (p) => p[tickId(m.key)] === true,
      },
      {
        id: upperId(m.key),
        kind: 'number',
        label: `${m.label} to (${m.unit})`,
        group: 'bounds',
        default: m.upper,
        advanced: true,
        visibleIf: (p) => p[tickId(m.key)] === true,
      },
    ]),
  ],

  inferOutputs: (ctx) => {
    const schema = ctx.schema('recording')
    const resolved = schema ? recordingColumns(ctx, schema) : undefined
    return {
      model: T.cellModel(),
      parameters: T.table(fitParametersSchema()),
      traces: T.table(
        fitTracesSchema(resolved && 'cols' in resolved ? resolved.sweepDtype : 'i64'),
      ),
      iterations: T.table(fitIterationsSchema()),
    }
  },

  validate: (ctx) => {
    const schema = ctx.schema('recording')
    const resolved = schema ? recordingColumns(ctx, schema) : undefined
    return [
      ...settingIssues(ctx.params),
      ...(resolved && 'issues' in resolved ? resolved.issues : []),
    ]
  },

  evaluate: async (ctx) => {
    const value = ctx.input('model')
    if (!isCellModelValue(value)) throw new Error('Wire a Compartment Model into Model.')
    const table = ctx.input('recording')
    if (!isTableValue(table)) throw new Error('Wire a recording into Recording.')
    const issues = settingIssues(ctx.params)
    const resolved = recordingColumns(ctx, table.schema)
    if ('issues' in resolved) issues.push(...resolved.issues)
    if (issues.length || !('cols' in resolved)) throw new Error(issues[0])
    const sweeps = recordedSweeps(table, resolved.cols)
    const p = ctx.params
    const free = freeOf(p)
    const maxIterations = Number(p.maxIterations)
    const bounds = Object.fromEntries(
      MEMBRANE_PARAMETERS.filter((m) => free.includes(m.key)).map((m) => [
        m.key,
        { lower: Number(p[lowerId(m.key)]), upper: Number(p[upperId(m.key)]) },
      ]),
    )
    // One evaluation per free parameter in each Jacobian, so no more workers than that.
    const cores = typeof navigator === 'undefined' ? 2 : (navigator.hardwareConcurrency ?? 2)
    const size = Math.max(1, Math.min(cores - 1, free.length))
    let pool: ReturnType<typeof fitPool> | undefined
    try {
      const result = await fitPassive(
        value,
        sweeps,
        {
          free,
          bounds,
          seal: Number(p.seal),
          window: windowed(p)
            ? { start: Number(p.windowStart), end: Number(p.windowEnd) }
            : undefined,
          skipAfterSteps: Number(p.skipAfterSteps),
          dt: Number(p.dt),
          maxIterations,
          signal: ctx.signal,
          onIteration: (it) =>
            ctx.progress(
              Math.min(1, it.iteration / maxIterations),
              `Iteration ${it.iteration}: RMS ${formatNumber(it.rms)} mV`,
            ),
        },
        (setup) =>
          (pool = fitPool(
            () => new Worker(new URL('./fit.worker.ts', import.meta.url), { type: 'module' }),
            setup,
            size,
            ctx.signal,
          )).evaluate,
      )
      const carried = channelAreaNote(value.channels.length, result)
      if (carried) ctx.warn(carried)
      for (const note of fitNotes(result)) ctx.warn(note)
      return {
        model: fittedModel(value, result),
        parameters: fitParametersTable(result),
        traces: fitTracesTable(result, resolved.sweepDtype),
        iterations: fitIterationsTable(result),
      }
    } finally {
      pool?.close()
    }
  },
})
