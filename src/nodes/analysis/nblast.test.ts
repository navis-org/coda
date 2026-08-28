/**
 * The NBLAST node's contract, and the seam under it.
 *
 * The Python itself is not testable here — vitest has no Pyodide and jsdom has no `Worker` —
 * so the engine is mocked and what is checked is everything on this side of it: that the
 * points leave in micrometres, that every control reaches the request, that the labels come
 * back attached to the right axis, and that an oversized comparison is refused before anything
 * is marshalled. `scripts/probe-nblast.mjs` covers the other side by running the real
 * `nblast.py` against the real wheel in Node.
 *
 * The unit conversion is the one worth the most: it is the difference between a score matrix
 * and a matrix of confident nonsense, and nothing about the nonsense looks wrong.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { column, tableSchema } from '../../core/types'
import type { MatrixValue, SkeletonsValue } from '../../core/values'
import { isSkeletonsValue, makeTable } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import type { NblastRequest } from '../../pyodide/nblast'
import {
  checkNblastSize,
  checkNblastUnits,
  dotpropSetFrom,
  nblastLabels,
  NM_PER_UM,
} from '../lib/nblastOps'
import '../index'

vi.mock('../../pyodide/nblast', () => ({
  runNblast: vi.fn(),
}))
const { runNblast } = await import('../../pyodide/nblast')
const mockedRun = vi.mocked(runNblast)

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

/** dataset → find(LC4) → skeletons → nblast */
function pipeline(params: Record<string, unknown> = {}, limit = 20): CodaGraph {
  let g = emptyGraph('nblast-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('skel', 'neuron.skeletons', { limit }))
  g = addNode(g, node('nb', 'neuron.nblast', params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'skel',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'skel',
    targetHandle: 'neurons',
  })
  g = addEdge(g, {
    source: 'skel',
    sourceHandle: 'skeletons',
    target: 'nb',
    targetHandle: 'query',
  })
  return g
}

/** A square identity-ish result, the shape the engine promises. */
function scores(
  rows: number,
  cols: number,
): { scores: Float64Array; rows: number; cols: number } {
  const values = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) values[r * cols + c] = r === c ? 1 : 0.25
  }
  return { scores: values, rows, cols }
}

function skeletonsFixture(): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [
      {
        id: '11',
        positions: new Float32Array([0, 0, 0, 1000, 2000, 3000]),
        radii: new Float32Array([1, 1]),
        parents: new Int32Array([-1, 0]),
      },
      {
        id: '22',
        positions: new Float32Array([5000, 0, 0]),
        radii: new Float32Array([1]),
        parents: new Int32Array([-1]),
      },
    ],
    attributes: makeTable(tableSchema(column('neuronId', 'i64'), column('type', 'str')), {
      neuronId: [11, 22],
      type: ['LC4', null],
    }),
    bounds: { min: [0, 0, 0], max: [5000, 2000, 3000] },
  }
}

beforeEach(() => {
  mockedRun.mockReset()
})

