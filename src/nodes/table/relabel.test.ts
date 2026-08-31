/**
 * Relabel — one column rewritten through a mapping table.
 *
 * The operation is pinned in `tableOps.test.ts`; what is worth pinning *here* is the node's own
 * contract, which is where this kind of node fails silently:
 *
 *  - the three column params resolve through `ctx.column`, so the provenance key and the values
 *    actually read agree about which names resolved (invariant 5);
 *  - `inferOutputs` publishes exactly what `evaluate` returns — the dtype above all, since the
 *    mapping's value column decides it and `unmatched: 'keep'` widens it (invariant 3);
 *  - the defaults are aimed at the mapper's `Labels` output, and `unmatched` defaults to leaving
 *    the cell **empty** rather than keeping the original. That default is the design (see
 *    `docs/comparative.md`), so it is asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext, resolveColumn } from '../../core/node'
import type { ColumnParam, ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { ID_COLUMN_NAME } from '../../core/ids'
import { T, column, columnNames, schemaOf, tableSchema } from '../../core/types'
import type { CodaType } from '../../core/types'
import '../index'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'

const EDGES = tableSchema(column('preType', 'str'), column('weight', 'i64'))
const edges = (kind: 'table' | 'neurons' = 'table') =>
  tableFromRows(
    EDGES,
    [
      { preType: 'LC4', weight: 30 },
      { preType: 'DNp01', weight: 10 },
    ],
    kind,
  )

/** The mapper's `Labels` output, which is what the pickers' declared defaults name. */
const LABELS = tableSchema(column(ID_COLUMN_NAME, 'str'), column('label', 'str'))
const labels = () =>
  tableFromRows(LABELS, [
    { [ID_COLUMN_NAME]: 'LC4', label: 'LC4_LC6' },
    { [ID_COLUMN_NAME]: 'LPLC1', label: 'LPLC1' },
  ])

const def = requireNodeDef('core.relabel')

const inputsOf = (
  map: CodaType | undefined = T.table(LABELS),
  input: CodaType = T.table(EDGES),
) => ({
  in: input,
  map,
})

/** `evaluate`'s context, with the pickers resolved exactly as the editor resolves them. */
function run(
  params: ParamValues,
  table = edges(),
  map = labels(),
  inputs = inputsOf(T.table(map.schema), T.table(table.schema)),
) {
  const all = { ...defaultParams(def), ...params }
  const ctx = {
    params: all,
    input: (id: string) => (id === 'in' ? table : map),
    column: (id: string) =>
      resolveColumn(def.params?.find((p) => p.id === id) as ColumnParam, all, inputs),
  }
  return (def.evaluate as (c: unknown) => { out: TableValue })(ctx).out
}

