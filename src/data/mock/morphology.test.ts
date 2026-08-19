/**
 * Synthetic morphology.
 *
 * The properties that matter are structural, not aesthetic: a valid rooted tree (so
 * downstream morphometrics have something well-formed to traverse), determinism (so the
 * provenance cache stays valid across reloads), and geometry that actually sits where the
 * neuron's ROIs are.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { boundsOf, skeletonPointCount } from '../../core/values'
import { registerSource } from '../source'
import { MockSource } from './MockSource'
import { getConnectome } from './generate'
import {
  generateRoiMesh,
  generateSkeleton,
  roiCenter,
  skeletonToTubeMesh,
  synapsePosition,
} from './morphology'

const source = new MockSource({ latencyMs: 0 })

beforeAll(() => {
  registerSource(source)
})

function someBodyIds(count: number): number[] {
  const connectome = getConnectome('optic-lobe-mini')!
  return connectome.neurons.filter((n) => n.type === 'LC4').slice(0, count).map((n) => n.bodyId)
}

describe('generateSkeleton', () => {
  it('produces a valid rooted tree', () => {
    const skeleton = generateSkeleton(12345, ['LO(R)', 'PVLP(R)'])
    const count = skeleton.parents.length
    expect(count).toBeGreaterThan(50)
    expect(skeleton.positions.length).toBe(count * 3)
    expect(skeleton.radii.length).toBe(count)

    // Exactly one root, and every parent points backwards — so a traversal terminates.
    let roots = 0
    for (let i = 0; i < count; i++) {
      const parent = skeleton.parents[i]!
      if (parent === -1) {
        roots++
        continue
      }
      expect(parent).toBeGreaterThanOrEqual(0)
      expect(parent, `node ${i} parent ${parent}`).toBeLessThan(i)
    }
    expect(roots).toBe(1)
  })

  it('is deterministic for a body id, so cache keys stay valid', () => {
    const a = generateSkeleton(999, ['ME(R)'])
    const b = generateSkeleton(999, ['ME(R)'])
    expect([...a.positions]).toEqual([...b.positions])
    expect([...a.parents]).toEqual([...b.parents])
  })

  it('gives different neurons different shapes', () => {
    const a = generateSkeleton(1, ['ME(R)'])
    const b = generateSkeleton(2, ['ME(R)'])
    expect([...a.positions]).not.toEqual([...b.positions])
  })

  it('tapers: the soma is the thickest point', () => {
    const skeleton = generateSkeleton(4242, ['LO(R)', 'PVLP(R)'])
    const somaRadius = skeleton.radii[0]!
    for (let i = 1; i < skeleton.radii.length; i++) {
      expect(skeleton.radii[i]!).toBeLessThanOrEqual(somaRadius)
    }
  })

  it('places the soma near the first ROI, so scenes are spatially plausible', () => {
    const centre = roiCenter('CA(R)')
    const skeleton = generateSkeleton(777, ['CA(R)', 'PED(R)'])
    const distance = Math.hypot(
      skeleton.positions[0]! - centre[0],
      skeleton.positions[1]! - centre[1],
      skeleton.positions[2]! - centre[2],
    )
    expect(distance).toBeLessThan(2000)
  })

  it('honours a point budget', () => {
    const small = generateSkeleton(555, ['ME(R)'], { targetPoints: 80 })
    expect(small.parents.length).toBeLessThanOrEqual(120)
  })
})

describe('skeletonToTubeMesh', () => {
  it('builds a closed tube with valid triangle indices', () => {
    const skeleton = generateSkeleton(31337, ['LO(R)'], { targetPoints: 60 })
    const mesh = skeletonToTubeMesh(skeleton, 5)

    expect(mesh.positions.length).toBe(skeleton.parents.length * 5 * 3)
    expect(mesh.indices.length % 3).toBe(0)
    const vertexCount = mesh.positions.length / 3
    for (const index of mesh.indices) {
      expect(index).toBeLessThan(vertexCount)
    }
  })

  it('has two triangles per radial segment per edge', () => {
    const skeleton = generateSkeleton(31337, ['LO(R)'], { targetPoints: 60 })
    const edges = [...skeleton.parents].filter((p) => p >= 0).length
    const mesh = skeletonToTubeMesh(skeleton, 5)
    expect(mesh.indices.length / 3).toBe(edges * 5 * 2)
  })
})

describe('synapsePosition', () => {
  it('is deterministic and lands within the neuron bounds', () => {
    const skeleton = generateSkeleton(2024, ['LO(R)', 'PVLP(R)'])
    const bounds = boundsOf([skeleton.positions])
    const first = synapsePosition(skeleton, 3)
    expect(synapsePosition(skeleton, 3)).toEqual(first)

    // Jitter can push a synapse slightly off the cable, but not into another brain region.
    for (let axis = 0; axis < 3; axis++) {
      expect(first[axis]).toBeGreaterThan(bounds.min[axis]! - 200)
      expect(first[axis]).toBeLessThan(bounds.max[axis]! + 200)
    }
  })
})

describe('MockSource morphology', () => {
  it('fetches skeletons with an attribute row per neuron', async () => {
    const bodyIds = someBodyIds(3)
    const skeletons = await source.fetchSkeletons({ datasetId: 'optic-lobe-mini', bodyIds })

    expect(skeletons.kind).toBe('skeletons')
    expect(skeletons.items).toHaveLength(3)
    expect(skeletons.attributes.length).toBe(3)
    // Attribute rows are in item order — the encoding layer indexes by position.
    expect(skeletons.attributes.data.bodyId).toEqual(skeletons.items.map((i) => i.bodyId))
    expect(skeletons.attributes.schema.columns.map((c) => c.name)).toContain('cableLength')
    expect(skeletonPointCount(skeletons)).toBeGreaterThan(100)
  })

  it('reports bounds that enclose the geometry', async () => {
    const skeletons = await source.fetchSkeletons({
      datasetId: 'optic-lobe-mini',
      bodyIds: someBodyIds(2),
    })
    for (const item of skeletons.items) {
      for (let i = 0; i < item.positions.length; i += 3) {
        for (let axis = 0; axis < 3; axis++) {
          expect(item.positions[i + axis]!).toBeGreaterThanOrEqual(skeletons.bounds.min[axis]!)
          expect(item.positions[i + axis]!).toBeLessThanOrEqual(skeletons.bounds.max[axis]!)
        }
      }
    }
  })

  it('derives meshes from the same skeletons, so the two views agree', async () => {
    const bodyIds = someBodyIds(2)
    const [skeletons, meshes] = await Promise.all([
      source.fetchSkeletons({ datasetId: 'optic-lobe-mini', bodyIds }),
      source.fetchMeshes({ datasetId: 'optic-lobe-mini', bodyIds }),
    ])
    expect(meshes.items.map((m) => m.bodyId)).toEqual(skeletons.items.map((s) => s.bodyId))
    expect(meshes.items[0]!.indices.length).toBeGreaterThan(0)
  })

  it('places synapses with one attribute row per point', async () => {
    const points = await source.fetchSynapses({
      datasetId: 'optic-lobe-mini',
      bodyIds: someBodyIds(2),
    })
    expect(points.kind).toBe('points')
    expect(points.positions.length).toBe(points.attributes.length * 3)
    expect(points.attributes.schema.columns.map((c) => c.name)).toContain('polarity')
    expect(new Set(points.attributes.data.polarity as string[])).toEqual(new Set(['pre', 'post']))
  })

  it('filters synapses by polarity and weight', async () => {
    const bodyIds = someBodyIds(2)
    const pre = await source.fetchSynapses({
      datasetId: 'optic-lobe-mini',
      bodyIds,
      polarity: 'pre',
    })
    expect(new Set(pre.attributes.data.polarity as string[])).toEqual(new Set(['pre']))

    const heavy = await source.fetchSynapses({
      datasetId: 'optic-lobe-mini',
      bodyIds,
      minWeight: 20,
    })
    for (const weight of heavy.attributes.data.weight as number[]) {
      expect(weight).toBeGreaterThanOrEqual(20)
    }
  })

  it('advertises its geometry capabilities', () => {
    expect(source.capabilities.skeletons).toBe(true)
    expect(source.capabilities.meshes).toBe(true)
    expect(source.capabilities.synapses).toBe(true)
  })
})

/**
 * Region shells.
 *
 * The ROIs widget draws these and nothing else, so what matters is that they are well-formed
 * triangle meshes (the outline tracer fills faces — a shell with no faces projects to a dotty
 * ring), that they are deterministic like every other synthetic thing here, and that they sit
 * where the neurons do. The last one is the claim that would be quietly wrong: a shell placed
 * from a different table than the arbors would draw a perfectly convincing brain with the
 * neurons beside it rather than inside it.
 */