describe('nblastOps — the flattening', () => {
  it('converts nanometres to micrometres, which is what the scoring matrix is calibrated in', () => {
    const set = dotpropSetFrom(skeletonsFixture())
    // 1000, 2000, 3000 nm is 1, 2, 3 um. Handed over unconverted, every pair of neurons in a
    // dataset falls past the matrix's last bin and scores as strangers, with no error anywhere.
    expect(Array.from(set.points.slice(3, 6))).toEqual([1, 2, 3])
    expect(NM_PER_UM).toBe(1000)
  })

  it('lays neurons end to end and keeps parent indices neuron-local', () => {
    const set = dotpropSetFrom(skeletonsFixture())
    expect(Array.from(set.offsets)).toEqual([0, 2, 3])
    // The second neuron's root is -1, not "2" — nblast.py slices each neuron out and hands
    // fastcore row numbers, so a global index would be a dangling reference.
    expect(Array.from(set.parents)).toEqual([-1, 0, -1])
    expect(set.points.length).toBe(3 * 3)
  })

  it('drops nothing, however few points a skeleton has', () => {
    const set = dotpropSetFrom(skeletonsFixture())
    // The one-point neuron is still a row: a filtered set would put every label after it on
    // the wrong neuron.
    expect(set.offsets.length - 1).toBe(2)
  })

  it('labels by neuron id, by a column, and by neuron id again where that column is empty', () => {
    const skeletons = skeletonsFixture()
    expect(nblastLabels(skeletons, undefined)).toEqual(['11', '22'])
    expect(nblastLabels(skeletons, 'type')).toEqual(['LC4', '22'])
  })

  it('refuses coordinates that are not nanometres, naming the side', () => {
    const voxels: SkeletonsValue = { ...skeletonsFixture(), units: 'voxels' }
    expect(() => checkNblastUnits('Query', voxels, 'skeletons', 'Skeletons')).toThrow(/Query skeletons are in voxels/)
    // The message has to point at where the fact is visible, since nothing about the scores
    // would have shown it.
    expect(() => checkNblastUnits('Query', voxels, 'skeletons', 'Skeletons')).toThrow(/Skeletons node's footer/)
  })

  it('lets nanometres and unknown through, which are not the same thing', () => {
    // Unknown is what a value built before units existed says, and no source produces it
    // today. Refusing on it would refuse on a fact nobody stated.
    expect(() =>
      checkNblastUnits('Query', { ...skeletonsFixture(), units: 'nm' }, 'skeletons', 'Skeletons'),
    ).not.toThrow()
    expect(() => checkNblastUnits('Query', skeletonsFixture(), 'skeletons', 'Skeletons')).not.toThrow()
  })

  it('says what an oversized comparison will cost, naming both sides, and scores it anyway', () => {
    // It used to throw here. 600 x 600 is a cell type against its own hemisphere, which is an
    // ordinary question, and refusing it on a seventeen-second measurement was the guard rail
    // deciding which science was possible — see `NBLAST_PAIRS_WARN`.
    const said: string[] = []
    const ctx = { warn: (m: string) => said.push(m) }
    checkNblastSize(ctx, 600, 600)
    expect(said.join(' ')).toMatch(/600 x 600/)
    expect(said.join(' ')).toMatch(/pairs a second/)
    // The house closing clause, from `warnOverThreshold` rather than hand-written here — which
    // is the point: `core/limits.ts` records why that half must survive being copied.
    expect(said.join(' ')).toMatch(/Going ahead anyway/)

    said.length = 0
    checkNblastSize(ctx, 100, 100)
    expect(said).toEqual([])
  })

  it('still refuses the one size that has no matrix on the other side of it', () => {
    // The crash floor, and the only refusal left in this file that is about size: a
    // 10,000-square all-by-all is 800 MB of Float64 in a single allocation.
    expect(() => checkNblastSize({ warn: () => undefined }, 10_000, 10_000)).toThrow(
      /would allocate/,
    )
  })
})

describe('neuron.nblast — types and params', () => {
  it('publishes a matrix, which is what the Heatmap and Normalize already take', () => {
    const inference = inferGraph(pipeline())
    expect(inference.nodes.nb?.outputs.scores?.kind).toBe('matrix')
  })

  it('has no presentational params, because every one of them changes the scores', () => {
    const def = requireNodeDef('neuron.nblast')
    // Including `labelColumn`: the labels are part of the matrix that leaves the port, not a
    // way of drawing it. Marking any of these presentational would let a stale downstream
    // result survive an edit that changed the numbers.
    expect((def.params ?? []).filter((p) => p.presentational).map((p) => p.id)).toEqual([])
  })

  it('is expensive, so it does not re-run on every keystroke', () => {
    expect(requireNodeDef('neuron.nblast').cost).toBe('expensive')
  })

  it('warns when resampling is off, since scores then follow the tracing', () => {
    const nblast = requireNodeDef('neuron.nblast')
    // `makeInferContext` rather than a hand-rolled literal, so a new member on `InferContext`
    // is one edit rather than ten — the rule `nblastMatches.test.ts` already records.
    const issues =
      nblast.validate?.(makeInferContext(nblast, { ...defaultParams(nblast), resample: 0 }, {})) ??
      []
    expect(issues.join(' ')).toMatch(/traced/)
  })
})

describe('neuron.nblast — running', () => {
  it('sends micrometres, forwards every control, and asks for an all-by-all', async () => {
    mockedRun.mockImplementation((request: NblastRequest) =>
      Promise.resolve(
        scores(request.query.offsets.length - 1, request.query.offsets.length - 1),
      ),
    )
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ k: 7, resample: 2, symmetry: 'min', useAlpha: true }), {
      mode: 'full',
    })

    expect(mockedRun).toHaveBeenCalledTimes(1)
    const request = mockedRun.mock.calls[0]![0]
    expect(request).toMatchObject({ k: 7, resample: 2, symmetry: 'min', useAlpha: true })
    expect(request.target).toBeUndefined()

    const skeletons = scheduler.output('skel', 'skeletons')
    if (!isSkeletonsValue(skeletons)) throw new Error('expected skeletons')
    const nm = Math.max(
      ...skeletons.items.flatMap((i) => Array.from(i.positions).map(Math.abs)),
    )
    const um = Math.max(...Array.from(request.query.points).map(Math.abs))
    expect(um).toBeCloseTo(nm / NM_PER_UM, 3)
  })

  it('labels both axes of an all-by-all from the picked column', async () => {
    mockedRun.mockImplementation((request: NblastRequest) =>
      Promise.resolve(
        scores(request.query.offsets.length - 1, request.query.offsets.length - 1),
      ),
    )
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ labelColumn: 'type' }), { mode: 'full' })
    const matrix = scheduler.output('nb', 'scores') as MatrixValue
    expect(matrix.kind).toBe('matrix')
    expect(matrix.rowLabels).toEqual(matrix.colLabels)
    expect(matrix.rowLabels.every((l) => l.startsWith('LC4'))).toBe(true)
    expect(matrix.valueLabel).toBe('NBLAST score')
    // Not a distance: a clustering node has to invert these, and it can only know to if the
    // matrix says so. Absent would be a fact nobody stated rather than a wrong one.
    expect(matrix.measure).toBe('similarity')
  })

  it('stops before marshalling when the skeletons are in voxels', async () => {
    // The mock says nm, so this fakes the degraded dataset: `Meta` with no voxel size, which
    // is the one live path that reaches NBLAST with an unconverted skeleton.
    mockedRun.mockResolvedValue(scores(1, 1))
    const scheduler = makeScheduler()
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })
    const fetched = scheduler.output('skel', 'skeletons')
    if (!isSkeletonsValue(fetched)) throw new Error('expected skeletons')
    expect(fetched.units).toBe('nm')
    expect(() => checkNblastUnits('Query', { ...fetched, units: 'voxels' }, 'skeletons', 'Skeletons')).toThrow(
      /wrong scale/,
    )
  })

  it('warns above Warn above, naming the side that is large, and scores it', async () => {
    mockedRun.mockImplementation((request: NblastRequest) =>
      Promise.resolve(
        scores(request.query.offsets.length - 1, request.query.offsets.length - 1),
      ),
    )
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ limit: 2 }), { mode: 'full' })

    expect(scheduler.info('nb').error ?? scheduler.info('nb').state).toBe('ok')
    expect(scheduler.warning('nb')).toMatch(
      /neurons on Query is past this node's Warn above \(2\)/,
    )
    // The whole difference from the old behaviour: there is a result under the warning.
    expect(mockedRun).toHaveBeenCalled()
  })

  it('keeps the warning on the result, so a re-run that answers from cache still says it', async () => {
    mockedRun.mockImplementation((request: NblastRequest) =>
      Promise.resolve(
        scores(request.query.offsets.length - 1, request.query.offsets.length - 1),
      ),
    )
    const scheduler = makeScheduler()
    const graph = pipeline({ limit: 2 })
    await scheduler.run(graph, { mode: 'full' })
    await scheduler.run(graph, { mode: 'full' })
    // Nothing re-ran, and the caveat is still under the matrix it is a caveat about.
    expect(scheduler.warning('nb')).toMatch(/Warn above/)
  })
})
