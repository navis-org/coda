/**
 * The k-NN node's contract.
 *
 * Two things carry it, and neither is the algorithm. The **shape**: fastcore answers with two
 * rectangular arrays padded to `k`, and what leaves this node is a tidy table with the padding
 * dropped and counted — get that wrong and a neighbour called -1 with a score of negative
 * infinity reaches somebody's chart. And the **names**: `queryId`/`targetId` rather than navis's
 * `query`/`target`, because a column whose last word is not "id" prints a neuron id with thousand
 * separators.
 *
 * The Python is mocked here for the reason it is in `nblast.test.ts` — vitest has no Pyodide.
 * `scripts/probe-nblast.mjs` runs the real entry point against the real wheel, and the CI job
 * runs that.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import type { DType } from '../../core/types'
import { attributeSchema, column, tableSchema } from '../../core/types'
import type { CellValue, SkeletonsValue } from '../../core/values'
import { EMPTY_BOUNDS, getColumn, isTableValue, tableFromRows } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import type { NblastKnnRequest } from '../../pyodide/nblast'
import { knnTable } from '../lib/nblastOps'
import '../index'

vi.mock('../../pyodide/nblast', () => ({
  runNblast: vi.fn(),
  runNblastKnn: vi.fn(),
}))
const { runNblastKnn } = await import('../../pyodide/nblast')
const mockedKnn = vi.mocked(runNblastKnn)

const source: DataSource = new MockSource({ latencyMs: 0 })

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** dataset → find(LC4) → skeletons → k-NN */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('knn-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('skel', 'neuron.skeletons', { limit: 20 }))
  g = addNode(g, node('knn', 'neuron.nblastKnn', params))
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'skel', targetHandle: 'dataset' })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'skel', targetHandle: 'neurons' })
  g = addEdge(g, { source: 'skel', sourceHandle: 'skeletons', target: 'knn', targetHandle: 'query' })
  return g
}

/** Descending scores, and `-1`/`-Infinity` wherever a row ran out of candidates. */
function knnResult(rows: number, k: number, padFrom = k): {
  idx: Int32Array
  scores: Float64Array
  rows: number
  k: number
} {
  const idx = new Int32Array(rows * k)
  const scores = new Float64Array(rows * k)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < k; c++) {
      const at = r * k + c
      const padded = c >= padFrom
      idx[at] = padded ? -1 : (r + c + 1) % rows
      scores[at] = padded ? -Infinity : 1 - c * 0.1
    }
  }
  return { idx, scores, rows, k }
}

/**
 * A skeleton set carrying nothing but its ids, which is all `knnTable` reads off it.
 *
 * The ids go in the *attribute table* rather than only on the geometry, because that is the
 * copy `knnTable` uses — it takes the published cell and the published dtype together, so the
 * `queryId` it emits is the same value and type as the `neuronId` that fed it.
 */
function idSet(ids: readonly CellValue[], dtype: DType = 'i64'): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: ids.map((id) => ({
      id: String(id),
      positions: new Float32Array(),
      radii: new Float32Array(),
      parents: new Int32Array(),
    })),
    attributes: tableFromRows(
      tableSchema(column('neuronId', dtype)),
      ids.map((neuronId) => ({ neuronId })),
    ),
    bounds: EMPTY_BOUNDS,
  }
}

beforeEach(() => {
  mockedKnn.mockReset()
})

