/**
 * CAVE, against recorded responses.
 *
 * Every fixture in `__fixtures__` is a real reply from `flywire_fafb_public`, trimmed but not
 * edited — which matters more here than usual, because the thing most likely to be silently
 * wrong is a *character-level* fact about the bytes. The query fixtures are `.txt` rather than
 * `.json` and are read as text, so an eighteen-digit root id is never rounded on its way into
 * the test the way it would be by an `import` of a JSON module.
 *
 * Recorded rather than live for the house reason and one of CAVE's own: materializations
 * expire, so a suite pointed at a real one has a shelf life. 783 does not expire until 2121,
 * which is why it is the pilot — but the *token* would still be a prerequisite for CI.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import type { DataSource } from '../source'
import { resetCache } from '../cache'
import { resetIndexLoads } from '../neuronIndex'
import { DRACO_INFO } from '../../test/precomputedStubs'
import { resetPrecomputedProbes } from '../precomputed/probe'
import { resetTransport } from '../precomputed/transport'
import { CaveSource } from './CaveSource'
import { CAVE_MAX_ROWS, refuseIfCapped } from './client'
import {
  peekTableFacts,
  peekTableList,
  resetCaveState,
  tableColumnsFor,
  tableFactsFor,
  tableListFor,
} from './tables'
import { registerDatastackSpec, resetRuntimeSpecs, specFor } from './spec'
import { caveScene } from './scene'
import { readL2Skeletons } from './l2'
import { l2SourceFor } from './datastack'
import { probeFlat } from './flat'
import { skeletonServiceFor, skeletonServiceUrl } from './skeletonService'
import { segmentationLayerIndex } from '../neuroglancer/scene'
import { MESH_WARN_NEURONS, decimateGridFor, fragmentConcurrencyFor } from './meshes'
import { quoteWideIntegers, parseCaveJson } from './json'
import {
  getSession,
  reportAuthFailure,
  resetCredentials,
  setToken,
  subscribeAuthFailure,
} from './credentials'

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8')

const DATASET = 'flywire_fafb_public:783'
const DATASTACK = 'flywire_fafb_public'
const VERSION = 783
/** The query args every table and view request carries; see `api.ts`. */
const QUERY_ARGS = 'return_pyarrow=false&arrow_format=false&split_positions=false'

interface Captured {
  url: string
  body?: unknown
}

/**
 * The captured requests that asked for rows, dropping the counts that shadow each of them.
 *
 * Every truncation-checked read now issues two requests to one table — the query and the
 * server's own `COUNT` of it, concurrently — so a filter on the path alone counts each read
 * twice. Which half a test means is never ambiguous; saying so is what keeps `toHaveLength`
 * about the thing it was written about.
 */
const rowQueries = (captured: readonly Captured[], path: string): Captured[] =>
  captured.filter((c) => c.url.includes(path) && !c.url.includes('count=true'))

const countQueries = (captured: readonly Captured[], path: string): Captured[] =>
  captured.filter((c) => c.url.includes(path) && c.url.includes('count=true'))

/** A version listing in the shape `versions.json` has, for a datastack with no fixture. */
const materializations = (datastack: string, versions: number[]) =>
  JSON.stringify(
    versions.map((version, i) => ({
      version,
      valid: true,
      datastack,
      status: 'AVAILABLE',
      time_stamp: `202${4 + i}-01-0${i + 1}T00:00:00.000000`,
      expires_on: '2121-11-10T07:10:01.417779',
    })),
  )

/**
 * A fetch that answers from the fixtures and records what was asked for.
 *
 * Matched on the *path*, because half of what this suite is checking is that the right endpoint
 * was called — `tables` living on a v2 path inside the v3 API, a view query going to `/views/`
 * rather than `/table/` — and a stub that answered everything would hide exactly that.
 *
 * **A `count=true` query is answered by counting the answer**, rather than by a fixture of its
 * own. That is what the real endpoint does — the same SQL under a `COUNT` — and it is the only
 * way the two can never disagree here: a hand-written count fixture beside a rows fixture is a
 * pair that drifts, and drifting *in the direction of agreement* is precisely the bug
 * `refuseIfCapped` exists to catch. So every override and every fixture below describes rows,
 * and the count follows from it.
 */
/**
 * The three `info` documents `gs://flywire_v141_m783` publishes, at the URLs it publishes them.
 *
 * Real shapes rather than convenient ones, and the top one is the whole reason `isVolumeInfo`
 * exists: it carries `type`, `scales`, a named `mesh` and named `skeletons`, and **no `@type`**.
 * Read as a legacy mesh directory — which is what a switch on `@type` alone does with it — it
 * resolves to the bucket root, where no manifest exists, and every neuron comes back meshless.
 */
const FLAT_INFOS: Readonly<Record<string, unknown>> = {
  'https://storage.googleapis.com/flywire_v141_m783/info': {
    type: 'segmentation',
    scales: [{ key: '16_16_40' }],
    mesh: 'mesh_mip_1_err_40',
    skeletons: 'skeletons_mip_1',
  },
  'https://storage.googleapis.com/flywire_v141_m783/mesh_mip_1_err_40/info': DRACO_INFO,
  'https://storage.googleapis.com/flywire_v141_m783/skeletons_mip_1/info': {
    '@type': 'neuroglancer_skeletons',
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    vertex_attributes: [
      { id: 'radius', data_type: 'float32', num_components: 1 },
      { id: 'cross_sectional_area', data_type: 'float32', num_components: 1 },
    ],
    sharding: {
      '@type': 'neuroglancer_uint64_sharded_v1',
      preshift_bits: 0,
      hash: 'murmurhash3_x86_128',
      minishard_bits: 1,
      shard_bits: 16,
      minishard_index_encoding: 'gzip',
      data_encoding: 'gzip',
    },
  },
}

/**
 * A level-2 chunk graph and its coordinates: `a—b—c—d`, a straight chain.
 *
 * At module scope because two blocks want it — the decoder tests below, and the thumbnail route,
 * which reads the same two endpoints through the same stub. A second chunk-graph fixture is one
 * that can drift from the one the decoder asserts against.
 */
const CHAIN = JSON.stringify({
  edge_graph: [
    ['1', '2'],
    ['2', '3'],
    ['3', '4'],
  ],
})
/**
 * The L2 cache's table mapping with FlyWire's segmentation table in it.
 *
 * `caveclient.l2cache.has_cache()`'s rule is membership of this document, so the datastack whose
 * fixture says `…/segmentation/1.0/flywire_public` needs `flywire_public` as a key. The real
 * deployment does *not* list it — which is what makes the published bucket FlyWire's only
 * skeleton — so this is a stand-in for the datastacks that do (BANC, minnie65, Aedes).
 */
const L2_MAPPING = JSON.stringify({ flywire_public: {} })

const chunkAt = (n: number) => ({ rep_coord_nm: [n * 10, 0, 0], max_dt_nm: n })
const COORDS = JSON.stringify({
  '1': chunkAt(1),
  '2': chunkAt(2),
  '3': chunkAt(3),
  '4': chunkAt(4),
})

/**
 * A precomputed skeleton, as bytes: two points and the edge between them.
 *
 * The service answers the same format a bucket does — `numVertices`, `numEdges`, the positions,
 * the edges, then one contiguous array per declared vertex attribute — which is the whole reason
 * `parseSkeleton` is shared rather than written twice. `precomputed/skeletons.test.ts` is where
 * the format itself is pinned; this only has to be readable.
 */
function serviceSkeletonBytes(): ArrayBuffer {
  const bytes = new ArrayBuffer(8 + 2 * 12 + 8 + 2 * 4 + 2 * 4)
  const view = new DataView(bytes)
  view.setUint32(0, 2, true)
  view.setUint32(4, 1, true)
  for (let i = 0; i < 2; i++) {
    view.setFloat32(8 + i * 12, 100 * i, true)
    view.setFloat32(8 + i * 12 + 4, 0, true)
    view.setFloat32(8 + i * 12 + 8, 0, true)
  }
  view.setUint32(32, 0, true)
  view.setUint32(36, 1, true)
  // `radius` then `compartment`, in the order the service's own `info` declares them.
  view.setFloat32(40, 7, true)
  view.setFloat32(44, 9, true)
  return bytes
}

const SERVICE_INFO = {
  '@type': 'neuroglancer_skeletons',
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  vertex_attributes: [
    { id: 'radius', data_type: 'float32', num_components: 1 },
    { id: 'compartment', data_type: 'float32', num_components: 1 },
  ],
}

