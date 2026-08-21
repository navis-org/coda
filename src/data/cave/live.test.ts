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
