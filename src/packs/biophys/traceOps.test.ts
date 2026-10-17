/**
 * Combine Traces' arithmetic: the names, the grid, the resampling and its two refusals (no
 * extrapolation, no bridging a gap), a long input spread into sweeps, and the schema agreeing
 * with the table.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
import type { TraceInput } from './traceOps'
import {
  combinedColumns,
  combinedSchema,
  combinedTable,
  planGrid,
  prepareTraces,
  resample,
} from './traceOps'

/** Simulate's shape: wide, a column per site, sampled every 1 ms from 0 to 4. */
const simulated = makeTable(
  tableSchema(
    column('t', 'f64', 'ms'),
    column('soma', 'f64', 'mV'),
    column('tip', 'f64', 'mV'),
  ),
  { t: [0, 1, 2, 3, 4], soma: [0, 10, 20, 30, 40], tip: [5, 5, null, 5, 5] },
)

/** Load Recording's shape: long, two sweeps sampled every 2 ms, the second out of time order. */
const recorded = makeTable(
  tableSchema(column('t', 'f64', 'ms'), column('sweep', 'i64'), column('soma', 'f64', 'mV')),
  { t: [0, 2, 4, 4, 0, 2], sweep: [1, 1, 1, 2, 2, 2], soma: [0, 2, 4, 14, 10, 12] },
)

function input(table: TableValue, over: Partial<TraceInput> = {}): TraceInput {
  return {
    label: 'in1',
    named: false,
    table,
    time: 't',
    columns: table.schema.columns.filter((c) => c.name !== 't' && c.name !== 'sweep'),
    shift: 0,
    ...over,
  }
}

const spec = (i: TraceInput) => prepareTraces(i).spec

describe('combinedColumns', () => {
  it('prefixes a column two inputs share with each input’s label, a given name always', () => {
    const names = combinedColumns([
      spec(input(simulated, { label: 'sim' })),
      spec(input(recorded, { label: 'rec', sweep: 'sweep' })),
    ]).map((c) => c.name)
    // `soma` is in both, so each says whose; spread or not, it is one measurement.
    expect(names).toEqual(['sim: soma', 'tip', 'rec: soma 1', 'rec: soma 2'])
    const named = combinedColumns([spec(input(simulated, { label: 'model', named: true }))])
    expect(named.map((c) => c.name)).toEqual(['model: soma', 'model: tip'])
  })

  it('names a lone sweep without its number', () => {
    const one = makeTable(recorded.schema, { t: [0, 2], sweep: [3, 3], soma: [1, 2] })
    expect(combinedColumns([spec(input(one, { sweep: 'sweep' }))]).map((c) => c.name)).toEqual([
      'soma',
    ])
  })
})

describe('resample', () => {
  const t = Float64Array.of(0, 1, 2, 3)
  const y = Float64Array.of(0, 10, Number.NaN, 30)
  it('is linear between neighbours, exact on a sample, empty outside and beside a gap', () => {
    expect(resample(t, y, Float64Array.of(-0.1, 0.25, 1, 1.5, 2, 3, 3.1))).toEqual([
      null,
      2.5,
      10,
      null,
      null,
      30,
      null,
    ])
  })
})

describe('prepareTraces', () => {
  it('counts a time a trace already has, which an unspread long table is full of', () => {
    expect(prepareTraces(input(recorded, { sweep: 'sweep' })).repeated).toBe(0)
    // The same table read as one trace: every time is there twice.
    expect(prepareTraces(input(recorded)).repeated).toBe(3)
  })
})

describe('planGrid', () => {
  it('ends on the last time rather than a hair past it, and survives a group per row', () => {
    const short = makeTable(simulated.schema, {
      t: [0, 0.1, 0.2, 0.3],
      soma: [0, 1, 2, 3],
      tip: [0, 0, 0, 0],
    })
    const grid = planGrid([prepareTraces(input(short))], { kind: 'step', step: 0.1 }).build()
    expect(grid.length).toBe(4)
    expect(grid[3]).toBe(0.3)
    // A sweep column with a value a row: one group each, far past what a spread call takes.
    const n = 200_000
    const rows = makeTable(recorded.schema, {
      t: Array.from({ length: n }, (_, i) => i),
      sweep: Array.from({ length: n }, (_, i) => i),
      soma: Array.from({ length: n }, () => 0),
    })
    const plan = planGrid([prepareTraces(input(rows, { sweep: 'sweep' }))], {
      kind: 'step',
      step: 1,
    })
    expect(plan.length).toBe(n)
  })

  it('takes the first input’s times, the finest step over every input, or a step given', () => {
    const prepared = [
      prepareTraces(input(recorded, { sweep: 'sweep' })),
      prepareTraces(input(simulated, { shift: 1 })),
    ]
    expect(Array.from(planGrid(prepared, { kind: 'first' }).build())).toEqual([0, 2, 4])
    // The simulation's 1 ms, from the recording's 0 to the shifted simulation's 5.
    expect(Array.from(planGrid(prepared, { kind: 'finest' }).build())).toEqual([
      0, 1, 2, 3, 4, 5,
    ])
    const fixed = planGrid(prepared, { kind: 'step', step: 2.5 })
    expect(fixed.length).toBe(3)
    expect(Array.from(fixed.build())).toEqual([0, 2.5, 5])
    // The length is known before anything is built.
    expect(planGrid(prepared, { kind: 'step', step: 1e-9 }).length).toBe(5_000_000_001)
  })
})

describe('combinedTable', () => {
  it('puts every input on the grid, shifted, a long one spread into sweeps, the schema agreeing', () => {
    const prepared = [
      prepareTraces(
        input(simulated, { label: 'sim', columns: [simulated.schema.columns[1]!] }),
      ),
      prepareTraces(input(recorded, { label: 'rec', sweep: 'sweep', shift: 1 })),
    ]
    const table = combinedTable(prepared, planGrid(prepared, { kind: 'first' }).build())
    expect(table.schema).toEqual(combinedSchema(prepared.map((p) => p.spec)))
    expect(table.schema.columns.map((c) => [c.name, c.unit])).toEqual([
      ['t', 'ms'],
      ['sim: soma', 'mV'],
      ['rec: soma 1', 'mV'],
      ['rec: soma 2', 'mV'],
    ])
    expect(getColumn(table, 't')).toEqual([0, 1, 2, 3, 4])
    // The recording starts at 1 ms once shifted: nothing before it, linear after; the second
    // sweep's rows put in time order first.
    expect(getColumn(table, 'rec: soma 1')).toEqual([null, 0, 1, 2, 3])
    expect(getColumn(table, 'rec: soma 2')).toEqual([null, 10, 11, 12, 13])
  })
})
