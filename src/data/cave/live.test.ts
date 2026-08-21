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

const live = TOKEN ? describe : describe.skip

beforeAll(() => setToken(TOKEN))
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
