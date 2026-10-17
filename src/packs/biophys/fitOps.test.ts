/**
 * Fit Model's tables and conversions — each schema agreeing with its table, a recording read into
 * the solver's units — and the node end to end on a recording made from a known membrane, its
 * columns resolved the way the card resolves them.
 */

import { describe, expect, it } from 'vitest'

import type { EvalContext } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { T, column, tableSchema } from '../../core/types'
import type { CellModelValue, TableValue } from '../../core/values'
import { describeValue, getColumn, makeTable } from '../../core/values'
import type { PassiveFitResult } from './fit'
import { passiveResponses } from './fit'
import { fitModelNode } from './fitModel'
import { modelNode } from './model'
import {
  fitIterationsSchema,
  fitIterationsTable,
  fitNotes,
  fitParametersSchema,
  fitParametersTable,
  fitTracesSchema,
  fitTracesTable,
  appliedParams,
  fittedModel,
  recordedSweeps,
} from './fitOps'
import type { FitOutcome } from './fitOps'
import type { FitMembrane } from './passive'
import { HH, build, cloud } from './testFixtures'
import { placePoints } from './build'

const TRUTH = { rm: 15_000, cm: 1.1, ra: 180, eLeak: -55 }

/**
 * Load Recording's shape for a two-sweep I–V made from `TRUTH`: `t` (ms), `sweep`, the voltage in
 * mV and the command in pA, every 0.1 ms for 100 ms, the second sweep's rows first.
 */
function recording(): TableValue {
  const t = Float64Array.from({ length: 1000 }, (_, i) => i * 0.1)
  const sweeps = [-30, 30].map((pA, k) => ({
    sweep: k + 1,
    t,
    v: new Float64Array(t.length),
    command: t.map((x) => (x >= 20 && x < 70 ? pA / 1000 : 0)),
  }))
  const v = passiveResponses(build({ membrane: TRUTH }), TRUTH, sweeps, 0.025)
  const rows = [1, 0].flatMap((k) =>
    Array.from(t, (x, i) => [x, k + 1, v[k]![i]!, sweeps[k]!.command[i]! * 1000] as const),
  )
  return makeTable(
    tableSchema(
      column('t', 'f64', 'ms'),
      column('sweep', 'i64'),
      column('IN 1', 'f64', 'pA'),
      column('Vm_prime', 'f64', 'mV'),
      column('I_clamp', 'f64', 'pA'),
    ),
    {
      t: rows.map((r) => r[0]),
      sweep: rows.map((r) => r[1]),
      'IN 1': rows.map(() => 0),
      Vm_prime: rows.map((r) => r[2]),
      I_clamp: rows.map((r) => r[3]),
    },
  )
}

function context(
  model: CellModelValue,
  table: TableValue,
  params: Record<string, unknown>,
  warnings: string[],
): EvalContext {
  const inputs = { model: T.cellModel(), recording: T.table(table.schema) }
  return {
    ...makeInferContext(
      fitModelNode,
      { ...defaultParams(fitModelNode), ...params } as never,
      inputs,
    ),
    input: (port: string) => (port === 'model' ? model : table),
    warn: (message: string) => warnings.push(message),
    progress: () => {},
    signal: new AbortController().signal,
  } as unknown as EvalContext
}

describe('recordedSweeps', () => {
  it('splits by sweep in the order met, sorts by time, converts to mV, nA and ms', () => {
    const table = makeTable(
      tableSchema(
        column('t', 'f64', 's'),
        column('sweep', 'i64'),
        column('v', 'f64', 'V'),
        column('i', 'f64', 'pA'),
      ),
      {
        t: [0.002, 0, 0.001, 0],
        sweep: [2, 2, 2, 1],
        v: [-0.06, -0.07, null, -0.05],
        i: [10, null, 20, 0],
      },
    )
    const sweeps = recordedSweeps(table, {
      time: 't',
      sweep: 'sweep',
      voltage: 'v',
      command: 'i',
      scale: { time: 1000, voltage: 1000, current: 1e-3 },
    })
    expect(sweeps.map((s) => s.sweep)).toEqual([2, 1])
    expect(Array.from(sweeps[0]!.t)).toEqual([0, 1, 2])
    // A missing voltage is not compared; a missing current is none.
    expect(Array.from(sweeps[0]!.v)).toEqual([-70, Number.NaN, -60])
    expect(Array.from(sweeps[0]!.command)).toEqual([0, 0.02, 0.01])
  })

  it('refuses a sweep whose times are not evenly spaced', () => {
    const table = makeTable(
      tableSchema(column('t', 'f64'), column('v', 'f64'), column('i', 'f64')),
      { t: [0, 1, 3], v: [0, 0, 0], i: [0, 0, 0] },
    )
    const cols = { time: 't', sweep: undefined, voltage: 'v', command: 'i' }
    expect(() =>
      recordedSweeps(table, { ...cols, scale: { time: 1, voltage: 1, current: 1 } }),
    ).toThrow(/not evenly spaced/)
  })
})

