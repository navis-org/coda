/**
 * Unpivot — wide back to long.
 *
 * The fold itself is pinned in `tableOps.test.ts`; what is worth pinning *here* is the node's
 * own contract, which is the half that fails silently:
 *
 *  - both pickers resolve through `ctx.columns`, so the provenance key and the columns actually
 *    folded agree about which names resolved (invariant 5);
 *  - `inferOutputs` publishes exactly what `evaluate` returns, kind included (invariant 3) —
 *    and unlike Pivot it can, because every output column is named by a param or copied from
 *    the input rather than by the data;
 *  - it *warns* rather than refusing when it is not configured, because a node that passes its
 *    input through has no business blocking everything downstream over a control nobody set.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext, validateColumnParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, schemaOf, tableSchema } from '../../core/types'
import '../index'
import type { TableValue } from '../../core/values'
import { SILENT } from '../../core/limits'
import { tableFromRows } from '../../core/values'

const WIDE = tableSchema(
  column('neuronId', 'i64'),
  column('DNp02', 'i64', 'synapses'),
  column('PLP003', 'i64', 'synapses'),
)

function base(): TableValue {
  return tableFromRows(
    WIDE,
    [
      { neuronId: 1, DNp02: 40, PLP003: 0 },
      { neuronId: 2, DNp02: null, PLP003: 7 },
    ],
    // Neurons, so the kind's survival is asserted rather than assumed from a default.
    'neurons',
  )
}

const def = requireNodeDef('core.unpivot')

function run(params: Record<string, unknown>, table: TableValue = base()) {
  const all = { ...defaultParams(def), ...params }
  const ctx = {
    params: all,
    input: () => table,
    columns: (id: string) => {
      const raw = all[id]
      const names = Array.isArray(raw) ? raw.map(String) : []
      // What `resolveColumns` does against a *known* schema: drop what is not there.
      return names.filter((n) => table.schema.columns.some((c) => c.name === n))
    },
    warn: SILENT.warn,
  }
  return (def.evaluate as (c: unknown) => { out: TableValue })(ctx).out
}

describe('the node', () => {
  const folded = { columns: ['DNp02', 'PLP003'] }

  it('publishes exactly the table it evaluates, kind included', () => {
    const inferred = def.inferOutputs?.(
      makeInferContext(def, { ...defaultParams(def), ...folded } as never, {
        in: T.neurons(WIDE),
      }),
    )
    const out = run(folded)

    expect(inferred?.out?.kind).toBe('neurons')
    expect(columnNames(schemaOf(inferred?.out))).toEqual(columnNames(out.schema))
    expect(out.kind).toBe('neurons')
    expect(out.data.name).toEqual(['DNp02', 'PLP003', 'DNp02', 'PLP003'])
    expect(out.data.value).toEqual([40, 0, null, 7])
  })

  it('derives its schema rather than observing one, which is what Pivot cannot do', () => {
    // Every output column is named by a param or copied from the input, so a picker downstream
    // fills before the first run — the whole difference from `core.pivot`'s wide half, whose
    // columns *are* the data. Asserted as the design, not as an implementation detail.
    expect(def.observesOutputSchema).toBeFalsy()
    const inferred = def.inferOutputs?.(
      makeInferContext(def, { ...defaultParams(def), ...folded } as never, {
        in: T.table(WIDE),
      }),
    )
    expect(columnNames(schemaOf(inferred?.out))).toEqual(['neuronId', 'name', 'value'])
  })

  it('drops the neurons claim when the id column is folded away', () => {
    const params = { columns: ['neuronId', 'DNp02'] }
    const inferred = def.inferOutputs?.(
      makeInferContext(def, { ...defaultParams(def), ...params } as never, {
        in: T.neurons(WIDE),
      }),
    )
    expect(inferred?.out?.kind).toBe('table')
    expect(run(params).kind).toBe('table')
  })

  it('says nothing about a table it cannot see yet', () => {
    // A Pivot upstream publishes no schema until it has run; unknown is not empty.
    const out = def.inferOutputs?.(makeInferContext(def, defaultParams(def), { in: T.table() }))
    expect(out?.out).toEqual(T.table())
  })

  it('warns rather than refusing when nothing is picked, and passes the table through', () => {
    const issues = def.validate?.(
      makeInferContext(def, defaultParams(def), { in: T.table(WIDE) }),
    )
    expect(issues?.length).toBeGreaterThan(0)
    // A warning is not a refusal: the table still arrives downstream unchanged.
    expect(run({}).schema).toEqual(WIDE)
  })

  it('drops a column the current schema lacks rather than putting the name in the key', () => {
    // Through `ctx.columns`, which is what keeps the provenance key and the values read in step.
    expect(run({ columns: ['gone', 'PLP003'] }).data.name).toEqual(['PLP003', 'PLP003'])
  })

  it('keeps what Keep names, and everything else when it names nothing', () => {
    const wide = tableSchema(
      column('neuronId', 'i64'),
      column('type', 'str'),
      column('DNp02', 'i64'),
    )
    const table = tableFromRows(wide, [{ neuronId: 1, type: 'LC4', DNp02: 40 }], 'neurons')
    const one = { columns: ['DNp02'] }
    expect(columnNames(run(one, table).schema)).toEqual(['neuronId', 'type', 'name', 'value'])
    expect(columnNames(run({ ...one, keep: ['type'] }, table).schema)).toEqual([
      'type',
      'name',
      'value',
    ])
  })

  it('falls back to keeping everything when the only kept column is gone', () => {
    /*
     * `core.select`'s shape, and it is worth pinning rather than discovering: `resolveColumns`
     * drops a name the current schema lacks, so a Keep list of one missing column resolves to
     * empty — which here means "everything not folded" rather than "nothing". Keeping columns
     * is lossless, so the fallback is the safe direction, and `validateColumnParams` puts
     * "Missing column(s): gone" on the card so it is not silent. The reload case cannot reach
     * it at all: against a schema that has not *arrived*, `resolveColumns` hands the stored
     * names straight through.
     */
    expect(columnNames(run({ ...folded, keep: ['gone'] }).schema)).toEqual([
      'neuronId',
      'name',
      'value',
    ])
    const issues = validateColumnParams(
      def,
      makeInferContext(def, { ...defaultParams(def), ...folded, keep: ['gone'] } as never, {
        in: T.table(WIDE),
      }),
    )
    expect(issues.join(' ')).toContain('gone')
  })
})
