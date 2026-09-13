/**
 * The Reduce Matrix node's own contract. The reduction is pinned in
 * `nodes/lib/matrixReduce.test.ts`; what belongs here is the part that fails without the
 * numbers being wrong:
 *
 * - `inferOutputs` publishes exactly what `evaluate` returns (invariant 3), which is the whole
 *   reason this node needs no `observesOutputSchema` — its columns are named by its params, so
 *   a picker downstream must fill before anything has run;
 * - an ignored `Exclude diagonal` reaches the card, since `visibleIf` cannot see a matrix's
 *   shape and so the control is offered where it cannot apply;
 * - a non-matrix input is the one thing it refuses.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import { defaultInputPorts, defaultOutputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, schemaOf, tableSchema } from '../../core/types'
import type { MatrixValue, TableValue, Value } from '../../core/values'
import { makeMatrix, tableFromRows } from '../../core/values'
import '../index'

const def = requireNodeDef('core.reduceMatrix')

const MATRIX: MatrixValue = makeMatrix(
  ['a', 'b'],
  ['t0', 't1'],
  Float64Array.from([1, 3, NaN, NaN]),
)

function run(
  params: Record<string, unknown>,
  input: Value = MATRIX,
): { out: TableValue; warnings: string[] } {
  const warnings: string[] = []
  const ctx = {
    params: { ...defaultParams(def), ...params },
    input: () => input,
    warn: (message: string) => warnings.push(message),
  }
  const out = (def.evaluate as (c: unknown) => { out: TableValue })(ctx).out
  return { out, warnings }
}

function inferred(params: Record<string, unknown>) {
  const ctx = makeInferContext(def, { ...defaultParams(def), ...params } as never, {
    in: T.matrix(),
  })
  return def.inferOutputs?.(ctx)?.out
}

describe('the node', () => {
  it('takes a matrix and hands back one table', () => {
    expect(defaultInputPorts(def).map((port) => port.type.kind)).toEqual(['matrix'])
    expect(defaultOutputPorts(def).map((port) => port.id)).toEqual(['out'])
  })

  it('publishes at edit time exactly what it returns at run time', () => {
    for (const params of [
      {},
      { stats: [] },
      { stats: ['mean', 'n'], prefix: 'zap' },
      { stats: ['max'], axis: 'columns' },
    ]) {
      const promised = inferred(params)
      expect(columnNames(schemaOf(promised!)), JSON.stringify(params)).toEqual(
        columnNames(run(params).out.schema),
      )
    }
  })

  it('arrives computing the mean, since a card that does nothing says nothing', () => {
    const { out } = run({})
    expect(columnNames(out.schema)).toEqual(['label', 'mean'])
    // The second neuron's row is all NaN — the shape `Neurons to ZapBench Traces` produces for a neuron
    // with no id under `unmatched: null`, which is what this node has to leave as an absence.
    expect(out.data.mean).toEqual([2, null])
  })

  it('says when Exclude diagonal could not apply, rather than applying it anyway', () => {
    // `visibleIf` takes params and a matrix's shape is not one, so the control is offered on
    // every matrix and the run is the only place that can tell.
    const { out, warnings } = run({ excludeDiagonal: true, stats: ['mean'] })
    expect(out.data.mean).toEqual([2, null])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Exclude diagonal')
  })

  it('refuses anything that is not a matrix', () => {
    const table = tableFromRows(tableSchema(column('neuronId', 'str')), [{ neuronId: '1' }])
    expect(() => run({}, table)).toThrow(/not a matrix/)
  })

  it('re-runs on an edit rather than waiting for Run', () => {
    // Pure arithmetic over a value already in memory. `expensive` here would mean a Run to see
    // what ticking `max` did.
    expect(def.cost).toBe('cheap')
  })
})