/** A fit that settled on `membrane`, as `fittedModel` reads one. */
const settledOn = (membrane: FitMembrane): FitOutcome => ({
  membrane,
  reason: 'converged',
  iterations: [{ iteration: 7, rms: 0.5, membrane }],
  startRms: 4,
  rms: 0.5,
})

describe('fittedModel', () => {
  it('rescales the axial path to the fitted Ra and scales the area as the build scales one', () => {
    const value = build({ ...HH, membrane: TRUTH, areaFactor: 1.5 })
    // The card's own area factor, 3 on a model built at 1.5: twice the membrane it was built with.
    const fitted = fittedModel(value, settledOn({ ...TRUTH, ra: 360, area: 3 }))
    expect(fitted.compartments.gAxial[3]).toBeCloseTo(value.compartments.gAxial[3]! / 2, 12)
    expect(fitted.membrane).toEqual({ ...TRUTH, ra: 360 })
    expect(fitted.areaFactor).toBe(3)
    expect(fitted.compartments.area[3]).toBeCloseTo(value.compartments.area[3]! * 2, 12)
    // No published set any more, whatever the start model was built from.
    expect(fitted.preset.label).toBe('Fitted')
    // Densities as placed: their conductances grow with the membrane.
    expect(fitted.channels).toEqual(value.channels)
    // Led by how the fit ended, the counts kept.
    expect(describeValue(fitted)).toMatch(
      /^Settled after 7 iterations · RMS 4 → 0\.5 mV · [\d,]+ compartments · /,
    )
    // The input is the input to every other run: untouched.
    expect(value.membrane.ra).toBe(180)
  })

  it('places points as the model it was fitted on does, so Simulate can record on it', () => {
    const value = build({ membrane: TRUTH })
    const fitted = fittedModel(value, settledOn({ ...TRUTH, area: 1 }))
    const points = cloud([['A', '7', 'pre', 45_000, 0]])
    expect(placePoints(fitted, points)).toEqual(placePoints(value, points))
  })
})

describe('appliedParams', () => {
  it('is the fit as the Compartment Model’s params: Custom, rounded, the card’s own area factor', () => {
    const value = build({ membrane: TRUTH, areaFactor: 1.5 })
    const fitted = fittedModel(value, settledOn({ ...TRUTH, rm: 15_003.7, area: 3 }))
    expect(appliedParams(fitted)).toEqual({
      preset: 'custom',
      rm: 15_000,
      cm: 1.1,
      ra: 180,
      eLeak: -55,
      areaFactor: 3,
    })
    // A built model has no fit to apply.
    expect(appliedParams(value)).toBeUndefined()
    // Every key a param the Compartment Model declares: a renamed one would be written to nothing.
    const declared = new Set((modelNode.params ?? []).map((p) => p.id))
    expect(Object.keys(appliedParams(fitted)!).filter((id) => !declared.has(id))).toEqual([])
  })
})

