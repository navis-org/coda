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
 * It also covers the morphology CAVE publishes, all three routes of it. The skeleton *service*
 * is exercised against two datastacks on purpose: it is a cache that generates on demand, and
 * FlyWire's is empty where MICrONS' is full, so the interesting assertion is the one about the
 * fallback rather than the one about the download.
 *
 * It is pointed at materialization **783**, which is a stable public release rather than a
 * moving target: the server reports `expires_on: 2121-11-10`. That is most of why FlyWire
 * public is the pilot datastack — a suite pointed at a materialization that expires in weeks
 * has a shelf life measured in weeks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CaveSource } from './CaveSource'
import { resetCredentials, setToken } from './credentials'
import { caveServerFor, datastackRecord, l2SourceFor, materializationsFor } from './datastack'
import { CAVE_MAX_ROWS, refuseIfCapped } from './client'
import { countTable, queryTable, queryTableChecked, tableMetadata } from './api'
import { resetCaveTables, tableColumnsFor, tableFactsFor, tableListFor } from './tables'
import { caveScene } from './scene'
import { flatUrlFor, probeFlat } from './flat'
import { discoverLoginService } from './oauth'
import { existingSkeletons, serviceLooksEmpty, skeletonServiceFor } from './skeletonService'
import { segmentationLayerIndex } from '../neuroglancer/scene'
import { registerDatastackSpec, specFor } from './spec'
import { ID_COLUMN_NAME } from '../../core/ids'
import { cableLength } from '../../core/values'
import type { RestoreFetch } from '../../test/precomputedStubs'
import { serveDracoWasmFromDisk } from '../../test/precomputedStubs'

const TOKEN = process.env.CAVE_TOKEN
const DATASET = 'flywire_fafb_public:783'
/** One real proofread neuron, used as the seed for every connectivity check below. */
const SEED = '720575940628857210'

const live = TOKEN ? describe : describe.skip

let restoreFetch: RestoreFetch = () => {}
beforeAll(async () => {
  setToken(TOKEN)
  restoreFetch = await serveDracoWasmFromDisk()
})
afterAll(() => {
  restoreFetch()
  resetCredentials()
})

