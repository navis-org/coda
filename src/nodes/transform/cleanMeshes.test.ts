/**
 * Clean Meshes: the flattening, the scattering, the `detail` rule, and the node.
 *
 * `cleanSkeletons.test.ts`'s counterpart, with the same division of labour —
 * `scripts/probe-meshes.mjs` runs the real `meshes.py` against the real wheel and owns whether
 * fastcore decimated correctly; this owns whether the right buffers went over and the right
 * meshes came back.
 *
 * Two assertions here are worth more than the rest, and both are failures that *render* rather
 * than raise: a face index that is no longer local to its own mesh, and an item count that
 * moved. The first is a cloud of stray triangles somewhere between two neurons; the second is
 * a collection where every attribute row after the missing mesh belongs to the wrong one.
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
import type { MeshesValue } from '../../core/values'
import { isMeshesValue, makeTable } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import type { CleanMeshesRequest, CleanMeshesResult } from '../../pyodide/meshes'
import type { MeshCleanParams } from '../lib/cleanOps'
import {
  changesFaces,
  checkDropInternalsSize,
  isMeshNoOp,
  meshRequestFrom,
  meshesFromResult,
} from '../lib/cleanOps'
import '../index'

vi.mock('../../pyodide/meshes', () => ({ runCleanMeshes: vi.fn() }))
const { runCleanMeshes } = await import('../../pyodide/meshes')
const mockedRun = vi.mocked(runCleanMeshes)

const OFF: MeshCleanParams = {
  dropInternals: false,
  openness: 0.05,
  rays: 16,
  passes: 3,
  fillHoles: false,
  ratio: 1,
  smooth: 0,
  method: 'taubin',
  volumeCorrection: false,
}

/** Two tetrahedra and an empty mesh — the third being the case the item-count rule is about. */
function meshesFixture(detail = false): MeshesValue {
  const tetra = (offset: number) =>
    new Float32Array([0, 0, 0, 1000, 0, 0, 0, 1000, 0, 0, 0, 1000].map((v, i) =>
      i % 3 === 0 ? v + offset : v,
    ))
  const faces = new Uint32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3])
  return {
    kind: 'meshes',
    items: [
      { id: '11', positions: tetra(0), indices: faces },
      { id: '22', positions: tetra(5000), indices: faces },
      { id: '33', positions: new Float32Array([]), indices: new Uint32Array([]) },
    ],
    attributes: makeTable(tableSchema(column('neuronId', 'i64'), column('type', 'str')), {
      neuronId: [11, 22, 33],
      type: ['LC4', 'LC6', 'LC10'],
    }),
    bounds: { min: [0, 0, 0], max: [6000, 1000, 1000] },
    units: 'nm',
    ...(detail ? { detail: { lod: 1, levels: 4, triangles: 8 } } : {}),
  }
}

function passThrough(request: CleanMeshesRequest): CleanMeshesResult {
  return {
    positions: request.positions.slice(),
    indices: request.indices.slice(),
    vertexOffsets: request.vertexOffsets.slice(),
    faceOffsets: request.faceOffsets.slice(),
  }
}

describe('cleanOps — is anything switched on', () => {
  it('recognises the untouched card as a pass-through', () => {
    expect(isMeshNoOp(OFF)).toBe(true)
  })

  it('recognises each control that does something', () => {
    expect(isMeshNoOp({ ...OFF, dropInternals: true })).toBe(false)
    expect(isMeshNoOp({ ...OFF, fillHoles: true })).toBe(false)
    expect(isMeshNoOp({ ...OFF, ratio: 0.5 })).toBe(false)
    expect(isMeshNoOp({ ...OFF, smooth: 5 })).toBe(false)
  })

  it('knows which of them can move the face count', () => {
    // Which is what decides whether `detail` survives.
    expect(changesFaces({ ...OFF, smooth: 20 })).toBe(false)
    expect(changesFaces({ ...OFF, ratio: 0.5 })).toBe(true)
    expect(changesFaces({ ...OFF, fillHoles: true })).toBe(true)
    expect(changesFaces({ ...OFF, dropInternals: true })).toBe(true)
  })
})

