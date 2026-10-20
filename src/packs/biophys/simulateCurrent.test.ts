/**
 * Simulate Model's Current socket: a table of injected current held onto the run's steps, into the
 * soma or a named site, one run per sweep, added to the Clamp tab's — and read through the card's
 * pickers, by unit, as Fit Model Passive reads a recording.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { ParamValues } from '../../core/node'
import { T, column, tableSchema } from '../../core/types'
import type { DType } from '../../core/types'
import type { CellValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
import { held } from './resample'
import { simulateNode } from './simulate'
import { movieBasis, runSimulateJob } from './simulateJob'
import { planRun, runInputs, tracesTable } from './simulateOps'
import { build, cloud } from './testFixtures'

const PARAMS: ParamValues = {
  ...defaultParams(simulateNode),
  drive: 'none',
  duration: 60,
  dt: 0.025,
  sampleEvery: 0.5,
}

/** A current table: `t` in ms, `I` in `unit`, and optionally `site` and `sweep`. */
function currentTable(
  rows: { t: number; I: number; site?: string; sweep?: CellValue }[],
  unit = 'pA',
  sweepDtype: DType = 'i64',
) {
  const hasSite = rows.some((r) => r.site !== undefined)
  const hasSweep = rows.some((r) => r.sweep !== undefined)
  return makeTable(
    tableSchema(
      column('t', 'f64', 'ms'),
      column('I', 'f64', unit),
      ...(hasSite ? [column('site', 'str')] : []),
      ...(hasSweep ? [column('sweep', sweepDtype)] : []),
    ),
    {
      t: rows.map((r) => r.t),
      I: rows.map((r) => r.I),
      ...(hasSite ? { site: rows.map((r) => r.site ?? null) } : {}),
      ...(hasSweep ? { sweep: rows.map((r) => r.sweep ?? null) } : {}),
    },
  )
}

/** The card's run of `value` with `current` wired, its pickers resolved as the card resolves them. */
function plan(
  value: ReturnType<typeof build>,
  current: ReturnType<typeof currentTable> | undefined,
  over: ParamValues = {},
  record?: ReturnType<typeof cloud>,
) {
  const params = { ...PARAMS, ...over }
  const ctx = makeInferContext(simulateNode, params, {
    ...(current ? { current: T.table(current.schema) } : {}),
    ...(record ? { record: T.points(record.attributes.schema) } : {}),
  })
  return planRun(
    value,
    params,
    runInputs({ record, spikes: undefined, current }, (id) => ctx.column(id), params),
  )
}

async function soma(p: ReturnType<typeof plan>) {
  const result = await runSimulateJob(p.job)
  return tracesTable(p.labels, result, p.job, p.sweeps, p.injecting)
}

describe('held', () => {
  it('holds each value until the next sample, the last for one step, and nothing outside', () => {
    const t = Float64Array.of(10, 20, 25)
    const y = Float64Array.of(1, Number.NaN, 3)
    const grid = Float64Array.of(5, 10, 15, 20, 24, 25, 29, 30, 40)
    expect(Array.from(held(t, y, grid))).toEqual([0, 1, 1, 0, 0, 3, 3, 0, 0])
  })
})

