/**
 * Combine Columns — one column out of several, the first with a value winning.
 *
 * The operation itself is pinned in `tableOps.test.ts`; what is worth pinning *here* is the
 * node's own contract, which is the half that fails silently. Three things:
 *
 *  - the columns are resolved through `ctx.columns`, so the provenance key and the values read
 *    agree about which names actually resolved (invariant 5);
 *  - `inferOutputs` publishes exactly what `evaluate` returns, including the new column and the
 *    kind (invariant 3);
 *  - it *warns* rather than refusing when it is not configured, because a node that passes its
 *    input through has no business blocking everything downstream over a control nobody set.
 *
 * The last is the gap that let `out.barChart` carry a wrong refusal for months, unnoticed
 * because it had no node-level test.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { GraphNode } from '../../core/graph'
import { checkConnection, inferGraph } from '../../core/inference'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, schemaOf, tableSchema } from '../../core/types'
import '../index'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'

const ANN = tableSchema(
  column('neuronId', 'str'),
  column('cell_type', 'str'),
  column('hemibrain_type', 'str'),
)

function base(): TableValue {
  return tableFromRows(
    ANN,
    [
      { neuronId: '1', cell_type: 'LC4', hemibrain_type: 'LC4b' },
      { neuronId: '2', cell_type: '', hemibrain_type: 'PS180' },
      { neuronId: '3', cell_type: null, hemibrain_type: null },
    ],
    // Neurons, so the kind's survival is actually asserted rather than assumed from a default.
    'neurons',
  )
}

const def = requireNodeDef('core.combineColumns')

function run(params: Record<string, unknown>, table: TableValue = base()) {
  const ctx = {
    params: { ...defaultParams(def), ...params },
    input: () => table,
    columns: (id: string) => {
      const raw = { ...defaultParams(def), ...params }[id]
      const names = Array.isArray(raw) ? raw.map(String) : []
      // What `resolveColumns` does against a *known* schema: drop what is not there.
      return names.filter((n) => table.schema.columns.some((c) => c.name === n))
    },
  }
  return (def.evaluate as (c: unknown) => { out: TableValue })(ctx).out
}

describe('the node', () => {
  it('publishes exactly the table it evaluates, kind included', () => {
    const params = { columns: ['cell_type', 'hemibrain_type'], into: 'type' }
    const neurons = T.neurons(ANN)
    const inferred = def.inferOutputs?.(makeInferContext(def, params as never, { in: neurons }))
    const out = run(params)

    const published = inferred?.out
    expect(published?.kind).toBe('neurons')
    expect(columnNames(schemaOf(published))).toEqual(columnNames(out.schema))
    expect(out.kind).toBe('neurons')
    expect(out.data.type).toEqual(['LC4', 'PS180', null])
  })

  it('says nothing about a table it cannot see yet', () => {
    // A Pivot upstream publishes no schema until it has run; unknown is not empty.
    const out = def.inferOutputs?.(makeInferContext(def, defaultParams(def), { in: T.table() }))
    expect(out?.out).toEqual(T.table())
  })

  it('warns rather than refusing when nothing is picked, and passes the table through', () => {
    const issues = def.validate?.(
      makeInferContext(def, defaultParams(def), { in: T.table(ANN) }),
    )
    expect(issues?.length).toBeGreaterThan(0)
    // A warning is not a refusal: the table still arrives downstream unchanged.
    expect(run({ columns: [], into: 'type' }).schema).toEqual(ANN)
  })

  it('drops a column the current schema lacks rather than putting the name in the key', () => {
    // Through `ctx.columns`, which is what keeps the provenance key and the values read in step.
    expect(run({ columns: ['gone', 'hemibrain_type'], into: 'type' }).data.type).toEqual([
      'LC4b',
      'PS180',
      null,
    ])
  })

  it('stands between an annotation source and a Dataset', () => {
    /*
     * The wiring this node was added for: a published annotation TSV whose types are spread over
     * several columns, folded into `type` before a datastack is labelled by it. Asserted through
     * `checkConnection` because `addEdge` takes the handle it is given — the trap
     * `export.test.ts` records.
     */
    let g = emptyGraph('combine-chain')
    g = addNode(g, node('url', 'core.tableFromUrl', { url: 'https://x.dev/a.tsv' }))
    g = addNode(g, node('cc', 'core.combineColumns', { columns: ['cell_type'], into: 'type' }))
    g = addNode(
      g,
      node('ds', 'dataset.cave', {
        datastack: 'test_stack',
        version: '1',
        neuronTable: 'neurons',
      }),
    )
    g = addEdge(g, { source: 'url', sourceHandle: 'out', target: 'cc', targetHandle: 'in' })
    g = addEdge(g, {
      source: 'cc',
      sourceHandle: 'out',
      target: 'ds',
      targetHandle: 'annotations',
    })

    const inf = inferGraph(g)
    for (const [from, to] of [
      [
        { nodeId: 'url', portId: 'out' },
        { nodeId: 'cc', portId: 'in' },
      ],
      [
        { nodeId: 'cc', portId: 'out' },
        { nodeId: 'ds', portId: 'annotations' },
      ],
    ] as const) {
      expect(checkConnection(g, inf, from, to).ok).toBe(true)
    }
  })
})

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}