describe('fitNotes', () => {
  const base = {
    correlations: [
      [1, 0.99, Number.NaN],
      [0.99, 1, Number.NaN],
      [Number.NaN, Number.NaN, Number.NaN],
    ],
    reason: 'max-iterations',
    parameters: [
      {
        key: 'rm',
        label: 'Rm',
        unit: 'Ω·cm²',
        log: true,
        lower: 1e3,
        upper: 1e6,
        free: true,
        start: 1,
        fitted: 1e4,
        standardError: 8e3,
        atBound: false,
      },
      {
        key: 'ra',
        label: 'Ra',
        unit: 'Ω·cm',
        log: true,
        lower: 20,
        upper: 2000,
        free: true,
        start: 1,
        fitted: 100,
        standardError: 1,
        atBound: false,
      },
      {
        key: 'cm',
        label: 'Cm',
        unit: 'µF/cm²',
        log: true,
        lower: 0.2,
        upper: 5,
        free: true,
        start: 1,
        fitted: 5,
        standardError: undefined,
        atBound: true,
      },
    ],
  } as unknown as PassiveFitResult
  it('names a bound, a loose parameter, a traded pair and an unsettled fit', () => {
    const notes = fitNotes(base).join('\n')
    expect(notes).toMatch(/Cm ended on its upper bound/)
    expect(notes).toMatch(/fit the area factor instead/)
    expect(notes).toMatch(/Rm is poorly constrained \(± 80%\)/)
    expect(notes).toMatch(/Rm and Ra trade against each other \(r = 0\.99\)/)
    expect(notes).toMatch(/Max iterations/)
  })
})

describe('fitNotes, the advice for a bound', () => {
  const parameter = (
    key: string,
    free: boolean,
    start: number,
    fitted: number,
    atBound = false,
  ) => ({
    key,
    label: key,
    unit: '',
    log: true,
    lower: 0,
    upper: 1e9,
    free,
    start,
    fitted,
    standardError: atBound ? undefined : 0,
    atBound,
  })
  const notes = (parameters: unknown[]) =>
    fitNotes({
      correlations: undefined,
      reason: 'converged',
      parameters,
    } as unknown as PassiveFitResult).join('\n')
  it('names the move not already made', () => {
    const ra = parameter('ra', true, 100, 2000, true)
    expect(notes([ra, parameter('cm', true, 1, 1), parameter('area', false, 1, 1)])).toMatch(
      /Fix Cm/,
    )
    expect(notes([ra, parameter('cm', false, 1, 1), parameter('area', false, 1, 1)])).toMatch(
      /Tick Fit area factor/,
    )
    expect(notes([ra, parameter('cm', false, 1, 1), parameter('area', true, 1, 1)])).toMatch(
      /check the soma diameter and the radii/,
    )
  })
  it('says when the fitted cable wants finer compartments than it has', () => {
    const fine = [
      parameter('ra', true, 100, 100),
      parameter('cm', false, 1, 1),
      parameter('area', true, 1, 1.2),
    ]
    expect(notes(fine)).not.toMatch(/d_lambda/)
    const coarse = [
      parameter('ra', true, 100, 300),
      parameter('cm', false, 1, 1),
      parameter('area', true, 1, 3),
    ]
    expect(notes(coarse)).toMatch(/to 33% of the one the model’s compartments were cut for/)
  })
})

