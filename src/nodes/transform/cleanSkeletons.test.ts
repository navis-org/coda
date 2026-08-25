/**
 * Clean Skeletons: the flattening, the scattering, the ceilings, and the node.
 *
 * The Python is not testable here — vitest has no Pyodide and jsdom has no `Worker` — so the
 * engine is mocked and what is checked is everything on this side of it.
 * `scripts/probe-skeletons.mjs` runs the real `skeletons.py` against the real wheel in Node,
 * and the two files divide the work cleanly: the probe owns whether fastcore resampled
 * correctly, this owns whether the right buffers went over and the right neurons came back.
 *
 * The assertion worth the most is the **item count**. `SkeletonsValue` promises one attribute
 * row per item in the same order, so a set that came back one neuron shorter is a set where
 * every label after that neuron is wrong — and it draws.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams, makeInferContext } from '../../core/node'
import type { ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { column, tableSchema } from '../../core/types'
import type { SkeletonsValue } from '../../core/values'
import { isSkeletonsValue, makeTable } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import type { CleanSkeletonsRequest, CleanSkeletonsResult } from '../../pyodide/skeletons'
import type { SkeletonCleanParams } from '../lib/cleanOps'
import {
  checkCleanUnits,
  checkResampleSize,
  cleanRequestFrom,
  emptiedItems,
  isNoOp,
  skeletonsFromResult,
  usesDistance,
} from '../lib/cleanOps'
import { NM_PER_UM } from '../lib/nblastOps'
import '../index'

vi.mock('../../pyodide/skeletons', () => ({ runCleanSkeletons: vi.fn() }))
const { runCleanSkeletons } = await import('../../pyodide/skeletons')
const mockedRun = vi.mocked(runCleanSkeletons)

const OFF: SkeletonCleanParams = {
  heal: false,
  healMaxDist: 0,
  smooth: 0,
  method: 'none',
  spacing: 1,
  factor: 2,
}

/** Two neurons and an empty one — the third being the case the item-count rule is about. */
function skeletonsFixture(): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [
      {
        id: '11',
        positions: new Float32Array([0, 0, 0, 1000, 0, 0, 2000, 0, 0]),
        radii: new Float32Array([10, 20, 30]),
        parents: new Int32Array([-1, 0, 1]),
      },
      {
        id: '22',
        positions: new Float32Array([5000, 0, 0, 6000, 0, 0]),
        radii: new Float32Array([40, 50]),
        parents: new Int32Array([-1, 0]),
      },
      {
        id: '33',
        positions: new Float32Array([]),
        radii: new Float32Array([]),
        parents: new Int32Array([]),
      },
    ],
    attributes: makeTable(tableSchema(column('neuronId', 'i64'), column('type', 'str')), {
      neuronId: [11, 22, 33],
      type: ['LC4', 'LC6', 'LC10'],
    }),
    bounds: { min: [0, 0, 0], max: [6000, 0, 0] },
    units: 'nm',
  }
}

/** What the engine promises: the same nodes back, unchanged. */
function passThrough(request: CleanSkeletonsRequest): CleanSkeletonsResult {
  return {
    points: request.points.slice(),
    parents: request.parents.slice(),
    radii: request.radii.slice(),
    offsets: request.offsets.slice(),
  }
}

describe('cleanOps — is anything switched on', () => {
  it('recognises the untouched card as a pass-through', () => {
    expect(isNoOp(OFF)).toBe(true)
    expect(isNoOp({ ...OFF, method: 'resample', spacing: 0 })).toBe(true)
    expect(isNoOp({ ...OFF, method: 'downsample', factor: 1 })).toBe(true)
  })

  it('recognises each control that does something', () => {
    expect(isNoOp({ ...OFF, heal: true })).toBe(false)
    expect(isNoOp({ ...OFF, smooth: 1 })).toBe(false)
    expect(isNoOp({ ...OFF, method: 'resample', spacing: 1 })).toBe(false)
    expect(isNoOp({ ...OFF, method: 'downsample', factor: 2 })).toBe(false)
  })
})

