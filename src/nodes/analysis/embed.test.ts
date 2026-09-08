/**
 * The Embedding node, against the real umap-js.
 *
 * Unlike the clustering pair's tests there is no seam mocked here, and that is deliberate: the
 * backend is an ordinary npm dependency that runs in Node, so the thing worth checking is the
 * one the shaping tests cannot reach — that umap-js accepts what `embedOps` builds. Its
 * `initializeFit` throws on several of the ways a k-NN graph can be malformed and silently
 * mis-weights on the others, so a graph this node builds and never hands over is a graph nobody
 * has checked.
 *
 * **What is not asserted is where a point lands.** UMAP is stochastic; what is asserted is that
 * one seed is reproducible, that two seeds differ, and that the neighbourhood structure the
 * input describes survives — two tight groups come out as two tight groups.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { GraphNode } from '../../core/graph'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { inferGraph } from '../../core/inference'
import { column, tableSchema } from '../../core/types'
import type { MatrixValue, TableValue, Value } from '../../core/values'
import { getColumn, isTableValue, makeMatrix, tableFromRows } from '../../core/values'
import '../index'
import { searchFor } from '../../test/findNeurons'

const def = requireNodeDef('core.embed')

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** Eight observations in two obvious groups of four, as similarities. */
function scoreMatrix(): MatrixValue {
  const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const values: number[] = []
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      values.push(i === j ? 1 : Math.floor(i / 4) === Math.floor(j / 4) ? 0.9 : 0.05)
    }
  }
  return makeMatrix(
    labels,
    labels.slice(),
    Float64Array.from(values),
    'NBLAST score',
    'similarity',
  )
}

const NEIGHBOUR_SCHEMA = tableSchema(
  column('queryId', 'str'),
  column('targetId', 'str'),
  column('score', 'f64'),
)

/** The same structure as `scoreMatrix` — every pair listed, in `NBLAST k-NN`'s long shape. */
function neighbourRows(): Array<Record<string, string | number>> {
  const matrix = scoreMatrix()
  const rows: Array<Record<string, string | number>> = []
  matrix.rowLabels.forEach((query, i) => {
    matrix.colLabels.forEach((target, j) => {
      if (i === j) return
      rows.push({ queryId: query, targetId: target, score: matrix.values[i * 8 + j]! })
    })
  })
  return rows
}

function neighbourTable(): TableValue {
  return tableFromRows(NEIGHBOUR_SCHEMA, neighbourRows())
}

interface RunOptions {
  params?: Record<string, unknown>
  inputs?: Record<string, Value | undefined>
}

async function run(options: RunOptions): Promise<{ table: TableValue; warnings: string[] }> {
  const warnings: string[] = []
  const params = { ...defaultParams(def), ...(options.params ?? {}) }
  const out = await def.evaluate!({
    params,
    input: (port: string) => options.inputs?.[port],
    inputs: options.inputs ?? {},
    // Every column param here resolves to its own stored value: nothing in these graphs has a
    // schema for `resolveColumn` to substitute against, which is what `inferGraph` covers below.
    column: (id: string) => ((params as Record<string, unknown>)[id] as string) || undefined,
    columns: () => [],
    progress: () => {},
    warn: (message: string) => warnings.push(message),
    signal: undefined,
  } as never)
  const table = out.out
  if (!isTableValue(table)) throw new Error('not a table')
  return { table, warnings }
}

/** The edit-time half, which `validate` reads. Written once; two tests want it. */
function validateWith(
  inputs: Record<string, unknown>,
  params: Record<string, unknown> = {},
): string[] {
  return def.validate!({
    params: { ...defaultParams(def), ...params },
    inputs,
    schema: () => undefined,
    attributes: () => undefined,
    column: () => undefined,
    columns: () => [],
    inputPorts: () => [],
    outputPorts: () => [],
  } as never)
}

/** Points as `[x, y]`, in row order. */
function points(table: TableValue): Array<[number, number]> {
  const x = getColumn(table, 'umap1')
  const y = getColumn(table, 'umap2')
  return x.map((_, i) => [Number(x[i]), Number(y[i])] as [number, number])
}

