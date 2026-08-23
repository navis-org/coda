/**
 * CAVE, against the real services. **Skipped unless `CAVE_TOKEN` is set.**
 *
 * `cave.test.ts` runs against recorded fixtures, which proves the plumbing and proves nothing
 * about the only question that eventually matters: whether the endpoints still answer in the
 * shapes those fixtures were cut from. Every one of them is a *live* fact — that `tables` sits
 * on a v2 path inside the v3 API, that `select_columns` must be a list here and a map there,
 * that a quoted eighteen-digit id is accepted by a filter — and none of them is in a contract
 * anyone publishes. This is what notices when one changes.
 *
 * Run it:
 *
 *   CAVE_TOKEN=$(jq -r .token ~/.cloudvolume/secrets/cave-secret.json) \
 *     pnpm vitest run src/data/cave/live.test.ts
 *
 * Out of CI on purpose — it needs a credential and a network, the standing
 * `scripts/check-export.py` has when navis is absent. It reads only; nothing here writes.
 *
 * It also covers the morphology CAVE *does* publish. Skeletons are absent on purpose: the
 * service is a cache that generates on demand and is empty for this datastack — 100 proofread
 * root ids across skeleton versions 0 to 4 all answered `exists: false`, and a queued generation
 * had not landed after five minutes — so a test would either hang or assert that the world has
 * not improved.
 *
 * It is pointed at materialization **783**, which is a stable public release rather than a
 * moving target: the server reports `expires_on: 2121-11-10`. That is most of why FlyWire
 * public is the pilot datastack — a suite pointed at a materialization that expires in weeks
 * has a shelf life measured in weeks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CaveSource } from './CaveSource'
import { resetCredentials, setToken } from './credentials'
import { datastackRecord, l2SourceFor, materializationsFor } from './datastack'
import { caveScene } from './scene'
import { segmentationLayerIndex } from '../neuroglancer/scene'
import { registerDatastackSpec } from './spec'
import { ID_COLUMN_NAME } from '../../core/ids'

const TOKEN = process.env.CAVE_TOKEN
const DATASET = 'flywire_fafb_public:783'
/** One real proofread neuron, used as the seed for every connectivity check below. */
const SEED = '720575940628857210'

/**
 * The Draco decoder's wasm, off disk.
 *
 * `draco.ts` imports it with `?url`, which resolves to a path only a browser can fetch — so
 * under Node the mesh path dies before it decodes anything. `precomputed.test.ts` replaces
 * `fetch` outright for the same reason; here it has to pass everything else through, because
 * the point of this file is that the requests are real.
 */
async function serveDracoWasmFromDisk(): Promise<void> {
  const real = globalThis.fetch
  const { readFile } = await import('node:fs/promises')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('draco_decoder.wasm')) {
      const bytes = await readFile(require.resolve('draco3d/draco_decoder.wasm'))
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as Response
    }
    return real(input, init)
  }) as typeof fetch
}

const live = TOKEN ? describe : describe.skip

beforeAll(async () => {
  setToken(TOKEN)
  await serveDracoWasmFromDisk()
})
afterAll(() => resetCredentials())