describe('the Current socket', () => {
  it('injects a table’s step exactly as the Clamp tab’s step does', async () => {
    const value = build()
    const byClamp = await soma(
      plan(value, undefined, {
        clamp: true,
        amplitude: 0.1,
        clampDelay: 10,
        clampDuration: 30,
      }),
    )
    // 100 pA from 10 ms to 40 ms, as three breakpoints.
    const table = currentTable([
      { t: 0, I: 0 },
      { t: 10, I: 100 },
      { t: 40, I: 0 },
    ])
    const byTable = await soma(plan(value, table))
    const a = getColumn(byClamp, 'soma') as number[]
    const b = getColumn(byTable, 'soma') as number[]
    expect(Math.max(...a.map((v, i) => Math.abs(v - b[i]!)))).toBeLessThan(1e-9)
    // Its current is the injected column, in nA.
    expect(getColumn(byTable, 'injected')).toEqual(getColumn(byClamp, 'injected'))
  })

  it('runs every sweep from rest, the outputs naming it, and adds to the Clamp tab', async () => {
    const value = build()
    const rows = [1, 2].flatMap((sweep) => [
      { t: 0, I: 0, sweep },
      { t: 10, I: sweep === 1 ? 50 : -50, sweep },
      { t: 40, I: 0, sweep },
    ])
    const p = plan(value, currentTable(rows))
    expect(p.job.sweeps).toHaveLength(2)
    const table = await soma(p)
    expect(table.schema.columns.map((c) => c.name)).toEqual(['t', 'sweep', 'soma', 'injected'])
    const sweep = getColumn(table, 'sweep')
    const v = getColumn(table, 'soma') as number[]
    const one = v.filter((_, i) => sweep[i] === 1)
    const two = v.filter((_, i) => sweep[i] === 2)
    expect(one.length).toBe(two.length)
    // A passive cell is linear about rest: the two sweeps mirror each other.
    const rest = one[0]!
    expect(Math.max(...one.map((x, i) => Math.abs(x - rest + (two[i]! - rest))))).toBeLessThan(
      1e-9,
    )
    // With a holding current from the Clamp tab on top, each sweep's deflection adds to its own.
    const holding = { clamp: true, amplitude: 0.05, clampDelay: 0, clampDuration: 60 }
    const both = await soma(plan(value, currentTable(rows), holding))
    const alone = await soma(plan(value, undefined, holding))
    const h = getColumn(alone, 'soma') as number[]
    const vb = (getColumn(both, 'soma') as number[]).filter(
      (_, i) => getColumn(both, 'sweep')[i] === 1,
    )
    expect(
      Math.max(...vb.map((x, i) => Math.abs(x - rest - (one[i]! - rest) - (h[i]! - rest)))),
    ).toBeLessThan(1e-9)
  })

  it('goes into the site a row names, the soma for none, and says a name no site has', () => {
    const value = build()
    const record = cloud([['7', '7', 'post', 45_000, 0]])
    const p = plan(
      value,
      currentTable(
        // 20 pA from 0 to 10 ms at each, a lone row being held for no time at all.
        ['', 'site 1', 'nowhere'].flatMap((site) => [
          { t: 0, I: 20, site },
          { t: 10, I: 0, site },
        ]),
      ),
      { currentSite: 'site' },
      record,
    )
    const into = p.job.sweeps![0]!.map((c) => c.compartment).sort()
    expect(into).toEqual([value.soma.compartment, p.job.record[1]!].sort())
    expect(p.notes.join(' ')).toMatch(/names "nowhere", which no record site is called/)
  })

  it('reads the current by its unit, asks when two columns could be it, and refuses one with none', () => {
    const two = makeTable(
      tableSchema(
        column('t', 'f64', 'ms'),
        column('Im', 'f64', 'pA'),
        column('Icmd', 'f64', 'pA'),
      ),
      { t: [0], Im: [1], Icmd: [1] },
    )
    const ctx = (table: typeof two, over: ParamValues = {}) =>
      makeInferContext(simulateNode, { ...PARAMS, ...over }, { current: T.table(table.schema) })
    expect(simulateNode.validate!(ctx(two)).join(' ')).toMatch(
      /Pick the injected current: Im and Icmd could each be it/,
    )
    expect(simulateNode.validate!(ctx(two, { currentValue: 'Icmd' }))).toEqual([])
    const bare = makeTable(tableSchema(column('t', 'f64', 'ms'), column('I', 'f64')), {
      t: [0],
      I: [1],
    })
    expect(simulateNode.validate!(ctx(bare)).join(' ')).toMatch(
      /No column of the current table is in pA or nA/,
    )
    // A sweep column names the outputs' sweeps before a run, in its own dtype.
    const swept = currentTable([{ t: 0, I: 1, sweep: 'a' }], 'pA', 'str')
    const inferred = simulateNode.inferOutputs!(ctx(swept))
    const traces = (
      inferred.traces as { schema: { columns: { name: string; dtype: string }[] } }
    ).schema
    expect(traces.columns.find((c) => c.name === 'sweep')?.dtype).toBe('str')
  })
})

describe('the Current socket’s edges', () => {
  it('runs an empty table once with no current, saying so, and keeps the injected column', async () => {
    const value = build()
    const p = plan(value, currentTable([]))
    expect(p.job.sweeps).toHaveLength(1)
    expect(p.notes.join(' ')).toMatch(/no row with a time, so no current is injected/)
    const table = await soma(p)
    // The column inference promised, as zeros: nothing reached a record site.
    expect((getColumn(table, 'injected') as number[]).every((x) => x === 0)).toBe(true)
  })

  it('says a table that ends on a current, its last row held only one step', () => {
    const p = plan(
      build(),
      currentTable([
        { t: 0, I: 0 },
        { t: 10, I: 100 },
      ]),
    )
    expect(p.notes.join(' ')).toMatch(/ends on a current that is not zero once/)
  })

  it('keeps the sweep column’s name from a record site, and a site column from the current picker', () => {
    const value = build()
    const named = cloud([['sweep', '7', 'post', 45_000, 0]])
    const p = plan(
      value,
      currentTable([{ t: 0, I: 1, sweep: 1 }]),
      { recordLabel: 'neuronId' },
      named,
    )
    expect(p.labels).not.toContain('sweep')
    const table = makeTable(
      tableSchema(column('t', 'f64', 'ms'), column('I', 'f64'), column('site', 'i64')),
      { t: [0], I: [1], site: [3] },
    )
    const params = { ...PARAMS, currentUnit: 'pA', currentSite: 'site' }
    const ctx = makeInferContext(simulateNode, params, { current: T.table(table.schema) })
    expect(simulateNode.validate!(ctx)).toEqual([])
    expect(ctx.column('currentValue')).toBe('I')
  })

  it('bases Playback’s movie on the sweep it replays, the first, and no other', () => {
    const value = build()
    const rows = (second: number) => [
      { t: 0, I: 10, sweep: 1 },
      { t: 10, I: 0, sweep: 1 },
      { t: 0, I: second, sweep: 2 },
      { t: 10, I: 0, sweep: 2 },
    ]
    const a = plan(value, currentTable(rows(20)))
    const b = plan(value, currentTable(rows(-20)))
    expect(movieBasis(b.job)).toBe(movieBasis(a.job))
    // Playback's replan holds only that sweep, keeps every label, and keys the same movie.
    const params = { ...PARAMS }
    const table = currentTable(rows(20))
    const ctx = makeInferContext(simulateNode, params, { current: T.table(table.schema) })
    const replay = planRun(
      value,
      params,
      runInputs({ current: table }, (id) => ctx.column(id), params),
      { replay: true },
    )
    expect(replay.job.sweeps).toHaveLength(1)
    expect(replay.sweeps?.cells).toEqual([1, 2])
    expect(movieBasis(replay.job)).toBe(movieBasis(a.job))
  })
})
