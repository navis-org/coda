/**
 * `CatmaidSource` against Virtual Fly Brain's public FAFB. **Skipped unless `CATMAID_LIVE=1`.**
 *
 *   CATMAID_LIVE=1 pnpm vitest run src/data/catmaid/live.test.ts
 *   CATMAID_LIVE=1 CATMAID_TOKEN=… pnpm vitest run src/data/catmaid/live.test.ts
 *
 * The fixture suite beside this one proves the decoding; this is the only thing that notices an
 * endpoint shape changing, and it is out of CI for the reason the CAVE and FlyTable live tests
 * are — it is somebody's public server and the suite runs on every commit.
 *
 * **The token is what splits it in two, and the split is the finding rather than a limitation.**
 * Every `GET` this backend makes is answered anonymously — projects, skeletons, connector links,
 * neuropil volumes — so the morphology half runs with no credential at all. The label half does
 * not: `skeleton/annotationlist` is POST-only, and in a browser that needs a token or the dev
 * relay. Node has no such restriction, but the *client* is browser code and does not do the CSRF
 * handshake, so without a token these tests exercise exactly what a published build could reach.
 * See `docs/catmaid_vfb.md`.
 */

import { describe, expect, it } from 'vitest'

import { CatmaidSource } from './CatmaidSource'
import { DEFAULT_CATMAID_SERVER, setInstances } from './credentials'
import { cableLength } from '../../core/values'

const LIVE = process.env.CATMAID_LIVE === '1'
const TOKEN = process.env.CATMAID_TOKEN
const FAFB = '1'

const live = LIVE ? describe : describe.skip
const withToken = LIVE && TOKEN ? it : it.skip

function source(): CatmaidSource {
  if (TOKEN) setInstances([{ server: DEFAULT_CATMAID_SERVER, token: TOKEN }])
  return new CatmaidSource(DEFAULT_CATMAID_SERVER, 'catmaid-live', 'CATMAID (live)')
}