live('CAVE, live', () => {
  const source = new CaveSource()

  /*
   * The sign-in's one live dependency, and it fails silently: `auth_info` is what says where a
   * deployment logs in, so if `login_url` moved or the document went away the button would open
   * a window at a 404 and nothing else would notice. **No token is needed to ask** — the
   * property that makes signing in possible at all — which makes this the cheapest check in the
   * file and the only one guarding a path no unit test can reach.
   */
  it('says where it signs in, without being asked for a token', async () => {
    const service = await discoverLoginService('https://global.daf-apis.com')

    // Not the prefix: today's deployment serves middle_auth under `/sticky_auth` and the point
    // of reading `auth_info` is that the next one need not. What must hold is that a login
    // service was named, on the same origin, at middle_auth's endpoint.
    expect(service.origin).toBe('https://global.daf-apis.com')
    expect(service.authorizeUrl.startsWith(`${service.origin}/`)).toBe(true)
    expect(service.authorizeUrl.endsWith('/api/v1/authorize')).toBe(true)

    // And that Google is what is behind it, which is what the panel's copy promises.
    const response = await fetch(service.authorizeUrl, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toMatch(/accounts\.google\.com/)
  })

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
    const table = await source.findNeurons({
      datasetId: DATASET,
      rows: [{ field: 'type', op: 'matches', values: ['DNp01'] }],
    })
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
   * The Detail control on the flat route, which is a published pyramid rather than a knob: a
   * lower budget picks a coarser *level*, and nothing is simplified. The two properties that
   * matter are that the level actually moves, and that `detail` says which of the two happened —
   * a levelled source reporting `decimated: true` would tell a reader 98% of its triangles had
   * been merged away when none had.
   */
  it('drops to a coarser published level for a lower budget, rather than decimating', async () => {
    const [low, high] = await Promise.all([
      source.fetchMeshes({ datasetId: DATASET, neuronIds: [SEED], triangleBudget: 150_000 }),
      source.fetchMeshes({ datasetId: DATASET, neuronIds: [SEED], triangleBudget: 20_000_000 }),
    ])
    expect(low.detail?.decimated).toBeUndefined()
    expect(low.detail?.levels).toBeGreaterThan(1)
    expect(low.detail!.lod).toBeGreaterThan(high.detail!.lod!)
    expect(low.items[0]!.indices.length).toBeLessThan(high.items[0]!.indices.length)

    /*
     * And the budget is *overshot*, which is not a failure and has to be said: LOD 3 is the
     * coarsest this neuron has and it is 389,116 triangles. There is no finer knob than
     * "coarsest" on a published pyramid — see `chooseLod` — which is exactly the property the
     * graphene route below does not share.
     */
    expect(low.items[0]!.indices.length / 3).toBeGreaterThan(150_000)
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

      /*
       * Both layers present, and the segmentation published **as-is** — no `middleauth+`.
       *
       * This asserted the prefix until the day `caveScene` stopped adding it, and asserted it
       * for a while afterwards, because a live test is only run by somebody who chose to. The
       * prefix is spelunker's and is added by `sceneUrl`/`scenePatchUrl`, which are the only
       * places a scene meets the viewer it is about to open in — a seunglab-flavoured
       * deployment refuses it, and `flywire_fafb_public` publishes exactly such a viewer.
       */
      expect(String(segmentation?.source)).toMatch(/^graphene:\/\/https:\/\//)
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

/**
 * The skeleton service, and the gap between declaring one and having one.
 *
 * All three specced datastacks declare `skeleton_source`; one of them can answer. That is not a
 * flake to be worked around but the model — a generated skeleton exists because somebody asked
 * for it — and it is why `existingSkeletons` is asked before anything is downloaded: a GET for an
 * id the cache has never seen routes to a *generation*, measured at 10–45 s per neuron against
 * ~1.5 s for a cached one.
 *
 * The earlier version of this file said skeletons were "absent on purpose" here. They are not
 * absent any more; what changed is that the question became answerable before the wait.
 */
describe.skipIf(!TOKEN)('CAVE, live — the skeleton service', () => {
  it('is declared by FlyWire and holds nothing, which is what the fallback is for', async () => {
    setToken(TOKEN!)
    const service = await skeletonServiceFor('flywire_fafb_public')
    expect(service).toBeTruthy()
    // The highest version the deployment lists. `-1` means "latest" and is deliberately not
    // picked: a cache key on a number whose meaning moves is not a key.
    expect(service!.version).toBeGreaterThanOrEqual(0)

    const ids = (
      (await new CaveSource().findNeurons({ datasetId: 'flywire_fafb_public:783', limit: 5 }))
        .data[ID_COLUMN_NAME] as string[]
    ).slice(0, 5)
    expect(await existingSkeletons(service!, ids)).toEqual(new Set())
    // And having asked, `automatic` stops asking for the rest of the session.
    expect(serviceLooksEmpty('flywire_fafb_public')).toBe(true)
  }, 120_000)

  it('answers for minnie65, with radii and a real reconstruction', async () => {
    /*
     * MICrONS is the datastack that makes this route worth having. Measured on root id
     * 864691134884807418: 7,167 vertices, 186 kB, 1.45 s — against a few hundred nodes down the
     * level-2 route, which minnie65 also has. That is why the service leads the preference list
     * where both exist.
     */
    setToken(TOKEN!)
    const service = await skeletonServiceFor('minnie65_public')
    expect(service).toBeTruthy()

    registerDatastackSpec({
      datastack: 'minnie65_public',
      label: 'MICrONS',
      description: 'live',
      neurons: { table: 'proofreading_status_and_strategy', idColumn: 'pt_root_id' },
    })
    const cave = new CaveSource()
    const version = (await materializationsFor('minnie65_public'))[0]
    const dataset = `minnie65_public:${version}`
    const ids = (
      (await cave.findNeurons({ datasetId: dataset, limit: 3 })).data[ID_COLUMN_NAME] as string[]
    ).slice(0, 2)

    // Every one of them, which is what `automatic` requires before it takes this route: a scene
    // mixing a reconstruction with a chunk decomposition is one where cable length means two
    // things.
    expect((await existingSkeletons(service!, ids)).size).toBe(ids.length)

    const skeletons = await cave.fetchSkeletons!({ datasetId: dataset, neuronIds: ids })
    expect(skeletons.provenance?.id).toBe('service')
    expect(skeletons.items).toHaveLength(ids.length)
    expect(skeletons.units).toBe('nm')
    for (const item of skeletons.items) {
      // A real reconstruction rather than a chunk graph: thousands of nodes, and radii on them.
      expect(item.parents.length).toBeGreaterThan(1000)
      expect(item.radii.some((r) => r > 0)).toBe(true)
      expect(item.positions.length).toBe(item.parents.length * 3)
    }
    /*
     * And the route list agrees with what the fetch did, which is what the dropdown shows.
     * The L2 peek is awaited first on purpose: the fetch above never asked it — it took the
     * service and stopped — so a list read straight after would be missing an entry that is
     * genuinely there. That is `capabilitiesFor`'s contract showing through, and it is why the
     * dropdown grows rather than appearing complete.
     */
    expect(await l2SourceFor('minnie65_public')).toBeTruthy()
    expect(cave.skeletonSourcesFor!(dataset)?.map((r) => r.id)).toEqual(['service', 'l2'])
  }, 300_000)
})

/**
 * Discovery, against the real services.
 *
 * Every fact in `tables.ts` is a live one that nobody publishes a contract for — that the tables
 * listing sits on a v2 path inside the v3 API and answers different *names* than the v2 metadata
 * endpoint does, that a view has neither a metadata endpoint nor a count, and that the annotation
 * service and the materialization engine each keep their own row count and the two disagree. The
 * fixture suite proves the plumbing and can see none of that.
 *
 * The one thing deliberately **not** exercised here is a column sample of an aggregating view.
 * `valid_connection_v2` and `nt_summary_view` both failed to answer a one-row query in 45
 * seconds, which is the finding rather than a flake — a test asserting it would either hang or
 * assert that the world has not improved. `proofread_neurons_view` is the plain view that
 * answered in 0.77 s, and it is what stands in.
 */
describe.skipIf(!TOKEN)('CAVE, live — discovery', () => {
  const DATASTACK = 'flywire_fafb_public'
  const VERSION = 783

  it('lists both kinds of object, and the view Connectivity prefers is only in one', async () => {
    resetCaveTables()
    const entries = await tableListFor(DATASTACK, VERSION)
    const names = (kind: string) => entries.filter((e) => e.kind === kind).map((e) => e.name)

    expect(names('table')).toContain('proofread_neurons')
    expect(names('table')).toContain('hierarchical_neuron_annotations')
    /*
     * The reason `includeViews` defaults on. `valid_connection_v2` is the pre-aggregated edge
     * list the whole CAVE connectivity path is built around, and it appears in no table listing —
     * so a node faithful to `get_tables` alone would omit the most useful object in the datastack.
     */
    expect(names('view')).toContain('valid_connection_v2')
    expect(names('table')).not.toContain('valid_connection_v2')
    // Tables first, each half sorted, so the same Run twice is the same table twice — the
    // server returns tables in query-planner order and views as an object, so neither is a
    // promise and neither may be relied on.
    expect(entries.map((e) => e.kind)).toEqual([
      ...names('table').map(() => 'table'),
      ...names('view').map(() => 'view'),
    ])
    expect(names('table')).toEqual([...names('table')].sort())
    expect(names('view')).toEqual([...names('view')].sort())
  }, 60_000)

  /**
   * The count that `docs/backends.md` recorded as pointing the wrong way, with the reason.
   *
   * Both are real and they measure different things: the annotation service counts the table as
   * it stands, the materialization engine counts what this snapshot froze. Asserted as an
   * inequality rather than as two numbers, so a re-materialization does not fail the suite —
   * what is being pinned is that they are *two* answers, which is the thing a card showing one
   * of them silently gets wrong.
   */
  it('reports two row counts for one table, and they are not the same number', async () => {
    resetCaveTables()
    const facts = await tableFactsFor(DATASTACK, VERSION, 'proofread_neurons')
    expect(facts.kind).toBe('table')
    expect(facts.rows).toBeGreaterThan(0)
    expect(facts.materializedRows).toBeGreaterThan(0)
    expect(facts.rows).not.toBe(facts.materializedRows)
  }, 60_000)

  /*
   * The v3 metadata endpoint answers the name a query takes; the v2 one answers the materialized
   * name (`nuclei_v1__fly_v31`). A card built from the v2 spelling shows somebody a name they
   * cannot type back in, which is why `tableMetadata` is the one v3 call beside a v2 listing.
   */
  it('describes a table under the name the listing gave it, not the materialized one', async () => {
    resetCaveTables()
    const facts = await tableFactsFor(DATASTACK, VERSION, 'nuclei_v1')
    expect(facts.name).toBe('nuclei_v1')
    expect(facts.schemaType).toBe('nucleus_detection')
    expect(facts.description).toMatch(/nucleus/i)
  }, 60_000)

  it('describes a view from the listing, since it has neither a metadata record nor a count', async () => {
    resetCaveTables()
    const facts = await tableFactsFor(DATASTACK, VERSION, 'valid_connection_v2')
    expect(facts.kind).toBe('view')
    expect(facts.description).toMatch(/synaptic connections/i)
    expect(facts.rows).toBeUndefined()
    expect(facts.materializedRows).toBeUndefined()
  }, 60_000)

  /**
   * The column sample, and the half of it that cannot be got any other way.
   *
   * A table's registered schema describes a row *before* materialization — `pt` as a bound
   * spatial point — where a query answers with `pt_position_x/y/z`, `pt_supervoxel_id` and
   * `pt_root_id`. And `pt_root_id` is eighteen digits, so this is also invariant 8 end to end:
   * the digits reaching the listing are the digits on the wire.
   */
  it('reads the materialized column set off one row, with a wide id exact and as text', async () => {
    resetCaveTables()
    const columns = await tableColumnsFor(DATASTACK, VERSION, 'nuclei_v1', 'table')
    const by = new Map(columns.map((c) => [c.name, c]))

    expect([...by.keys()]).toEqual(
      expect.arrayContaining(['pt_position_x', 'pt_position_y', 'pt_position_z', 'pt_root_id']),
    )
    // Not the pre-materialization shape.
    expect(by.has('pt')).toBe(false)
    const root = by.get('pt_root_id')
    expect(root?.dtype).toBe('str')
    expect(root?.example).toMatch(/^\d{18}$/)
  }, 60_000)

  it('samples a plain view in the time an aggregating one will not', async () => {
    resetCaveTables()
    const columns = await tableColumnsFor(DATASTACK, VERSION, 'proofread_neurons_view', 'view')
    expect(columns.map((c) => c.name)).toContain('pt_root_id')
  }, 60_000)
})

/**
 * BANC, and the two things a reference table is a live fact about.
 *
 * A different deployment on purpose — `cave.fanc-fly.com` rather than `prod.flywire-daf.com` —
 * because that is the whole finding: the 500,000-row cap is a **per-deployment config value**,
 * and a suite that only ever asked one server was what made `CAVE_MAX_ROWS` look like a constant.
 * Both assertions here are about facts nobody publishes a contract for and neither is stable by
 * construction: that this deployment does not truncate a two-million-row reply, and that a
 * reference table's root id arrives from the join endpoint under an unsuffixed name.
 */
describe.skipIf(!TOKEN)('CAVE, live — a reference table on another deployment', () => {
  const BANC = 'brain_and_nerve_cord_public'
  /** The kind with the fewest rows, so a join query in a test stays a few hundred rows. */
  const SMALL_KIND = 'fanc_1116_cell_type'
  let server = ''
  let version = 0

  beforeAll(async () => {
    setToken(TOKEN)
    server = await caveServerFor(BANC)
    // Newest first, and a bare integer — the same ordering the version dropdown reads.
    version = (await materializationsFor(BANC))[0]!
  }, 60_000)

  /*
   * The budget honoured by *simplification*, which is the whole reason `decimateGridFor` exists:
   * graphene publishes one level of detail, so the only way the Meshes node's `Detail` control
   * can mean anything on this route is by deciding how hard the fetched mesh is simplified.
   *
   * Here rather than on FlyWire because FlyWire no longer takes this route — its materializations
   * were flattened, and `DatastackSpec.flat` prefers the published pyramid. BANC is the datastack
   * that still exercises graphene, and its flat bucket is deliberately not listed: it publishes
   * legacy meshes at 28.4 MB and 60.8 MB for two neurons this answers in ~200 kB of Draco.
   */
  it('decimates an arriving graphene mesh to the triangle budget it was given', async () => {
    const ids = (
      await new CaveSource().findNeurons({ datasetId: `${BANC}:${version}`, limit: 8 })
    ).data[ID_COLUMN_NAME] as string[]
    const low = await new CaveSource().fetchMeshes({
      datasetId: `${BANC}:${version}`,
      // The first row of `backbone_proofread` is sometimes a fragment with no mesh at all; a
      // handful of candidates is what makes this about decimation rather than about luck.
      neuronIds: ids.slice(0, 4),
      triangleBudget: 150_000,
    })
    const triangles = low.items[0]!.indices.length / 3
    expect(triangles).toBeLessThanOrEqual(150_000)
    // Not so aggressive that the arbor goes — `MIN_DECIMATE_GRID` is the floor under it.
    expect(triangles).toBeGreaterThan(5_000)

    // And it says so: a source with no levels reports that it simplified, not "level 0 of 0".
    expect(low.detail?.decimated).toBe(true)
  }, 600_000)

  it('draws a thumbnail from the level-2 chunk graph, since there is no pyramid here', async () => {
    /*
     * BANC's segmentation is `graphene://` and its flat bucket is deliberately not listed — it
     * publishes legacy meshes at tens of megabytes a neuron — so the only cheap representation
     * this datastack has is its level-2 chunk graph. Two small requests, and the mask that comes
     * out of them is the thumbnail.
     *
     * Node counts here are real and worth pinning as a range rather than a number: they move with
     * proofreading. Measured over four v888 neurons at the time of writing: 19, 310, 1,266 and
     * 2,684 chunks.
     */
    const source = new CaveSource()
    const ids = (await source.findNeurons({ datasetId: `${BANC}:${version}`, limit: 1 })).data[
      ID_COLUMN_NAME
    ] as string[]
    const coarse = await source.fetchCoarseGeometry!({
      datasetId: `${BANC}:${version}`,
      neuronId: ids[0]!,
    })
    if (coarse?.kind !== 'skeleton') throw new Error(`expected a skeleton, got ${coarse?.kind}`)
    expect(coarse.parents.length).toBeGreaterThan(4)
    expect(coarse.positions.length).toBe(coarse.parents.length * 3)

    /*
     * And it is drawable, which for `rasteriseSkeleton` means at least one edge with real extent —
     * a tree of roots, or one collapsed to a point, is a mask with nothing in it. `cableLength`
     * is exactly that question and is `src/core`'s own, which is what keeps this in the data
     * layer's terms: `src/data` does not import from `src/ui` (invariant 1), and the test-file
     * exemption in the lint config is for helpers rather than a way around it. How the result
     * actually *looks* was checked by printing four of these as ASCII — see `STROKE_FRACTION`.
     */
    expect(cableLength(coarse)).toBeGreaterThan(0)
  }, 120_000)

  it('reports codex_annotations as a reference table, which is what the join hangs on', async () => {
    const metadata = await tableMetadata(server, BANC, version, 'codex_annotations')
    expect(metadata.schema_type).toBe('cell_type_reference')
    expect(metadata.reference_table).toBe('cell_representative_point')
  }, 60_000)

  it('holds more rows in one table than the cap Coda used to refuse at', async () => {
    /*
     * The bug, as a number. `count=true` on the whole table answers about two million, and the
     * unfiltered read really does return all of them — so counting rows against `CAVE_MAX_ROWS`
     * refused a *complete* answer, and told the user CAVE had truncated it.
     */
    const total = await countTable(server, BANC, version, { table: 'codex_annotations' })
    expect(total).toBeGreaterThan(CAVE_MAX_ROWS)
    expect(() =>
      refuseIfCapped(total, total, 'codex_annotations', 'they would be short'),
    ).not.toThrow()
  }, 120_000)

  it('answers the root id bare from the join, and the base count matches the joined rows', async () => {
    const query = {
      table: 'codex_annotations',
      filters: { equal: { classification_system: SMALL_KIND } },
      columns: ['cell_type'],
      reference: { table: 'cell_representative_point', columns: ['pt_root_id'] },
    }
    const [rows, total] = await Promise.all([
      queryTable(server, BANC, version, query),
      countTable(server, BANC, version, query),
    ])
    // And the same pair through the one function every read actually uses.
    expect(
      await queryTableChecked(server, BANC, version, query, { consequence: 'x' }),
    ).toHaveLength(rows.length)

    // Unsuffixed: `suffix_map` renames only what collides, and nothing here does.
    expect(Object.keys(rows[0]!)).toContain('pt_root_id')
    expect(Object.keys(rows[0]!)).not.toContain('pt_root_id_ref')
    // Text, not a number — invariant 8 across the join like anywhere else.
    expect(String(rows[0]!.pt_root_id)).toMatch(/^\d{18}$/)

    /*
     * And the check itself: `count=true` is not honoured on the join endpoint, so `countTable`
     * counts the **base** table. That is only a valid test if the join loses no rows — the
     * foreign key the annotation service maintains says it should not, and this is what would
     * notice if it stopped being true.
     */
    expect(rows).toHaveLength(total)
    expect(() =>
      refuseIfCapped(rows.length, total, 'codex_annotations', 'they would be short'),
    ).not.toThrow()
  }, 120_000)

  it('refuses a column the reference table holds and this one does not', async () => {
    /*
     * The 500 that started this, kept as a live fact because the message is the whole reason the
     * join is worth having: it names a column the user typed and no reason it should be wrong.
     */
    await expect(
      queryTable(server, BANC, version, {
        table: 'codex_annotations',
        columns: ['pt_root_id', 'cell_type'],
        limit: 1,
      }),
    ).rejects.toThrow(/pt_root_id not in model/)
  }, 60_000)
})

/**
 * The flat segmentations published beside a materialization, against the real buckets.
 *
 * Everything here is a fact about somebody else's bucket that CAVE's own metadata does not
 * mention, which is exactly the class of thing a fixture cannot keep honest. Three of them are
 * the reason `DatastackSpec.flat` is shaped the way it is: the `info` carries no `@type`, the
 * pyramid is real, and the skeletons exist on the one datastack with no level-2 cache to build
 * any from.
 *
 * The buckets are public and CORS-open (`access-control-allow-origin: *` on
 * storage.googleapis.com), so unlike everything above this needs no token at all. It is gated on
 * one anyway: this file is out of `pnpm test` because it goes to the network, and a describe that
 * ignored the gate would put eight seconds of Google Storage in the ordinary suite.
 */
live('CAVE, live — the flat segmentation beside a materialization', () => {
  const FLYWIRE = specFor('flywire_fafb_public')!

  it('resolves the bucket root to a volume, not to a legacy mesh directory', async () => {
    /*
     * `gs://flywire_v141_m783/info` declares `type`, `scales`, `mesh` and `skeletons` and **no
     * `@type`**. Read by `@type` alone it is a legacy mesh directory at the bucket root, where
     * no manifest exists — so every fetch 404d and, because a missing mesh is an ordinary
     * answer, surfaced as "these neurons have no meshes" rather than as a bad URL.
     */
    const flat = await probeFlat(FLYWIRE, 783)
    expect(flat?.kind).toBe('volume')
    expect(flat?.mesh?.format).toBe('multilod-draco')
    expect(flat?.summary).toBe('segmentation · multi-resolution meshes · skeletons')

    // 630 was flattened too, and publishes meshes only — which is why the spec is keyed by
    // version rather than by datastack.
    const older = await probeFlat(FLYWIRE, 630)
    expect(older?.mesh?.format).toBe('multilod-draco')
    expect(older?.skeletonUrl).toBeUndefined()
  }, 60_000)

  it('has no entry for a materialization nobody flattened', () => {
    // Sparse on purpose. An absent entry is the ordinary case and means the graphene route.
    expect(flatUrlFor(FLYWIRE, 571)).toBeUndefined()
    expect(flatUrlFor(specFor('brain_and_nerve_cord_public')!, 888)).toBeUndefined()
  })

  it('answers one neuron’s coarsest level in two requests, inside the thumbnail ceiling', async () => {
    /*
     * What makes a thumbnail possible at all. The same neuron through graphene is 492 supervoxel
     * fragments and ~1.2 MB with no level to trade against; here the coarsest level is a single
     * fragment. Measured across eight v783 neurons it runs 73 kB to 1.44 MB, so
     * `THUMBNAIL_MAX_BYTES` admits every one of them and the ceiling only fires for something
     * pathological.
     */
    const source = new CaveSource()
    const coarse = await source.fetchCoarseGeometry!({
      datasetId: 'flywire_fafb_public:783',
      neuronId: '720575940633370649',
    })
    if (coarse?.kind !== 'mesh') throw new Error(`expected a mesh, got ${coarse?.kind}`)
    expect(coarse.indices.length).toBeGreaterThan(300)

    // Nanometres by publication, via the mesh `info`'s own transform — the same frame the
    // skeleton below lands in, which is the check that would notice a missing conversion.
    const xs = Array.from(
      { length: coarse.positions.length / 3 },
      (_, i) => coarse.positions[i * 3]!,
    )
    expect(Math.min(...xs)).toBeGreaterThan(600_000)
    expect(Math.max(...xs)).toBeLessThan(800_000)
  }, 120_000)

  it('reads a published skeleton for the one datastack that can build none', async () => {
    /*
     * `flywire_fafb_public` has no level-2 cache — the assertion two describes up — and the
     * skeleton service it declares generates *from* that cache, which is why it was found empty.
     * So this bucket is the only skeleton FlyWire has, and before it was wired in the Skeletons
     * node refused for the whole datastack.
     */
    const skeletons = await new CaveSource().fetchSkeletons!({
      datasetId: 'flywire_fafb_public:783',
      neuronIds: ['720575940633370649'],
    })
    const item = skeletons.items[0]!
    expect(skeletons.units).toBe('nm')
    expect(item.positions.length).toBe(item.parents.length * 3)
    expect(item.parents.length).toBeGreaterThan(1_000)
    // A rooted tree in visit order: a parent always precedes its child, which every consumer
    // that walks to a root depends on. `spanningForest` is what guarantees it.
    for (let i = 0; i < item.parents.length; i++) expect(item.parents[i]!).toBeLessThan(i)
    // Same frame as the mesh above, which is the pair that says neither needed converting.
    expect(item.positions[0]!).toBeGreaterThan(600_000)
  }, 120_000)
})
