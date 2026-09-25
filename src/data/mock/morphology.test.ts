/**
 * Synthetic morphology.
 *
 * The properties that matter are structural, not aesthetic: a valid rooted tree (so
 * downstream morphometrics have something well-formed to traverse), determinism (so the
 * provenance cache stays valid across reloads), and geometry that actually sits where the
 * neuron's ROIs are.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { boundsOf, signedVolume, skeletonPointCount } from '../../core/values'
import { SYNAPSE_UNITS } from '../synapseUnits'
import { registerSource } from '../source'
import { MockSource, skeletonRois } from './MockSource'
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

function someNeuronIds(count: number): string[] {
  const connectome = getConnectome('optic-lobe-mini')!
  return connectome.neurons
    .filter((n) => n.type === 'LC4')
    .slice(0, count)
    .map((n) => String(n.neuronId))
}

describe('MockSource synapses between', () => {
  /*
   * The property the seam promises every source, held where it is cheapest to: grouping rows by
   * (source, target) reproduces the connection weight. Measured on neuPrint for 1,173 real pairs;
   * the mock is where a regression in the contract itself shows first.
   */
  const connectome = getConnectome('optic-lobe-mini')!
  const sources = someNeuronIds(4)
  const edges = sources.flatMap((id) => connectome.out.get(Number(id)) ?? [])
  // Half the partners, so an edge to a partner nobody asked for is part of what is tested.
  const partners = [...new Set(edges.map((e) => e.post))]
  const targets = partners.slice(0, Math.max(1, Math.ceil(partners.length / 2))).map(String)

  /** Rows per (source, target) pair, from a cloud's attributes. */
  const sum = (rows: { neuronId?: unknown[]; partnerId?: unknown[] }) => {
    const got = new Map<string, number>()
    for (let i = 0; i < (rows.neuronId ?? []).length; i++) {
      const key = `${rows.neuronId![i]}>${rows.partnerId![i]}`
      got.set(key, (got.get(key) ?? 0) + 1)
    }
    return got
  }
  /** Synapses per pair, from the generated edges. */
  const expectFrom = (list: typeof edges) => {
    const want = new Map<string, number>()
    for (const edge of list) {
      const key = `${edge.pre}>${edge.post}`
      want.set(key, (want.get(key) ?? 0) + edge.weight)
    }
    return want
  }

  it('returns one row per synapse, only onto the targets asked for', async () => {
    expect(partners.length).toBeGreaterThan(1)
    const points = await source.fetchSynapsesBetween({
      datasetId: 'optic-lobe-mini',
      sourceIds: sources,
      targetIds: targets,
      location: 'pre',
    })
    expect(sum(points.attributes.data)).toEqual(
      expectFrom(edges.filter((edge) => targets.includes(String(edge.post)))),
    )
    expect(points.positions.length).toBe(points.attributes.length * 3)
  })

  it('leaves either end open: every synapse the sources make, or every one onto the targets', async () => {
    const down = await source.fetchSynapsesBetween({
      datasetId: 'optic-lobe-mini',
      sourceIds: sources,
      location: 'pre',
    })
    expect(sum(down.attributes.data)).toEqual(expectFrom(edges))

    const up = await source.fetchSynapsesBetween({
      datasetId: 'optic-lobe-mini',
      targetIds: targets,
      location: 'pre',
    })
    const incoming = targets.flatMap((id) => connectome.in.get(Number(id)) ?? [])
    expect(incoming.length).toBeGreaterThan(0)
    expect(sum(up.attributes.data)).toEqual(expectFrom(incoming))

    await expect(
      source.fetchSynapsesBetween({ datasetId: 'optic-lobe-mini', location: 'pre' }),
    ).rejects.toThrow(/sources, targets or both/)
  })

  it('moves the points and nothing else when Location changes', async () => {
    const ask = (location: 'pre' | 'post') =>
      source.fetchSynapsesBetween({
        datasetId: 'optic-lobe-mini',
        sourceIds: sources,
        targetIds: targets,
        location,
      })
    const [pre, post] = await Promise.all([ask('pre'), ask('post')])
    expect(post.attributes.data.neuronId).toEqual(pre.attributes.data.neuronId)
    expect(post.attributes.data.partnerId).toEqual(pre.attributes.data.partnerId)
    expect(new Set(post.attributes.data.polarity)).toEqual(new Set(['post']))
    expect([...post.positions]).not.toEqual([...pre.positions])
  })
})

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

  it('is deterministic for a neuron id, so cache keys stay valid', () => {
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
    const neuronIds = someNeuronIds(3)
    const skeletons = await source.fetchSkeletons({ datasetId: 'optic-lobe-mini', neuronIds })

    expect(skeletons.kind).toBe('skeletons')
    expect(skeletons.items).toHaveLength(3)
    expect(skeletons.attributes.length).toBe(3)
    // Attribute rows are in item order — the encoding layer indexes by position.
    const ids = skeletons.items.map((i) => i.id)
    expect(skeletons.attributes.data.neuronId?.map(String)).toEqual(ids)
    expect(skeletons.attributes.schema.columns.map((c) => c.name)).toContain('cableLength')
    expect(skeletonPointCount(skeletons)).toBeGreaterThan(100)
    // Synthetic, but it still states its units rather than leaving a consumer to guess — the
    // NBLAST node refuses anything that is not nanometres, and silence is not nanometres.
    expect(skeletons.units).toBe('nm')
  })

  it('reports bounds that enclose the geometry', async () => {
    const skeletons = await source.fetchSkeletons({
      datasetId: 'optic-lobe-mini',
      neuronIds: someNeuronIds(2),
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
    const neuronIds = someNeuronIds(2)
    const [skeletons, meshes] = await Promise.all([
      source.fetchSkeletons({ datasetId: 'optic-lobe-mini', neuronIds }),
      source.fetchMeshes({ datasetId: 'optic-lobe-mini', neuronIds }),
    ])
    expect(meshes.items.map((m) => m.id)).toEqual(skeletons.items.map((s) => s.id))
    expect(meshes.items[0]!.indices.length).toBeGreaterThan(0)
  })

  it('places synapses with one attribute row per point', async () => {
    const points = await source.fetchSynapses({
      unit: SYNAPSE_UNITS.links,
      datasetId: 'optic-lobe-mini',
      neuronIds: someNeuronIds(2),
    })
    expect(points.kind).toBe('points')
    expect(points.positions.length).toBe(points.attributes.length * 3)
    expect(points.attributes.schema.columns.map((c) => c.name)).toContain('polarity')
    expect(new Set(points.attributes.data.polarity as string[])).toEqual(
      new Set(['pre', 'post']),
    )
  })

  it('filters synapses by polarity and weight', async () => {
    const neuronIds = someNeuronIds(2)
    const pre = await source.fetchSynapses({
      unit: SYNAPSE_UNITS.links,
      datasetId: 'optic-lobe-mini',
      neuronIds,
      polarity: 'pre',
    })
    expect(new Set(pre.attributes.data.polarity as string[])).toEqual(new Set(['pre']))

    /*
     * The mock has no per-synapse confidence — its `weight` column is the *connection's* weight —
     * so the control is unhonourable here and says so instead of filtering by it. Filtering a
     * point cloud by connection weight under a control labelled confidence is the conflation the
     * rename exists to undo.
     */
    const warnings: string[] = []
    const all = await source.fetchSynapses({
      unit: SYNAPSE_UNITS.links,
      datasetId: 'optic-lobe-mini',
      neuronIds,
      minConfidence: 20,
      onWarn: (message) => warnings.push(message),
    })
    expect(warnings.join(' ')).toMatch(/no per-synapse confidence/)
    expect(all.attributes.length).toBeGreaterThan(0)
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
    const connectome = getConnectome('optic-lobe-mini')!
    const meshes = await source.fetchRoiMeshes({ datasetId: 'optic-lobe-mini' })

    expect(meshes.kind).toBe('meshes')
    expect(meshes.items).toHaveLength(connectome.rois.length)
    expect(meshes.attributes.length).toBe(meshes.items.length)
    // Identity is the region's name, in the item and in the attribute row, in the same order.
    expect(meshes.items.map((m) => m.id)).toEqual(connectome.rois)
    expect(meshes.attributes.data.roi).toEqual(connectome.rois)
  })

  it('builds valid triangle meshes', async () => {
    const meshes = await source.fetchRoiMeshes({ datasetId: 'optic-lobe-mini' })
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
    const meshes = await source.fetchRoiMeshes({ datasetId: 'optic-lobe-mini' })
    const union = boundsOf(meshes.items.map((m) => m.positions))

    const connectome = getConnectome('optic-lobe-mini')!
    const neuronId = connectome.neurons[0]!.neuronId
    const skeleton = generateSkeleton(neuronId, skeletonRois(connectome, neuronId))

    let inside = 0
    const points = skeleton.positions.length / 3
    for (let i = 0; i < points; i++) {
      const x = skeleton.positions[i * 3]!
      const y = skeleton.positions[i * 3 + 1]!
      const z = skeleton.positions[i * 3 + 2]!
      if (
        x >= union.min[0] &&
        x <= union.max[0] &&
        y >= union.min[1] &&
        y <= union.max[1] &&
        z >= union.min[2] &&
        z <= union.max[2]
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

describe('synthetic regions and the synapses in them', () => {
  /** The `i`th vertex of a flat xyz array. */
  const vertex = (positions: Float32Array, i: number): [number, number, number] => [
    positions[i * 3]!,
    positions[i * 3 + 1]!,
    positions[i * 3 + 2]!,
  ]

  /*
   * They were wound inward once, and `Points in Volumes` — which reads "inside" off the facing of
   * the first surface a ray meets — found the centre of every region outside it. Nothing that
   * draws a mesh noticed.
   */
  it('winds every region shell with its normals facing out', () => {
    for (const roi of getConnectome('optic-lobe-mini')!.rois) {
      const mesh = generateRoiMesh(roi)
      expect(signedVolume(mesh.positions, mesh.indices), roi).toBeGreaterThan(0)
    }
  })

  /*
   * The skeleton is regenerated per route and the region order is part of its seed, so a route
   * ordering the regions differently grows a different neuron. The synapse routes did, and a T4a
   * cell's synapses sat on a mirror-image arbor the 3D view never drew.
   */
  it('puts synapses on the skeleton the skeleton route draws', async () => {
    const neuronIds = getConnectome('optic-lobe-mini')!
      .neurons.filter((n) => n.type === 'T4a')
      .slice(0, 3)
      .map((n) => String(n.neuronId))
    const [skeletons, points] = await Promise.all([
      source.fetchSkeletons({ datasetId: 'optic-lobe-mini', neuronIds }),
      source.fetchSynapses({
        datasetId: 'optic-lobe-mini',
        neuronIds,
        unit: SYNAPSE_UNITS.links,
      }),
    ])
    const nodes = skeletons.items.flatMap((s) =>
      Array.from({ length: s.positions.length / 3 }, (_, i) => vertex(s.positions, i)),
    )
    for (let p = 0; p < points.positions.length / 3; p++) {
      const [x, y, z] = vertex(points.positions, p)
      let nearest = Infinity
      for (const [a, b, c] of nodes)
        nearest = Math.min(nearest, Math.hypot(a - x, b - y, c - z))
      // `synapsePosition` jitters a site by up to 45 nm on each axis off its node.
      expect(nearest).toBeLessThan(80)
    }
  })
})
