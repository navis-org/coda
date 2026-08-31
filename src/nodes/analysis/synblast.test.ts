/**
 * The syNBLAST node's contract, and the seam under it.
 *
 * The Python is not testable here — vitest has no Pyodide and jsdom has no `Worker` — so the
 * engine is mocked and what is checked is everything on this side of it. That is a longer list
 * than NBLAST's, because this node's input is the wrong *shape*: a `PointsValue` is one row per
 * synapse and fastcore wants one array per neuron, so the grouping is Coda's own code and every
 * way it can go wrong is silent. A group boundary in the wrong place is a matrix comparing two
 * neurons' synapses as though they were one neuron's, and it draws.
 *
 * `scripts/probe-nblast.mjs` covers the other side by running the real `coda_synblast_run`
 * against the real wheel in Node.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { column, tableSchema } from '../../core/types'
import type { MatrixValue, PointsValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import type * as NblastBridge from '../../pyodide/nblast'
import type { SynblastRequest } from '../../pyodide/nblast'
import { NM_PER_UM } from '../lib/nblastOps'
import {
  UNIDENTIFIED,
  groupSynapses,
  hasPolarity,
  synapseLabels,
  synapseSetFrom,
  synblastSidesFrom,
} from '../lib/synblastOps'
import '../index'

vi.mock('../../pyodide/nblast', async (importOriginal) => {
  // Only `runSynblast` is replaced: `NM_PER_UM` and the request types come from the real
  // module, and a whole-module stub would leave the ops under test importing a mock of
  // themselves.
  const actual = await importOriginal<typeof NblastBridge>()
  return { ...actual, runSynblast: vi.fn() }
})
const { runSynblast } = await import('../../pyodide/nblast')
const mockedRun = vi.mocked(runSynblast)

const source: DataSource = new MockSource({ latencyMs: 0 })

function makeScheduler(): Scheduler {
  return new Scheduler({
    resolveSource: (id) => {
      if (id !== 'mock') throw new Error(`unexpected source ${id}`)
      return source
    },
  })
}

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** dataset → find(LC4) → synapses → synblast */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('synblast-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('syn', 'neuron.synapses', { limit: 20 }))
  g = addNode(g, node('sb', 'neuron.synblast', params))
  for (const [from, out, to, into] of [
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'syn', 'dataset'],
    ['find', 'neurons', 'syn', 'neurons'],
    ['syn', 'points', 'sb', 'query'],
  ] as const) {
    g = addEdge(g, { source: from, sourceHandle: out, target: to, targetHandle: into })
  }
  return g
}

/** A square identity-ish result, the shape the engine promises. */
function scores(rows: number, cols: number) {
  const values = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) values[r * cols + c] = r === c ? 1 : 0.25
  }
  return { scores: values, rows, cols }
}

/**
 * Three neurons' synapses, deliberately **interleaved** rather than blocked.
 *
 * The ordering is the point: a grouping written as "start a new group when the id changes"
 * passes on a blocked cloud and produces five groups here. Both backends happen to answer
 * neuron by neuron today, which is exactly why a fixture that assumed it would test nothing.
 */
function pointsFixture(): PointsValue {
  const rows = [
    { id: 11, polarity: 'pre', type: 'LC4', xyz: [0, 0, 0] },
    { id: 22, polarity: 'post', type: 'LC6', xyz: [1000, 0, 0] },
    { id: 11, polarity: 'post', type: 'LC4', xyz: [2000, 0, 0] },
    { id: 22, polarity: 'pre', type: 'LC6', xyz: [3000, 0, 0] },
    { id: 11, polarity: 'pre', type: 'LC4', xyz: [4000, 0, 0] },
    { id: null, polarity: 'pre', type: null, xyz: [5000, 0, 0] },
  ]
  const positions = new Float32Array(rows.flatMap((r) => r.xyz))
  return {
    kind: 'points',
    positions,
    attributes: makeTable(
      tableSchema(column('neuronId', 'i64'), column('polarity', 'str'), column('type', 'str')),
      {
        neuronId: rows.map((r) => r.id),
        polarity: rows.map((r) => r.polarity),
        type: rows.map((r) => r.type),
      },
    ),
    bounds: { min: [0, 0, 0], max: [5000, 0, 0] },
    units: 'nm',
  }
}