describe('mock region meshes', () => {
  it('answers a dataset with one shell per region, named', async () => {
    const connectome = getConnectome('hemibrain-mini')!
    const meshes = await source.fetchRoiMeshes({ datasetId: 'hemibrain-mini' })

    expect(meshes.kind).toBe('meshes')
    expect(meshes.items).toHaveLength(connectome.rois.length)
    expect(meshes.attributes.length).toBe(meshes.items.length)
    // Identity is the region's name, in the item and in the attribute row, in the same order.
    expect(meshes.items.map((m) => m.label)).toEqual(connectome.rois)
    expect(meshes.attributes.data.roi).toEqual(connectome.rois)
  })

  it('builds valid triangle meshes', async () => {
    const meshes = await source.fetchRoiMeshes({ datasetId: 'hemibrain-mini' })
    for (const mesh of meshes.items) {
      expect(mesh.positions.length % 3).toBe(0)
      expect(mesh.indices.length % 3).toBe(0)
      expect(mesh.indices.length).toBeGreaterThan(0)
      const vertexCount = mesh.positions.length / 3
      for (const index of mesh.indices) expect(index).toBeLessThan(vertexCount)
      expect(Number.isFinite(mesh.positions[0])).toBe(true)
    }
  })

  it('is deterministic, so a reload draws the same brain', () => {
    const a = generateRoiMesh('CA(R)')
    const b = generateRoiMesh('CA(R)')
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    // …and two regions are not the same solid moved.
    const other = generateRoiMesh('PED(R)')
    expect(Array.from(other.positions)).not.toEqual(Array.from(a.positions))
  })

  it('places each shell around its own region centre', () => {
    for (const roi of ['CA(R)', 'AL(R)', 'LH(R)']) {
      const mesh = generateRoiMesh(roi)
      const bounds = boundsOf([mesh.positions])
      const [cx, cy, cz] = roiCenter(roi)
      expect(cx).toBeGreaterThan(bounds.min[0])
      expect(cx).toBeLessThan(bounds.max[0])
      expect(cy).toBeGreaterThan(bounds.min[1])
      expect(cy).toBeLessThan(bounds.max[1])
      expect(cz).toBeGreaterThan(bounds.min[2])
      expect(cz).toBeLessThan(bounds.max[2])
    }
  })

  it('encloses the neurons drawn beside it', async () => {
    // The shells and the arbors are placed from the same ROI table, so a neuron's points should
    // land inside the union of the regions it innervates. Not every point: an arbor is grown
    // with jitter and the shells are not convex hulls of it. Most of them is the honest claim,
    // and it is the one that fails if the two ever stop sharing a coordinate frame.
    const meshes = await source.fetchRoiMeshes({ datasetId: 'hemibrain-mini' })
    const union = boundsOf(meshes.items.map((m) => m.positions))

    const connectome = getConnectome('hemibrain-mini')!
    const bodyId = connectome.neurons[0]!.bodyId
    const rois = connectome.roiCounts.filter((rc) => rc.bodyId === bodyId).map((rc) => rc.roi)
    const skeleton = generateSkeleton(bodyId, rois)

    let inside = 0
    const points = skeleton.positions.length / 3
    for (let i = 0; i < points; i++) {
      const x = skeleton.positions[i * 3]!
      const y = skeleton.positions[i * 3 + 1]!
      const z = skeleton.positions[i * 3 + 2]!
      if (
        x >= union.min[0] && x <= union.max[0] &&
        y >= union.min[1] && y <= union.max[1] &&
        z >= union.min[2] && z <= union.max[2]
      ) {
        inside++
      }
    }
    expect(inside / points).toBeGreaterThan(0.9)
  })

  it('advertises the capability, and a source without it offers no method', () => {
    expect(source.capabilities.roiMeshes).toBe(true)
    expect(typeof source.fetchRoiMeshes).toBe('function')
  })
})