describe('cleanOps — units, and when they matter', () => {
  it('lets a voxel set through when no distance is in play', () => {
    // Keeping every Nth node counts hops, which means the same thing in voxels as in
    // nanometres. Refusing it would refuse a well-defined operation over a control nobody set.
    expect(usesDistance({ ...OFF, method: 'downsample', factor: 4 })).toBe(false)
    expect(() => checkCleanUnits({ units: 'voxels' }, false)).not.toThrow()
  })

  it('refuses one when a distance is', () => {
    expect(usesDistance({ ...OFF, smooth: 2 })).toBe(true)
    expect(usesDistance({ ...OFF, heal: true, healMaxDist: 5 })).toBe(true)
    expect(usesDistance({ ...OFF, method: 'resample', spacing: 1 })).toBe(true)
    expect(() => checkCleanUnits({ units: 'voxels' }, true)).toThrow(/not nanometres/)
  })

  it('does not count healing with no limit as a distance', () => {
    // The bridges are found in whatever units the coordinates are in; nothing on the card
    // states a length, so there is nothing to be wrong about.
    expect(usesDistance({ ...OFF, heal: true, healMaxDist: 0 })).toBe(false)
  })

  it('lets an unstated unit through, since absent means unknown', () => {
    expect(() => checkCleanUnits({}, true)).not.toThrow()
    expect(() => checkCleanUnits({ units: 'nm' }, true)).not.toThrow()
  })
})

describe('cleanOps — the flattening', () => {
  it('lays neurons end to end and keeps parent indices neuron-local', () => {
    const request = cleanRequestFrom(skeletonsFixture(), OFF)
    expect(Array.from(request.offsets)).toEqual([0, 3, 5, 5])
    // The second neuron's root is -1, not "3": `skeletons.py` slices each neuron out and hands
    // fastcore row numbers, so a global index would be a dangling reference.
    expect(Array.from(request.parents)).toEqual([-1, 0, 1, -1, 0])
    expect(request.points.length).toBe(5 * 3)
    expect(Array.from(request.radii)).toEqual([10, 20, 30, 40, 50])
  })

  it('sends nanometres and converts the controls, not the coordinates', () => {
    // The opposite split from NBLAST's, and deliberate: the coordinates stay exactly as they
    // are and the micrometre controls are multiplied, so nothing round-trips through a second
    // scale.
    const request = cleanRequestFrom(skeletonsFixture(), {
      ...OFF,
      smooth: 2,
      heal: true,
      healMaxDist: 10,
      method: 'resample',
      spacing: 0.5,
    })
    expect(request.points[3]).toBe(1000)
    expect(request.smooth).toBe(2 * NM_PER_UM)
    expect(request.healMaxDist).toBe(10 * NM_PER_UM)
    expect(request.spacing).toBe(0.5 * NM_PER_UM)
  })

  it('builds its own buffers rather than handing over the upstream ones', () => {
    // `callPython` transfers, so passing an upstream item's `positions` would detach the
    // scheduler's cached result for the node above.
    const value = skeletonsFixture()
    const request = cleanRequestFrom(value, OFF)
    expect(request.points).not.toBe(value.items[0]!.positions)
    expect(request.radii).not.toBe(value.items[0]!.radii)
    expect(request.parents).not.toBe(value.items[0]!.parents)
  })
})

describe('cleanOps — the scattering', () => {
  it('gives every neuron back its own slice, with the attribute table untouched', () => {
    const value = skeletonsFixture()
    const out = skeletonsFromResult(value, passThrough(cleanRequestFrom(value, OFF)))
    expect(out.items.length).toBe(3)
    expect(out.items.map((i) => i.id)).toEqual(['11', '22', '33'])
    expect(out.items.map((i) => i.parents.length)).toEqual([3, 2, 0])
    expect(Array.from(out.items[1]!.radii)).toEqual([40, 50])
    expect(out.attributes).toBe(value.attributes)
  })

  it('carries units and space through, since neither moved', () => {
    const value = { ...skeletonsFixture(), space: 'JRCFIB2018F' }
    const out = skeletonsFromResult(value, passThrough(cleanRequestFrom(value, OFF)))
    expect(out.units).toBe('nm')
    expect(out.space).toBe('JRCFIB2018F')
  })

  it('recomputes the bounds, which a changed node set makes stale', () => {
    const value = skeletonsFixture()
    const request = cleanRequestFrom(value, OFF)
    const moved = passThrough(request)
    moved.points[0] = -9000
    const out = skeletonsFromResult(value, moved)
    expect(out.bounds.min[0]).toBe(-9000)
  })

  it('refuses a result with a different number of neurons in it', () => {
    // The failure this prevents draws: every label after the missing neuron would belong to
    // the wrong one.
    const value = skeletonsFixture()
    const short = passThrough(cleanRequestFrom(value, OFF))
    expect(() =>
      skeletonsFromResult(value, { ...short, offsets: short.offsets.slice(0, 3) }),
    ).toThrow(/no longer line up/)
  })

  it('counts the neurons that came back empty', () => {
    expect(emptiedItems(Int32Array.from([0, 3, 5, 5]))).toBe(1)
    expect(emptiedItems(Int32Array.from([0, 3, 5, 7]))).toBe(0)
    expect(emptiedItems(Int32Array.from([0, 0, 0]))).toBe(2)
  })
})

