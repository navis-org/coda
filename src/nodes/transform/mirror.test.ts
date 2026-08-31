/**
 * The Mirror Neurons contract, at the graph level.
 *
 * `transformOps.test.ts` has the arithmetic. What this covers is the part the arithmetic cannot
 * see: **where the midline comes from**. The node has no Dataset socket, so the answer travels
 * on the value — and the two failures that matters for are a graph whose geometry says nothing
 * (which must refuse with something actionable, not throw about a missing property) and a
 * `Space` override that has to be honoured identically by `validate` and `evaluate`.
 *
 * The mock connectome is exactly the right fixture for that, and not by accident: it is
 * synthetic, so `spaceForDataset` answers nothing for it, so every graph here starts in the
 * unregistered state and has to say so. The override is then the only way through, which is
 * what makes it the thing under test rather than a corner.
 *
 * **The spline is mocked and the landmark fetch is stubbed**, on `nblast.test.ts`'s precedent
 * and for its reason: Pyodide under vitest would mean a 13 MB dependency, a network fetch
 * inside the suite and a boot per test file. What runs the real `warp.py` against the real
 * wheel and the real landmark files is `scripts/probe-transform.mjs`, in its own CI job. So
 * what is checked here is the *node* — the order of flip and spline, the ceiling, what happens
 * when Warp is off — and never the arithmetic of a thin-plate spline, which is fastcore's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { schemaOf } from '../../core/types'
import { isSkeletonsValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import { MIRRORED_COLUMN, checkWarpSize } from '../lib/transformOps'
import { resetLandmarks } from '../../data/transforms/landmarks'
import '../index'

vi.mock('../../pyodide/warp', () => ({ warpPoints: vi.fn() }))
const { warpPoints } = await import('../../pyodide/warp')
const mockedWarp = vi.mocked(warpPoints)

const source: DataSource = new MockSource({ latencyMs: 0 })

/**
 * A landmark file with the columns the manifest names, so `parseLandmarks` reads it for real.
 *
 * The count has to match the manifest's or `landmarks.ts` refuses — which is the check that
 * stops a stale CSV being fitted, and is exactly as true of a stub as of a real file. So the
 * body is generated to length rather than written out.
 */
function landmarkCsv(rows: number): string {
  const lines = ['x_flip,y_flip,z_flip,x_mirr,y_mirr,z_mirr']
  for (let i = 0; i < rows; i++) lines.push(`${i},${i},${i},${i + 1},${i},${i}`)
  return lines.join('\n')
}

/** MANC's mirror set, which is what every test here reaches for through the Space override. */
const MANC_LANDMARKS = 1887