describe('cleanOps — the flattening', () => {
  it('lays meshes end to end and keeps face indices mesh-local', () => {
    const request = meshRequestFrom(meshesFixture(), OFF)
    expect(Array.from(request.vertexOffsets)).toEqual([0, 4, 8, 8])
    expect(Array.from(request.faceOffsets)).toEqual([0, 4, 8, 8])
    // The second tetrahedron's faces still read 0..3, not 4..7. Re-basing here would have to
    // be undone on the way back, and a mesh whose faces index the wrong vertices renders as
    // stray triangles rather than as an error.
    expect(Array.from(request.indices.slice(12, 15))).toEqual([0, 1, 2])
    expect(request.indices.length).toBe(8 * 3)
  })

  it('builds its own buffers rather than handing over the upstream ones', () => {
    const value = meshesFixture()
    const request = meshRequestFrom(value, OFF)
    expect(request.positions).not.toBe(value.items[0]!.positions)
    expect(request.indices).not.toBe(value.items[0]!.indices)
  })

  it('carries every control across', () => {
    const request = meshRequestFrom(meshesFixture(), {
      dropInternals: true,
      openness: 0.08,
      rays: 8,
      passes: 2,
      fillHoles: true,
      ratio: 0.3,
      smooth: 7,
      method: 'humphrey',
      volumeCorrection: true,
    })
    expect(request).toMatchObject({
      dropInternals: true,
      openness: 0.08,
      rays: 8,
      passes: 2,
      fillHoles: true,
      ratio: 0.3,
      smooth: 7,
      method: 'humphrey',
      volumeCorrection: true,
    })
  })
})

describe('cleanOps — the scattering', () => {
  it('gives every mesh back its own slice, with the attribute table untouched', () => {
    const value = meshesFixture()
    const out = meshesFromResult(value, passThrough(meshRequestFrom(value, OFF)), true)
    expect(out.items.length).toBe(3)
    expect(out.items.map((i) => i.id)).toEqual(['11', '22', '33'])
    expect(out.items.map((i) => i.indices.length / 3)).toEqual([4, 4, 0])
    expect(out.attributes).toBe(value.attributes)
  })

  it('keeps the face indices local on the way back too', () => {
    const value = meshesFixture()
    const out = meshesFromResult(value, passThrough(meshRequestFrom(value, OFF)), true)
    for (const item of out.items) {
      const vertices = item.positions.length / 3
      for (const index of item.indices) expect(index).toBeLessThan(vertices)
    }
  })

  it('recomputes the bounds, which a changed surface makes stale', () => {
    const value = meshesFixture()
    const moved = passThrough(meshRequestFrom(value, OFF))
    moved.positions[0] = -9000
    expect(meshesFromResult(value, moved, true).bounds.min[0]).toBe(-9000)
  })

  it('refuses a result with a different number of meshes in it', () => {
    const value = meshesFixture()
    const short = passThrough(meshRequestFrom(value, OFF))
    expect(() =>
      meshesFromResult(value, { ...short, vertexOffsets: short.vertexOffsets.slice(0, 3) }, true),
    ).toThrow(/no longer line up/)
  })

  it('keeps the level-of-detail caption when only the vertices moved', () => {
    const value = meshesFixture(true)
    const out = meshesFromResult(value, passThrough(meshRequestFrom(value, OFF)), true)
    expect(out.detail).toEqual({ lod: 1, levels: 4, triangles: 8 })
  })

  it('drops it wherever the face count could have moved', () => {
    /*
     * Not just because the triangle count would be stale. `detailNote` reads `decimated` as
     * "this source publishes one level of detail, so meshes were simplified on arrival to fit
     * the triangle budget — raise Detail on the Meshes node", every clause of which is false
     * about a mesh somebody decimated here on purpose. Two levels of detail in one collection
     * is no level of detail; so is a level that has been overwritten.
     */
    const value = meshesFixture(true)
    const out = meshesFromResult(value, passThrough(meshRequestFrom(value, OFF)), false)
    expect(out.detail).toBeUndefined()
    expect('detail' in out).toBe(false)
  })
})