describe('cleanOps — the resample ceiling', () => {
  /**
   * One metre of cable in a single neuron.
   *
   * A round number rather than the fixture's three micrometres, because what this guard is
   * about is a *large* set: the node count is total cable over spacing, and both factors have
   * to be realistic for the arithmetic in the message to be checkable by eye. A metre is about
   * what five hundred fly neurons come to.
   */
  const cable = (): SkeletonsValue => ({
    kind: 'skeletons',
    items: [
      {
        id: '1',
        positions: new Float32Array([0, 0, 0, 1e9, 0, 0]),
        radii: new Float32Array([1, 1]),
        parents: new Int32Array([-1, 0]),
      },
    ],
    attributes: makeTable(tableSchema(column('neuronId', 'i64')), { neuronId: [1] }),
    bounds: { min: [0, 0, 0], max: [1e9, 0, 0] },
    units: 'nm',
  })

  it('says nothing at a spacing that keeps the geometry a sensible size', () => {
    // A metre at one micrometre is a million nodes, which is the ordinary case.
    const said: string[] = []
    checkResampleSize({ warn: (m) => said.push(m) }, cable(), 1 * NM_PER_UM)
    expect(said).toEqual([])
  })

  it('warns when the spacing would multiply the node count', () => {
    // The same metre at a tenth of a micrometre is ten million, which is 200 MB of geometry
    // before anything draws it.
    const said: string[] = []
    checkResampleSize({ warn: (m) => said.push(m) }, cable(), 0.1 * NM_PER_UM)
    expect(said.join(' ')).toMatch(/nodes after resampling/)
    expect(said.join(' ')).toMatch(/Spacing of 0.1 µm/)
  })

  it('still refuses the one spacing that has no geometry on the other side of it', () => {
    // The crash floor: the only thing left in this file that refuses, and only for an
    // allocation. A metre at ten nanometres is a hundred million nodes, i.e. 2 GB.
    expect(() => checkResampleSize({ warn: () => undefined }, cable(), 10)).toThrow(
      /would allocate/,
    )
  })

  it('says nothing when there is no resampling to size', () => {
    const said: string[] = []
    checkResampleSize({ warn: (m) => said.push(m) }, cable(), 0)
    expect(said).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

const source: DataSource = new MockSource({ latencyMs: 0 })

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** dataset → find(LC4) → skeletons → clean */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('clean-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('skel', 'neuron.skeletons', { limit: 20 }))
  g = addNode(g, node('clean', 'neuron.cleanSkeletons', params))
  for (const [from, out, to, into] of [
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'skel', 'dataset'],
    ['find', 'neurons', 'skel', 'neurons'],
    ['skel', 'skeletons', 'clean', 'in'],
  ] as const) {
    g = addEdge(g, { source: from, sourceHandle: out, target: to, targetHandle: into })
  }
  return g
}

function scheduler(): Scheduler {
  return new Scheduler({
    resolveSource: (id) => {
      if (id !== 'mock') throw new Error(`unexpected source ${id}`)
      return source
    },
  })
}

beforeEach(() => {
  mockedRun.mockReset()
})

describe('neuron.cleanSkeletons — types and params', () => {
  it('publishes skeletons with the same attribute schema, since it touches no column', () => {
    const inference = inferGraph(pipeline())
    const out = inference.nodes.clean?.outputs.out
    expect(out?.kind).toBe('skeletons')
    const upstream = inference.nodes.skel?.outputs.skeletons
    expect(out && 'schema' in out ? out.schema : undefined).toEqual(
      upstream && 'schema' in upstream ? upstream.schema : undefined,
    )
  })

  it('is expensive, so a spacing field does not fire a pipeline per keystroke', () => {
    expect(requireNodeDef('neuron.cleanSkeletons').cost).toBe('expensive')
  })

  it('makes resample and downsample one control, so both cannot be on', () => {
    const def = requireNodeDef('neuron.cleanSkeletons')
    const method = (def.params ?? []).find((p) => p.id === 'method')
    expect(method?.kind).toBe('enum')
    // Structural rather than a rule somebody has to remember: there is no state in which both
    // ran, because there is one field holding one of three values.
    const spacing = (def.params ?? []).find((p) => p.id === 'spacing')
    const factor = (def.params ?? []).find((p) => p.id === 'factor')
    expect(spacing?.visibleIf?.({ method: 'downsample' })).toBe(false)
    expect(factor?.visibleIf?.({ method: 'resample' })).toBe(false)
  })

  // Through `makeInferContext`, which runs the real column resolution — a literal
  // context stub is ten fields that go stale the moment `InferContext` gains one.
  const validate = (params: ParamValues) => {
    const def = requireNodeDef('neuron.cleanSkeletons')
    return (def.validate?.(makeInferContext(def, { ...defaultParams(def), ...params }, {})) ?? [])
      .join(' ')
  }

  it('says so when nothing is switched on', () => {
    expect(validate({ method: 'none' })).toMatch(/passes the skeletons through/)
  })

  it('catches a spacing that was typed in nanometres', () => {
    expect(validate({ method: 'resample', spacing: 500 })).not.toMatch(/micrometres, not/)
    expect(validate({ method: 'resample', spacing: 0.001 })).toMatch(/micrometres, not/)
  })
})

describe('neuron.cleanSkeletons — running', () => {
  it('passes the skeletons through untouched when nothing is on, without calling Python', async () => {
    const s = scheduler()
    await s.run(pipeline({ method: 'none' }), { mode: 'full' })
    expect(mockedRun).not.toHaveBeenCalled()
    expect(s.output('clean', 'out')).toBe(s.output('skel', 'skeletons'))
  })

  it('forwards every control, with the distances in nanometres', async () => {
    mockedRun.mockImplementation((request: CleanSkeletonsRequest) =>
      Promise.resolve(passThrough(request)),
    )
    const s = scheduler()
    await s.run(
      pipeline({ heal: true, healMaxDist: 8, smooth: 3, method: 'resample', spacing: 2 }),
      { mode: 'full' },
    )
    expect(mockedRun).toHaveBeenCalledTimes(1)
    expect(mockedRun.mock.calls[0]![0]).toMatchObject({
      heal: true,
      healMaxDist: 8000,
      smooth: 3000,
      method: 'resample',
      spacing: 2000,
    })
  })

  it('keeps the neuron count and the attribute table aligned across a real thinning', async () => {
    // The engine halves every neuron's nodes, which is what downsampling does — and the one
    // thing that must not change is how many neurons there are.
    mockedRun.mockImplementation((request: CleanSkeletonsRequest) => {
      const offsets = new Int32Array(request.offsets.length)
      const points: number[] = []
      const parents: number[] = []
      const radii: number[] = []
      for (let n = 0; n + 1 < request.offsets.length; n++) {
        const from = request.offsets[n]!
        const to = request.offsets[n + 1]!
        let kept = 0
        for (let i = from; i < to; i += 2) {
          points.push(request.points[i * 3]!, request.points[i * 3 + 1]!, request.points[i * 3 + 2]!)
          parents.push(kept === 0 ? -1 : kept - 1)
          radii.push(request.radii[i]!)
          kept += 1
        }
        offsets[n + 1] = offsets[n]! + kept
      }
      return Promise.resolve({
        points: Float32Array.from(points),
        parents: Int32Array.from(parents),
        radii: Float32Array.from(radii),
        offsets,
      })
    })

    const s = scheduler()
    await s.run(pipeline({ method: 'downsample', factor: 2 }), { mode: 'full' })
    const before = s.output('skel', 'skeletons')
    const after = s.output('clean', 'out')
    if (!isSkeletonsValue(before) || !isSkeletonsValue(after)) throw new Error('expected skeletons')

    expect(after.items.length).toBe(before.items.length)
    expect(after.attributes.length).toBe(after.items.length)
    expect(after.items.map((i) => i.id)).toEqual(before.items.map((i) => i.id))
    for (const item of after.items) {
      expect(item.positions.length).toBe(item.parents.length * 3)
      expect(item.radii.length).toBe(item.parents.length)
      // Every parent is -1 or an index into this neuron. The failure this catches draws.
      for (const parent of item.parents) expect(parent).toBeLessThan(item.parents.length)
    }
    const total = (v: SkeletonsValue) => v.items.reduce((n, i) => n + i.parents.length, 0)
    expect(total(after)).toBeLessThan(total(before))
  })
})
