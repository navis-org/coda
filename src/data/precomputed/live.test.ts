/**
 * The precomputed datasource, against the real buckets. **Skipped unless `PRECOMPUTED_LIVE` is set.**
 *
 * `datasource.test.ts` runs against hand-written `info` documents, which proves the
 * classification and proves nothing about the only question that eventually matters: whether the
 * buckets still publish what those documents were copied from. Every fact asserted here is a
 * *live* one that nobody publishes a contract for — that male-CNS's volume names
 * `multi-res-meshes` rather than the single-resolution directory its viewer state advertises,
 * that hemibrain's names `mesh` and a `segment_properties` sidecar beside it — and the mesh
 * resolution is measured rather than derived, so a bucket reorganising is exactly the change that
 * would otherwise show up as a Meshes node quietly downloading full resolution.
 *
 * Run it:
 *
 *   PRECOMPUTED_LIVE=1 pnpm vitest run src/data/precomputed/live.test.ts
 *
 * Out of the default suite on purpose: it is tens of megabytes of somebody else's bandwidth for
 * facts that change on the timescale of a dataset release. It reads only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseNgSource } from '../neuroglancer/sourceUrl'
import { PrecomputedSource } from './PrecomputedSource'
import { fetchMeshes as fetchMeshSet, openMeshSource } from './index'
import { probePrecomputed } from './probe'
import type { RestoreFetch } from '../../test/precomputedStubs'
import { serveDracoWasmFromDisk } from '../../test/precomputedStubs'

const live = process.env.PRECOMPUTED_LIVE ? describe : describe.skip

const MALECNS = 'precomputed://gs://flyem-male-cns/v1.0/segmentation'
const HEMIBRAIN = 'gs://neuroglancer-janelia-flyem-hemibrain/v1.2/segmentation'

/** One hemibrain body, the same one `precomputed.test.ts` pins its shard maths against. */
const BODY = '1158187240'

let restore: RestoreFetch = () => {}
beforeAll(async () => {
  restore = await serveDracoWasmFromDisk()
})
afterAll(() => restore())

function sourceFor(spec: string): PrecomputedSource {
  const ref = parseNgSource(spec)
  if (!ref) throw new Error(`did not parse: ${spec}`)
  return new PrecomputedSource(ref)
}