beforeEach(() => {
  mockedRun.mockReset()
})

describe('synblastOps — the grouping', () => {
  it('groups by neuron in first-appearance order, however the rows are interleaved', () => {
    const groups = groupSynapses(pointsFixture())
    expect(groups.map((g) => g.id)).toEqual(['11', '22', UNIDENTIFIED])
    expect(groups[0]!.rows).toEqual([0, 2, 4])
    expect(groups[1]!.rows).toEqual([1, 3])
  })

  it('keeps orphan synapses as their own group rather than dropping them', () => {
    // Dropping them would quietly change what the matrix is a comparison of, and there is no
    // channel that survives a cached result to say so.
    const groups = groupSynapses(pointsFixture())
    expect(groups[2]!.rows).toEqual([5])
  })

  it('keys the groups by the id as text, so two wide ids cannot collide', () => {
    // Invariant 8. Through a float64 these two are the same number; as text they are two
    // neurons, which is what a matrix row has to be.
    const a = '720575940622093200'
    const b = '720575940622093201'
    expect(Number(a) === Number(b)).toBe(true)
    const points: PointsValue = {
      kind: 'points',
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: [a, b] }),
      bounds: { min: [0, 0, 0], max: [1, 0, 0] },
    }
    expect(groupSynapses(points).map((g) => g.id)).toEqual([a, b])
  })
})

describe('synblastOps — the flattening', () => {
  it('converts nanometres to micrometres, which is what the scoring matrix is calibrated in', () => {
    const points = pointsFixture()
    const set = synapseSetFrom(points, groupSynapses(points), 'polarity')
    // Neuron 11's second synapse is at 2000 nm, i.e. 2 um. Unconverted, every pair falls past
    // the lookup matrix's last distance bin and scores as strangers with no error anywhere.
    expect(set.points[3]).toBeCloseTo(2000 / NM_PER_UM, 5)
    expect(NM_PER_UM).toBe(1000)
  })

  it('lays each group end to end, so the offsets and the labels agree', () => {
    const points = pointsFixture()
    const groups = groupSynapses(points)
    const set = synapseSetFrom(points, groups, 'polarity')
    expect(Array.from(set.offsets)).toEqual([0, 3, 5, 6])
    expect(set.points.length).toBe(6 * 3)
  })

  it('maps polarity onto the two connector types fastcore compares on', () => {
    const points = pointsFixture()
    const set = synapseSetFrom(points, groupSynapses(points), 'polarity')
    // Gathered per group, not in row order: neuron 11 is pre, post, pre.
    expect(Array.from(set.types.slice(0, 3))).toEqual([0, 1, 0])
    expect(Array.from(set.types.slice(3, 5))).toEqual([1, 0])
  })

  it('puts everything in one pool when no polarity column is picked', () => {
    const points = pointsFixture()
    const set = synapseSetFrom(points, groupSynapses(points), undefined)
    expect(Array.from(set.types)).toEqual([0, 0, 0, 0, 0, 0])
    // Which is why the node turns `by_type` off there rather than leaving it on and inert.
    expect(hasPolarity(points.attributes, undefined)).toBe(false)
    expect(hasPolarity(points.attributes, 'polarity')).toBe(true)
    expect(hasPolarity(points.attributes, 'nosuch')).toBe(false)
  })

  it('labels a group from its first row, falling back to the id', () => {
    const points = pointsFixture()
    const groups = groupSynapses(points)
    expect(synapseLabels(points, groups, 'type')).toEqual(['LC4', 'LC6', UNIDENTIFIED])
    expect(synapseLabels(points, groups, undefined)).toEqual(['11', '22', UNIDENTIFIED])
  })
})

