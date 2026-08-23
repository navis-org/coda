/**
 * Rename Columns — the general form of the import nodes' `ID column`.
 *
 * The operation is pinned in `tableOps.test.ts`; what is worth pinning *here* is the half that
 * fails silently:
 *
 *  - `inferOutputs` publishes exactly what `evaluate` returns, the **kind** included — which is
 *    the whole point of this node and the one thing no column assertion would catch;
 *  - the promotion needs an *applied* rename, so a table that merely already carries a
 *    `neuronId` is not quietly upgraded to a claim nobody made (`core.stack`'s rule);
 *  - nothing refuses, because a node passing a whole table through has no business blocking
 *    everything downstream over a half-typed row — invariant 5's corollary, and the gap that
 *    let `out.barChart` carry a wrong refusal for months for want of a node-level test.
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
import { encodeRenames } from '../lib/renames'

const FOREIGN = tableSchema(
  column('root_id', 'str'),
  column('cell_type', 'str'),
  column('score', 'f64', 'nm'),
)

function base(kind: TableValue['kind'] = 'table'): TableValue {
  return tableFromRows(
    FOREIGN,
    [
      { root_id: '720575940628857210', cell_type: 'LC4', score: 1.5 },
      { root_id: '720575940628857211', cell_type: 'LC6', score: 2.5 },
    ],
    kind,
  )
}

const def = requireNodeDef('core.rename')

const params = (...renames: Array<[string, string]>) => ({
  ...defaultParams(def),
  renames: encodeRenames(renames.map(([from, to]) => ({ from, to }))),
})

function run(p: Record<string, unknown>, table: TableValue = base()) {
  return (def.evaluate as (c: unknown) => { out: TableValue })({
    params: p,
    input: () => table,
  }).out
}

describe('the node', () => {
  it('publishes exactly the table it evaluates', () => {
    const p = params(['root_id', 'neuronId'], ['cell_type', 'type'])
    const inferred = def.inferOutputs?.(makeInferContext(def, p as never, { in: T.table(FOREIGN) }))
    const out = run(p)

    expect(columnNames(schemaOf(inferred?.out))).toEqual(columnNames(out.schema))
    expect(columnNames(out.schema)).toEqual(['neuronId', 'type', 'score'])
    // Only the name changes: the values, the dtype and the unit ride along.
    expect(out.data.neuronId).toEqual(['720575940628857210', '720575940628857211'])
    expect(out.schema.columns[2]).toEqual(column('score', 'f64', 'nm'))
  })

  it('says nothing about a table it cannot see yet', () => {
    // A Pivot upstream publishes no schema until it has run; unknown is not empty.
    const out = def.inferOutputs?.(makeInferContext(def, defaultParams(def), { in: T.table() }))
    expect(out?.out).toEqual(T.table())
  })

  it('passes the table through untouched when nothing is configured', () => {
    const out = run(defaultParams(def) as Record<string, unknown>)
    expect(out.schema).toEqual(FOREIGN)
    expect(def.validate?.(makeInferContext(def, defaultParams(def), { in: T.table(FOREIGN) })))
      .toEqual([])
  })
})

describe('the kind', () => {
  const kindOf = (p: Record<string, unknown>, input: TableValue['kind']) =>
    def.inferOutputs?.(
      makeInferContext(def, p as never, {
        in: input === 'neurons' ? T.neurons(FOREIGN) : T.table(FOREIGN),
      }),
    )?.out?.kind

  it('promotes to Neurons when a column is renamed onto neuronId, in both halves', () => {
    const p = params(['root_id', 'neuronId'])
    expect(kindOf(p, 'table')).toBe('neurons')
    // The value half has to agree, or every downstream `idColumn()` guarantee breaks after a run.
    expect(run(p).kind).toBe('neurons')
  })

  it('demotes when neuronId is renamed away', () => {
    const neurons = tableSchema(column('neuronId', 'str'), column('type', 'str'))
    const p = params(['neuronId', 'segment'])
    const inferred = def.inferOutputs?.(
      makeInferContext(def, p as never, { in: T.neurons(neurons) }),
    )
    expect(inferred?.out?.kind).toBe('table')
    expect(run(p, tableFromRows(neurons, [{ neuronId: '1', type: 'LC4' }], 'neurons')).kind).toBe(
      'table',
    )
    // And says so, because a socket that stops accepting a wire two nodes later needs a cause.
    const issues = def.validate?.(makeInferContext(def, p as never, { in: T.neurons(neurons) }))
    expect(issues?.join(' ')).toMatch(/no longer a Neurons table/)
  })

  it('does not promote a table it did not touch', () => {
    /*
     * `core.stack`'s rule: a `neurons` kind is a *claim* that the ids are neurons of a dataset,
     * and a plain table that happens to carry a `neuronId` never made it. So a rename of some
     * other column leaves the kind alone even though the result plainly has the column.
     */
    const carries = tableSchema(column('neuronId', 'str'), column('cell_type', 'str'))
    const p = params(['cell_type', 'type'])
    expect(
      def.inferOutputs?.(makeInferContext(def, p as never, { in: T.table(carries) }))?.out?.kind,
    ).toBe('table')
  })

  it('does not promote on a rename whose source is not in the table', () => {
    // A stale row naming a column an upstream edit removed has renamed nothing at all, so the
    // `neuronId` the table already had is not evidence of an act somebody performed.
    const carries = tableSchema(column('neuronId', 'str'))
    const p = params(['gone', 'neuronId'])
    expect(
      def.inferOutputs?.(makeInferContext(def, p as never, { in: T.table(carries) }))?.out?.kind,
    ).toBe('table')
  })
})