live('precomputed datasources, live', () => {
  it('follows male-CNS down to its multi-resolution meshes', async () => {
    // The one that matters: male-CNS's *published viewer state* advertises
    // `meshes-malecns/single-res-meshes`, and its volume declares `mesh: multi-res-meshes`. This
    // node follows the volume, which is the branch docs/backends.md records as the correct one —
    // the other resolves and downloads several megabytes a neuron with nothing failing.
    const probe = await probePrecomputed(parseNgSource(MALECNS)!.url!)
    expect(probe.ok).toBe(true)
    if (!probe.ok) return
    expect(probe.source.volumeType).toBe('segmentation')
    expect(probe.source.meshUrl).toMatch(/multi-res-meshes$/)
    expect(probe.source.mesh?.format).toBe('multilod-draco')
    // Published beside the meshes, and opened by the probe so the first Run costs nothing.
    expect(probe.source.skeletonUrl).toMatch(/skeletons-precomputed$/)
    expect(probe.source.skeletons?.sharding).toBeUndefined()
    expect(probe.source.skeletons?.vertexAttributes).toEqual([])
    expect(probe.source.summary).toBe('segmentation · multi-resolution meshes · skeletons')
  }, 60_000)

  it('finds hemibrain’s meshes and its segment-property sidecar', async () => {
    const probe = await probePrecomputed(parseNgSource(HEMIBRAIN)!.url!)
    expect(probe.ok).toBe(true)
    if (!probe.ok) return
    expect(probe.source.meshUrl).toMatch(/\/mesh$/)
    expect(probe.source.mesh?.format).toBe('multilod-draco')
    // Nothing reads this yet; it is what makes region names and a browsable id list possible.
    expect(probe.source.segmentPropertiesUrl).toMatch(/segment_properties$/)
  }, 60_000)

  it('fetches a real mesh through the source, keyed by text', async () => {
    const source = sourceFor(HEMIBRAIN)
    const meshes = await source.fetchMeshes({
      datasetId: source.datasetId,
      neuronIds: [BODY],
      triangleBudget: 150_000,
    })

    expect(meshes.items).toHaveLength(1)
    const item = meshes.items[0]!
    // Invariant 8, end to end: the id that comes back is the text that went in, in the item's
    // draw key and in the attribute column both.
    expect(item.id).toBe(BODY)
    expect(meshes.attributes.data['neuronId']).toEqual([BODY])
    expect(item.positions.length).toBeGreaterThan(0)
    expect(item.indices.length % 3).toBe(0)
    for (const index of item.indices) expect(index).toBeLessThan(item.positions.length / 3)

    // Nanometres, not voxels: hemibrain body 1158187240 sits well inside the volume's ~250 µm
    // extent, and a mesh read in 8 nm voxels would be an eighth of these numbers.
    expect(meshes.units).toBe('nm')
    expect(meshes.bounds.max[0]! - meshes.bounds.min[0]!).toBeGreaterThan(1_000)
    expect(meshes.bounds.max[0]!).toBeLessThan(1_000_000)

    // A multi-resolution source reports which level it settled on, which is what the viewer
    // caption reads.
    expect(meshes.detail?.levels).toBeGreaterThan(1)
  }, 120_000)

it('reads male-CNS skeletons as trees, in the same nanometres as its meshes', async () => {
    /*
     * Two facts that no fixture can establish. **The coordinates are already nanometres** —
     * around 3.6e5 for a volume ~93,800 voxels of 8 nm across — so a reader that scaled them by
     * the voxel size would put every skeleton 8× away from the mesh of the same neuron, with
     * nothing failing. And **male-CNS declares no vertex attributes at all**, so every radius is
     * 0: a reader that assumed a `radius` attribute would read edge bytes as widths.
     */
    const source = sourceFor(MALECNS)
    const ids = ['100000', '100003']
    const skeletons = await source.fetchSkeletons({ datasetId: source.datasetId, neuronIds: ids })

    expect(skeletons.items.map((s) => s.id)).toEqual(ids)
    expect(skeletons.units).toBe('nm')
    for (const item of skeletons.items) {
      expect(item.positions.length).toBe(item.parents.length * 3)
      expect(item.radii.length).toBe(item.parents.length)
      // A real tree: exactly one root per component, and no path that loops.
      for (let i = 0; i < item.parents.length; i++) {
        expect(item.parents[i]!).toBeLessThan(i)
        let steps = 0
        for (let at = item.parents[i]!; at !== -1; at = item.parents[at]!) {
          if (++steps > item.parents.length) throw new Error(`cycle in ${item.id}`)
        }
      }
    }

    // Nanometres, not voxels: this body spans ~48 µm in x inside a ~750 µm volume.
    const span = skeletons.bounds.max[0]! - skeletons.bounds.min[0]!
    expect(span).toBeGreaterThan(10_000)
    expect(skeletons.bounds.max[0]!).toBeLessThan(2_000_000)

    // The one column a skeleton can answer that a mesh cannot, and it is a real number.
    const cable = skeletons.attributes.data['cableLength'] as number[]
    expect(cable[0]!).toBeGreaterThan(1_000)
  }, 120_000)

  it('agrees with the mesh reader about where a neuron is', async () => {
    /*
     * The check that catches a units mistake in either reader, and the reason it is worth its
     * own case: both sets are internally consistent, so a factor-of-eight error is invisible
     * until the two are drawn together. Same body, both paths, boxes that overlap.
     */
    const source = sourceFor(MALECNS)
    const id = '100000'
    const [skeletons, meshes] = await Promise.all([
      source.fetchSkeletons({ datasetId: source.datasetId, neuronIds: [id] }),
      source.fetchMeshes({ datasetId: source.datasetId, neuronIds: [id], triangleBudget: 150_000 }),
    ])
    if (meshes.items.length === 0) return // No mesh for this body; the skeleton case still ran.

    for (let axis = 0; axis < 3; axis++) {
      expect(skeletons.bounds.min[axis]!).toBeLessThan(meshes.bounds.max[axis]!)
      expect(skeletons.bounds.max[axis]!).toBeGreaterThan(meshes.bounds.min[axis]!)
    }
  }, 120_000)

  it('reads hemibrain’s region shells, which are unsharded multi-resolution', async () => {
    /*
     * The layout `readManifest` used to refuse outright. `v1.2/rois/mesh` publishes `1` and
     * `1.index` side by side rather than shard files — and it is the only way to reach the region
     * shells, so "no source in use is built this way" stopped being true the moment ROI Meshes
     * had to work on a precomputed source.
     */
    const base = 'https://storage.googleapis.com/neuroglancer-janelia-flyem-hemibrain/v1.2/rois/mesh'
    const source = await openMeshSource(base)
    expect(source.format).toBe('multilod-draco')
    expect(source.info?.sharding).toBeUndefined()

    const result = await fetchMeshSet(source, ['1', '2'], { triangleBudget: 150_000 })
    expect(result.meshes.map((m) => m.neuronId)).toEqual(['1', '2'])
    for (const mesh of result.meshes) {
      expect(mesh.positions.length).toBeGreaterThan(0)
      expect(mesh.indices.length % 3).toBe(0)
      for (const index of mesh.indices) expect(index).toBeLessThan(mesh.positions.length / 3)
    }

    // Nanometres: the mesh `info` carries a diagonal-256 transform, and a region shell spans tens
    // of microns inside hemibrain's ~250 µm volume.
    let min = Infinity
    let max = -Infinity
    const first = result.meshes[0]!
    for (let i = 0; i < first.positions.length; i += 3) {
      min = Math.min(min, first.positions[i]!)
      max = Math.max(max, first.positions[i]!)
    }
    expect(max - min).toBeGreaterThan(1_000)
    expect(max).toBeLessThan(1_000_000)
  }, 120_000)

  it('reads hemibrain’s region shells by name, end to end', async () => {
    /*
     * The whole ROI Meshes path against the real bucket: names out of the segment-property
     * sidecar, geometry out of the unsharded mesh directory beside it, joined by the segment ids
     * that pair them. `MeshGeometry.id` carries the *label*, because that is what
     * `ROI_MESH_SCHEMA` says a region is called and what a legend draws.
     */
    const source = sourceFor('gs://neuroglancer-janelia-flyem-hemibrain/v1.2/rois')
    const datasets = await source.listDatasets()
    expect(datasets[0]!.description).toContain('multi-resolution meshes')

    const meshes = await source.fetchRoiMeshes({
      datasetId: source.datasetId,
      rois: ['EB', 'FB'],
    })
    expect(meshes.items.map((m) => m.id)).toEqual(['EB', 'FB'])
    expect(meshes.attributes.data['roi']).toEqual(['EB', 'FB'])
    expect(meshes.units).toBe('nm')
    for (const item of meshes.items) {
      expect(item.indices.length % 3).toBe(0)
      expect(item.positions.length).toBeGreaterThan(0)
    }
    // The central complex sits in the middle of a ~250 µm volume, not at the origin.
    expect(meshes.bounds.min[0]!).toBeGreaterThan(0)
    expect(meshes.bounds.max[0]!).toBeLessThan(1_000_000)
  }, 120_000)

  it('lists hemibrain’s 63 regions, and its 22,706 labelled neurons', async () => {
    // Two sidecars on one bucket, and the difference in scale is the reason the sidecar is not
    // read by the probe: 63 names is nothing and 22,706 is half a megabyte.
    const rois = sourceFor('gs://neuroglancer-janelia-flyem-hemibrain/v1.2/rois')
    const regions = await rois.neuronIndex({ datasetId: rois.datasetId })
    expect(regions.length).toBe(63)
    expect(regions.data['label']).toContain('EB')

    const seg = sourceFor('gs://neuroglancer-janelia-flyem-hemibrain/v1.2/segmentation')
    const index = await seg.neuronIndex({ datasetId: seg.datasetId })
    expect(index.length).toBeGreaterThan(20_000)
    expect(index.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'label'])

    // And the query path over it, anchored like every other backend: `LC.*` is not `LPLC1`.
    const found = await seg.findNeurons({
      datasetId: seg.datasetId,
      rows: [{ field: 'label', op: 'matches', values: ['LC1[0-2]'] }],
    })
    const labels = new Set(found.data['label']!.map(String))
    expect([...labels].sort()).toEqual(['LC10', 'LC11', 'LC12'])
  }, 120_000)

  it('says a volume with no meshes has none, rather than failing to read it', async () => {
    // male-CNS's supervoxel volume: a real `neuroglancer_multiscale_volume` that declares itself
    // a segmentation and names no `mesh` directory. That pair is the case worth pinning — "is a
    // segmentation" and "has geometry" are different questions, and `capabilitiesFor` is what
    // turns the second into a refusal on the Meshes node instead of a run that fetches nothing.
    const spec = 'precomputed://gs://flyem-male-cns/v1.0/supervoxels'
    const probe = await probePrecomputed(parseNgSource(spec)!.url!)
    expect(probe.ok).toBe(true)
    if (!probe.ok) return
    expect(probe.source.kind).toBe('volume')
    expect(probe.source.meshUrl).toBeUndefined()
    expect(probe.source.summary).toBe('segmentation')
    expect(sourceFor(spec).capabilitiesFor()).toEqual({
      meshes: false,
      skeletons: false,
      neuronIndex: false,
      roiMeshes: false,
    })
  }, 60_000)

  it('recognises an annotation source, which carries no geometry to fetch', async () => {
    // male-CNS's synapse layer. Nothing reads these yet; what matters now is that one pasted
    // here is reported as what it is rather than as an unreadable URL.
    const spec = 'precomputed://gs://flyem-male-cns/v1.0/male-cns-v1.0-synapses-precomputed'
    const probe = await probePrecomputed(parseNgSource(spec)!.url!)
    expect(probe.ok).toBe(true)
    if (!probe.ok) return
    expect(probe.source.kind).toBe('annotations')
    expect(probe.source.summary).toBe('annotations')
  }, 60_000)
})