describe('the node', () => {
  it('publishes exactly the column it evaluates, dtype and kind included', () => {
    const params = { column: 'preType' }
    const neurons = inputsOf(T.table(LABELS), T.neurons(EDGES))
    const inferred = def.inferOutputs!(makeInferContext(def, params as never, neurons))
    const out = run(params, edges('neurons'), labels(), neurons)

    expect(inferred.out?.kind).toBe('neurons')
    expect(schemaOf(inferred.out)?.columns).toEqual(out.schema.columns)
    expect(out.data.preType).toEqual(['LC4_LC6', null])
  })

  it('publishes the widening that `keep` causes rather than discovering it after a run', () => {
    // The mapping's values decide the dtype; `keep` puts the originals back in beside them.
    const numeric = tableSchema(column(ID_COLUMN_NAME, 'str'), column('cluster', 'i64'))
    const map = tableFromRows(numeric, [{ [ID_COLUMN_NAME]: 'LC4', cluster: 7 }])
    for (const unmatched of ['null', 'keep'] as const) {
      const params = { column: 'preType', valueColumn: 'cluster', unmatched }
      const inferred = def.inferOutputs?.(
        makeInferContext(def, params as never, inputsOf(T.table(numeric))),
      )
      const out = run(params, edges(), map)
      expect(schemaOf(inferred?.out)?.columns).toEqual(out.schema.columns)
      expect(out.schema.columns[0]!.dtype).toBe(unmatched === 'keep' ? 'str' : 'i64')
    }
  })

  it('defaults to leaving an unmapped value empty, which is the design', () => {
    /*
     * Not a style choice. `keep` leaves raw type names sitting in a column of cross-dataset
     * labels where they are indistinguishable from matched ones — the confusion this whole area
     * exists to prevent. See docs/comparative.md, decision 8.
     */
    expect(defaultParams(def).unmatched).toBe('null')
    expect(run({ column: 'preType' }).data.preType).toEqual(['LC4_LC6', null])
  })

  it('points its own defaults at the mapper output it exists for', () => {
    // Both pickers land on the right column of a two-column Labels table with nothing set —
    // and `resolveColumn` would otherwise hand *both* of them its first column.
    const params = defaultParams(def)
    const ctx = makeInferContext(def, params, inputsOf())
    expect(ctx.column('keyColumn')).toBe(ID_COLUMN_NAME)
    expect(ctx.column('valueColumn')).toBe('label')
  })

  it('says nothing about a table it cannot see yet', () => {
    const out = def.inferOutputs?.(
      makeInferContext(def, defaultParams(def), { in: T.table(), map: T.table() }),
    )
    expect(out?.out).toEqual(T.table())
    // A mapping whose schema has not arrived leaves the input's columns alone rather than
    // blanking every picker downstream.
    const known = def.inferOutputs?.(
      makeInferContext(def, defaultParams(def), inputsOf(T.table())),
    )
    expect(columnNames(schemaOf(known?.out))).toEqual(['preType', 'weight'])
  })

  it('warns where a mapping cannot say anything, and where the ids have already been lost', () => {
    const same = def.validate?.(
      makeInferContext(
        def,
        { ...defaultParams(def), column: 'preType', valueColumn: ID_COLUMN_NAME },
        inputsOf(),
      ),
    )
    expect(same?.join(' ')).toMatch(/maps to itself/)

    /*
     * Invariant 8's signature, and it reads as a mapping with holes rather than as a bug: the
     * mapper publishes `neuronId` as text, and a table carrying ids as `i64` carries float64s
     * in which an eighteen-digit root id stopped being itself upstream of this node.
     */
    const ids = tableSchema(column(ID_COLUMN_NAME, 'i64'), column('weight', 'i64'))
    const drift = def.validate?.(
      makeInferContext(
        def,
        { ...defaultParams(def), column: ID_COLUMN_NAME },
        inputsOf(T.table(LABELS), T.table(ids)),
      ),
    )
    expect(drift?.join(' ')).toMatch(/matched as text.*already a different id/)
  })

  it('warns before quietly suffixing a result name the table already carries', () => {
    const issues = def.validate?.(
      makeInferContext(
        def,
        { ...defaultParams(def), column: 'preType', into: 'weight' },
        inputsOf(),
      ),
    )
    expect(issues?.join(' ')).toMatch(/already exists/)
    expect(columnNames(run({ column: 'preType', into: 'weight' }).schema)).toEqual([
      'preType',
      'weight',
      'weight_2',
    ])
    // The column's own name is the one that is not a collision — it means what empty means.
    expect(
      def.validate?.(
        makeInferContext(
          def,
          { ...defaultParams(def), column: 'preType', into: 'preType' },
          inputsOf(),
        ),
      ),
    ).toEqual([])
  })

  it('refuses at run time rather than relabelling nothing', () => {
    // Unlike the `out.*` viewers, this node has no pass-through to fall back on: a Relabel that
    // relabels nothing is a wire that silently stopped doing its job.
    // Reachable only where the schemas have not arrived — with one in hand `resolveColumn`
    // falls back to a first column, which is the behaviour a picker on a known table must have.
    const blind = { in: T.table(), map: T.table() }
    expect(() => run({}, edges(), labels(), blind)).toThrow(/No column to relabel/)
  })
})