describe('cleanOps — the drop-internals ceiling', () => {
  it('says nothing when the switch is off, however many triangles there are', () => {
    const said: string[] = []
    checkDropInternalsSize({ warn: (m) => said.push(m) }, meshesFixture(), OFF)
    expect(said).toEqual([])
  })

  it('says nothing on a small mesh', () => {
    const said: string[] = []
    checkDropInternalsSize({ warn: (m) => said.push(m) }, meshesFixture(), {
      ...OFF,
      dropInternals: true,
    })
    expect(said).toEqual([])
  })

  it('warns on a real one, naming the controls that move it', () => {
    // 600,000 triangles at 16 rays and 3 passes is 28.8 million casts... which is under the
    // threshold, so this builds the case that is not: half a million triangles per mesh across
    // enough meshes to matter.
    const many: MeshesValue = {
      ...meshesFixture(),
      items: Array.from({ length: 40 }, (_, i) => ({
        id: String(i),
        positions: new Float32Array(3),
        // 200,000 triangles each, i.e. 8 million across the set — roughly forty hemibrain
        // neurons at the finest level of detail.
        indices: new Uint32Array(200_000 * 3),
      })),
    }
    const said: string[] = []
    checkDropInternalsSize({ warn: (m) => said.push(m) }, many, { ...OFF, dropInternals: true })
    expect(said.join(' ')).toMatch(/ray casts/)
    expect(said.join(' ')).toMatch(/Rays or/)
    expect(said.join(' ')).toMatch(/Detail on the Meshes node/)
  })

  it('never refuses, because the cost is a wait', () => {
    const huge: MeshesValue = {
      ...meshesFixture(),
      items: [{ id: '1', positions: new Float32Array(3), indices: new Uint32Array(9_000_000) }],
    }
    expect(() =>
      checkDropInternalsSize({ warn: () => undefined }, huge, { ...OFF, dropInternals: true }),
    ).not.toThrow()
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

/** dataset → find(LC4) → meshes → clean */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('clean-mesh-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('mesh', 'neuron.meshes', { limit: 10 }))
  g = addNode(g, node('clean', 'neuron.cleanMeshes', params))
  for (const [from, out, to, into] of [
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'mesh', 'dataset'],
    ['find', 'neurons', 'mesh', 'neurons'],
    ['mesh', 'meshes', 'clean', 'in'],
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

describe('neuron.cleanMeshes — types and params', () => {
  it('publishes meshes with the same attribute schema, since it touches no column', () => {
    const inference = inferGraph(pipeline())
    expect(inference.nodes.clean?.outputs.out?.kind).toBe('meshes')
  })

  it('is expensive, so a ratio slider does not fire a pipeline per keystroke', () => {
    expect(requireNodeDef('neuron.cleanMeshes').cost).toBe('expensive')
  })

  it('hides the openness controls until Drop internal membrane is on', () => {
    const def = requireNodeDef('neuron.cleanMeshes')
    for (const id of ['openness', 'rays', 'passes']) {
      const param = (def.params ?? []).find((p) => p.id === id)
      expect(param?.visibleIf?.({ dropInternals: false })).toBe(false)
      expect(param?.visibleIf?.({ dropInternals: true })).toBe(true)
    }
  })

  // Through `makeInferContext`, which runs the real column resolution — a literal
  // context stub is ten fields that go stale the moment `InferContext` gains one.
  const validate = (params: ParamValues) => {
    const def = requireNodeDef('neuron.cleanMeshes')
    return (def.validate?.(makeInferContext(def, { ...defaultParams(def), ...params }, {})) ?? [])
      .join(' ')
  }

  it('says so when nothing is switched on', () => {
    expect(validate({ ratio: 1 })).toMatch(/passes the meshes through/)
  })

  it('says so when Laplacian would shrink the mesh unchecked', () => {
    // The one combination here that quietly changes a measurement rather than a picture.
    expect(validate({ smooth: 5, method: 'laplacian' })).toMatch(/shrinks/)
    expect(validate({ smooth: 5, method: 'laplacian', volumeCorrection: true })).not.toMatch(
      /shrinks/,
    )
    expect(validate({ smooth: 5, method: 'taubin' })).not.toMatch(/shrinks/)
  })
})

describe('neuron.cleanMeshes — running', () => {
  it('passes the meshes through untouched when nothing is on, without calling Python', async () => {
    const s = scheduler()
    await s.run(pipeline({ ratio: 1 }), { mode: 'full' })
    expect(mockedRun).not.toHaveBeenCalled()
    expect(s.output('clean', 'out')).toBe(s.output('mesh', 'meshes'))
  })

  it('keeps the mesh count and the attribute table aligned across a real decimation', async () => {
    // The engine keeps every other face, which is what decimation does — and the one thing
    // that must not change is how many meshes there are.
    mockedRun.mockImplementation((request: CleanMeshesRequest) => {
      const faceOffsets = new Int32Array(request.faceOffsets.length)
      const indices: number[] = []
      for (let m = 0; m + 1 < request.faceOffsets.length; m++) {
        const from = request.faceOffsets[m]!
        const to = request.faceOffsets[m + 1]!
        let kept = 0
        for (let f = from; f < to; f += 2) {
          indices.push(request.indices[f * 3]!, request.indices[f * 3 + 1]!, request.indices[f * 3 + 2]!)
          kept += 1
        }
        faceOffsets[m + 1] = faceOffsets[m]! + kept
      }
      return Promise.resolve({
        positions: request.positions.slice(),
        indices: Uint32Array.from(indices),
        vertexOffsets: request.vertexOffsets.slice(),
        faceOffsets,
      })
    })

    const s = scheduler()
    await s.run(pipeline({ ratio: 0.5 }), { mode: 'full' })
    const before = s.output('mesh', 'meshes')
    const after = s.output('clean', 'out')
    if (!isMeshesValue(before) || !isMeshesValue(after)) throw new Error('expected meshes')

    expect(after.items.length).toBe(before.items.length)
    expect(after.attributes.length).toBe(after.items.length)
    expect(after.items.map((i) => i.id)).toEqual(before.items.map((i) => i.id))
    for (const item of after.items) {
      const vertices = item.positions.length / 3
      expect(item.indices.length % 3).toBe(0)
      for (const index of item.indices) expect(index).toBeLessThan(vertices)
    }
    // And the level-of-detail caption is gone, because the face count moved.
    expect(after.detail).toBeUndefined()
  })
})