live('CAVE, live', () => {
  const source = new CaveSource()

  it('lists FlyWire public with its materializations', async () => {
    const datasets = await source.listDatasets()
    expect(datasets.map((d) => d.id)).toContain(DATASET)
    // Newest first, and the version half is a materialization number the existing dropdown
    // orders correctly because `compareVersions` reads bare integers numerically.
    expect(Number(datasets[0]!.version)).toBeGreaterThanOrEqual(783)
  }, 60_000)

  it('discovers the annotation kinds without reading the annotations', async () => {
    const names = source.schemasFor(DATASET).neurons.columns.map((c) => c.name)
    // Synchronous, so the first answer is the placeholder — invariant 2.
    expect(names).toEqual(['neuronId'])

    await new Promise((r) => setTimeout(r, 4000))
    expect(source.schemasFor(DATASET).neurons.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'type',
      'cell_class',
      'cell_sub_class',
      'flow',
      'super_class',
    ])
  }, 60_000)

  it('reads a wide root id exactly, all the way to a Coda table', async () => {
    const table = await source.findNeurons({ datasetId: DATASET, neuronIds: [SEED], limit: 5 })
    expect(table.data.neuronId).toEqual([SEED])
    // The whole point of invariant 8 reaching CAVE: text in, text out, no double in between.
    expect(table.schema.columns[0]!.dtype).toBe('str')
  }, 300_000)

  it('finds neurons by an anchored pattern, locally', async () => {
    const table = await source.findNeurons({ datasetId: DATASET, typePattern: 'DNp01' })
    expect(table.length).toBeGreaterThan(0)
    expect(new Set(table.data.type)).toEqual(new Set(['DNp01']))
  }, 300_000)

  it('answers connectivity from the roll-up view, weight cut applied server-side', async () => {
    const all = await source.fetchConnectivity({
      datasetId: DATASET,
      neuronIds: [SEED],
      direction: 'outputs',
    })
    const strong = await source.fetchConnectivity({
      datasetId: DATASET,
      neuronIds: [SEED],
      direction: 'outputs',
      minWeight: 5,
    })
    expect(all.length).toBeGreaterThan(strong.length)
    expect(Math.min(...strong.data.weight!.map(Number))).toBeGreaterThanOrEqual(5)
    // Query-relative: `neuronId` is the neuron asked about, whichever way the synapse points.
    expect(new Set(strong.data.neuronId)).toEqual(new Set([SEED]))
  }, 300_000)

  /*
   * The two halves of morphology that work, and the check that ties them together.
   *
   * A mesh and a synapse cloud for one neuron have to sit in the same space, and neither is
   * scaled by anything here — the fragments decode to world nanometres and the synapse query
   * asks for `desired_resolution: [1, 1, 1]`. If either assumption were wrong the two boxes
   * would be a whole factor apart, and nothing else would fail: each is internally consistent.
   */
  it('reads a synapse cloud and a mesh into the same nanometre frame', async () => {
    const points = await source.fetchSynapses({
      datasetId: DATASET,
      neuronIds: [SEED],
      polarity: 'pre',
    })
    expect(points.units).toBe('nm')
    expect(points.attributes.length).toBeGreaterThan(1000)

    const meshes = await source.fetchMeshes({ datasetId: DATASET, neuronIds: [SEED] })
    expect(meshes.units).toBe('nm')
    expect(meshes.items).toHaveLength(1)
    expect(meshes.items[0]!.id).toBe(SEED)

    // The mesh encloses the presynaptic cloud, within a micron of slack for the decimation.
    const slack = 1000
    for (let axis = 0; axis < 3; axis++) {
      expect(meshes.bounds.min[axis]!).toBeLessThanOrEqual(points.bounds.min[axis]! + slack)
      expect(meshes.bounds.max[axis]!).toBeGreaterThanOrEqual(points.bounds.max[axis]! - slack)
    }
  }, 600_000)

  /*
   * The budget is honoured rather than a fixed grid applied, which is the whole reason
   * `decimateGridFor` exists: graphene publishes one level of detail, so the only way the Meshes
   * node's `Detail` control can mean anything here is by deciding how hard the fetched mesh is
   * simplified. One neuron is 1,276,736 triangles before decimation.
   */
  it('decimates an arriving mesh to the triangle budget it was given', async () => {
    const low = await source.fetchMeshes({
      datasetId: DATASET,
      neuronIds: [SEED],
      triangleBudget: 150_000,
    })
    const triangles = low.items[0]!.indices.length / 3
    expect(triangles).toBeLessThanOrEqual(150_000)
    // Not so aggressive that the arbor goes — `MIN_DECIMATE_GRID` is the floor under it.
    expect(triangles).toBeGreaterThan(5_000)

    // And it says so: a source with no levels reports that it simplified, not "level 0 of 0".
    expect(low.detail?.decimated).toBe(true)
    expect(low.detail?.triangles).toBe(triangles)
  }, 600_000)

  it('builds an adjacency matrix over real root ids', async () => {
    const partners = await source.fetchConnectivity({
      datasetId: DATASET,
      neuronIds: [SEED],
      direction: 'outputs',
      minWeight: 50,
    })
    const targets = [...new Set(partners.data.partnerId!.map(String))].slice(0, 5)
    const matrix = await source.fetchAdjacency({
      datasetId: DATASET,
      sourceIds: [SEED],
      targetIds: targets,
    })
    expect(matrix.rowLabels).toEqual([SEED])
    expect(matrix.colLabels).toEqual(targets)
    expect([...matrix.values].every((v) => v >= 50)).toBe(true)
  }, 300_000)
})