beforeEach(() => {
  resetLandmarks()
  vi.stubGlobal('fetch', async () => new Response(landmarkCsv(MANC_LANDMARKS), { status: 200 }))
  // Identity by default: the node's job is to hand the spline the *flipped* coordinates and put
  // back what it returns, and an identity spline is what makes the first of those visible.
  mockedWarp.mockImplementation(async (_pairs, points) => ({
    positions: points.slice(),
    fitMs: 0,
    applyMs: 0,
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  mockedWarp.mockReset()
})

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

/** dataset → find(LC4) → skeletons → mirror, or → mirror straight off the table. */
function pipeline(
  params: Record<string, unknown> = {},
  from: 'skeletons' | 'table' = 'skeletons',
): CodaGraph {
  let g = emptyGraph('mirror-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('mirror', 'neuron.mirror', params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })

  if (from === 'table') {
    g = addEdge(g, {
      source: 'find',
      sourceHandle: 'neurons',
      target: 'mirror',
      targetHandle: 'in',
    })
    return g
  }

  g = addNode(g, node('geo', 'neuron.skeletons', { limit: 100 }))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'geo',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'geo',
    targetHandle: 'neurons',
  })
  g = addEdge(g, {
    source: 'geo',
    sourceHandle: 'skeletons',
    target: 'mirror',
    targetHandle: 'in',
  })
  return g
}

/** Run to completion and hand back the scheduler, which is what holds the outputs. */
async function run(graph: CodaGraph): Promise<Scheduler> {
  const scheduler = makeScheduler()
  await scheduler.run(graph, { mode: 'full' })
  return scheduler
}

describe('neuron.mirror — types', () => {
  it('hands on the kind it was given', () => {
    const outputs = inferGraph(pipeline()).nodes['mirror']?.outputs['out']
    expect(outputs?.kind).toBe('skeletons')
  })

  it('promises the column it is going to add', () => {
    // Invariant 3 across the two halves: `inferOutputs` says the schema and `evaluate` builds
    // the table, and a downstream picker offers whatever the first one said.
    const schema = schemaOf(inferGraph(pipeline()).nodes['mirror']?.outputs['out'])
    // `schemaOf` only answers for tabular types, so read the geometry type's schema directly.
    const type = inferGraph(pipeline()).nodes['mirror']?.outputs['out']
    expect(schema).toBeUndefined()
    expect(type && 'schema' in type ? type.schema?.columns.map((c) => c.name) : []).toContain(
      MIRRORED_COLUMN,
    )
  })

  it('says any for an unresolved input rather than guessing a kind', () => {
    let g = emptyGraph('bare')
    g = addNode(g, node('mirror', 'neuron.mirror'))
    expect(inferGraph(g).nodes['mirror']?.outputs['out']?.kind).toBe('any')
  })
})

describe('neuron.mirror — what it refuses, and when', () => {
  it('warns at edit time about a table, which is a wiring mistake', () => {
    const issues = inferGraph(pipeline({}, 'table')).nodes['mirror']?.issues ?? []
    expect(issues.map((i) => i.message).join(' ')).toMatch(/skeletons, meshes or points/)
  })

  it('says nothing about a freshly wired node with no space yet', () => {
    /*
     * A *type* carries no space; only a value does. So an unset override on an unresolved
     * input is the ordinary state, and a warning there would sit on every new graph — the
     * distinction `capabilityOf` draws between not knowing and knowing the answer is no.
     */
    expect(inferGraph(pipeline()).nodes['mirror']?.issues ?? []).toEqual([])
  })

  it('warns at edit time about a space Coda ships nothing for', () => {
    const issues = inferGraph(pipeline({ space: 'JRC2018Ucns' })).nodes['mirror']?.issues ?? []
    expect(issues.map((i) => i.message).join(' ')).toMatch(/ships no mirror/)
  })

  it('refuses unregistered geometry by naming both ways out', async () => {
    /*
     * The commonest real failure. A synthetic connectome has no template space and never will,
     * so the message has to be about what to do rather than about a missing field — this is not
     * a bug upstream, it is a dataset nobody registered.
     */
    const error = (await run(pipeline())).info('mirror').error ?? ''
    expect(error).toMatch(/do not say which template space/)
    expect(error).toMatch(/name the space on this node/)
  })
})

describe('neuron.mirror — the override, which is the only way through here', () => {
  it('mirrors about the named space’s midline', async () => {
    /*
     * Ground truth: `MANC.boundingbox` x runs 49184..342752, so navis flips about their sum,
     * 391936. The mock's optic lobe is nowhere near MANC, which is the point — the override is
     * a claim the user is making, and the node acts on it rather than second-guessing.
     */
    const scheduler = await run(pipeline({ space: 'MANC', warp: false }))
    expect(scheduler.info('mirror').error).toBeUndefined()
    const source = scheduler.output('geo', 'skeletons')
    const mirrored = scheduler.output('mirror', 'out')
    if (!isSkeletonsValue(source) || !isSkeletonsValue(mirrored))
      throw new Error('not skeletons')

    const x = source.items[0]!.positions[0]!
    /*
     * Within a float32 ULP of the midline rather than exact. `flipAt - x` is computed in double
     * and stored on the float32 grid *at 391936*, whose spacing is 0.03125 nm — four thousand
     * times coarser than the grid `x` itself sits on near the origin. An EM voxel is 4 nm, so
     * this is nothing; an equality assertion here would be a test that fails on arithmetic
     * doing exactly what it should.
     */
    expect(mirrored.items[0]!.positions[0]).toBeCloseTo(391936 - x, 1)
    // The other two axes are untouched, which is what says an axis was chosen rather than all
    // three negated.
    expect(mirrored.items[0]!.positions[1]).toBe(source.items[0]!.positions[1])
    expect(mirrored.items[0]!.positions[2]).toBe(source.items[0]!.positions[2])
  })

  it('marks the rows, and leaves the ids alone', async () => {
    const value = (await run(pipeline({ space: 'MANC', warp: false }))).output('mirror', 'out')
    if (!isSkeletonsValue(value)) throw new Error('not skeletons')
    expect(value.attributes.data[MIRRORED_COLUMN]?.every((v) => v === true)).toBe(true)
    expect(value.attributes.schema.columns.map((c) => c.name)).toContain('neuronId')
  })

  it('refuses when the override contradicts what the geometry says', async () => {
    /*
     * The failure this shape exists to prevent, and it is entirely silent the other way round:
     * FlyWire geometry mirrored about MANC's midline lands 654 µm away and still looks like a
     * neuron. The realistic way the combination arises is a param left over from an earlier
     * experiment, so the override *fills a gap* rather than overruling, and a conflict refuses
     * by naming both sides.
     *
     * Two mirrors in a chain is how the fixture gets geometry that carries a space at all: the
     * mock carries none — which is what lets every other test here use the override — and the
     * first mirror stamps `MANC` on what it hands out.
     */
    let g = pipeline({ space: 'MANC', warp: false })
    g = addNode(g, node('mirror2', 'neuron.mirror', { space: 'FLYWIRE', warp: false }))
    g = addEdge(g, {
      source: 'mirror',
      sourceHandle: 'out',
      target: 'mirror2',
      targetHandle: 'in',
    })

    const scheduler = await run(g)
    expect(scheduler.info('mirror').error).toBeUndefined()
    const error = scheduler.info('mirror2').error ?? ''
    expect(error).toMatch(/are in MANC/)
    expect(error).toMatch(/Space is set to .*FLYWIRE/)
    expect(error).toMatch(/From the data/)
  })

  it('stamps the space it mirrored in, not the one the data arrived with', async () => {
    // Both are `MANC` here — the mock carries none — and that is the point: the output is in
    // the space the mirror was performed in, because a mirror maps a space onto itself.
    const value = (await run(pipeline({ space: 'MANC', warp: false }))).output('mirror', 'out')
    if (!isSkeletonsValue(value)) throw new Error('not skeletons')
    expect(value.space).toBe('MANC')
  })

  it('does not disturb the value it was handed', async () => {
    /*
     * The upstream buffer is the scheduler's cached result for the Skeletons node. Mirroring
     * through it would move the neurons that node is still holding, with a 3D viewer an inch
     * away redrawing somewhere else and nothing connecting the two.
     */
    const scheduler = await run(pipeline({ space: 'MANC', warp: false }))
    const before = scheduler.output('geo', 'skeletons')
    const after = scheduler.output('mirror', 'out')
    if (!isSkeletonsValue(before) || !isSkeletonsValue(after)) throw new Error('not skeletons')
    expect(before.items[0]!.positions).not.toBe(after.items[0]!.positions)
    expect(before.attributes.schema.columns.map((c) => c.name)).not.toContain(MIRRORED_COLUMN)
  })

  it('mirroring twice returns the coordinates it started from', async () => {
    let g = pipeline({ space: 'MANC', warp: false })
    g = addNode(g, node('mirror2', 'neuron.mirror', { space: 'MANC', warp: false }))
    g = addEdge(g, {
      source: 'mirror',
      sourceHandle: 'out',
      target: 'mirror2',
      targetHandle: 'in',
    })
    const scheduler = await run(g)
    const before = scheduler.output('geo', 'skeletons')
    const twice = scheduler.output('mirror2', 'out')
    if (!isSkeletonsValue(before) || !isSkeletonsValue(twice)) throw new Error('not skeletons')
    /*
     * "Returns", not "is bit-identical". The reflection is an involution in exact arithmetic
     * and not in float32: the intermediate is rounded to the grid at the midline, which for
     * MANC is 0.03125 nm wide, so the round trip lands within half of that. Measured worst
     * case below, against an EM voxel of 4 nm.
     */
    const back = [...twice.items[0]!.positions]
    const start = [...before.items[0]!.positions]
    expect(back).toHaveLength(start.length)
    const worst = Math.max(...back.map((v, i) => Math.abs(v - start[i]!)))
    expect(worst).toBeLessThan(0.02)
    // And the second pass gets its own column rather than overwriting the first, so the record
    // of what happened is not quietly a record of one mirror.
    expect(twice.attributes.schema.columns.map((c) => c.name)).toContain(`${MIRRORED_COLUMN}_2`)
  })
})

describe('neuron.mirror — the spline half', () => {
  it('hands the spline the flipped coordinates, not the originals', async () => {
    /*
     * The order that matters, and the one nothing else can catch. A mirror landmark file's
     * *source* side is already affine-flipped — `x_flip` in navis-flybrains' own column names —
     * so the spline's input has to be the flipped coordinate. Warp first and flip after would
     * produce a neuron on the correct side of the brain and the wrong shape, which looks like a
     * reconstruction artefact rather than a bug.
     */
    const scheduler = await run(pipeline({ space: 'MANC', warp: true }))
    expect(scheduler.info('mirror').error).toBeUndefined()
    expect(mockedWarp).toHaveBeenCalledTimes(1)

    const source = scheduler.output('geo', 'skeletons')
    if (!isSkeletonsValue(source)) throw new Error('not skeletons')
    const handed = mockedWarp.mock.calls[0]![1]
    expect(handed[0]).toBeCloseTo(391936 - source.items[0]!.positions[0]!, 1)
  })

  it('gathers every neuron into one call rather than one call each', async () => {
    // A set of skeletons is one buffer per neuron, and the spline is a flat reduction either
    // way — so crossing the bridge per neuron would pay the marshalling five hundred times for
    // no arithmetic saved.
    const scheduler = await run(pipeline({ space: 'MANC', warp: true }))
    const value = scheduler.output('mirror', 'out')
    if (!isSkeletonsValue(value)) throw new Error('not skeletons')
    expect(value.items.length).toBeGreaterThan(1)
    expect(mockedWarp).toHaveBeenCalledTimes(1)

    let points = 0
    for (const item of value.items) points += item.positions.length / 3
    expect(mockedWarp.mock.calls[0]![1].length).toBe(points * 3)
  })

  it('scatters the answer back onto the neuron it came from', async () => {
    /*
     * The failure a length check cannot see: coordinates put back at the wrong offsets are a
     * set of neurons that all still draw, each made of somebody else's branches. So the stub
     * marks each point with its own index and the assertion reads them back per item.
     */
    mockedWarp.mockImplementation(async (_pairs, points) => {
      const positions = new Float32Array(points.length)
      for (let i = 0; i < points.length; i += 3) positions[i] = i / 3
      return { positions, fitMs: 0, applyMs: 0 }
    })

    const scheduler = await run(pipeline({ space: 'MANC', warp: true }))
    const value = scheduler.output('mirror', 'out')
    if (!isSkeletonsValue(value)) throw new Error('not skeletons')

    let expected = 0
    for (const item of value.items) {
      for (let i = 0; i < item.positions.length; i += 3) {
        expect(item.positions[i]).toBe(expected)
        expected += 1
      }
    }
  })

  it('recomputes the bounding box from what the spline returned', async () => {
    // Bounds are a roll-up, and the flip's box describes where the points were *before* the
    // correction moved them. A viewer framed on it sits slightly off the neurons.
    mockedWarp.mockImplementation(async (_pairs, points) => ({
      positions: new Float32Array(points.length).fill(42),
      fitMs: 0,
      applyMs: 0,
    }))
    const value = (await run(pipeline({ space: 'MANC', warp: true }))).output('mirror', 'out')
    if (!isSkeletonsValue(value)) throw new Error('not skeletons')
    expect(value.bounds.min).toEqual([42, 42, 42])
    expect(value.bounds.max).toEqual([42, 42, 42])
  })

  it('touches no runtime at all with Warp off', async () => {
    // The whole reason the switch exists: off costs nothing, where on pulls in ten megabytes
    // of CPython on first use. A node that booted it anyway would make the control a lie.
    const scheduler = await run(pipeline({ space: 'MANC', warp: false }))
    expect(scheduler.info('mirror').error).toBeUndefined()
    expect(mockedWarp).not.toHaveBeenCalled()
  })

  it('carries the failure through rather than falling back to the flip', async () => {
    /*
     * A silent fallback would be the worst of both: a node that goes green having done
     * something several micrometres different from what the card says it did. NBLAST scores a
     * homologue as a stranger at that distance, so this is exactly the size of error that
     * changes an answer without changing anything visible.
     */
    mockedWarp.mockRejectedValue(new Error('worker died'))
    const error =
      (await run(pipeline({ space: 'MANC', warp: true }))).info('mirror').error ?? ''
    expect(error).toMatch(/worker died/)
  })

  it('says what a set whose cost is out of proportion will take, naming both factors', () => {
    /*
     * Points times landmarks, and neither is visible from the other: the landmark count comes
     * from whichever template the geometry is in, the point count from a fetch several nodes
     * upstream. Checked here directly rather than through a graph, because building three
     * million points to prove a threshold is a test that costs more than the thing it guards.
     *
     * It refused, once. The cost here is *time* — a spline allocates one buffer of the points
     * it was handed — and a wait is the caller's to spend.
     */
    const said: string[] = []
    const ctx = { warn: (m: string) => said.push(m) }
    checkWarpSize(ctx, 3_000_000, 3390)
    expect(said.join(' ')).toMatch(/3,000,000 points/)
    expect(said.join(' ')).toMatch(/3,390 landmarks/)
    expect(said.join(' ')).toMatch(/turn Warp off/)
    expect(said.join(' ')).toMatch(/Warping anyway/)

    said.length = 0
    checkWarpSize(ctx, 1_000_000, 3390)
    expect(said).toEqual([])
  })
})
