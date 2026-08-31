/**
 * The Collect node as a fold.
 *
 * Testable without a scheduler precisely because it is `(accumulated, input) => accumulated'`
 * and nothing else — which is the design's own claim, so this is where that claim is checked.
 * The scheduler's side (that it is called once per pass, with the previous pass's return) is in
 * `core/scheduler.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams } from '../../core/node'
import type { EvalContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { column, tableSchema } from '../../core/types'
import type { SkeletonsValue, TableValue, Value } from '../../core/values'
import { EMPTY_BOUNDS, emptyTable, isTableValue, tableFromRows } from '../../core/values'
import '../index'

const def = requireNodeDef('flow.collect')

function ctx(input: Value | undefined, accumulated?: Record<string, Value>): EvalContext {
  return {
    params: defaultParams(def),
    refresh: false,
    input: () => input,
    inputKey: () => undefined,
    column: () => undefined,
    columns: () => [],
    inputPorts: () => [],
    outputPorts: () => [],
    resolveSource: () => {
      throw new Error('not needed')
    },
    signal: new AbortController().signal,
    progress: () => {},
    warn: () => {},
    publish: () => {},
    reportFetched: () => {},
    iteration: { index: accumulated ? 1 : 0, count: 2, label: '', size: 1 },
    ...(accumulated ? { accumulated } : {}),
  } as EvalContext
}

const A = tableSchema(column('neuronId', 'str'))
const rows = (...ids: string[]) =>
  tableFromRows(
    A,
    ids.map((neuronId) => ({ neuronId })),
  )

/** Run several passes through the fold, exactly as the scheduler threads them. */
function fold(values: Value[]): Value | undefined {
  let carried: Record<string, Value> | undefined
  for (const value of values) {
    carried = def.evaluate(ctx(value, carried) as never) as Record<string, Value>
  }
  return carried?.['out']
}

function skeletons(id: string): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [
      {
        id,
        positions: new Float32Array([0, 0, 0]),
        parents: new Int32Array([-1]),
        radii: new Float32Array([1]),
      },
    ],
    attributes: tableFromRows(A, [{ neuronId: id }]),
    bounds: EMPTY_BOUNDS,
  }
}

describe('Collect', () => {
  it('is the input itself on the first pass', () => {
    // Absent `accumulated` and "outside a loop" are the same state here, which is what makes a
    // Collect on its own a pass-through rather than a node that needs a loop to work.
    expect(fold([rows('1')])).toEqual(rows('1'))
  })

  it('stacks every pass rather than keeping the last', () => {
    const out = fold([rows('1'), rows('2'), rows('3')])
    expect(isTableValue(out) ? (out as TableValue).data['neuronId'] : []).toEqual([
      '1',
      '2',
      '3',
    ])
  })

  /*
   * `stackTables`' documented rule, inherited rather than re-decided: a column only one pass
   * carries is filled with null for the others. Quietly dropping it is the failure that rule
   * exists to prevent, and a loop is exactly where passes differ — one neuron with a soma tag
   * and one without.
   */
  it('keeps a column that only some passes carried', () => {
    const wide = tableFromRows(tableSchema(column('neuronId', 'str'), column('soma', 'str')), [
      { neuronId: '2', soma: 'left' },
    ])
    const out = fold([rows('1'), wide]) as TableValue
    expect(out.schema.columns.map((c) => c.name)).toContain('soma')
    expect(out.data['soma']).toEqual([null, 'left'])
  })

  it('stacks geometry, keeping every item', () => {
    const out = fold([skeletons('1'), skeletons('2')])
    expect(out?.kind).toBe('skeletons')
    expect((out as SkeletonsValue).items.map((i) => i.id)).toEqual(['1', '2'])
  })

  it('folds an empty pass in without losing what came before', () => {
    // An element that produced nothing is a real outcome — a neuron with no partners — and must
    // not empty the accumulation or break the fold.
    const out = fold([rows('1'), emptyTable(A), rows('2')])
    expect(isTableValue(out) ? (out as TableValue).data['neuronId'] : []).toEqual(['1', '2'])
  })

  /*
   * Named rather than silently keeping the newer one. A Collect that quietly held only the last
   * compatible pass would look like a loop that had not run, which is the hardest kind of bug to
   * trace back to its cause.
   */
  it('refuses two passes that produced different kinds, naming the pass', () => {
    expect(() => fold([rows('1'), skeletons('2')])).toThrow(/produced skeletons where/)
  })

  it('refuses an unwired input rather than returning undefined downstream', () => {
    expect(() => def.evaluate(ctx(undefined) as never)).toThrow(/Nothing is connected/)
  })
})