/**
 * Aedes: a datastack with **no** connection roll-up and no configured synapse table.
 *
 * The case most CAVE datastacks are in, and the whole reason the fallback exists. Nothing about
 * it is configured here — `wclee_aedes_brain` declares `synapse_table: "synapses"` in its own
 * info record, and its columns are the standard `synapse` schema's, so the spec names only the
 * neuron table.
 */
describe.skipIf(!TOKEN)('CAVE, live — connectivity by aggregation', () => {
  it('builds an edge list from raw synapses on a datastack with no view', async () => {
    setToken(TOKEN!)
    registerDatastackSpec({
      datastack: 'wclee_aedes_brain',
      label: 'Aedes',
      description: 'live',
      neurons: { table: 'nuclei_v1_aedes', idColumn: 'pt_root_id' },
    })
    const cave = new CaveSource()
    const versions = await materializationsFor('wclee_aedes_brain')
    const dataset = `wclee_aedes_brain:${versions[0]}`

    // A real root id off the nuclei table rather than a literal: root ids change with edits, so
    // a hardcoded one is a test that rots into a false negative.
    const neurons = await cave.findNeurons({ datasetId: dataset, limit: 1 })
    const seed = String(neurons.data[ID_COLUMN_NAME]?.[0])
    expect(seed).toMatch(/^\d+$/)

    const edges = await cave.fetchConnectivity({
      datasetId: dataset,
      neuronIds: [seed],
      direction: 'outputs',
    })
    expect(edges.length).toBeGreaterThan(0)

    // Counted, not read: every weight is a positive integer and the seed is on every row.
    const weights = edges.data.weight as number[]
    expect(weights.every((w) => Number.isInteger(w) && w > 0)).toBe(true)
    expect(new Set(edges.data[ID_COLUMN_NAME] as string[])).toEqual(new Set([seed]))

    // The cut is applied after counting, so a higher threshold is a strict subset.
    const strong = await cave.fetchConnectivity({
      datasetId: dataset,
      neuronIds: [seed],
      direction: 'outputs',
      minWeight: 3,
    })
    expect(strong.length).toBeLessThan(edges.length)
    expect((strong.data.weight as number[]).every((w) => w >= 3)).toBe(true)
  }, 120_000)
})

/**
 * The scene, against every datastack Coda might build one for.
 *
 * The two source transformations were derived from `caveclient` and checked by running it, but
 * on values fetched at one moment — this is what notices the info record changing shape.
 */
