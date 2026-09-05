/**
 * Group By — one aggregation, several value columns.
 *
 * The fold itself is pinned in `tableOps.test.ts`; what is worth pinning *here* is the node's
 * own contract, and this node has the version of it that fails most quietly. Its output schema
 * is **computed** rather than copied, so `inferOutputs` is the only thing telling a downstream
 * column picker that `sum_pre` and `sum_post` exist — and it says so before anything has run.
 * A disagreement between it and `evaluate` (invariant 3) is invisible until a Run, and then
 * shows up two nodes away as a picker that lost its column.
 *
 * Four things, three of which the single-column version could not get wrong:
 *
 *  - infer publishes exactly the columns evaluate returns, for one value column and for several;
 *  - the value columns resolve through `ctx.columns`, so the provenance key and the values read
 *    agree about which names actually resolved (invariant 5);
 *  - `count` ignores the value list rather than being a state the picker has to be emptied for;
 *  - an unset picker is a *warning* — but, unlike `core.combineColumns`, evaluate really does
 *    refuse, because there is no table to pass through: a group-by with no aggregate is not this
 *    node's input with a column added, it is a different table.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, schemaOf, tableSchema } from '../../core/types'
import '../index'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'

const CONN = tableSchema(
  column('type', 'str'),
  column('status', 'str'),
  column('pre', 'i64', 'synapses'),
  column('post', 'i64', 'synapses'),
)

function base(): TableValue {
  return tableFromRows(CONN, [
    { type: 'LC4', status: 'Traced', pre: 1, post: 10 },
    { type: 'LC4', status: 'Traced', pre: 2, post: 20 },
    { type: 'LC6', status: 'Anchor', pre: 4, post: 40 },
  ])
}

const def = requireNodeDef('core.groupBy')

function params(overrides: Record<string, unknown>) {
  return { ...defaultParams(def), ...overrides }
}

function run(overrides: Record<string, unknown>, table: TableValue = base()) {
  const merged = params(overrides)
  const ctx = {
    params: merged,
    input: () => table,
    columns: (id: string) => {
      const raw = merged[id]
      const names = Array.isArray(raw) ? raw.map(String) : []
      // What `resolveColumns` does against a *known* schema: drop what is not there.
      return names.filter((n) => table.schema.columns.some((c) => c.name === n))
    },
  }
  return (def.evaluate as (c: unknown) => { out: TableValue })(ctx).out
}

function inferred(overrides: Record<string, unknown>) {
  return def.inferOutputs?.(
    makeInferContext(def, params(overrides) as never, { in: T.table(CONN) }),
  )?.out
}

describe('the node', () => {
  it('publishes exactly the columns it evaluates, for one value column', () => {
    const p = { by: ['type'], agg: 'sum', value: ['pre'] }
    expect(columnNames(schemaOf(inferred(p)))).toEqual(columnNames(run(p).schema))
    expect(columnNames(schemaOf(inferred(p)))).toEqual(['type', 'n', 'sum_pre'])
  })

  it('publishes exactly the columns it evaluates, for several', () => {
    // The case the schema half is easiest to get wrong: one aggregate per value column, in the
    // order the picker holds them, with `n` before all of them.
    const p = { by: ['type'], agg: 'sum', value: ['post', 'pre'] }
    const out = run(p)
    expect(columnNames(schemaOf(inferred(p)))).toEqual(columnNames(out.schema))
    expect(columnNames(out.schema)).toEqual(['type', 'n', 'sum_post', 'sum_pre'])
    const idx = (out.data.type as string[]).indexOf('LC4')
    expect((out.data.sum_pre as number[])[idx]).toBe(3)
    expect((out.data.sum_post as number[])[idx]).toBe(30)
  })

  it('renames every aggregate when the aggregation changes, which is what pickers follow', () => {
    const p = { by: ['type'], agg: 'mean', value: ['pre', 'post'] }
    expect(columnNames(schemaOf(inferred(p)))).toEqual(['type', 'n', 'mean_pre', 'mean_post'])
    expect(schemaOf(inferred(p))?.columns.map((c) => c.dtype)).toEqual([
      'str',
      'i64',
      'f64',
      'f64',
    ])
  })

  it('says nothing about a table it cannot see yet', () => {
    // A Pivot upstream publishes no schema until it has run; unknown is not empty.
    const out = def.inferOutputs?.(makeInferContext(def, defaultParams(def), { in: T.table() }))
    expect(out?.out).toEqual(T.table())
  })

  it('ignores the value list for count, rather than making it a state to empty', () => {
    const p = { by: ['type'], agg: 'count', value: ['pre', 'post'] }
    expect(columnNames(schemaOf(inferred(p)))).toEqual(['type', 'n'])
    expect(columnNames(run(p).schema)).toEqual(['type', 'n'])
    expect(
      def.validate?.(makeInferContext(def, params(p) as never, { in: T.table(CONN) })),
    ).toEqual([])
  })

  it('drops a column the current schema lacks rather than putting the name in the key', () => {
    // Through `ctx.columns`, which is what keeps the provenance key and the values read in step.
    expect(
      columnNames(run({ by: ['type'], agg: 'sum', value: ['gone', 'pre'] }).schema),
    ).toEqual(['type', 'n', 'sum_pre'])
  })

  it('warns about an unset value picker, naming the aggregation', () => {
    const issues = def.validate?.(
      makeInferContext(def, params({ by: ['type'], agg: 'sum', value: [] }) as never, {
        in: T.table(CONN),
      }),
    )
    expect(issues).toEqual(['"sum" needs at least one value column'])
  })

  it('warns about an unset key picker first, since it is the one that refuses', () => {
    const issues = def.validate?.(
      makeInferContext(def, params({ by: [], agg: 'sum', value: ['pre'] }) as never, {
        in: T.table(CONN),
      }),
    )
    expect(issues).toEqual(['Pick at least one column to group by'])
  })
})