function distance(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

describe('the Embedding node', () => {
  it('refuses to guess when nothing, or more than one thing, is wired', () => {
    expect(validateWith({})[0]).toMatch(/Wire one of Matrix, Features, Neighbours/)
    // Not a precedence: on an expensive node, silently picking one would put a picture on the
    // canvas computed from an input it ignored.
    const both = validateWith({ matrix: { kind: 'matrix' }, features: { kind: 'table' } })
    expect(both[0]).toMatch(/Matrix and Features are wired at once/)
  })

  it('refuses a Min distance above the Spread it packs within', () => {
    // umap-learn refuses this outright; umap-js does not, so an unfittable pair there comes
    // back as an arrangement that merely looks wrong.
    const issues = validateWith({ matrix: { kind: 'matrix' } }, { minDist: 0.9, spread: 0.2 })
    expect(issues[0]).toMatch(/Min distance cannot exceed Spread/)
  })

  it('embeds a score matrix, one row per observation, in the matrix’s own order', async () => {
    const matrix = scoreMatrix()
    const { table } = await run({ inputs: { matrix }, params: { neighbors: 4 } })
    expect(table.length).toBe(8)
    expect(getColumn(table, 'label')).toEqual(matrix.rowLabels)
    expect(points(table).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true)
  })

  it('keeps the neighbourhoods the input describes', async () => {
    // The one claim worth making about a stochastic layout: two groups that share nothing come
    // out further apart than the members of either. Generous, because the point is that the
    // structure survived rather than that it survived by a particular margin.
    const { table } = await run({ inputs: { matrix: scoreMatrix() }, params: { neighbors: 4 } })
    const p = points(table)
    const within = Math.max(distance(p[0]!, p[1]!), distance(p[4]!, p[5]!))
    const between = distance(p[0]!, p[4]!)
    expect(between).toBeGreaterThan(within)
  })

  it('is reproducible at one seed and different at another', async () => {
    // What makes invariant 4 hold without a nonce, and what lets the Annotations pickers be
    // data rather than presentational: re-running for a label costs the time, not the picture.
    const once = await run({
      inputs: { matrix: scoreMatrix() },
      params: { neighbors: 4, seed: 7 },
    })
    const again = await run({
      inputs: { matrix: scoreMatrix() },
      params: { neighbors: 4, seed: 7 },
    })
    expect(points(again.table)).toEqual(points(once.table))

    const other = await run({
      inputs: { matrix: scoreMatrix() },
      params: { neighbors: 4, seed: 8 },
    })
    expect(points(other.table)).not.toEqual(points(once.table))
  })

  it('refuses a matrix of counts read as similarities', async () => {
    // `linkageOps`' guard, reused rather than restated — the same mistake with the same two
    // opposite fixes, and UMAP embeds negative distances as happily as fastcore clusters them.
    const labels = ['a', 'b', 'c', 'd']
    const counts = Float64Array.from([0, 77, 3, 1, 77, 0, 5, 2, 3, 5, 0, 9, 1, 2, 9, 0])
    const matrix = makeMatrix(labels, labels.slice(), counts, 'synapses')
    await expect(run({ inputs: { matrix } })).rejects.toThrow(/Normalize/)
  })

  it('embeds a long neighbour table without ever building a matrix', async () => {
    const { table } = await run({
      inputs: { neighbours: neighbourTable() },
      params: {
        neighbors: 4,
        queryColumn: 'queryId',
        targetColumn: 'targetId',
        scoreColumn: 'score',
      },
    })
    expect(table.length).toBe(8)
    expect(getColumn(table, 'label')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    expect(points(table).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true)
  })

  it('says how many neighbour rows named somebody with no point of their own', async () => {
    const extra = tableFromRows(NEIGHBOUR_SCHEMA, [
      ...neighbourRows(),
      { queryId: 'a', targetId: 'stranger', score: 0.99 },
    ])
    const { warnings } = await run({
      inputs: { neighbours: extra },
      params: {
        neighbors: 4,
        queryColumn: 'queryId',
        targetColumn: 'targetId',
        scoreColumn: 'score',
      },
    })
    expect(warnings.join(' ')).toMatch(/never appears in "queryId"/)
  })

  it('joins an Annotations table onto the label, leaving misses null', async () => {
    const annotations = tableFromRows(
      tableSchema(column('neuronId', 'str'), column('type', 'str')),
      [
        { neuronId: 'a', type: 'LC4' },
        { neuronId: 'b', type: 'LC4' },
        { neuronId: 'e', type: 'LC6' },
      ],
    )
    const { table } = await run({
      inputs: { matrix: scoreMatrix(), annotations },
      params: { neighbors: 4, matchOn: 'neuronId', labelBy: 'type' },
    })
    expect(getColumn(table, 'annotation').slice(0, 3)).toEqual(['LC4', 'LC4', null])
    expect(getColumn(table, 'annotation')[4]).toBe('LC6')
  })

  it('warns when the Annotations table matched nothing at all', async () => {
    const annotations = tableFromRows(
      tableSchema(column('neuronId', 'str'), column('type', 'str')),
      [{ neuronId: 'nobody', type: 'LC4' }],
    )
    const { warnings } = await run({
      inputs: { matrix: scoreMatrix(), annotations },
      params: { neighbors: 4, matchOn: 'neuronId', labelBy: 'type' },
    })
    expect(warnings.join(' ')).toMatch(/Nothing in the Annotations table matched/)
  })

  it('publishes its columns before anything has run, so a Scatter fills its pickers', async () => {
    // The whole reason `annotation` is a constant name rather than the picked one — a Scatter
    // wired to this must be configurable at edit time.
    let g = emptyGraph('embed-pipeline')
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
    g = addNode(g, node('find', 'neuron.findNeurons', searchFor({ type: 'LC.*' })))
    g = addNode(g, node('adj', 'neuron.adjacency', { groupByType: true }))
    g = addNode(g, node('em', 'core.embed', { neighbors: 4 }))
    g = addNode(g, node('sc', 'out.scatter'))
    for (const [s, sh, t, th] of [
      ['ds', 'dataset', 'find', 'dataset'],
      ['ds', 'dataset', 'adj', 'dataset'],
      ['find', 'neurons', 'adj', 'sources'],
      ['find', 'neurons', 'adj', 'targets'],
      ['adj', 'matrix', 'em', 'matrix'],
      ['em', 'out', 'sc', 'in'],
    ] as const) {
      g = addEdge(g, { source: s, sourceHandle: sh, target: t, targetHandle: th })
    }
    const schema = inferGraph(g).nodes.em?.outputs.out
    expect(schema?.kind).toBe('table')
    expect(
      (schema as { schema?: { columns: Array<{ name: string }> } }).schema?.columns.map(
        (c) => c.name,
      ),
    ).toEqual(['label', 'umap1', 'umap2', 'annotation'])
  })
})