describe.skipIf(!TOKEN)('CAVE, live — a built neuroglancer scene', () => {
  it('assembles a loadable scene from each datastack’s own record', async () => {
    setToken(TOKEN!)
    for (const datastack of [
      'wclee_aedes_brain',
      'flywire_fafb_public',
      'brain_and_nerve_cord_public',
    ]) {
      const info = await datastackRecord(datastack)
      const scene = caveScene(datastack, info)
      if (!scene) throw new Error(`${datastack} built no scene`)

      const layers = scene.layers as Array<Record<string, unknown>>
      const segmentation = layers.find((l) => l.type === 'segmentation')
      const image = layers.find((l) => l.type === 'image')

      // Both layers present, and the segmentation authenticated — without the prefix it renders
      // empty, which is the failure this whole thing exists to avoid.
      expect(String(segmentation?.source)).toMatch(/^graphene:\/\/middleauth\+https:\/\//)
      expect(String(image?.source)).toMatch(/^precomputed:\/\//)

      // The neuron ids have somewhere to land.
      expect(segmentationLayerIndex(scene, `${datastack}:1`)).toBeGreaterThanOrEqual(0)

      // Metres, and small: a nanometre voxel is 1e-9..1e-7 m, so a factor slip is visible here.
      const dims = scene.dimensions as Record<string, [number, string]>
      for (const axis of ['x', 'y', 'z']) {
        expect(dims[axis]?.[1]).toBe('m')
        expect(dims[axis]?.[0]).toBeGreaterThan(1e-9)
        expect(dims[axis]?.[0]).toBeLessThan(1e-6)
      }

      // And a viewer that can authenticate it.
      expect(info.viewer_site).toMatch(/^https:\/\//)
    }
  }, 60_000)
})

/**
 * Skeletons from the level-2 cache, and the per-datastack gate in front of them.
 *
 * The gate is the point: six of the thirteen datastacks the info service lists have a cache, so
 * a flat answer is wrong for somebody whichever way it is set. These three are one of each kind
 * — a cache and a skeleton service, a cache and no service, and a service with no cache.
 */
describe.skipIf(!TOKEN)('CAVE, live — L2 skeletons', () => {
  it('knows which datastacks can answer, and builds a real tree for one that can', async () => {
    setToken(TOKEN!)
    expect(await l2SourceFor('brain_and_nerve_cord_public')).toBeTruthy()
    // A populated cache and no skeleton service at all — the datastack the service route misses.
    expect(await l2SourceFor('wclee_aedes_brain')).toBeTruthy()
    // Declares a skeleton service and has no cache, which is why that service is empty: it
    // generates from this. The one Coda ships a node for, and it genuinely cannot answer.
    expect(await l2SourceFor('flywire_fafb_public')).toBeUndefined()

    registerDatastackSpec({
      datastack: 'brain_and_nerve_cord_public',
      label: 'BANC',
      description: 'live',
      neurons: { table: 'cell_info', idColumn: 'pt_root_id' },
    })
    const cave = new CaveSource()
    const version = (await materializationsFor('brain_and_nerve_cord_public'))[0]
    const dataset = `brain_and_nerve_cord_public:${version}`
    const ids = (
      (await cave.findNeurons({ datasetId: dataset, limit: 6 })).data[
        ID_COLUMN_NAME
      ] as string[]
    ).slice(0, 5)

    const skeletons = await cave.fetchSkeletons!({ datasetId: dataset, neuronIds: ids })
    expect(skeletons.items.length).toBeGreaterThan(0)
    // Nanometres by publication, not by conversion — `rep_coord_nm` is already nm.
    expect(skeletons.units).toBe('nm')

    for (const item of skeletons.items) {
      expect(item.positions.length).toBe(item.parents.length * 3)
      expect(item.radii.length).toBe(item.parents.length)
      // A forest: every parent is a real index, and following them always terminates.
      for (let i = 0; i < item.parents.length; i++) {
        let steps = 0
        for (let at = item.parents[i]!; at !== -1; at = item.parents[at]!) {
          expect(at).toBeLessThan(item.parents.length)
          if (++steps > item.parents.length) throw new Error(`cycle in ${item.id}`)
        }
      }
    }
    // At least one is a neuron rather than a fragment. Measured: 739, 69 and 2 nodes on the
    // first three, so a lower bound of ten is well clear of the noise.
    expect(Math.max(...skeletons.items.map((i) => i.parents.length))).toBeGreaterThan(10)
  }, 180_000)
})