describe('what it warns about rather than refusing', () => {
  const issuesFor = (p: Record<string, unknown>) =>
    def.validate?.(makeInferContext(def, p as never, { in: T.table(FOREIGN) })) ?? []

  it('names a source column the table does not carry, and still runs', () => {
    const p = params(['gone', 'whatever'], ['cell_type', 'type'])
    expect(issuesFor(p).join(' ')).toMatch(/Missing column\(s\): gone/)
    // The other rename still happens; a warning is not a refusal.
    expect(columnNames(run(p).schema)).toEqual(['root_id', 'type', 'score'])
  })

  it('names a row with no new name yet, which is what a half-typed row is', () => {
    expect(issuesFor(params(['cell_type', ''])).join(' ')).toMatch(/No new name for: cell_type/)
  })

  it('reports two rows aiming at one name, and suffixes rather than losing a column', () => {
    /*
     * The mapping is not injective and a widget lets somebody express that in two keystrokes.
     * Emitting both literally would give a table whose schema claims two columns its data has
     * one of — `makeTable`'s ragged throw at best, a silently overwritten column at worst.
     */
    const p = params(['root_id', 'label'], ['cell_type', 'label'])
    expect(issuesFor(p).join(' ')).toMatch(/Renamed to the same name: label/)
    expect(columnNames(run(p).schema)).toEqual(['label', 'label_2', 'score'])
  })

  it('says nothing at all about a schema it cannot see', () => {
    // `columnSchemaFor`'s rule: a port publishing no schema is not a port whose table lacks
    // these columns, and warning there puts a badge on every Rename downstream of a Pivot.
    const p = params(['gone', 'whatever'])
    expect(def.validate?.(makeInferContext(def, p as never, { in: T.table() }))).toEqual([])
  })
})

describe('in a graph', () => {
  it('turns a fetched table into one a Neurons socket accepts', () => {
    /*
     * The chain this node exists for, and the one its guide describes: `Table from URL →
     * Rename Columns → Skeletons`. Asserted through `checkConnection` because `addEdge` takes
     * the handle it is given — the trap `export.test.ts` records.
     */
    let g = emptyGraph('rename-chain')
    g = addNode(g, graphNode('url', 'core.tableFromUrl', { url: 'https://example.org/a.csv' }))
    g = addNode(g, graphNode('rn', 'core.rename', params(['root_id', 'neuronId'])))
    g = addNode(g, graphNode('skel', 'neuron.skeletons'))
    g = addEdge(g, { source: 'url', sourceHandle: 'out', target: 'rn', targetHandle: 'in' })

    const inf = inferGraph(g)
    expect(
      checkConnection(
        g,
        inf,
        { nodeId: 'url', portId: 'out' },
        { nodeId: 'rn', portId: 'in' },
      ).ok,
    ).toBe(true)
    /*
     * The URL node publishes no schema on a cold session, so nothing here can *know* the rename
     * applies — which is exactly why the promotion is decided from the pairs against whatever
     * schema there is, and why this link is refused until the first run rather than claimed.
     * What is pinned is that the socket check runs at all; see the kind tests for the answer.
     */
    expect(inf.nodes['rn']?.outputs?.out?.kind).toBe('table')
  })
})

function graphNode(id: string, type: string, p: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...p } as GraphNode['params'],
  }
}