describe('knnTable — the shape fastcore answers in', () => {
  it('lays the rectangle out long, best first, one-based', () => {
    const table = knnTable(knnResult(3, 2), idSet([10, 11, 12]), idSet([10, 11, 12]))
    expect(table.length).toBe(6)
    expect(getColumn(table, 'rank')).toEqual([1, 2, 1, 2, 1, 2])
    // Row 0's best match is index 1, which is body 11 — the ids are resolved through the
    // *target* set, which is not the query set when a Target is wired.
    expect(getColumn(table, 'queryId')?.[0]).toBe(10)
    expect(getColumn(table, 'targetId')?.[0]).toBe(11)
  })

  it('drops the padding rather than emitting neighbour -1', () => {
    // fastcore pads a short row with -1 / -inf to keep the arrays rectangular. Carried
    // through, that is a neuron id of -1 with a score of negative infinity in a chart. What is
    // left is a short table, which is the honest artefact.
    const table = knnTable(knnResult(3, 4, 2), idSet([10, 11, 12]), idSet([10, 11, 12]))
    expect(table.length).toBe(6)
    expect(getColumn(table, 'targetId')).not.toContain(-1)
    expect(getColumn(table, 'score')?.every((s) => Number.isFinite(Number(s)))).toBe(true)
  })

  it('names the id columns so a neuron id is not printed as a quantity', () => {
    // navis calls these `query` and `target`. `isIdentifierColumn` reads a name's last word,
    // so those would print body 527536 as "527,536" — the bug `ui/format.ts` exists for.
    const table = knnTable(knnResult(1, 1), idSet([527536]), idSet([527536]))
    expect(table.schema.columns.map((c) => c.name)).toEqual([
      'queryId',
      'targetId',
      'rank',
      'score',
    ])
  })

  it('carries a wide id through exactly, in the dtype its own table published', () => {
    /*
     * Why `knnTable` reads the attribute table rather than `SkeletonGeometry.id`, and why it
     * does not pick a dtype of its own. A CAVE root id is eighteen digits, so its source
     * publishes `neuronId` as `str`; forcing these columns to `i64` would round it to a
     * *different neuron* here while the table an inch upstream still held the right one.
     */
    const wide = '648518347529750614'
    expect(Number(wide).toString()).not.toBe(wide)
    const table = knnTable(knnResult(1, 1), idSet([wide], 'str'), idSet([wide], 'str'))
    expect(getColumn(table, 'queryId')?.[0]).toBe(wide)
    expect(table.schema.columns.find((c) => c.name === 'targetId')?.dtype).toBe('str')
  })

  it('leaves an i64 source an i64 column, so nothing about neuPrint moves', () => {
    // The other half of the rule: mirroring is what makes the wide case work *without* handing
    // every existing user a text column, where a bare `527536` in a Table filter would stop
    // meaning `== 527536` and start meaning "contains".
    const table = knnTable(knnResult(1, 1), idSet([527536]), idSet([527536]))
    expect(table.schema.columns.find((c) => c.name === 'queryId')?.dtype).toBe('i64')
    expect(getColumn(table, 'queryId')?.[0]).toBe(527536)
  })

  it('carries a label per side only when one was asked for', () => {
    const labels = { query: ['LC4', 'LC6'], target: ['LC4', 'LC6'] }
    const table = knnTable(knnResult(2, 1), idSet([10, 11]), idSet([10, 11]), labels)
    expect(table.schema.columns.map((c) => c.name)).toContain('queryLabel')
    expect(getColumn(table, 'targetLabel')?.[0]).toBe('LC6')
  })
})

describe('neuron.nblastKnn — types and params', () => {
  it('advertises the columns it builds, so a picker downstream populates', () => {
    const inference = inferGraph(pipeline())
    const columns = attributeSchema(inference.nodes.knn?.outputs.matches)?.columns.map(
      (c) => c.name,
    )
    expect(columns).toEqual(['queryId', 'targetId', 'rank', 'score'])
  })

  it('advertises the label columns exactly when the picker resolves', () => {
    const inference = inferGraph(pipeline({ labelColumn: 'type' }))
    const columns = attributeSchema(inference.nodes.knn?.outputs.matches)?.columns.map(
      (c) => c.name,
    )
    expect(columns).toContain('queryLabel')
  })

  it('has no presentational params and is expensive', () => {
    const def = requireNodeDef('neuron.nblastKnn')
    expect((def.params ?? []).filter((p) => p.presentational).map((p) => p.id)).toEqual([])
    expect(def.cost).toBe('expensive')
  })

  it("does not call its neighbour count 'k' on the card, since the other k is a different thing", () => {
    // `tangentK` fits the tangent vectors; `k` is how many matches come back. Both are called
    // k by fastcore, and a card showing two controls called k is a card nobody can use.
    const labels = (requireNodeDef('neuron.nblastKnn').params ?? []).map((p) => p.label)
    expect(labels).toContain('Matches per neuron')
    expect(labels).toContain('Tangent neighbours')
  })
})

describe('neuron.nblastKnn — running', () => {
  it('forwards every control and asks for an all-by-all', async () => {
    mockedKnn.mockImplementation((request: NblastKnnRequest) =>
      Promise.resolve(knnResult(request.query.offsets.length - 1, request.k)),
    )
    const scheduler = new Scheduler({ resolveSource: () => source })
    await scheduler.run(pipeline({ k: 3, nCandidates: 400, symmetry: 'max', tangentK: 7 }), {
      mode: 'full',
    })

    expect(mockedKnn).toHaveBeenCalledTimes(1)
    const request = mockedKnn.mock.calls[0]![0]
    expect(request).toMatchObject({ k: 3, nCandidates: 400, symmetry: 'max', tangentK: 7 })
    expect(request.target).toBeUndefined()

    const matches = scheduler.output('knn', 'matches')
    if (!isTableValue(matches)) throw new Error('expected a table')
    expect(matches.length).toBe((matches.data['queryId'] ?? []).length)
    expect(new Set(getColumn(matches, 'rank'))).toEqual(new Set([1, 2, 3]))
  })

  it('refuses above Max neurons, naming the side that is too big', async () => {
    const scheduler = new Scheduler({ resolveSource: () => source })
    await scheduler.run(pipeline({ limit: 2 }), { mode: 'full' })
    expect(scheduler.info('knn').error).toMatch(/on Query exceeds this node's Max neurons \(2\)/)
    expect(mockedKnn).not.toHaveBeenCalled()
  })
})