describe('synblastOps — the guard rails', () => {
  const silent = { warn: () => undefined }

  it('refuses a value that is not a point cloud, pointing at the node that makes one', () => {
    expect(() => synblastSidesFrom(silent, undefined, undefined, 500)).toThrow(/Synapses node/)
  })

  it('refuses coordinates that are not nanometres, naming the side and the node', () => {
    const voxels = { ...pointsFixture(), units: 'voxels' as const }
    expect(() => synblastSidesFrom(silent, voxels, undefined, 500)).toThrow(
      /Query synapses are in voxels/,
    )
    expect(() => synblastSidesFrom(silent, voxels, undefined, 500)).toThrow(/Synapses node/)
  })

  it('refuses two template spaces, which is a comparison of nothing', () => {
    const a = { ...pointsFixture(), space: 'JRCFIB2018F' }
    const b = { ...pointsFixture(), space: 'FLYWIRE' }
    expect(() => synblastSidesFrom(silent, a, b, 500)).toThrow(/Transform Neurons/)
  })

  it('lets an unstated space through, since absent means unknown', () => {
    expect(() => synblastSidesFrom(silent, pointsFixture(), pointsFixture(), 500)).not.toThrow()
  })

  it('warns rather than refusing above Warn above', () => {
    const said: string[] = []
    const ctx = { warn: (m: string) => said.push(m) }
    expect(() => synblastSidesFrom(ctx, pointsFixture(), undefined, 2)).not.toThrow()
    expect(said.join(' ')).toMatch(/Warn above/)
  })
})

describe('neuron.synblast — types and params', () => {
  it('publishes a matrix, which is what the Heatmap and Linkage already take', () => {
    expect(inferGraph(pipeline()).nodes.sb?.outputs.scores?.kind).toBe('matrix')
  })

  it('is expensive, so it does not re-run on every keystroke', () => {
    expect(requireNodeDef('neuron.synblast').cost).toBe('expensive')
  })

  it('has no presentational params, because every one of them changes the scores', () => {
    const def = requireNodeDef('neuron.synblast')
    expect((def.params ?? []).filter((p) => p.presentational).map((p) => p.id)).toEqual([])
  })

  it('says so when there is no polarity column, since the measure is then a different one', () => {
    // Through `makeInferContext` rather than a hand-rolled literal: it runs the real
    // `resolveColumn`, so the picker resolves the way it does in the editor — which for an
    // optional picker against an unwired port is "not to anything", the case this asserts.
    const def = requireNodeDef('neuron.synblast')
    const issues = def.validate?.(makeInferContext(def, defaultParams(def), {})) ?? []
    expect(issues.join(' ')).toMatch(/polarity/)
  })
})

describe('neuron.synblast — running', () => {
  it('sends micrometres, one group per neuron, and asks for an all-by-all', async () => {
    mockedRun.mockImplementation((request: SynblastRequest) =>
      Promise.resolve(
        scores(request.query.offsets.length - 1, request.query.offsets.length - 1),
      ),
    )
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ symmetry: 'min', normalize: false }), { mode: 'full' })

    expect(mockedRun).toHaveBeenCalledTimes(1)
    const request = mockedRun.mock.calls[0]![0]
    expect(request).toMatchObject({ symmetry: 'min', normalize: false, byType: true })
    expect(request.target).toBeUndefined()

    const points = scheduler.output('syn', 'points') as PointsValue
    // Every synapse crosses, and exactly once — the group boundaries partition the cloud.
    expect(request.query.offsets[request.query.offsets.length - 1]).toBe(
      points.attributes.length,
    )
    const nm = Math.max(...Array.from(points.positions).map(Math.abs))
    const um = Math.max(...Array.from(request.query.points).map(Math.abs))
    expect(um).toBeCloseTo(nm / NM_PER_UM, 2)
  })

  it('labels both axes of an all-by-all and marks the matrix a similarity', async () => {
    mockedRun.mockImplementation((request: SynblastRequest) =>
      Promise.resolve(
        scores(request.query.offsets.length - 1, request.query.offsets.length - 1),
      ),
    )
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ labelColumn: 'type' }), { mode: 'full' })
    const matrix = scheduler.output('sb', 'scores') as MatrixValue
    expect(matrix.kind).toBe('matrix')
    expect(matrix.rowLabels).toEqual(matrix.colLabels)
    expect(matrix.rowLabels.every((l) => l.startsWith('LC4'))).toBe(true)
    // Clustering has to know to invert; absent would be a fact nobody stated rather than a
    // wrong one, and this one can be stated.
    expect(matrix.measure).toBe('similarity')
  })

  it('turns by_type off when the polarity picker is cleared', async () => {
    mockedRun.mockImplementation((request: SynblastRequest) =>
      Promise.resolve(
        scores(request.query.offsets.length - 1, request.query.offsets.length - 1),
      ),
    )
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ polarityColumn: '' }), { mode: 'full' })
    expect(mockedRun.mock.calls[0]![0].byType).toBe(false)
  })
})