function installFetch(
  overrides: Record<string, string | number> = {},
  options: { flat?: boolean; service?: 'empty' | 'full' } = {},
): Captured[] {
  const captured: Captured[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    captured.push({ url, ...(body ? { body } : {}) })
    const rowsAnswer = (text: string) =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) } as Response)
    /*
     * `precomputed/transport.ts` reads bytes, not text, so a flat bucket's `info` cannot ride on
     * `rowsAnswer` — a `Response` with no `arrayBuffer` throws inside `fetchInfo` and the probe
     * records it as a verdict about the URL.
     */
    const bytesAnswer = (doc: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () =>
          Promise.resolve(new TextEncoder().encode(JSON.stringify(doc)).buffer as ArrayBuffer),
      } as Response)
    const answer = (text: string) => {
      if (!url.includes('count=true')) return rowsAnswer(text)
      const rows = JSON.parse(text) as unknown[]
      return rowsAnswer(JSON.stringify([{ count: rows.length }]))
    }

    /*
     * A **number** is a count and answers only the count request; a string is rows, and its count
     * is derived by counting them. Making the two disagree is the whole of what truncation *is*,
     * and one map can express it because the value's type says which half it is — where two maps
     * had to be consulted in the right order, both requests carrying the same path.
     *
     * The `continue` is the load-bearing half: a count override whose fragment also matches the
     * *rows* request must fall through to the fixture below, or the read gets a one-row answer
     * that is the count object, and the refusal reports 1 row where the fixture has four.
     */
    for (const [fragment, value] of Object.entries(overrides)) {
      if (!url.includes(fragment)) continue
      if (typeof value !== 'number') return answer(value)
      if (url.includes('count=true')) return rowsAnswer(JSON.stringify([{ count: value }]))
    }
    if (url.includes('/info/api/v2/datastacks')) return answer(fixture('datastacks.json'))
    if (url.includes('/info/api/v2/datastack/full/'))
      return answer(fixture('datastack-flywire.json'))
    if (url.endsWith('/table/nuclei_v1/metadata'))
      return answer(fixture('table-metadata-nuclei.json'))
    /*
     * Materializations, per datastack. One fixture would answer FlyWire's 630 and 783 for every
     * datastack, and the listing test is precisely about a dataset id per materialization *of
     * that datastack* — so the other two are inline, at the numbers their servers really report.
     */
    if (url.includes('/datastack/brain_and_nerve_cord_public/metadata'))
      return answer(materializations('brain_and_nerve_cord_public', [888, 626]))
    if (url.includes('/datastack/minnie65_public/metadata'))
      return answer(materializations('minnie65_public', [1822, 1718]))
    if (url.includes('/materialize/api/v3/datastack/') && url.includes('/metadata'))
      return answer(fixture('versions.json'))
    /*
     * The discovery endpoints, matched with `endsWith` rather than `includes` — a *view query*
     * is `/version/783/views/valid_connection_v2/query`, so `includes('/views')` would answer the
     * listing fixture to a query and the query fixture would never be reached. The tables listing
     * is checked on the **v2** path deliberately: that is half of what these tests assert.
     */
    if (url.endsWith('/materialize/api/v2/datastack/flywire_fafb_public/version/783/tables'))
      return answer(fixture('tables.json'))
    if (url.endsWith('/materialize/api/v3/datastack/flywire_fafb_public/version/783/views'))
      return answer(fixture('views.json'))
    if (url.endsWith('/table/nuclei_v1/metadata'))
      return answer(fixture('table-metadata-nuclei.json'))
    // A second table, for the counts case alone — `proofread_neurons` is the one whose two
    // counts genuinely disagree, and only its metadata's existence matters here.
    if (url.endsWith('/table/proofread_neurons/metadata'))
      return answer('{"table_name":"proofread_neurons","schema_type":"proofreading_status"}')
    // Both counts, and they are deliberately the two *different* numbers the real services
    // report for `proofread_neurons`; `nuclei_v1`'s happen to agree, which is why the mismatch
    // is fixtured on the table that has one.
    if (
      url.endsWith(
        '/annotation/api/v2/aligned_volume/fafb_seung_alignment_v0/table/proofread_neurons/count',
      )
    )
      return answer('139540')
    if (url.endsWith('/version/783/table/proofread_neurons/count')) return answer('127978')
    if (
      url.endsWith(
        '/annotation/api/v2/aligned_volume/fafb_seung_alignment_v0/table/nuclei_v1/count',
      )
    )
      return answer('143140')
    if (url.endsWith('/version/783/table/nuclei_v1/count')) return answer('143140')
    if (url.includes('/table/nuclei_v1/query'))
      return answer(fixture('table-sample-nuclei.txt'))
    if (url.includes('/unique_string_values')) return answer(fixture('unique-strings.json'))
    if (url.includes('/table/proofread_neurons/query')) return answer(fixture('neurons.txt'))
    if (url.includes('/table/hierarchical_neuron_annotations/query')) {
      // Served filtered, as the server would: the index asks one kind at a time to stay under
      // the 500,000-row cap, so a stub answering the whole table would hide that entirely.
      const system = (body as { filter_equal_dict?: Record<string, Record<string, string>> })
        ?.filter_equal_dict?.hierarchical_neuron_annotations?.classification_system
      const rows = JSON.parse(fixture('annotations.txt')) as Array<Record<string, unknown>>
      return answer(
        JSON.stringify(rows.filter((r) => !system || r.classification_system === system)),
      )
    }
    if (url.includes('/views/valid_connection_v2/query'))
      return answer(fixture('connections.txt'))
    if (url.includes('/table/synapses_nt_v1/query')) return answer(fixture('synapses.txt'))
    if (url.includes('/segmentation/1.0/flywire_public/info'))
      return answer(fixture('segmentation.json'))
    if (url.includes('/meshing/api/v1/table/flywire_public/manifest/'))
      return answer(fixture('mesh-manifest.json'))
    /*
     * Off by default, and that is what makes the graphene cases above still mean something: an
     * unserved bucket 404s, `probeFlat` reports no flat source, and the fetch falls back — which
     * is the path every datastack without an entry takes for real.
     */
    /*
     * The skeleton service, off by default for `options.flat`'s reason: unserved, the versions
     * read 404s and `skeletonServiceFor` answers "no service", which is the path a datastack
     * whose deployment runs none takes for real.
     *
     * `exists` is what tells the two configurations apart. A declared service with an empty
     * cache is not a hypothetical — `flywire_fafb_public` and BANC are both exactly that — so
     * `'empty'` is a case the automatic route has to survive rather than an edge one.
     */
    if (options.service && url.includes('/skeletoncache/api/versions')) return answer('[-1,0,1,2,3,4]')
    if (options.service && url.includes('/skeletoncache/') && url.endsWith('/info'))
      return answer(JSON.stringify(SERVICE_INFO))
    if (options.service && url.endsWith('/precomputed/skeleton/exists')) {
      const ids = (String(init?.body ?? '').match(/\[(.*)\]/)?.[1] ?? '')
        .split(',')
        .filter(Boolean)
      return answer(
        JSON.stringify(Object.fromEntries(ids.map((id) => [id, options.service === 'full']))),
      )
    }
    if (options.service && /\/precomputed\/skeleton\/\d+\/\d+$/.test(url))
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(serviceSkeletonBytes()),
      } as Response)
    if (options.flat && FLAT_INFOS[url] !== undefined) return bytesAnswer(FLAT_INFOS[url])
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"message":"unexpected request"}'),
    } as Response)
  })
  return captured
}

