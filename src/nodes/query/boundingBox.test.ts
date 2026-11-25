import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import type { Bounds3, LayersValue, MeshesValue, PointsValue } from '../../core/values'
import { makeTable, signedVolume } from '../../core/values'
import { ROI_MESH_SCHEMA } from '../../data/source'
import { column, tableSchema } from '../../core/types'
import '../index'
import { node } from '../../test/graph'
import { sourcelessScheduler } from '../../test/scheduler'
import { boxLayer, boxMesh, parseTriple, readBox } from '../lib/boundingBox'
import { buildInsideTests } from '../lib/meshInside'
import { labelPointsByVolume } from '../lib/pointsInMeshes'

const params = (over: Record<string, unknown> = {}) => ({
  cornerA: '0, 0, 0',
  cornerB: '10, 20, 30',
  units: 'nm',
  voxelSize: '',
  name: 'box',
  ...over,
})

describe('parseTriple', () => {
  it('reads the spellings neuroglancer copies', () => {
    for (const text of ['1, 2, 3', '1 2 3', '1\t2\t3', '[1, 2, 3]', '(1,2,3)', ' 1,2,3 ']) {
      expect(parseTriple(text), text).toEqual([1, 2, 3])
    }
    expect(parseTriple('1.5, -2e3, 0')).toEqual([1.5, -2000, 0])
  })

  it('refuses anything that is not three numbers', () => {
    for (const text of ['', '1, 2', '1, 2, 3, 4', '1, two, 3', '1, 2, NaN']) {
      expect(parseTriple(text), text).toBeUndefined()
    }
  })
})

describe('readBox', () => {
  it('orders the corners on each axis, whichever was typed first', () => {
    const read = readBox(params({ cornerA: '10, 0, 30', cornerB: '0, 20, 0' }))
    expect(read).toMatchObject({ box: { min: [0, 0, 0], max: [10, 20, 30] } })
    expect(read).not.toHaveProperty('warning')
  })

  it('multiplies voxels by the voxel size', () => {
    const read = readBox(params({ units: 'voxels', voxelSize: '4, 4, 40', cornerB: '1, 2, 3' }))
    expect(read).toMatchObject({ box: { min: [0, 0, 0], max: [4, 8, 120] } })
  })

  /*
   * No default voxel size: one right for FlyWire is wrong by 5x on MANC, and a box in the wrong
   * place reads as "nothing is inside it" rather than as an error.
   */
  it('refuses voxels without a voxel size, and a voxel size of zero', () => {
    for (const voxelSize of ['', '4, 0, 40']) {
      expect(readBox(params({ units: 'voxels', voxelSize })), voxelSize).toEqual({
        error: expect.stringContaining('`Voxel size` must be three positive numbers'),
      })
    }
  })

  it('prints a fractional voxel size without float noise', () => {
    const read = readBox(
      params({ units: 'voxels', voxelSize: '0.1, 0.1, 0.1', cornerB: '3, 3, 3' }),
    )
    expect(read).toMatchObject({ box: { max: [0.3, 0.3, 0.3] } })
  })

  it('ignores a stored voxel size while the units are nm', () => {
    expect(readBox(params({ voxelSize: '4, 4, 40' }))).toMatchObject({
      box: { max: [10, 20, 30] },
    })
  })

  it('names the corner it cannot read', () => {
    expect(readBox(params({ cornerB: '1, 2' }))).toEqual({
      error: expect.stringContaining('Corner 2'),
    })
    expect(readBox(params({ cornerA: '' }))).toEqual({ error: expect.stringContaining('two') })
  })

  it('says which axis a flat box has no thickness on', () => {
    expect(readBox(params({ cornerB: '10, 0, 30' }))).toEqual(
      expect.objectContaining({ warning: expect.stringContaining('the same y,') }),
    )
  })

  it('falls back to "box" for an empty name', () => {
    expect(readBox(params({ name: '  ' }))).toMatchObject({ name: 'box' })
  })
})

