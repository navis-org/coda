/**
 * Pivot's two outputs.
 *
 * `Matrix` and `Table` are one pivot in two shapes, so the assertions that matter are the
 * ones tying them together — same labels, same cells, same order. The other half is the
 * wide schema's *lifetime*: it cannot be derived from inputs and params, so it reaches
 * downstream column pickers only through `observesOutputSchema`, and a node that quietly
 * stopped observing would look identical on the canvas until somebody opened a picker.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import type { ColumnParam } from '../../core/node'
import {
  defaultParams,
  makeInferContext,
  resolveColumn,
  validateColumnParams,
} from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { T, column, columnNames, schemaOf, tableSchema } from '../../core/types'
import { isMatrixValue, isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource, requireSource } from '../../data/source'
import '../index'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

function makeScheduler(): Scheduler {
  return new Scheduler({ resolveSource: (id) => requireSource(id) })
}

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** dataset → find(LC.*) → connectivity → pivot(preType × postType) → select */
function pipeline(): CodaGraph {
  let g = emptyGraph('pivot-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*', status: 'Traced' }))
  g = addNode(g, node('conn', 'neuron.connectivity', { direction: 'outputs', minWeight: 1 }))
  g = addNode(
    g,
    node('piv', 'core.pivot', {
      rows: 'preType',
      columns: 'postType',
      agg: 'sum',
      value: 'weight',
    }),
  )
  g = addNode(g, node('sel', 'core.select'))
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'conn', targetHandle: 'dataset' })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'conn',
    targetHandle: 'neurons',
  })
  g = addEdge(g, {
    source: 'conn',
    sourceHandle: 'connections',
    target: 'piv',
    targetHandle: 'in',
  })
  g = addEdge(g, { source: 'piv', sourceHandle: 'table', target: 'sel', targetHandle: 'in' })
  return g
}

describe('pivot node', () => {
  it('emits the same pivot as a matrix and as a wide table', async () => {
    const sched = makeScheduler()
    await sched.run(pipeline(), { mode: 'full' })

    const matrix = sched.output('piv', 'matrix')
    const table = sched.output('piv', 'table')
    if (!isMatrixValue(matrix)) throw new Error('expected a matrix')
    if (!isTableValue(table)) throw new Error('expected a table')

    expect(matrix.rowLabels.length).toBeGreaterThan(0)
    expect(matrix.colLabels.length).toBeGreaterThan(0)

    // Row field first, then one column per matrix column, in the matrix's own order.
    expect(columnNames(table.schema)).toEqual(['preType', ...matrix.colLabels])
    expect(table.length).toBe(matrix.rowLabels.length)
    expect(table.data.preType).toEqual(matrix.rowLabels)

    const width = matrix.colLabels.length
    for (let r = 0; r < matrix.rowLabels.length; r++) {
      for (let c = 0; c < width; c++) {
        expect(table.data[matrix.colLabels[c]!]![r]).toBe(matrix.values[r * width + c])
      }
    }
  })

  it('publishes the wide columns downstream once it has run, and not before', async () => {
    const graph = pipeline()

    // Before a run nothing can name the columns — they are values of the Columns field.
    const cold = inferGraph(graph)
    expect(cold.nodes.piv?.outputs.matrix?.kind).toBe('matrix')
    expect(schemaOf(cold.nodes.piv?.outputs.table)).toBeUndefined()
    expect(cold.ok).toBe(true)

    const sched = makeScheduler()
    await sched.run(graph, { mode: 'full' })
    const table = sched.output('piv', 'table')
    if (!isTableValue(table)) throw new Error('expected a table')

    // What the store feeds back in after a run finishes.
    const warm = inferGraph(graph, { observedSchemas: { piv: table.schema } })
    expect(columnNames(schemaOf(warm.nodes.piv?.outputs.table))).toEqual(columnNames(table.schema))
    // And it reaches the picker on the node downstream, which is the whole point.
    expect(columnNames(schemaOf(warm.nodes.sel?.inputs.in))).toEqual(columnNames(table.schema))
  })
})

/**
 * The field-against-itself refusal.
 *
 * Reported live as a browser holding 6-10 GB on one tab. `Columns` named a property schema
 * discovery had not returned yet on a fresh session, so `resolveColumn` fell back to the first
 * column — which `Rows` had already resolved to — and the node pivoted a 15,000-value field
 * against itself. The `validate` warning below was on the node the whole time and the run went
 * ahead anyway, which is why this one is a refusal.
 */
describe('pivot node — rows against columns', () => {
  const sameColumn = (): CodaGraph => setNodeParam(pipeline(), 'piv', 'columns', 'preType')

  it('warns at edit time', () => {
    const issues = (inferGraph(sameColumn()).nodes['piv']?.issues ?? []).map((i) => i.message)
    expect(issues).toContain('Rows and Columns point at the same column')
  })

  it('refuses to run, rather than building a diagonal the size of the field squared', async () => {
    const sched = makeScheduler()
    await sched.run(sameColumn(), { mode: 'full' })
    expect(sched.info('piv').state).toBe('error')
    expect(sched.info('piv').error).toContain('preType')
    // Points at the fix rather than only at the symptom: in the reported case the user never
    // chose this shape, a missing column picked it for them.
    expect(sched.info('piv').error).toContain('diagonal')
  })

  it('leaves the ordinary pivot alone', async () => {
    const sched = makeScheduler()
    await sched.run(pipeline(), { mode: 'full' })
    expect(sched.info('piv').state).toBe('ok')
  })
})

/**
 * The reported failure, as its own shape.
 *
 * A graph reloaded on a fresh session: neuPrint discovery has not landed, so the dataset
 * advertises only the canonical seven neuron properties and `somaSide` looks deleted. What
 * this asserts is that the Columns field is *kept* — the node then fails naming the column it
 * was told to use, and recovers by itself once discovery arrives, rather than quietly pivoting
 * whatever the first column happens to be.
 */
describe('pivot node — a column the schema has not heard of yet', () => {
  const def = requireNodeDef('core.pivot')
  const param = (id: string) => def.params!.find((p) => p.id === id) as ColumnParam

  /** What Group By emits when `somaSide` was dropped from its keys for the same reason. */
  const cold = T.table(tableSchema(column('type', 'str'), column('sum_pre', 'i64')))
  const warm = T.table(
    tableSchema(column('type', 'str'), column('somaSide', 'str'), column('sum_pre', 'i64')),
  )
  const params = { rows: '', columns: 'somaSide', agg: 'sum', value: '' }
  const pick = (id: string, input: typeof cold) =>
    resolveColumn(param(id), params as never, { in: input })

  it('keeps the chosen Columns field rather than substituting the first one', () => {
    // The substitution was the bug: it landed on `type`, which Rows had already taken, and
    // the node built a 15,000-square matrix out of two fields nobody had pointed at it.
    expect(pick('columns', cold)).toBe('somaSide')
    expect(pick('rows', cold)).toBe('type')
    expect(pick('rows', cold)).not.toBe(pick('columns', cold))
  })

  it('reports the column as missing, in the same words the multi-picker uses', () => {
    const issues = validateColumnParams(def, makeInferContext(def, params as never, { in: cold }))
    expect(issues).toContain('Missing column: somaSide')
  })

  it('resolves normally the moment discovery lands, with no edit', () => {
    expect(pick('columns', warm)).toBe('somaSide')
    expect(validateColumnParams(def, makeInferContext(def, params as never, { in: warm }))).toEqual(
      [],
    )
  })
})
