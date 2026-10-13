/**
 * The Line Chart node's contract: a tap. The lines themselves are `lineSeries.test.ts`' and the
 * drawing `lineChartViewer.test.tsx`'s; what is pinned here is that nothing on the card can stale a
 * result — the table passes through by identity, keeping its `neurons`-ness, and every setting is
 * presentational.
 */

import { describe, expect, it } from 'vitest'

import type { EvalContext } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import '../index'

const def = requireNodeDef('out.lineChart')
const SCHEMA = tableSchema(column('neuronId', 'str'), column('t', 'f64'), column('v', 'f64'))

describe('out.lineChart', () => {
  it('is cheap, and every setting is presentational', () => {
    expect(def.cost).toBe('cheap')
    expect(
      (def.params ?? []).filter((p) => p.presentational !== true).map((p) => p.id),
    ).toEqual([])
  })

  it('passes its table on by identity, whatever is drawn', async () => {
    const table = makeTable(SCHEMA, { neuronId: ['1'], t: [0], v: [1] })
    const ctx = { params: defaultParams(def), input: () => table } as unknown as EvalContext
    expect(((await def.evaluate(ctx)) as { out: unknown }).out).toBe(table)
  })

  it('keeps a neuron table a neuron table', () => {
    const ctx = makeInferContext(def, defaultParams(def), { in: T.neurons(SCHEMA) })
    expect(def.inferOutputs!(ctx).out).toEqual(T.neurons(SCHEMA))
  })
})