describe('the mesh', () => {
  const box: Bounds3 = { min: [0, 0, 0], max: [10, 20, 30] }

  /*
   * `signedVolume` is positive only when the faces point out, and a box clear of the origin is
   * needed: a face in a plane through the origin adds nothing to the sum. Equal to the box's
   * volume, not just positive, so a single flipped face fails.
   */
  it('winds every triangle outward', () => {
    const mesh = boxMesh({ min: [1, 2, 3], max: [11, 22, 33] }, 'b')
    expect(signedVolume(mesh.positions, mesh.indices)).toBeCloseTo(10 * 20 * 30)
  })

  /*
   * Through Points in Volumes' own inside test and labelling, so a box that draws but encloses
   * nothing — an open face, a mistyped index — fails here rather than as an empty `Inside`.
   */
  it('encloses what is inside it under Points in Volumes’ test', async () => {
    const mesh = boxMesh(box, 'my box')
    const volumes: MeshesValue = {
      kind: 'meshes',
      items: [mesh],
      attributes: makeTable(ROI_MESH_SCHEMA, { roi: ['my box'], primary: [true] }),
      bounds: box,
      units: 'nm',
    }
    const positions = new Float32Array([5, 10, 15, 1, 1, 29, -1, 10, 15, 5, 21, 15, 5, 10, 31])
    const points: PointsValue = {
      kind: 'points',
      positions,
      attributes: makeTable(tableSchema(column('n', 'str')), { n: ['a', 'b', 'c', 'd', 'e'] }),
      bounds: { min: [-1, 1, 15], max: [5, 21, 31] },
      units: 'nm',
    }
    const tests = await buildInsideTests(volumes.items)
    const { inside, outside } = await labelPointsByVolume(points, volumes, {
      name: 'roi',
      containing: tests.containing,
    })
    expect(inside.attributes.data['n']).toEqual(['a', 'b'])
    expect(inside.attributes.data['roi']).toEqual(['my box', 'my box'])
    expect(outside.attributes.data['n']).toEqual(['c', 'd', 'e'])
  })
})

describe('the layer', () => {
  it('is one axis-aligned box in nanometres', () => {
    const layer = boxLayer({ min: [1, 2, 3], max: [4, 5, 6] }, 'roi A')
    expect(layer).toMatchObject({
      type: 'annotation',
      name: 'roi A',
      source: { url: 'local://annotations' },
      annotations: [
        { type: 'axis_aligned_bounding_box', pointA: [1, 2, 3], pointB: [4, 5, 6] },
      ],
    })
  })
})

describe('the node', () => {
  it('emits a nanometre mesh and passes upstream layers on with its own added', async () => {
    let g = addNode(
      emptyGraph('bbox'),
      node('a', 'core.boundingBox', params({ name: 'first' })),
    )
    g = addNode(
      g,
      node(
        'b',
        'core.boundingBox',
        params({ units: 'voxels', voxelSize: '4, 4, 40', name: 'second' }),
      ),
    )
    g = addEdge(g, { source: 'a', sourceHandle: 'layers', target: 'b', targetHandle: 'layers' })
    const scheduler = sourcelessScheduler()
    await scheduler.run(g, { mode: 'full' })

    const meshes = scheduler.output('b', 'meshes') as MeshesValue
    expect(meshes.units).toBe('nm')
    expect(meshes.bounds).toEqual({ min: [0, 0, 0], max: [40, 80, 1200] })
    expect(meshes.items.map((m) => m.id)).toEqual(['second'])
    expect(meshes.attributes.data['roi']).toEqual(['second'])

    const layers = scheduler.output('b', 'layers') as LayersValue
    expect(layers.items.map((l) => l['name'])).toEqual(['first', 'second'])
  })

  it('warns on the card before a run when a corner is missing', () => {
    const g = addNode(
      emptyGraph('bbox'),
      node('a', 'core.boundingBox', params({ cornerB: '' })),
    )
    const issues = inferGraph(g).nodes['a']!.issues
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('two opposite corners'),
    ])
  })
})