live('CATMAID against the real FAFB instance', () => {
  it('lists projects anonymously', async () => {
    const datasets = await source().listDatasets()
    expect(datasets.length).toBeGreaterThan(0)
    const fafb = datasets.find((dataset) => dataset.id === FAFB)
    expect(fafb?.label).toBeTruthy()
    // No statuses, and the absence is the point: a source publishing an empty list must also
    // ignore the parameter, or a node's stored `Traced` default drops every row.
    expect(fafb?.statuses).toEqual([])
  })

  it('answers a thumbnail with a real skeleton, at the size that costs', async () => {
    /*
     * The most expensive thumbnail in the tree, and the numbers are why there is no byte ceiling
     * on it. Measured here: skeleton 16 is **940 kB in 0.70 s** and skeleton 2333007 is **4.2 MB
     * in 0.95 s**, uncompressed, because this deployment does not gzip. A `THUMBNAIL_MAX_BYTES`
     * cut pitched anywhere useful would blank exactly the densely traced neurons anyone is
     * looking for — the failure that constant's own docstring records from its 128 kB days.
     *
     * What makes it affordable is that `NeuronThumbnail` stores the 23 kB mask in IndexedDB, so
     * this is paid once per neuron ever rather than once per page turn.
     */
    const coarse = await source().fetchCoarseGeometry!({ datasetId: FAFB, neuronId: '16' })
    if (coarse?.kind !== 'skeleton') throw new Error(`expected a skeleton, got ${coarse?.kind}`)
    expect(coarse.parents.length).toBeGreaterThan(10_000)
    expect(coarse.positions.length).toBe(coarse.parents.length * 3)
    // Drawable: at least one edge with real extent, which is what `cableLength` measures. The
    // spread-and-max form this replaced put 16,840 arguments through `Math.max`.
    expect(cableLength(coarse)).toBeGreaterThan(0)
  }, 120_000)

  it('fetches a skeleton in nanometres, as a tree', async () => {
    const skeletons = await source().fetchSkeletons({ datasetId: FAFB, neuronIds: ['16'] })
    expect(skeletons.units).toBe('nm')
    expect(skeletons.items).toHaveLength(1)
    const item = skeletons.items[0]!
    expect(item.id).toBe('16')
    expect(item.positions.length / 3).toBeGreaterThan(10_000)

    // Exactly one root, and every other parent a real index — the id→index rebuild is the part
    // that would silently produce a forest of orphans if it were wrong.
    const roots = [...item.parents].filter((parent) => parent === -1)
    expect(roots).toHaveLength(1)
    for (const parent of item.parents) {
      expect(parent).toBeGreaterThanOrEqual(-1)
      expect(parent).toBeLessThan(item.positions.length / 3)
    }

    // Inside the FAFB stack: 253952 × 4 nm by 155648 × 4 nm by 7063 × 40 nm. A skeleton read as
    // voxels would be a factor of four to forty short of this and nothing else would fail.
    expect(skeletons.bounds.max[0]).toBeLessThan(253_952 * 4)
    expect(skeletons.bounds.max[0]).toBeGreaterThan(100_000)
  })

  it('fetches synapses that sit inside their own skeleton, in one frame', async () => {
    const client = source()
    const [skeletons, synapses] = await Promise.all([
      client.fetchSkeletons({ datasetId: FAFB, neuronIds: ['16'] }),
      client.fetchSynapses({ datasetId: FAFB, neuronIds: ['16'], polarity: 'pre' }),
    ])
    expect(synapses.units).toBe('nm')
    expect(synapses.attributes.length).toBeGreaterThan(100)
    // The cross-check that catches a scaling mistake in either: neither is scaled by anything
    // here, so if one were wrong the two boxes would be a whole factor apart while each stayed
    // internally consistent. Same rule as CAVE's mesh-encloses-synapses assertion.
    for (const axis of [0, 1, 2]) {
      expect(synapses.bounds.min[axis]).toBeGreaterThanOrEqual(skeletons.bounds.min[axis]! - 1)
      expect(synapses.bounds.max[axis]).toBeLessThanOrEqual(skeletons.bounds.max[axis]! + 1)
    }
    const polarity = synapses.attributes.data.polarity ?? []
    expect(new Set(polarity)).toEqual(new Set(['pre']))
  })

  it('reads the neuropil volumes as meshes', async () => {
    const meshes = await source().fetchRoiMeshes({
      datasetId: FAFB,
      rois: ['LAL_L', 'MB_PED_R'],
    })
    expect(meshes.units).toBe('nm')
    expect(meshes.items.map((item) => item.id).sort()).toEqual(['LAL_L', 'MB_PED_R'])
    for (const item of meshes.items) {
      expect(item.indices.length % 3).toBe(0)
      expect(item.positions.length % 3).toBe(0)
      // Every index inside the vertex list. An out-of-range one draws as a spike across the
      // scene rather than as an error.
      expect(Math.max(...item.indices)).toBeLessThan(item.positions.length / 3)
    }
    // Flat list, no hierarchy, so every region is summable — unlike neuPrint's nesting ROIs.
    expect(new Set(meshes.attributes.data.primary)).toEqual(new Set([true]))
  })

  withToken('builds the whole-instance neuron index, with derived types', async () => {
    const index = await source().neuronIndex({ datasetId: FAFB })
    expect(index.length).toBeGreaterThan(5000)

    const types = index.data.type ?? []
    const named = types.filter((value) => typeof value === 'string' && value.length > 0)
    // Measured at 100% on this instance: every skeleton carries a `neuron name` annotation.
    expect(named.length / index.length).toBeGreaterThan(0.95)
    expect(new Set(named).size).toBeGreaterThan(500)

    // The instance keeps what the type dropped, which is what makes the `#` split lossless.
    const instances = index.data.instance ?? []
    const hashed = instances.findIndex(
      (value) => typeof value === 'string' && value.includes('#'),
    )
    expect(hashed).toBeGreaterThanOrEqual(0)
    expect(String(instances[hashed])).toContain(String(types[hashed]))
  })

  withToken('answers connectivity with summed confidence buckets', async () => {
    const table = await source().fetchConnectivity({
      datasetId: FAFB,
      neuronIds: ['16'],
      direction: 'outputs',
      minWeight: 5,
    })
    expect(table.length).toBeGreaterThan(10)
    for (const weight of table.data.weight ?? [])
      expect(Number(weight)).toBeGreaterThanOrEqual(5)
    // Query-relative, like neuPrint's: the queried neuron is always `neuronId`.
    expect(new Set(table.data.neuronId)).toEqual(new Set([16]))
  })
})