beforeEach(() => {
  resetCredentials()
  resetCache()
  resetIndexLoads()
  // Every CAVE memo — the datastack record, the table listings, the per-table facts — is module
  // level now that the annotation providers share them, so all of it outlives a test file.
  resetCaveState()
  // The flat-bucket route reaches `precomputed`, whose `info` memo and probe verdicts are module
  // level too — and a *failed* probe is remembered on purpose, so it would outlive this file.
  resetPrecomputedProbes()
  resetTransport()
  // Custom CAVE registers a spec from a node's params; it is module state like the rest.
  resetRuntimeSpecs()
  setToken('test-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetCredentials()
})

// ---------------------------------------------------------------------------

describe('reading CAVE JSON', () => {
  it('keeps an eighteen-digit root id exactly, where JSON.parse loses it', () => {
    const raw = fixture('neurons.txt')
    expect(raw).toContain('"pt_root_id":720575940628857210')

    // The failure this exists for: not an error, a different neuron.
    const naive = JSON.parse(raw) as Array<{ pt_root_id: number }>
    expect(String(naive[0]!.pt_root_id)).toBe('720575940628857200')

    const parsed = parseCaveJson<Array<{ pt_root_id: string }>>(raw)
    expect(parsed[0]!.pt_root_id).toBe('720575940628857210')
    expect(typeof parsed[0]!.pt_root_id).toBe('string')
  })

  it('leaves a number a double can hold alone, id-shaped or not', () => {
    const parsed = parseCaveJson<Array<Record<string, unknown>>>(fixture('neurons.txt'))
    expect(parsed[0]!.id).toBe(1)
    expect(parsed[0]!.created).toBe(1687157012562)
    expect(parsed[0]!.pt_position_x).toBe(443342)
    // 16 digits and exactly representable: quoting it would turn a quantity into text.
    expect(parseCaveJson<{ n: unknown }>('{"n":1234567890123456}').n).toBe(1234567890123456)
  })

  /*
   * The reason the scan matches whole string literals first. FlyWire's `neuron_information_v2`
   * is free-text user annotation, so an id inside a tag is not hypothetical — and a naive
   * `replace(/:(\d{16,})/g, …)` splices quotes into the middle of a string and the document
   * stops parsing.
   */
  it('never reaches inside a string, however id-shaped its contents', () => {
    const text = '{"tag":"see root:720575940628857210, upstream","id":720575940628857210}'
    const parsed = parseCaveJson<{ tag: string; id: string }>(text)
    expect(parsed.tag).toBe('see root:720575940628857210, upstream')
    expect(parsed.id).toBe('720575940628857210')
  })

  it('leaves decimals and exponents alone rather than quoting half of one', () => {
    expect(quoteWideIntegers('{"a":0.1234567890123456789}')).toBe('{"a":0.1234567890123456789}')
    expect(quoteWideIntegers('{"a":12345678901234567.5}')).toBe('{"a":12345678901234567.5}')
    expect(quoteWideIntegers('{"a":1.2345678901234567e5}')).toBe('{"a":1.2345678901234567e5}')
  })

  it('quotes an id inside an array, not only one after a colon', () => {
    expect(parseCaveJson<{ ids: string[] }>('{"ids":[720575940628857210,1]}').ids).toEqual([
      '720575940628857210',
      1,
    ])
  })
})

// ---------------------------------------------------------------------------

describe('datasets and versions', () => {
  it('lists a dataset per materialization, newest first, and only for specced datastacks', async () => {
    installFetch()
    const source = new CaveSource()
    const datasets = await source.listDatasets()

    // The info service lists thirteen datastacks; `spec.ts` wires one, and offering a dataset
    // that would fail on the first Run is worse than not offering it.
    expect(datasets.map((d) => d.id)).toEqual([
      'flywire_fafb_public:783',
      'flywire_fafb_public:630',
      'brain_and_nerve_cord_public:888',
      'brain_and_nerve_cord_public:626',
      'minnie65_public:1822',
      'minnie65_public:1718',
    ])
    expect(datasets[0]!.version).toBe('783')
    expect(datasets[0]!.description).toMatch(/Materialization 783 materialized 2023-09-30/)
    expect(datasets[0]!.description).toMatch(/expires 2121-11-10/)
  })

  it('says which of the datastack’s tables it reads, marked as Coda’s own', async () => {
    installFetch()
    const [flywire] = await new CaveSource().listDatasets()

    /*
     * A CAVE datastack does not describe its own roles — `spec.ts` is where the four bindings are
     * decided, and until this landed they were visible nowhere in the app. The publisher's blurb
     * comes first and is left exactly as published; this is appended and says whose it is,
     * because a reader has no other way to tell where the quotation stops.
     */
    expect(flywire!.description).toMatch(/\*\*Coda reads this datastack as:\*\*/)
    expect(flywire!.description).toContain('- Neurons — `proofread_neurons`')
    expect(flywire!.description).toContain('- Annotations — `hierarchical_neuron_annotations`')
    expect(flywire!.description).toContain('- Synapses — `synapses_nt_v1`')
    // Named as a view, because that is why this datastack answers connectivity without counting.
    expect(flywire!.description).toMatch(/- Connectivity — `valid_connection_v2` \(a view/)
    // Per materialization, not per datastack: 783's bucket is not 630's, and a datastack whose
    // version has no entry says the graphene route instead.
    expect(flywire!.description).toContain(
      '- Morphology — `precomputed://gs://flywire_v141_m783`',
    )
    // The blurb still leads, and nothing was inserted into it.
    expect(flywire!.description?.startsWith('The public FlyWire segmentation')).toBe(true)
  })

  it('spells an unbound role out rather than leaving the line off', async () => {
    installFetch()
    const datasets = await new CaveSource().listDatasets()
    const banc = datasets.find((d) => d.id.startsWith('brain_and_nerve_cord_public'))!

    /*
     * The whole reason the list exists. "Why are there no cell types on BANC?" had no answer
     * anywhere in the app, and a list that silently skipped the role nobody configured would
     * answer the easy question and not the one being asked.
     */
    expect(banc.description).toContain('- Morphology — built from the graphene segmentation')
    expect(banc.description).toContain(
      '- Annotations — none configured; wire an annotation source for cell types',
    )
    // And the synapse fallback named, since it is why connectivity here is slower than FlyWire's.
    expect(banc.description).toMatch(/- Connectivity — counted from `synapses_v3`/)
  })

  it('takes the species from the spec, which is why a mouse is not a fly', async () => {
    installFetch()
    const datasets = await new CaveSource().listDatasets()

    /*
     * `species` was `'Drosophila melanogaster'` hardcoded in `datasetInfoFor`, from when FlyWire
     * was the only entry — so adding `minnie65_public` had Dataset Summary describe a mouse
     * visual cortex volume as a fly. The shape a hardcoded field's error always takes: silent,
     * confident, and only wrong for the entries added after it.
     */
    const of = (prefix: string) => datasets.find((d) => d.id.startsWith(prefix))!.species
    expect(of('flywire_fafb_public')).toBe('Drosophila melanogaster')
    expect(of('brain_and_nerve_cord_public')).toBe('Drosophila melanogaster')
    expect(of('minnie65_public')).toBe('Mus musculus')
  })

  it('asks the datastack’s own server for its versions, not the global one', async () => {
    const captured = installFetch()
    await new CaveSource().listDatasets()

    // `local_server` out of the info record. A listing built against the global server answers
    // 404 for every datastack, and the two are different hosts on every deployment.
    expect(captured.map((c) => c.url)).toEqual([
      'https://global.daf-apis.com/info/api/v2/datastacks',
      'https://global.daf-apis.com/info/api/v2/datastack/full/flywire_fafb_public',
      'https://global.daf-apis.com/info/api/v2/datastack/full/brain_and_nerve_cord_public',
      'https://global.daf-apis.com/info/api/v2/datastack/full/minnie65_public',
      'https://prod.flywire-daf.com/materialize/api/v3/datastack/flywire_fafb_public/metadata',
      'https://prod.flywire-daf.com/materialize/api/v3/datastack/brain_and_nerve_cord_public/metadata',
      'https://prod.flywire-daf.com/materialize/api/v3/datastack/minnie65_public/metadata',
    ])
  })

  it('publishes no regions and no statuses, so neither picker offers a filter that matches nothing', async () => {
    installFetch()
    const [latest] = await new CaveSource().listDatasets()
    expect(latest!.rois).toEqual([])
    expect(latest!.statuses).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('the neuron schema', () => {
  it('is discovered from the annotation kinds, and names the id column str', async () => {
    installFetch()
    const source = new CaveSource()
    // Synchronous, so it answers with the placeholder and starts discovery — invariant 2.
    expect(source.schemasFor(DATASET).neurons.columns.map((c) => c.name)).toEqual(['neuronId'])

    await source.neuronIndex({ datasetId: DATASET })

    const columns = source.schemasFor(DATASET).neurons.columns
    expect(columns.map((c) => c.name)).toEqual([
      'neuronId',
      'type',
      'cell_class',
      'cell_sub_class',
      'flow',
      'super_class',
    ])
    // Eighteen digits do not fit in a double, so an `i64` column would be a different neuron.
    expect(columns[0]!.dtype).toBe('str')
  })

  it('discovers from unique_string_values rather than by reading the annotations', async () => {
    const captured = installFetch()
    const source = new CaveSource()
    source.schemasFor(DATASET)
    await vi.waitFor(() => expect(source.schemasFor(DATASET).neurons.columns.length).toBe(6))

    // 52 kB against tens of megabytes: what lets discovery run from inference while the index
    // waits until something actually asks for neurons.
    expect(captured.some((c) => c.url.includes('/unique_string_values'))).toBe(true)
    expect(captured.some((c) => c.url.includes('/query'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('what counts as a truncated CAVE answer', () => {
  const check = (rows: number, total: number | undefined) =>
    refuseIfCapped(rows, total, 'codex_annotations', 'these annotations would be incomplete')

  it('refuses a result short of the count the server gives for the same query', () => {
    expect(() => check(500_000, 512_957)).toThrow(
      /CAVE returned 500,000 of "codex_annotations"'s 512,957 rows/,
    )
    // The consequence is the caller's, and it is the half a reader acts on.
    expect(() => check(500_000, 512_957)).toThrow(/these annotations would be incomplete/)
  })

  it('accepts a whole answer bigger than any one deployment’s cap', () => {
    /*
     * The bug this replaced. `CAVE_MAX_ROWS` is `prod.flywire-daf.com`'s configured
     * `QUERY_LIMIT_SIZE` and nothing more — `cave.fanc-fly.com` answered all **1,994,371** rows
     * of BANC's `codex_annotations` in one reply, with no warning header — and refusing at `>=`
     * threw away a complete answer while telling the user it had been cut short. A result
     * *larger* than a cap is positive proof that cap did not apply.
     */
    expect(() => check(1_994_371, 1_994_371)).not.toThrow()
  })

  it('accepts a short answer the server agrees is short', () => {
    expect(() => check(4, 4)).not.toThrow()
  })

  it('falls back to exactly the cap where no count could be had', () => {
    // One extra request against a shared production server is not allowed to break a read that
    // already has its answer, so a failed count degrades to the old, weaker tell.
    expect(() => check(CAVE_MAX_ROWS, undefined)).toThrow(/truncated "codex_annotations" at/)
    expect(() => check(CAVE_MAX_ROWS - 1, undefined)).not.toThrow()
    // And still not `>=`, even here: over the cap is not the cap.
    expect(() => check(CAVE_MAX_ROWS + 1, undefined)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------

describe('the neuron index', () => {
  it('pivots the long annotation table into one row per neuron', async () => {
    installFetch()
    const table = await new CaveSource().neuronIndex({ datasetId: DATASET })

    expect(table.kind).toBe('neurons')
    expect(table.data.neuronId).toEqual([
      '720575940628857210',
      '720575940626838909',
      '720575940626046919',
      '720575940630311383',
    ])
    expect(table.data.super_class).toEqual(['central', 'central', 'central', null])
    // `cell_type` is the one annotation kind Coda renames, because `type` is addressed by name.
    expect(table.data.type).toEqual([null, 'CB0924', null, null])
  })

  it('asks each table for only the columns it needs, as a list', async () => {
    const captured = installFetch()
    await new CaveSource().neuronIndex({ datasetId: DATASET })

    const neurons = rowQueries(captured, '/table/proofread_neurons/query')[0]!
    // A *list*: this endpoint rejects the table-keyed map outright, and a join accepts it while
    // silently taking the first column of that name from whichever table has one.
    expect(neurons.body).toEqual({ select_columns: ['id', 'pt_root_id'] })
    expect(neurons.url).toContain('arrow_format=false')

    /*
     * One annotation request per kind, which is what keeps each under CAVE's 500,000-row cap —
     * the whole table is over it, live, however much the row-count endpoint says otherwise.
     */
    const annotations = rowQueries(captured, '/table/hierarchical_neuron_annotations/query')
    expect(annotations).toHaveLength(5)
    expect(annotations[0]!.body).toEqual({
      filter_equal_dict: {
        hierarchical_neuron_annotations: { classification_system: 'cell_class' },
      },
      select_columns: ['target_id', 'cell_type'],
    })

    /*
     * And one count beside each, carrying **the same filter and nothing else**. That is the
     * whole of what makes the count a test rather than a second opinion: a count of the unfiltered
     * table would be five times the rows every time, and `refuseIfCapped` would refuse every
     * kind. Columns and limits are left off because they describe a shape a count does not have.
     */
    const counts = countQueries(captured, '/table/hierarchical_neuron_annotations/query')
    expect(counts).toHaveLength(5)
    expect(counts[0]!.body).toEqual({
      filter_equal_dict: {
        hierarchical_neuron_annotations: { classification_system: 'cell_class' },
      },
    })
  })

  it('refuses rather than handing back a silently truncated index', async () => {
    // Four rows in the fixture, and a server that says the table holds 512,957. The server says
    // *that* in a `warning` header its CORS policy does not expose, so asking it to count is the
    // only tell a browser has. A short index is not a visible failure — it is a dataset that
    // quietly lacks neurons.
    installFetch({ '/table/proofread_neurons/query': 512_957 })

    await expect(new CaveSource().neuronIndex({ datasetId: DATASET })).rejects.toThrow(
      /CAVE returned 4 of "proofread_neurons"'s 512,957 rows/,
    )
  })

  it('counts what it asked for, not what the table holds', async () => {
    const captured = installFetch()
    await new CaveSource().neuronIndex({ datasetId: DATASET })

    /*
     * The count goes to the **single-table** endpoint even where the read is filtered, and it
     * carries the read's filters and nothing else. Both halves matter: a count of the whole
     * table would exceed any filtered read and refuse it, and the *join* endpoint answers rows
     * to `count=true` rather than a count, so a reference read could not be checked there at all.
     */
    const counts = countQueries(captured, '/table/proofread_neurons/query')
    expect(counts).toHaveLength(1)
    expect(counts[0]!.url).toContain('/version/783/table/proofread_neurons/query')
    expect(counts[0]!.body).toEqual({})
  })

  it('keeps one row per root id where a table lists a segment twice', async () => {
    const twice = fixture('neurons.txt').replace(
      '{"id":1,',
      '{"id":99,"pt_root_id":720575940628857210},{"id":1,',
    )
    installFetch({ '/table/proofread_neurons/query': twice })

    const table = await new CaveSource().neuronIndex({ datasetId: DATASET })
    expect(table.data.neuronId).toEqual([
      '720575940628857210',
      '720575940626838909',
      '720575940626046919',
      '720575940630311383',
    ])
  })
})

// ---------------------------------------------------------------------------

describe('finding neurons', () => {
  const source = () => new CaveSource()

  it('anchors a pattern at both ends, as neuPrint’s =~ does', async () => {
    installFetch()
    const cave = source()
    expect(
      (
        await cave.findNeurons({
          datasetId: DATASET,
          rows: [{ field: 'type', op: 'matches', values: ['CB.*'] }],
        })
      ).length,
    ).toBe(1)
    // Anchored: the pattern has to describe the whole value.
    expect(
      (
        await cave.findNeurons({
          datasetId: DATASET,
          rows: [{ field: 'type', op: 'matches', values: ['B09'] }],
        })
      ).length,
    ).toBe(0)
  })

  it('reads an id list as text, so a wide id is not rounded on the way in', async () => {
    installFetch()
    const table = await source().findNeurons({
      datasetId: DATASET,
      neuronIds: ['720575940626046919'],
    })
    expect(table.data.neuronId).toEqual(['720575940626046919'])
  })

  it('treats an empty id list as no neurons, never as no filter', async () => {
    installFetch()
    expect((await source().findNeurons({ datasetId: DATASET, neuronIds: [] })).length).toBe(0)
  })

  /*
   * `Min size` used to be a plain number on the Find Neurons card whatever the dataset — unlike
   * `Status` and `In ROI`, whose pickers were fed from what the dataset reports. So it reached a
   * CAVE source configured, and CAVE has no `size` column: the filter read `index.data.size`
   * through `Number(undefined ?? 0)`, compared 0 against the threshold and dropped **every** row.
   * A node answering "0 neurons" for a datastack full of them, with nothing saying why.
   *
   * It is a filter row now, so the card cannot offer a field this datastack does not publish and
   * the case is unreachable from a new node. What still reaches here is a graph saved against
   * neuPrint and repointed at CAVE — refused, naming the field, rather than answering empty.
   */
  it('refuses a size filter it has nothing to answer with, rather than emptying the result', async () => {
    installFetch()
    const cave = source()
    await expect(
      cave.findNeurons({
        datasetId: DATASET,
        rows: [{ field: 'size', op: 'ge', values: ['1000'] }],
      }),
    ).rejects.toThrow(/no "size"/)
    // And no rows at all is not a filter — a fresh Find Neurons sends exactly that.
    expect((await cave.findNeurons({ datasetId: DATASET })).length).toBe(4)
  })

  it('applies the limit and downloads the index only once across queries', async () => {
    const captured = installFetch()
    const cave = source()
    expect((await cave.findNeurons({ datasetId: DATASET, limit: 2 })).length).toBe(2)
    expect((await cave.findNeurons({ datasetId: DATASET })).length).toBe(4)

    // The whole economics of this source: one download, then every query is local.
    // One neuron query plus one per annotation kind, then nothing more, ever.
    expect(captured.filter((c) => c.url.endsWith('/query?' + QUERY_ARGS)).length).toBe(6)
  })
})

// ---------------------------------------------------------------------------

describe('connectivity', () => {
  it('answers query-relative, whichever way the synapse points', async () => {
    installFetch()
    const cave = new CaveSource()
    const out = await cave.fetchConnectivity({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
      direction: 'outputs',
    })
    expect(out.data.neuronId?.[0]).toBe('720575940628857210')
    expect(out.data.partnerId?.[0]).toBe('720575940620711334')
    expect(out.data.weight?.[0]).toBe(166)

    const inn = await cave.fetchConnectivity({
      datasetId: DATASET,
      neuronIds: ['720575940620711334'],
      direction: 'inputs',
    })
    // The same fixture row read from the other end: `neuronId` is always the neuron asked about.
    expect(inn.data.neuronId?.[0]).toBe('720575940620711334')
    expect(inn.data.partnerId?.[0]).toBe('720575940628857210')
  })

  it('sends the id as text and the weight cut to the server', async () => {
    const captured = installFetch()
    await new CaveSource().fetchConnectivity({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
      direction: 'outputs',
      minWeight: 5,
    })

    const query = captured.find((c) => c.url.includes('/views/valid_connection_v2/query'))!
    expect(query.body).toEqual({
      filter_in_dict: { valid_connection_v2: { pre_pt_root_id: ['720575940628857210'] } },
      // Applied before anything is sent: 4,818 rows and 410 kB become 183 rows and 16 kB.
      filter_greater_equal_dict: { valid_connection_v2: { n_syn: 5 } },
      select_columns: ['pre_pt_root_id', 'post_pt_root_id', 'n_syn'],
    })
  })

  it('names both ends where the index knows them, and leaves the rest null', async () => {
    installFetch()
    const table = await new CaveSource().fetchConnectivity({
      datasetId: DATASET,
      neuronIds: ['720575940626838909'],
      direction: 'inputs',
    })
    // A partner outside the annotated set has no type, which is the honest answer rather than
    // a gap — and a connectivity table with no types at all is readable by nothing.
    expect(table.data.neuronType).toEqual([null, null, null])
    expect(table.schema.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'neuronType',
      'partnerId',
      'partnerType',
      'weight',
    ])
  })

  it('builds an adjacency matrix keyed by the ids that were asked for', async () => {
    installFetch()
    const matrix = await new CaveSource().fetchAdjacency({
      datasetId: DATASET,
      sourceIds: ['720575940628857210'],
      targetIds: ['720575940620711334', '720575940629426025'],
    })
    expect(matrix.rowLabels).toEqual(['720575940628857210'])
    expect([...matrix.values]).toEqual([166, 140])
  })
})

// ---------------------------------------------------------------------------

describe('synapses', () => {
  it('asks for nanometres rather than trusting the server default', async () => {
    const captured = installFetch()
    await new CaveSource().fetchSynapses({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
      polarity: 'pre',
    })

    const query = captured.find((c) => c.url.includes('/table/synapses_nt_v1/query'))!
    /*
     * The table stores 4x4x40 nm voxels — established by asking for both resolutions and
     * watching the values divide by exactly 4, 4 and 40. The server's current default happens to
     * be nanometres, so omitting this looks fine and would put every synapse a factor out of the
     * scene the day that moved, with nothing failing.
     */
    expect((query.body as { desired_resolution?: number[] }).desired_resolution).toEqual([
      1, 1, 1,
    ])
  })

  it('reads positions as a point cloud in nanometres, one attribute row apiece', async () => {
    installFetch()
    const points = await new CaveSource().fetchSynapses({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
      polarity: 'pre',
    })

    expect(points.units).toBe('nm')
    // And the frame the numbers are in, which travels with the units for the reason
    // `geometryFrame` records: a comparison across spaces is meaningless however honest the
    // units are, and nothing downstream could refuse one without this.
    expect(points.space).toBe('FLYWIRE')
    expect(points.attributes.length).toBe(3)
    expect(points.positions.length).toBe(9)
    expect([...points.positions.slice(0, 3)]).toEqual([561124, 235604, 142360])
  })

  it('keeps both root ids exact and orients them query-relative', async () => {
    installFetch()
    const cave = new CaveSource()
    const pre = await cave.fetchSynapses({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
      polarity: 'pre',
    })
    // `neuronId` is the end that matched the filter, whichever way the synapse points — the same
    // rule fetchConnectivity follows, so the two nodes agree about which id is whose.
    expect(pre.attributes.data.neuronId?.[0]).toBe('720575940628857210')
    expect(pre.attributes.data.partnerId?.[0]).toBe('720575940618002747')
    expect(pre.attributes.data.polarity?.[0]).toBe('pre')

    const post = await cave.fetchSynapses({
      datasetId: DATASET,
      neuronIds: ['720575940618002747'],
      polarity: 'post',
    })
    expect(post.attributes.data.neuronId?.[0]).toBe('720575940618002747')
    expect(post.attributes.data.partnerId?.[0]).toBe('720575940628857210')
  })

  it('applies the weight cut on the server, where it saves the download', async () => {
    const captured = installFetch()
    await new CaveSource().fetchSynapses({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
      polarity: 'pre',
      minWeight: 50,
    })

    // The node has always sent this and both other sources honour it; dropping it left a visible
    // control doing nothing against the query whose only backstop is the 500,000-row cap.
    const query = captured.find((c) => c.url.includes('/table/synapses_nt_v1/query'))!
    expect(query.body).toMatchObject({
      filter_greater_equal_dict: { synapses_nt_v1: { cleft_score: 50 } },
    })
  })

  it('sends no weight clause at the default, which excludes nothing', async () => {
    const captured = installFetch()
    await new CaveSource().fetchSynapses({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
      polarity: 'pre',
      minWeight: 1,
    })
    const query = captured.find((c) => c.url.includes('/table/synapses_nt_v1/query'))!
    expect(query.body).not.toHaveProperty('filter_greater_equal_dict')
  })

  it('reports progress, so the run ring does not sit at the node’s own 10%', async () => {
    installFetch()
    const seen: number[] = []
    await new CaveSource().fetchSynapses({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
      polarity: 'pre',
      onProgress: (fraction) => seen.push(fraction),
    })
    expect(seen.length).toBeGreaterThan(1)
  })

  it('advertises only the columns a synapse row can fill', async () => {
    installFetch()
    const points = await new CaveSource().fetchSynapses({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
      polarity: 'pre',
    })
    // No `type`/`partnerType`: the synapse table carries neither, and a column that is null on
    // every row is a dead entry in every picker on the node.
    expect(points.attributes.schema.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'partnerId',
      'polarity',
      'weight',
    ])
  })

  it('queries both ends when no polarity is named, because CAVE has no either-end filter', async () => {
    const captured = installFetch()
    await new CaveSource().fetchSynapses({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
    })
    const queries = rowQueries(captured, '/table/synapses_nt_v1/query')
    expect(queries).toHaveLength(2)
    // An `IN` on both columns of one query is an AND, which is the synapses a neuron makes onto
    // itself rather than the synapses it makes at all.
    const filtered = (c: Captured) =>
      Object.keys(
        (c.body as { filter_in_dict: Record<string, Record<string, unknown>> }).filter_in_dict
          .synapses_nt_v1 ?? {},
      )
    expect(filtered(queries[0]!)).toEqual(['pre_pt_root_id'])
    expect(filtered(queries[1]!)).toEqual(['post_pt_root_id'])
  })
})

// ---------------------------------------------------------------------------

describe('meshes', () => {
  it('asks the meshing API with verify, and reads fragments from the bucket', async () => {
    // No flat bucket served, so this is the fallback route — which is what every datastack
    // without a `flat` entry takes, and what FlyWire itself takes if the bucket is unreachable.
    const captured = installFetch()
    await new CaveSource()
      .fetchMeshes({ datasetId: DATASET, neuronIds: ['720575940628857210'] })
      .catch(() => undefined)

    /*
     * `verify=True` is not optional: without it the manifest answers a single fragment named
     * after the root id, which does not exist in the bucket — the unverified form is a promise
     * about what would be meshed rather than a list of files.
     */
    const manifest = captured.find((c) => c.url.includes('/meshing/api/v1/'))!
    expect(manifest.url).toContain('/manifest/720575940628857210:0?verify=True')

    // The table name comes out of the segmentation URL, not from the datastack: FlyWire calls
    // them `flywire_public` and `flywire_fafb_public`, and taking the wrong one 404s.
    expect(manifest.url).toContain('/table/flywire_public/')

    const fragment = captured.find((c) => c.url.includes('/fly_v31_meshes_v2_062619/'))!
    expect(fragment.url).toContain(
      'https://storage.googleapis.com/seunglab2/drosophila_v0/ws_190410_FAFB_v02_ws_size_threshold_200/',
    )
  })

  it('reads a recently edited fragment from unsharded_mesh_dir, not from the mesh root', async () => {
    /*
     * A verified manifest mixes two kinds of fragment: frozen ones inside shard files, and plain
     * objects covering the parts of the neuron somebody has edited since. BANC publishes the
     * second lot under `"dynamic"` — one neuron's manifest was 40 sharded and 21 not — and read
     * from the mesh root every one of them 404s. `mapWithConcurrency` turns each into a dropped
     * fragment, so the neuron arrives looking whole, minus every piece anyone has touched.
     *
     * FlyWire's public segmentation is frozen and declares no such directory, which is why the
     * fixture above never exercised this and the datastack that does was silently short.
     */
    const captured = installFetch({
      '/segmentation/1.0/flywire_public/info': JSON.stringify({
        data_dir: 'gs://a_bucket/seg',
        mesh: 'graphene_meshes',
        mesh_metadata: { unsharded_mesh_dir: 'dynamic' },
      }),
      '/meshing/api/v1/': JSON.stringify({
        fragments: [
          '~3/529288-0.shard:8331489:4061',
          '305453950923010514:0:30720-32768_0-4096',
        ],
      }),
    })
    await new CaveSource()
      .fetchMeshes({ datasetId: DATASET, neuronIds: ['720575940628857210'] })
      .catch(() => undefined)

    const bucket = 'https://storage.googleapis.com/a_bucket/seg/graphene_meshes'
    const fragments = captured.map((c) => c.url).filter((url) => url.startsWith(bucket))
    // The byte range is what makes a name a shard read; the `~<layer>/` prefix is part of the
    // path to the shard file and stays under the mesh root.
    expect(fragments).toContain(`${bucket}/~3/529288-0.shard:8331489:4061`)
    expect(fragments).toContain(`${bucket}/dynamic/305453950923010514:0:30720-32768_0-4096`)
  })

  it('prefers the flat pyramid over graphene where the materialization publishes one', async () => {
    /*
     * The whole point of `DatastackSpec.flat`. Graphene has no levels: 492 supervoxel fragments
     * and ~1.2 MB for one FlyWire neuron. The same neuron out of `gs://flywire_v141_m783` is two
     * range requests off a 3-to-5 level pyramid, and the manifest never gets asked for.
     */
    const captured = installFetch({}, { flat: true })
    await new CaveSource()
      .fetchMeshes({ datasetId: DATASET, neuronIds: ['720575940628857210'] })
      .catch(() => undefined)

    expect(captured.filter((c) => c.url.includes('/meshing/api/v1/'))).toEqual([])
    expect(captured.map((c) => c.url)).toContain(
      'https://storage.googleapis.com/flywire_v141_m783/mesh_mip_1_err_40/info',
    )
  })

  it('draws a thumbnail from the flat pyramid, and nothing where neither route exists', async () => {
    /*
     * `fetchCoarseGeometry`'s contract: `undefined` means "draw a placeholder". Reached only when
     * *both* routes are out — no pyramid and no level-2 cache — because for graphene alone the
     * alternative to a placeholder is a page of 25 rows fetching several hundred fragments each.
     * The stub serves no table mapping, so the L2 gate declines too.
     */
    installFetch()
    const bare = new CaveSource()
    expect(
      await bare.fetchCoarseGeometry!({ datasetId: DATASET, neuronId: '720575940628857210' }),
    ).toBeUndefined()

    vi.unstubAllGlobals()
    resetPrecomputedProbes()
    resetTransport()
    const captured = installFetch({}, { flat: true })
    // Undefined either way here, because the stub serves no shard bytes — what is being asserted
    // is that the flat route was *taken*, which the graphene one never reaches.
    await new CaveSource().fetchCoarseGeometry!({
      datasetId: DATASET,
      neuronId: '720575940628857210',
    }).catch(() => undefined)
    expect(captured.map((c) => c.url)).toContain(
      'https://storage.googleapis.com/flywire_v141_m783/mesh_mip_1_err_40/info',
    )
    expect(captured.filter((c) => c.url.includes('/meshing/api/v1/'))).toEqual([])
  })

  it('falls back to a level-2 skeleton for a thumbnail where there is no pyramid', async () => {
    /*
     * The route that gives a `graphene://`-only datastack thumbnails at all. Its cheapest mesh is
     * its *only* mesh — several hundred supervoxel fragments at full resolution — where the
     * level-2 chunk graph is two small requests and enough to draw with. `CoarseGeometry` is a
     * union so that a source can answer in the shape it actually has.
     */
    const captured = installFetch({
      '/lvl2_graph': CHAIN,
      '/attributes': COORDS,
      '/l2cache/api/v1/table_mapping': JSON.stringify({ flywire_public: {} }),
    })
    const coarse = await new CaveSource().fetchCoarseGeometry!({
      datasetId: DATASET,
      neuronId: '720575940628857210',
    })
    expect(coarse?.kind).toBe('skeleton')
    expect(coarse?.kind === 'skeleton' && coarse.parents.length).toBe(4)
    // Two requests, and neither of them the meshing API.
    expect(captured.filter((c) => c.url.includes('/meshing/api/v1/'))).toEqual([])
    expect(captured.filter((c) => c.url.includes('/lvl2_graph'))).toHaveLength(1)
  })

  it('turns the triangle budget into a decimation grid, since graphene has no levels', async () => {
    // The seam says a source with one level ignores `triangleBudget`; that is written for a
    // publisher whose levels are fixed. Graphene has one level and a continuous knob, so it is
    // the only source that can hit an arbitrary budget exactly — and the Meshes node's `Detail`
    // control is otherwise dead here.
    expect(decimateGridFor(1_500_000, 20)).toBeGreaterThan(decimateGridFor(150_000, 20))
    expect(decimateGridFor(1_500_000, 1)).toBeGreaterThan(decimateGridFor(1_500_000, 20))
    // Never so coarse that the arbor goes: `low` against a full set still clears the floor.
    expect(decimateGridFor(150_000, 20)).toBeGreaterThanOrEqual(48)
  })

  it('divides the fragment budget between the neurons in flight', async () => {
    // 32 was measured on *one* neuron. Three neurons at 32 apiece is 96 concurrent requests to
    // one host, past the point the measurement describes.
    expect(fragmentConcurrencyFor(1)).toBe(32)
    expect(fragmentConcurrencyFor(3)).toBeLessThan(32)
    expect(fragmentConcurrencyFor(3) * 3).toBeLessThanOrEqual(32)
  })

  it('says what a large graphene set will cost, and fetches it anyway', async () => {
    installFetch()
    /*
     * Built as text, not by adding to a number: `720575940000000000 + i` is past
     * `Number.MAX_SAFE_INTEGER`, so every element came out as the same string — invariant 8's
     * exact trap, reproduced inside a CAVE test. It passed, because only `.length` is read.
     */
    const ids = Array.from(
      { length: MESH_WARN_NEURONS + 1 },
      (_, i) => `7205759406288${String(57000 + i)}`,
    )
    expect(new Set(ids).size).toBe(ids.length)

    /*
     * This used to reject on the count alone. Twenty graphene meshes is a slow fetch, not an
     * impossible one, and the difference between those two is the whole of what `onWarn` was
     * added for — so what is pinned is that the warning is raised *and the fetch starts*. It
     * then dies on the stub, which serves no mesh fragments; that it got that far is the point.
     */
    const said: string[] = []
    await new CaveSource()
      .fetchMeshes({ datasetId: DATASET, neuronIds: ids, onWarn: (m) => said.push(m) })
      .catch(() => undefined)
    expect(said.join(' ')).toMatch(
      /no level of detail, so each one is dozens to hundreds of requests/,
    )
    // And it names the alternative, which for this datastack is not hypothetical: FlyWire's own
    // materializations were flattened, and only a stub with no bucket sends it down this route.
    expect(said.join(' ')).toMatch(
      /flat segmentation beside it does the same set in two requests/,
    )
    expect(said.join(' ')).toMatch(/Fetching anyway/)
  })
})

// ---------------------------------------------------------------------------

describe('a wired annotation chain', () => {
  const chain = {
    key: 'seaTable:base=main&table=info',
    table: makeTable(tableSchema(column('neuronId', 'str'), column('side', 'str')), {
      neuronId: ['720575940628857210', '720575940626838909', '999'],
      side: ['left', 'right', 'nobody'],
    }),
  }

  it('replaces the datastack’s labels in the rows, not just in the type', async () => {
    installFetch()
    const table = await new CaveSource().findNeurons({ datasetId: DATASET, annotations: chain })

    /*
     * The whole feature, and it was inert: `findNeurons` did not forward `req.annotations`, so
     * three query nodes advertised the chain's columns and returned the datastack's — and a
     * second complete index was built and cached under the unannotated key.
     */
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'side'])
    expect(table.data.side).toEqual(['left', 'right', null, null])
  })

  it('keeps every neuron the segmentation has, annotated or not', async () => {
    installFetch()
    const table = await new CaveSource().findNeurons({ datasetId: DATASET, annotations: chain })
    // A left join on the datastack's own list. The other direction would let an annotation base
    // decide which neurons *exist* — and those bases carry rows for ids edited away since.
    expect(table.length).toBe(4)
    expect(table.data.neuronId).not.toContain('999')
  })

  it('keys the index on the chain, so two datasets do not share one cached table', async () => {
    const captured = installFetch()
    const cave = new CaveSource()
    await cave.findNeurons({ datasetId: DATASET })
    const plain = captured.filter((c) => c.url.includes('/query?')).length
    await cave.findNeurons({ datasetId: DATASET, annotations: chain })
    // A second, differently-labelled index — not the first one handed back under its key.
    expect(captured.filter((c) => c.url.includes('/query?')).length).toBeGreaterThan(plain)
  })

  it('takes one row per neuron from a chain that repeats one, and takes the first', async () => {
    /*
     * The guarantee the providers now rely on rather than duplicating. `shapeRows` used to
     * collapse a repeated root id before the table ever left the annotation node, which hid a
     * real property of real data — measured against FlyTable's `main.info`: 58,340 rows over
     * 56,309 distinct ids, 1,089 neurons carrying more than one, and one segment appearing 104
     * times with its `side` disagreeing across them (a proofreading merge pulling many old
     * annotations onto one id).
     *
     * Collapsing it there changed nothing a Dataset saw — `dedupedIds` fixes the row order and
     * `annotationIndex` fixes the cells, both first-occurrence-wins — so all it did was keep the
     * one person who could resolve the conflict from seeing there was one. That is what this
     * pins: duplicates in, one row out, and the first row's value.
     */
    installFetch()
    const repeated = {
      key: 'seaTable:base=main&table=info',
      table: makeTable(tableSchema(column('neuronId', 'str'), column('side', 'str')), {
        neuronId: ['720575940628857210', '720575940628857210', '720575940626838909'],
        side: ['left', 'center', 'right'],
      }),
    }
    const table = await new CaveSource().findNeurons({
      datasetId: DATASET,
      annotations: repeated,
    })
    // Four neurons, as with the chain that repeats nothing — the extra row is not a neuron.
    expect(table.length).toBe(4)
    expect(table.data.side).toEqual(['left', 'right', null, null])
  })

  it('does not fetch the built-in annotations it is about to discard', async () => {
    const captured = installFetch()
    await new CaveSource().findNeurons({ datasetId: DATASET, annotations: chain })
    // Five queries of up to 139,255 rows, thrown away a line later.
    expect(
      captured.filter((c) => c.url.includes('/table/hierarchical_neuron_annotations/query')),
    ).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Connectivity without a roll-up view
// ---------------------------------------------------------------------------

/**
 * Most CAVE datastacks publish only a synapse table — `valid_connection_v2` is FlyWire having
 * done the aggregation once, and it is the exception. So the view is a fast path rather than a
 * requirement, and the general path counts synapses, which is `connecto`'s shape.
 */
describe('connectivity with no connection view', () => {
  const SYNAPTIC = 'synaptic_stack'
  const DATASET_SYN = `${SYNAPTIC}:1`

  /** The neuron list these ids live in — `typeLookup` runs beside every connectivity query. */
  const NUCLEI = JSON.stringify([
    { pt_root_id: 111, id: 1 },
    { pt_root_id: 222, id: 2 },
    { pt_root_id: 333, id: 3 },
  ])

  /** Three synapses A→B, one A→C: enough to show counting and a weight cut. */
  const SYNAPSE_ROWS = JSON.stringify([
    { pre_pt_root_id: 111, post_pt_root_id: 222 },
    { pre_pt_root_id: 111, post_pt_root_id: 222 },
    { pre_pt_root_id: 111, post_pt_root_id: 222 },
    { pre_pt_root_id: 111, post_pt_root_id: 333 },
  ])

  beforeEach(() => {
    registerDatastackSpec({
      datastack: SYNAPTIC,
      label: SYNAPTIC,
      description: 'synapses only',
      neurons: { table: 'nuclei', idColumn: 'pt_root_id' },
      synapses: {
        table: 'synapses',
        preColumn: 'pre_pt_root_id',
        postColumn: 'post_pt_root_id',
        positionColumn: 'ctr_pt_position',
      },
    })
  })

  it('counts synapses into weights when there is no view to ask', async () => {
    installFetch({ '/table/synapses/query': SYNAPSE_ROWS, '/table/nuclei/query': NUCLEI })
    const table = await new CaveSource().fetchConnectivity({
      datasetId: DATASET_SYN,
      neuronIds: ['111'],
      direction: 'outputs',
    })
    expect(table.data.partnerId).toEqual(['222', '333'])
    expect(table.data.weight).toEqual([3, 1])
  })

  it('asks for only the two id columns, which is what makes it affordable', async () => {
    const captured = installFetch({
      '/table/synapses/query': SYNAPSE_ROWS,
      '/table/nuclei/query': NUCLEI,
    })
    await new CaveSource().fetchConnectivity({
      datasetId: DATASET_SYN,
      neuronIds: ['111'],
      direction: 'outputs',
    })
    const body = captured.find((c) => c.url.includes('/table/synapses/query'))?.body as {
      select_columns?: string[]
    }
    expect(body?.select_columns).toEqual(['pre_pt_root_id', 'post_pt_root_id'])
  })

  it('cuts the weight after counting, since no server can do it before', async () => {
    installFetch({ '/table/synapses/query': SYNAPSE_ROWS, '/table/nuclei/query': NUCLEI })
    const table = await new CaveSource().fetchConnectivity({
      datasetId: DATASET_SYN,
      neuronIds: ['111'],
      direction: 'outputs',
      minWeight: 2,
    })
    // The A→C edge is gone, and nothing was pushed down — the view path's `atLeast` has no
    // synapse-level equivalent, so the whole table is transferred either way.
    expect(table.data.partnerId).toEqual(['222'])
  })

  it('filters on the queried end, so direction still means what it says', async () => {
    const captured = installFetch({
      '/table/synapses/query': SYNAPSE_ROWS,
      '/table/nuclei/query': NUCLEI,
    })
    await new CaveSource().fetchConnectivity({
      datasetId: DATASET_SYN,
      neuronIds: ['222'],
      direction: 'inputs',
    })
    const body = captured.find((c) => c.url.includes('/table/synapses/query'))?.body as {
      filter_in_dict?: unknown
    }
    expect(body?.filter_in_dict).toEqual({ synapses: { post_pt_root_id: ['222'] } })
  })

  it('prefers the view where one exists, rather than counting anyway', async () => {
    const captured = installFetch()
    await new CaveSource().fetchConnectivity({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
      direction: 'outputs',
    })
    // FlyWire's roll-up is orders of magnitude cheaper and can push the weight cut down with it.
    expect(captured.some((c) => c.url.includes('/views/valid_connection_v2/query'))).toBe(true)
    expect(captured.some((c) => c.url.includes('/table/synapses_nt_v1/query'))).toBe(false)
  })

  it('refuses when there is neither, naming both', async () => {
    registerDatastackSpec({
      datastack: 'bare',
      label: 'bare',
      description: 'nothing',
      neurons: { table: 'nuclei', idColumn: 'pt_root_id' },
    })
    installFetch({
      '/info/api/v2/datastack/full/': JSON.stringify({ local_server: 'https://x' }),
      '/table/nuclei/query': NUCLEI,
    })
    await expect(
      new CaveSource().fetchConnectivity({
        datasetId: 'bare:1',
        neuronIds: ['1'],
        direction: 'outputs',
      }),
    ).rejects.toThrow(/roll-up nor a synapse table/)
  })

  it('takes the datastack’s own declared synapse table when the spec names none', async () => {
    registerDatastackSpec({
      datastack: 'declared',
      label: 'declared',
      description: 'declares its own',
      neurons: { table: 'nuclei', idColumn: 'pt_root_id' },
    })
    const captured = installFetch({
      // 7 of 13 datastacks set this, Aedes among them — which is what lets one work with no
      // configuration at all.
      '/info/api/v2/datastack/full/': JSON.stringify({
        local_server: 'https://x',
        synapse_table: 'synapses',
      }),
      '/table/synapses/query': SYNAPSE_ROWS,
      '/table/nuclei/query': NUCLEI,
    })
    const table = await new CaveSource().fetchConnectivity({
      datasetId: 'declared:1',
      neuronIds: ['111'],
      direction: 'outputs',
    })
    expect(table.data.weight).toEqual([3, 1])
    expect(captured.some((c) => c.url.includes('/table/synapses/query'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// A datastack that publishes no neuron table
// ---------------------------------------------------------------------------

/**
 * Not every CAVE datastack has an equivalent of `proofread_neurons` — Aedes publishes synapses
 * and nuclei and nothing that enumerates neurons. There the chain *is* the neuron list, which is
 * the honest configuration rather than a fallback: a base keyed by root id is exactly an
 * enumeration, and the union of two such lists is two annotation nodes chained, since
 * `joinAnnotations` is a full outer join.
 */
describe('a datastack with no neuron table', () => {
  const BARE = 'bare_stack'
  const DATASET_BARE = `${BARE}:1`

  const chain = {
    key: 'seaTable:base=main&table=info',
    table: makeTable(tableSchema(column('neuronId', 'str'), column('side', 'str')), {
      // A repeat, because an annotation base is somebody's spreadsheet and can hold two rows
      // for one neuron — and a repeated id is double-counted by anything summing a weight.
      neuronId: ['720575940628857210', '999', '720575940628857210'],
      side: ['left', 'right', 'left'],
    }),
  }

  beforeEach(() => {
    registerDatastackSpec({
      datastack: BARE,
      label: BARE,
      description: 'no neuron table',
      connections: {
        view: 'valid_connection_v2',
        preColumn: 'pre_pt_root_id',
        postColumn: 'post_pt_root_id',
        weightColumn: 'n_syn',
      },
    })
  })

  it('takes the neuron list from the chain, deduplicated', async () => {
    installFetch()
    const table = await new CaveSource().findNeurons({
      datasetId: DATASET_BARE,
      annotations: chain,
    })
    // Every id the chain names — including `999`, which the FlyWire case deliberately drops.
    // There is no segmentation list to left-join onto; this *is* the list.
    expect(table.data.neuronId).toEqual(['720575940628857210', '999'])
    expect(table.data.side).toEqual(['left', 'right'])
  })

  it('reads no neuron table at all, since there is none to read', async () => {
    const captured = installFetch()
    await new CaveSource().findNeurons({ datasetId: DATASET_BARE, annotations: chain })
    expect(captured.filter((c) => c.url.includes('/query?'))).toHaveLength(0)
  })

  it('refuses with the wire to make, rather than answering no neurons', async () => {
    installFetch()
    // An empty table would read as a datastack with nothing in it, and the fix is a wire rather
    // than anything about the data — so it is worth naming.
    await expect(new CaveSource().findNeurons({ datasetId: DATASET_BARE })).rejects.toThrow(
      /Annotations source/,
    )
  })
})

// ---------------------------------------------------------------------------

describe('what it declines', () => {
  /*
   * Absent rather than throwing, which is what stops one missing capability taking a whole card
   * down: `out.profile` fetches its regions beside two connectivity queries in a `Promise.all`,
   * so a rejection here reported an error on every tile of a neuron whose partners had loaded.
   */
  it('offers no per-region counts at all, rather than a method that throws', () => {
    // Read through the interface, which is how every caller sees it: the class simply does not
    // declare the method, so a `CaveSource`-typed reference could not even ask.
    const source: DataSource = new CaveSource()
    expect(source.capabilities.roiCounts).toBe(false)
    expect(source.fetchRoiCounts).toBeUndefined()
  })

  it('declares meshes and synapses but not skeletons, paths or raw query', () => {
    const { capabilities } = new CaveSource()
    // Every false is a node that declines at edit time rather than failing at run time.
    expect(capabilities.paths).toBe(false)
    expect(capabilities.rawQuery).toBe(false)
    expect(capabilities.meshes).toBe(true)
    expect(capabilities.synapses).toBe(true)
    expect(capabilities.neuronIndex).toBe(true)
    /*
     * Skeletons are the one morphology CAVE has and this cannot use: the format is standard, but
     * the service is a cache that generates on demand and is empty for this datastack — 100
     * proofread root ids across skeleton versions 0 to 4 all answered `exists: false`. Claiming
     * it would make every Skeletons run hang rather than decline.
     */
    expect(capabilities.skeletons).toBe(false)
  })

  it('names the datastack when a dataset id has no wiring', async () => {
    installFetch()
    await expect(
      new CaveSource().neuronIndex({ datasetId: 'wclee_aedes_brain:1300' }),
    ).rejects.toThrow(/no wiring for the CAVE datastack "wclee_aedes_brain"/)
  })
})

// ---------------------------------------------------------------------------

describe('credentials', () => {
  it('reports a missing token on the channel rather than as a bare error', async () => {
    // No fetch stub: the point is that the client refuses before it would reach one.
    resetCredentials()
    const seen: string[] = []
    const stop = subscribeAuthFailure((m) => seen.push(m))

    await expect(new CaveSource().listDatasets()).rejects.toThrow(/No CAVE token/)
    expect(seen[0]).toMatch(/Add one in Connections/)
    stop()
  })

  it('reports a rejected token, and reads the status a browser is allowed to see', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"message":"Unauthorized"}'),
      } as Response),
    )
    const seen: string[] = []
    const stop = subscribeAuthFailure((m) => seen.push(m))

    await expect(new CaveSource().listDatasets()).rejects.toThrow(/rejected the token \(401\)/)
    // Only readable because CAVE sends `Access-Control-Allow-Origin` on its 401 as well —
    // verified live, and the whole reason this channel works at all.
    expect(seen).toHaveLength(1)
    stop()
  })

  /*
   * A sign-in's only visible difference from a paste is the label it carries, and the label is
   * how somebody sees they signed in with the wrong one of two Google accounts. So the half
   * worth pinning is the *clearing*: a token typed into the field must not inherit the last
   * sign-in's address, which would put a name on a credential that is not that account's.
   */
  it('labels a token that was signed in for, and drops the label when one is pasted', () => {
    resetCredentials()
    expect(getSession()).toBeUndefined()

    setToken('signed-in', { email: 'a@example.org', at: 1_700_000_000_000 })
    expect(getSession()).toEqual({ email: 'a@example.org', at: 1_700_000_000_000 })

    setToken('pasted-by-hand')
    expect(getSession()).toBeUndefined()

    setToken('signed-in-again', { at: 2 })
    setToken(undefined)
    expect(getSession()).toBeUndefined()
  })

  it('explains a validator refusal rather than printing its JSON at somebody', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve('{"schema_errors":{"select_columns":["Not a valid list."]}}'),
      } as Response),
    )
    await expect(new CaveSource().listDatasets()).rejects.toThrow(/invalid query/)
  })
})

// A channel with no listener must not throw — a peek has no caller to report to.
it('survives an auth failure nobody is listening for', () => {
  expect(() => reportAuthFailure('nobody home')).not.toThrow()
})

// ---------------------------------------------------------------------------
// A neuroglancer scene, built rather than published
// ---------------------------------------------------------------------------

/**
 * CAVE publishes no curated state per datastack, but its info record names every part of one.
 * Both source transformations here were established by *running* `caveclient`'s own formatters
 * on the real values, and one of them disagrees with it — see `imageSource`.
 */
describe('building a neuroglancer scene', () => {
  const INFO = {
    local_server: 'https://cave.fanc-fly.com',
    segmentation_source: 'graphene://https://cave.fanc-fly.com/segmentation/table/aedes',
    aligned_volume: { image_source: 'precomputed://gs://zetta_lee_mosquito/img/v2_sharded' },
    viewer_site: 'https://spelunker.cave-explorer.org/',
    viewer_resolution_x: 16,
    viewer_resolution_y: 16,
    viewer_resolution_z: 45,
  }

  const layers = (scene: Record<string, unknown> | undefined) =>
    (scene?.layers ?? []) as Array<Record<string, unknown>>

  it('publishes the segmentation plain, leaving middleauth+ to whoever opens it', () => {
    const scene = caveScene('aedes', INFO)
    const segmentation = layers(scene).find((l) => l.type === 'segmentation')
    /*
     * `caveclient`'s `format_graphene`, not `format_verbose_graphene`. The prefix is
     * spelunker's — `output_map` picks between the two by target site — and a scene is built
     * here with no idea which deployment will open it, so `sceneUrl` decides. This asserted the
     * opposite and passed, because its `viewer_site` above happens to be a spelunker one.
     */
    expect(segmentation?.source).toBe(
      'graphene://https://cave.fanc-fly.com/segmentation/table/aedes',
    )
  })

  it('passes the image source through, where caveclient answers None', () => {
    /*
     * `format_cave_explorer` routes a `precomputed://` scheme to `format_precomputed_neuroglancer`,
     * which handles `gs://`, `http://` and `https://` and falls through to None for a URL that
     * already carries its scheme — checked by running it. Every datastack probed publishes
     * exactly that form, so porting the formatter faithfully would ship no image layer at all.
     */
    expect(layers(caveScene('aedes', INFO)).find((l) => l.type === 'image')?.source).toBe(
      'precomputed://gs://zetta_lee_mosquito/img/v2_sharded',
    )
  })

  it('names the segmentation layer after the datastack, so the neuron ids land in it', () => {
    // `segmentationLayerIndex` matches the dataset id's family by name; anything else is found
    // only by the "first segmentation layer" fallback, which is luck rather than a rule.
    const scene = caveScene('aedes', INFO)
    expect(segmentationLayerIndex(scene!, 'aedes:490')).toBe(
      layers(scene).findIndex((l) => l.type === 'segmentation'),
    )
    expect(layers(scene).find((l) => l.type === 'segmentation')?.name).toBe('aedes')
  })

  it('converts the viewer resolution from nanometres to metres', () => {
    // `viewer_resolution_*` is nm per voxel and neuroglancer's dimensions are metres; a factor
    // out here misplaces everything with nothing failing.
    expect(caveScene('aedes', INFO)?.dimensions).toEqual({
      x: [1.6e-8, 'm'],
      y: [1.6e-8, 'm'],
      z: [4.5e-8, 'm'],
    })
  })

  it('leaves the dimensions out rather than guessing when none are published', () => {
    const scene = caveScene('aedes', { ...INFO, viewer_resolution_z: undefined })
    // Neuroglancer reads them off the sources; a partial guess would be silently wrong.
    expect(scene?.dimensions).toBeUndefined()
    expect(layers(scene)).toHaveLength(2)
  })

  it('builds a scene with no image layer rather than no scene', () => {
    const scene = caveScene('aedes', { ...INFO, aligned_volume: undefined })
    expect(layers(scene)).toHaveLength(1)
    expect(layers(scene)[0]?.type).toBe('segmentation')
  })

  it('answers nothing without a segmentation, which is the one part it cannot invent', () => {
    expect(caveScene('aedes', { ...INFO, segmentation_source: undefined })).toBeUndefined()
  })

  it('sets no layout, so a CAVE scene opens the way a neuPrint one does', () => {
    // `buildScene` supplies `layout` and `showSlices` when absent — a second rule here would be
    // a second place for the two to disagree.
    const scene = caveScene('aedes', INFO)
    expect(scene?.layout).toBeUndefined()
    expect(scene?.showSlices).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Skeletons from the level-2 chunk graph
// ---------------------------------------------------------------------------

/**
 * `fafbseg.flywire.get_l2_skeleton()`'s method: the graph of which level-2 chunks touch which,
 * plus a representative coordinate per chunk. The only real algorithm is turning an undirected,
 * possibly cyclic graph into a tree, and the three rules below are each a wrong picture if lost.
 */
describe('building a skeleton from the L2 graph', () => {
  // A real graphene source, so the URLs the module builds are checked against the paths
  // `installFetch` recognises rather than against a stub that answers everything.
  const SOURCE = {
    server: 'https://cave.fanc-fly.com',
    table: 'wclee_fly_cns_001_public',
    base: 'https://cave.fanc-fly.com/segmentation/table/wclee_fly_cns_001_public',
  }

  const one = async () => (await readL2Skeletons(SOURCE, ['1'], {}))[0]

  it('turns the chunk graph into a tree with one root', async () => {
    installFetch({ '/lvl2_graph': CHAIN, '/attributes': COORDS })
    const sk = await one()
    expect(sk?.parents).toHaveLength(4)
    expect([...sk!.parents].filter((p) => p === -1)).toHaveLength(1)
    for (const p of sk!.parents) expect(p).toBeLessThan(4)
  })

  it('emits points in visit order, so a parent always precedes its child', async () => {
    /*
     * `neuprint/decode.ts` does real work to guarantee this and `SkeletonGeometry` states it;
     * emitting in chunk-id order would satisfy the type and break every consumer that walks the
     * array once, the SWC writer included.
     *
     * The edges are deliberately given so that *encounter* order (3, 4, 1, 2) differs from
     * *visit* order (3, 4, 2, 1) — on a chain listed front to back the two coincide, and a test
     * built on one passes whichever the code emits.
     */
    installFetch({
      '/lvl2_graph': JSON.stringify({
        edge_graph: [
          ['3', '4'],
          ['1', '2'],
          ['2', '3'],
        ],
      }),
      '/attributes': COORDS,
    })
    const sk = await one()
    // Positions follow the walk: chunk 3 is the root, then 4 and 2, then 1.
    expect([...sk!.positions].filter((_, i) => i % 3 === 0)).toEqual([30, 40, 20, 10])
    for (let i = 0; i < sk!.parents.length; i++) expect(sk!.parents[i]!).toBeLessThan(i)
  })

  it('carries the cache’s coordinates and radius, in nanometres', async () => {
    installFetch({ '/lvl2_graph': CHAIN, '/attributes': COORDS })
    const sk = await one()
    expect([...sk!.positions.slice(0, 3)]).toEqual([10, 0, 0])
    expect([...sk!.radii].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  it('breaks a cycle rather than emitting one', async () => {
    installFetch({
      '/lvl2_graph': JSON.stringify({
        edge_graph: [
          ['1', '2'],
          ['2', '3'],
          ['3', '1'],
        ],
      }),
      '/attributes': COORDS,
    })
    const sk = await one()
    expect(sk?.parents).toHaveLength(3)
    for (let i = 0; i < sk!.parents.length; i++) {
      let steps = 0
      for (let at = sk!.parents[i]!; at !== -1; at = sk!.parents[at]!) {
        if (++steps > sk!.parents.length) throw new Error('parents form a cycle')
      }
    }
  })

  it('gives each disconnected component its own root', async () => {
    installFetch({
      '/lvl2_graph': JSON.stringify({
        edge_graph: [
          ['1', '2'],
          ['3', '4'],
        ],
      }),
      '/attributes': COORDS,
    })
    expect([...(await one())!.parents].filter((p) => p === -1)).toHaveLength(2)
  })

  it('drops a chunk the cache has never heard of, keeping the rest connected', async () => {
    installFetch({
      '/lvl2_graph': CHAIN,
      '/attributes': JSON.stringify({ '1': chunkAt(1), '2': chunkAt(2), '4': chunkAt(4) }),
    })
    const sk = await one()
    expect(sk?.parents).toHaveLength(3)
    // 3 is gone, so 4 is its own root rather than hanging off nothing.
    expect([...sk!.parents].filter((p) => p === -1)).toHaveLength(2)
  })

  it('answers nothing for a neuron of a single chunk', async () => {
    installFetch({ '/lvl2_graph': JSON.stringify({ edge_graph: [] }), '/attributes': COORDS })
    expect(await readL2Skeletons(SOURCE, ['1'], {})).toEqual([])
  })

  it('asks for every neuron’s chunks in one attributes request, not one each', async () => {
    /*
     * The call is keyed by *table*, not by root id, so the union of every neuron's chunks goes
     * in one request however many neurons were asked for. Measured: 1,177 chunks answered in
     * 1.64 s against roughly that for *each* of the twelve neurons they came from.
     */
    const captured = installFetch({ '/lvl2_graph': CHAIN, '/attributes': COORDS })
    await readL2Skeletons(SOURCE, ['1', '2', '3'], {})
    expect(captured.filter((c) => c.url.includes('/lvl2_graph'))).toHaveLength(3)
    expect(captured.filter((c) => c.url.includes('/attributes'))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------

/**
 * Two independent ways a CAVE dataset can have skeletons, and why both have to be asked.
 *
 * `flywire_fafb_public` is the case that forced this: it has **no** level-2 cache, so the peek
 * settled on a confident `false` and the Skeletons node refused — while
 * `gs://flywire_v141_m783/skeletons_mip_1` sat beside the datastack publishing them, unmentioned
 * anywhere in CAVE's own metadata.
 */
describe('where a CAVE skeleton comes from', () => {
  it('reports skeletons once the flat bucket has answered, on a datastack with no L2 cache', async () => {
    installFetch({}, { flat: true })
    const source = new CaveSource()

    // The first look cannot answer and starts the read — `peekL2Cache`'s contract, and the
    // reason `capabilitiesFor` may not await one (invariant 2).
    expect(source.capabilitiesFor!(DATASET)?.skeletons).not.toBe(true)
    await probeFlat(specFor(DATASTACK)!, VERSION)
    expect(source.capabilitiesFor!(DATASET)).toEqual({ skeletons: true })
  })

  it('takes the published skeletons over the chunk graph, and never asks the L2 cache', async () => {
    /*
     * They are not the same product. A published skeleton is a mip-1 skeletonisation — measured
     * across ten FlyWire v783 neurons, 14,559 to 338,087 nodes each — where an L2 skeleton is one
     * node per level-2 chunk. It is also one request per neuron rather than two.
     */
    const captured = installFetch({}, { flat: true })
    await new CaveSource().fetchSkeletons!({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
    }).catch(() => undefined)
    expect(captured.filter((c) => c.url.includes('/lvl2_graph'))).toEqual([])
    expect(captured.map((c) => c.url)).toContain(
      'https://storage.googleapis.com/flywire_v141_m783/skeletons_mip_1/info',
    )
  })

  it('lists the routes a dataset has, best first, as the peeks land', async () => {
    /*
     * The list is what the Skeletons node's dropdown is built from, and its *order* is what
     * "Automatic" names — so it has to be the same order `fetchSkeletons` walks. FlyWire public
     * is the useful case: a flat bucket, a declared service whose cache is empty, and no L2
     * cache at all.
     */
    installFetch({}, { flat: true, service: 'empty' })
    const source = new CaveSource()

    // Nothing has landed, so nothing is offered — `capabilitiesFor`'s contract, and the reason
    // this is legal to call from `inferOutputs` (invariant 2).
    expect(source.skeletonSourcesFor!(DATASET)).toBeUndefined()

    await probeFlat(specFor(DATASTACK)!, VERSION)
    await skeletonServiceFor(DATASTACK)
    /*
     * The service is offered even though its cache is empty, which is deliberate: whether it can
     * answer is a question about *these* root ids and is asked at fetch time. Hiding it here
     * would mean a build-time list of which deployments have generated anything, which goes stale
     * in the direction of concealing a route that works.
     */
    expect(source.skeletonSourcesFor!(DATASET)?.map((r) => r.id)).toEqual(['published', 'service'])
  })

  it('reads a middleauth-prefixed service URL as an ordinary one', () => {
    // MICrONS sets the prefix and Janelia does not; it is neuroglancer's way of saying "this
    // needs a token", which every call to the service carries anyway.
    expect(
      skeletonServiceUrl(
        'precomputed://middleauth+https://minnie.microns-daf.com/skeletoncache/api/v1/minnie65_public/precomputed/skeleton/',
      ),
    ).toBe('https://minnie.microns-daf.com/skeletoncache/api/v1/minnie65_public/precomputed/skeleton')
    expect(skeletonServiceUrl(null)).toBeUndefined()
    expect(skeletonServiceUrl('gs://a-bucket/skeletons')).toBeUndefined()
  })

  it('offers the service alongside the chunk graph, and prefers it', async () => {
    // minnie65_public's shape: an L2 cache *and* a populated service. The service is the better
    // reconstruction — ~7,000 vertices with radii against a few hundred chunk nodes — so it
    // leads, and `capabilitiesFor` is derived from the same list rather than asked separately.
    installFetch({ '/l2cache/api/v1/table_mapping': L2_MAPPING }, { service: 'full' })
    const source = new CaveSource()
    await l2SourceFor(DATASTACK)
    await skeletonServiceFor(DATASTACK)
    expect(source.skeletonSourcesFor!(DATASET)?.map((r) => r.id)).toEqual(['service', 'l2'])
    expect(source.capabilitiesFor!(DATASET)).toEqual({ skeletons: true })
  })

  it('takes the service only when it covers every neuron, and asks before fetching', async () => {
    /*
     * A GET for a root id the cache has never seen routes to a *generation* — 10–45 s a neuron
     * against 1.5 s cached — so `exists` is asked first, always. And a partial answer is not
     * taken: a scene mixing a real reconstruction with a chunk decomposition is one where cable
     * length silently means two things, which is worse than the coarse answer taken whole.
     */
    const full = installFetch({ '/l2cache/api/v1/table_mapping': L2_MAPPING }, { service: 'full' })
    const answered = await new CaveSource().fetchSkeletons!({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
    })
    expect(answered.provenance?.id).toBe('service')
    expect(answered.items).toHaveLength(1)
    expect(full.some((c) => c.url.endsWith('/precomputed/skeleton/exists'))).toBe(true)
    expect(full.filter((c) => c.url.includes('/lvl2_graph'))).toEqual([])
  })

  it('falls back to the chunk graph when the declared service holds nothing', async () => {
    // `flywire_fafb_public` and BANC both declare a service with an empty cache, so this is the
    // ordinary case rather than an edge one — and it must not surface as an error.
    const captured = installFetch(
      { '/l2cache/api/v1/table_mapping': L2_MAPPING, '/lvl2_graph': CHAIN, '/attributes': COORDS },
      { service: 'empty' },
    )
    const answered = await new CaveSource().fetchSkeletons!({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
    })
    expect(answered.provenance?.id).toBe('l2')
    expect(captured.some((c) => c.url.includes('/lvl2_graph'))).toBe(true)
  })

  it('refuses a pinned route the dataset does not have rather than substituting one', async () => {
    /*
     * The substitution is the failure being prevented: answering with the chunk graph because
     * the published bucket is absent would silently change what every cable length downstream
     * means, under a card that still said "published skeletons".
     */
    installFetch({ '/l2cache/api/v1/table_mapping': L2_MAPPING, '/lvl2_graph': CHAIN, '/attributes': COORDS })
    await expect(
      new CaveSource().fetchSkeletons!({
        datasetId: DATASET,
        neuronIds: ['720575940628857210'],
        skeletonSource: 'published',
      }),
    ).rejects.toThrow(/publishes no flat skeleton bucket/)
  })

  it('says both routes were looked for when neither datastack has one', async () => {
    // The message a user gets is the one thing that must not name only half of what was tried.
    installFetch()
    registerDatastackSpec({
      datastack: 'no_skeletons',
      label: 'Bare',
      description: 'live',
      neurons: { table: 'cell_info', idColumn: 'pt_root_id' },
    })
    await expect(
      new CaveSource().fetchSkeletons!({ datasetId: 'no_skeletons:1', neuronIds: ['1'] }),
    ).rejects.toThrow(/no level-2 cache.*no published skeletons/s)
  })
})

// ---------------------------------------------------------------------------
// Discovery: what a datastack holds, and what one table of it is
// ---------------------------------------------------------------------------

/**
 * The reads behind `List CAVE tables` and `CAVE table info`.
 *
 * Two of these assertions are about a *route* rather than a result, and they are the ones the
 * fixture stub is shaped for: the tables listing sits on a **v2** path inside the v3 API, and a
 * view is answered from the listing rather than from a metadata endpoint that does not exist.
 * Both were established live (see `tables.ts`) and neither is in any published contract.
 */
describe('CAVE discovery', () => {
  const path = (calls: Captured[]) => calls.map((c) => c.url)

  it('lists tables off the v2 path and views off the v3 one, tables first and sorted', async () => {
    const captured = installFetch()
    const entries = await tableListFor(DATASTACK, VERSION)
    expect(entries).toEqual([
      { name: 'fly_synapses_neuropil_v6', kind: 'table' },
      { name: 'hierarchical_neuron_annotations', kind: 'table' },
      { name: 'neuron_information_v2', kind: 'table' },
      { name: 'nuclei_v1', kind: 'table' },
      { name: 'proofread_neurons', kind: 'table' },
      { name: 'synapses_nt_v1', kind: 'table' },
      { name: 'nt_summary_view', kind: 'view' },
      { name: 'proofread_neurons_view', kind: 'view' },
      { name: 'valid_connection_v2', kind: 'view' },
    ])
    expect(path(captured)).toContain(
      'https://prod.flywire-daf.com/materialize/api/v2/datastack/flywire_fafb_public/version/783/tables',
    )
    expect(path(captured)).toContain(
      'https://prod.flywire-daf.com/materialize/api/v3/datastack/flywire_fafb_public/version/783/views',
    )
  })

  it('asks for no views when the node’s toggle is off', async () => {
    const captured = installFetch()
    const entries = await tableListFor(DATASTACK, VERSION, {}, false)
    expect(entries.every((e) => e.kind === 'table')).toBe(true)
    expect(path(captured).some((u) => u.endsWith('/views'))).toBe(false)
  })

  it('memoises the listing, so two nodes on one datastack cost one pair of requests', async () => {
    const captured = installFetch()
    await Promise.all([tableListFor(DATASTACK, VERSION), tableListFor(DATASTACK, VERSION)])
    await tableListFor(DATASTACK, VERSION)
    expect(path(captured).filter((u) => u.endsWith('/tables'))).toHaveLength(1)
    expect(path(captured).filter((u) => u.endsWith('/views'))).toHaveLength(1)
  })

  /*
   * The peek's contract, which is `peekMaterializations`': `undefined` means "not yet", not
   * "none". Read from a card that renders on every graph mutation, so the second half — one
   * fetch however many times it is asked — is what stops a request per keystroke.
   */
  it('peeks undefined and starts exactly one fetch, however many times it is asked', async () => {
    const captured = installFetch()
    expect(peekTableList(DATASTACK, VERSION)).toBeUndefined()
    expect(peekTableList(DATASTACK, VERSION)).toBeUndefined()
    expect(peekTableList(DATASTACK, VERSION)).toBeUndefined()
    await tableListFor(DATASTACK, VERSION)
    expect(peekTableList(DATASTACK, VERSION)).toHaveLength(9)
    expect(path(captured).filter((u) => u.endsWith('/tables'))).toHaveLength(1)
  })

  it('reads a table’s facts, and keeps the two row counts apart', async () => {
    installFetch()
    const facts = await tableFactsFor(DATASTACK, VERSION, 'proofread_neurons')
    // The measured disagreement, fixtured: the annotation service counts the table as it
    // stands, the materialization engine counts what v783 froze.
    expect(facts.rows).toBe(139540)
    expect(facts.materializedRows).toBe(127978)
  })

  it('trims a description, drops a null notice, and leaves a 1:1 resolution off', async () => {
    installFetch()
    const facts = await tableFactsFor(DATASTACK, VERSION, 'nuclei_v1')
    expect(facts.kind).toBe('table')
    expect(facts.schemaType).toBe('nucleus_detection')
    expect(facts.description?.startsWith('FlyWire nucleus description')).toBe(true)
    // `notice_text` is null on every table probed; a card rendering "null" would be reporting
    // the encoding rather than the absence.
    expect(facts.notice).toBeUndefined()
    expect(facts.referenceTable).toBeUndefined()
    // Every FlyWire table stores positions in nanometres already, so the row says nothing.
    expect(facts.voxelResolution).toBeUndefined()
    expect(facts.readPermission).toBe('PUBLIC')
  })

  /*
   * A view has no metadata endpoint and no count — `/table/{v}/metadata` 404s and
   * `/table/{v}/count` answers a **500** wrapping a 404 — so its description has to come from the
   * listing. What this asserts is the absence: neither request is issued.
   */
  it('describes a view from the listing, asking no metadata endpoint and no count', async () => {
    const captured = installFetch()
    const facts = await tableFactsFor(DATASTACK, VERSION, 'valid_connection_v2')
    expect(facts.kind).toBe('view')
    expect(facts.description?.startsWith('This is a summary table')).toBe(true)
    expect(facts.rows).toBeUndefined()
    expect(facts.materializedRows).toBeUndefined()
    expect(path(captured).some((u) => u.includes('valid_connection_v2/metadata'))).toBe(false)
    expect(path(captured).some((u) => u.includes('valid_connection_v2/count'))).toBe(false)
  })

  it('names every table in the datastack when the one asked for is not in it', async () => {
    installFetch()
    await expect(tableFactsFor(DATASTACK, VERSION, 'nuclei_v2')).rejects.toThrow(
      /not a table or view.*Available: fly_synapses_neuropil_v6/s,
    )
  })

  /*
   * A count is the supplementary half of the card — the metadata and the columns are what it is
   * for — so a service that declines one should leave a row off rather than taking the node down.
   */
  it('leaves a count off rather than failing when the service declines it', async () => {
    installFetch()
    // The overrides answer 200, and what has to be exercised here is a *refusal* — so the one
    // endpoint is layered over the stub rather than routed through it.
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      String(url).includes('/annotation/api/v2/aligned_volume/')
        ? Promise.resolve({
            ok: false,
            status: 404,
            text: () => Promise.resolve('{"message":"no such table"}'),
          } as Response)
        : inner(url, init),
    )
    const facts = await tableFactsFor(DATASTACK, VERSION, 'nuclei_v1')
    expect(facts.rows).toBeUndefined()
    expect(facts.materializedRows).toBe(143140)
    expect(facts.schemaType).toBe('nucleus_detection')
  })

  it('gates the facts peek on the listing, so a half-typed name requests nothing', async () => {
    const captured = installFetch()
    // The listing has not landed, so nothing about a name can be decided yet.
    expect(peekTableFacts(DATASTACK, VERSION, 'nucl')).toBeUndefined()
    await tableListFor(DATASTACK, VERSION)
    const before = captured.length
    // Now it has, and `nucl` is not in it — so still nothing, and still no request.
    expect(peekTableFacts(DATASTACK, VERSION, 'nucl')).toBeUndefined()
    expect(captured).toHaveLength(before)
    // A real name does start one.
    expect(peekTableFacts(DATASTACK, VERSION, 'nuclei_v1')).toBeUndefined()
    await tableFactsFor(DATASTACK, VERSION, 'nuclei_v1')
    expect(peekTableFacts(DATASTACK, VERSION, 'nuclei_v1')?.schemaType).toBe(
      'nucleus_detection',
    )
  })

  /*
   * Invariant 8 at this seam. `pt_root_id` is eighteen digits and `pt_supervoxel_id` seventeen —
   * both beyond a float64 — so `json.ts` quotes them before the parser sees them, and the column
   * listing reports `str` because that *is* what any consumer of this table gets.
   */
  it('samples one row for the columns, keeping a wide id exact and as text', async () => {
    const captured = installFetch()
    const columns = await tableColumnsFor(DATASTACK, VERSION, 'nuclei_v1', 'table')
    const by = new Map(columns.map((c) => [c.name, c]))

    expect(captured.at(-1)?.body).toMatchObject({ limit: 1 })
    expect(by.get('pt_root_id')).toEqual({
      name: 'pt_root_id',
      dtype: 'str',
      example: '720575940626838909',
    })
    expect(by.get('pt_supervoxel_id')?.example).toBe('82827379285852979')
    expect(by.get('volume')?.dtype).toBe('f64')
    expect(by.get('pt_position_x')?.dtype).toBe('i64')
    // `valid` arrives as the string "t", not a JSON boolean — so `bool` would be a claim the
    // wire does not support.
    expect(by.get('valid')).toEqual({ name: 'valid', dtype: 'str', example: 't' })
    // The documented hole: one row says nothing about a column whose one value is null, and a
    // blank dtype is an admission where `str` would be a guess.
    expect(by.get('superceded_id')).toEqual({ name: 'superceded_id', example: '' })
  })

  it('reads no columns off an empty result rather than inventing them', async () => {
    installFetch({ '/table/nuclei_v1/query': '[]' })
    expect(await tableColumnsFor(DATASTACK, VERSION, 'nuclei_v1', 'table')).toEqual([])
  })
})