describe('Fit Model', () => {
  it('fits a recording through the card’s own column resolution, each table matching its schema', async () => {
    const table = recording()
    const warnings: string[] = []
    // Started off the truth, with channels, so the passive copy is what is fitted.
    const start = build({ ...HH, membrane: { rm: 25_000, cm: 0.8, ra: 120, eLeak: -60 } })
    const ctx = context(start, table, { dt: 0.025, skipAfterSteps: 0 }, warnings)
    // A lone column in mV is what the unset voltage picker means; two in pA are a question.
    expect(ctx.column('voltage')).toBe('Vm_prime')
    const unset = makeInferContext(fitModelNode, ctx.params, {
      recording: T.table(table.schema),
    })
    expect(fitModelNode.validate!(unset).join('\n')).toMatch(
      /Pick the injected current: IN 1 and I_clamp could each be it/,
    )
    await expect(fitModelNode.evaluate(ctx)).rejects.toThrow(/Pick the injected current/)
    const picked = context(
      start,
      table,
      { dt: 0.025, skipAfterSteps: 0, command: 'I_clamp' },
      warnings,
    )
    expect(
      fitModelNode.validate!(
        makeInferContext(fitModelNode, picked.params, { recording: T.table(table.schema) }),
      ),
    ).toEqual([])
    // An area factor fitted below what the card takes could never be applied.
    const tiny = { ...picked.params, fitCm: false, fitArea: true, areaLower: 0.005 }
    expect(
      fitModelNode.validate!(
        makeInferContext(fitModelNode, tiny, { recording: T.table(table.schema) }),
      ),
    ).toEqual([
      'Area factor’s lower bound must be at least 0.01, the Compartment Model’s smallest.',
    ])
    const out = (await fitModelNode.evaluate(picked)) as Record<string, unknown>
    const model = out.model as CellModelValue
    expect(model.membrane.rm).toBeCloseTo(TRUTH.rm, -2)
    expect(model.membrane.eLeak).toBeCloseTo(TRUTH.eLeak, 1)
    expect(warnings.some((w) => /passive cell/.test(w))).toBe(true)

    const inferred = fitModelNode.inferOutputs!(
      makeInferContext(fitModelNode, picked.params, { recording: T.table(table.schema) }),
    )
    for (const port of ['parameters', 'traces', 'iterations'] as const) {
      expect((out[port] as TableValue).schema, port).toEqual(
        (inferred[port] as { schema: unknown }).schema,
      )
    }
    const traces = out.traces as TableValue
    expect(new Set(getColumn(traces, 'sweep'))).toEqual(new Set([1, 2]))
    const recorded = getColumn(traces, 'recorded') as number[]
    const fitted = getColumn(traces, 'fitted') as number[]
    expect(Math.max(...recorded.map((r, i) => Math.abs(r - fitted[i]!)))).toBeLessThan(0.01)
  })

  it('says when a recording names no voltage it can read', () => {
    const table = makeTable(tableSchema(column('t', 'f64', 'ms'), column('x', 'f64')), {
      t: [0],
      x: [0],
    })
    const issues = fitModelNode.validate!(
      makeInferContext(fitModelNode, {}, { recording: T.table(table.schema) }),
    )
    expect(issues.join('\n')).toMatch(/No column is in mV or V/)
    // A unit given by hand lists every column, and the picker on its default takes the first.
    const given = fitModelNode.validate!(
      makeInferContext(
        fitModelNode,
        { voltageUnit: 'mV', commandUnit: 'pA', voltage: 'x', command: 'x' },
        { recording: T.table(table.schema) },
      ),
    )
    expect(given).toEqual([])
    // A unit set by hand opens every column but time and sweep, which it does not make a voltage.
    const long = makeTable(
      tableSchema(
        column('t', 'f64', 'ms'),
        column('sweep', 'i64'),
        column('Vm', 'f64'),
        column('I', 'f64', 'pA'),
      ),
      { t: [0], sweep: [1], Vm: [0], I: [0] },
    )
    const handSet = fitModelNode.validate!(
      makeInferContext(
        fitModelNode,
        { ...defaultParams(fitModelNode), voltageUnit: 'mV' },
        {
          recording: T.table(long.schema),
        },
      ),
    )
    expect(handSet.join('\n')).toMatch(/Pick the recorded voltage: Vm and I could each be it/)
  })

  it('reads only a fitted parameter’s bounds, and names a remedy that exists for time', () => {
    const schema = tableSchema(
      column('t', 'f64', 'min'),
      column('Vm', 'f64', 'mV'),
      column('I', 'f64', 'pA'),
    )
    const issues = fitModelNode.validate!(
      makeInferContext(
        fitModelNode,
        { ...defaultParams(fitModelNode), fitRa: false, raLower: 5000, raUpper: 10 },
        { recording: T.table(schema) },
      ),
    ).join('\n')
    expect(issues).not.toMatch(/Ra’s lower bound/)
    expect(issues).toMatch(
      /t is in min, which is not a time unit: give the table its times in ms or s/,
    )
  })
})

describe('the tables', () => {
  it('agree with their schemas on an empty fit', () => {
    const empty = { parameters: [], traces: [], iterations: [] } as unknown as PassiveFitResult
    expect(fitParametersTable(empty).schema).toEqual(fitParametersSchema())
    expect(fitTracesTable(empty, 'str').schema).toEqual(fitTracesSchema('str'))
    expect(fitIterationsTable(empty).schema).toEqual(fitIterationsSchema())
  })
})
