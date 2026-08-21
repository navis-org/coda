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
import { CaveSource } from './CaveSource'
import { CAVE_MAX_ROWS } from './client'
import { resetDatastackRecords } from './datastack'
import { registerDatastackSpec, resetRuntimeSpecs } from './spec'
import { MAX_MESH_NEURONS, decimateGridFor, fragmentConcurrencyFor } from './meshes'
import { quoteWideIntegers, parseCaveJson } from './json'
import { reportAuthFailure, resetCredentials, setToken, subscribeAuthFailure } from './credentials'

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8')

const DATASET = 'flywire_fafb_public:783'
/** The query args every table and view request carries; see `api.ts`. */
const QUERY_ARGS = 'return_pyarrow=false&arrow_format=false&split_positions=false'

interface Captured {
  url: string
  body?: unknown
}

/**
 * A fetch that answers from the fixtures and records what was asked for.
 *
 * Matched on the *path*, because half of what this suite is checking is that the right endpoint
 * was called — `tables` living on a v2 path inside the v3 API, a view query going to `/views/`
 * rather than `/table/` — and a stub that answered everything would hide exactly that.
 */
function installFetch(overrides: Record<string, string> = {}): Captured[] {
  const captured: Captured[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    captured.push({ url, ...(body ? { body } : {}) })
    const answer = (text: string) =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) } as Response)

    for (const [fragment, text] of Object.entries(overrides)) {
      if (url.includes(fragment)) return answer(text)
    }
    if (url.includes('/info/api/v2/datastacks')) return answer(fixture('datastacks.json'))
    if (url.includes('/info/api/v2/datastack/full/')) return answer(fixture('datastack-flywire.json'))
    if (url.includes('/materialize/api/v3/datastack/flywire_fafb_public/metadata'))
      return answer(fixture('versions.json'))
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
    if (url.includes('/views/valid_connection_v2/query')) return answer(fixture('connections.txt'))
    if (url.includes('/table/synapses_nt_v1/query')) return answer(fixture('synapses.txt'))
    if (url.includes('/segmentation/1.0/flywire_public/info'))
      return answer(fixture('segmentation.json'))
    if (url.includes('/meshing/api/v1/table/flywire_public/manifest/'))
      return answer(fixture('mesh-manifest.json'))
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
  // The datastack record is memoised at module level now that the annotation providers share
  // it, so it outlives a test file without this.
  resetDatastackRecords()
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
    ])
    expect(datasets[0]!.version).toBe('783')
    expect(datasets[0]!.description).toMatch(/Materialization 783 materialized 2023-09-30/)
    expect(datasets[0]!.description).toMatch(/expires 2121-11-10/)
  })

  it('asks the datastack’s own server for its versions, not the global one', async () => {
    const captured = installFetch()
    await new CaveSource().listDatasets()

    // `local_server` out of the info record. A listing built against the global server answers
    // 404 for every datastack, and the two are different hosts on every deployment.
    expect(captured.map((c) => c.url)).toEqual([
      'https://global.daf-apis.com/info/api/v2/datastacks',
      'https://global.daf-apis.com/info/api/v2/datastack/full/flywire_fafb_public',
      'https://prod.flywire-daf.com/materialize/api/v3/datastack/flywire_fafb_public/metadata',
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

    const neurons = captured.find((c) => c.url.includes('/table/proofread_neurons/query'))!
    // A *list*: this endpoint rejects the table-keyed map outright, and a join accepts it while
    // silently taking the first column of that name from whichever table has one.
    expect(neurons.body).toEqual({ select_columns: ['id', 'pt_root_id'] })
    expect(neurons.url).toContain('arrow_format=false')

    /*
     * One annotation request per kind, which is what keeps each under CAVE's 500,000-row cap —
     * the whole table is over it, live, however much the row-count endpoint says otherwise.
     */
    const annotations = captured.filter((c) =>
      c.url.includes('/table/hierarchical_neuron_annotations/query'),
    )
    expect(annotations).toHaveLength(5)
    expect(annotations[0]!.body).toEqual({
      filter_equal_dict: { hierarchical_neuron_annotations: { classification_system: 'cell_class' } },
      select_columns: ['target_id', 'cell_type'],
    })
  })

  it('refuses rather than handing back a silently truncated index', async () => {
    const capped = JSON.stringify(
      Array.from({ length: CAVE_MAX_ROWS }, (_, i) => ({ id: i, pt_root_id: String(i) })),
    )
    installFetch({ '/table/proofread_neurons/query': capped })

    // The server says so in a `warning` header its CORS policy does not expose, so counting is
    // the only tell a browser has. A short index is not a visible failure — it is a dataset
    // that quietly lacks neurons.
    await expect(new CaveSource().neuronIndex({ datasetId: DATASET })).rejects.toThrow(
      /truncated "proofread_neurons" at 500,000 rows/,
    )
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
    expect((await cave.findNeurons({ datasetId: DATASET, typePattern: 'CB.*' })).length).toBe(1)
    // Anchored: the pattern has to describe the whole value.
    expect((await cave.findNeurons({ datasetId: DATASET, typePattern: 'B09' })).length).toBe(0)
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
    expect((query.body as { desired_resolution?: number[] }).desired_resolution).toEqual([1, 1, 1])
  })

  it('reads positions as a point cloud in nanometres, one attribute row apiece', async () => {
    installFetch()
    const points = await new CaveSource().fetchSynapses({
      datasetId: DATASET,
      neuronIds: ['720575940628857210'],
      polarity: 'pre',
    })

    expect(points.units).toBe('nm')
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
    const queries = captured.filter((c) => c.url.includes('/table/synapses_nt_v1/query'))
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

    const fragment = captured.find((c) => c.url.includes('storage.googleapis.com'))!
    expect(fragment.url).toContain(
      '/seunglab2/drosophila_v0/ws_190410_FAFB_v02_ws_size_threshold_200/fly_v31_meshes_v2_062619/',
    )
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

  it('refuses a set no graphene segmentation could serve, and says why', async () => {
    installFetch()
    /*
     * Built as text, not by adding to a number: `720575940000000000 + i` is past
     * `Number.MAX_SAFE_INTEGER`, so every element came out as the same string — invariant 8's
     * exact trap, reproduced inside a CAVE test. It passed, because only `.length` is read.
     */
    const ids = Array.from(
      { length: MAX_MESH_NEURONS + 1 },
      (_, i) => `7205759406288${String(57000 + i)}`,
    )
    expect(new Set(ids).size).toBe(ids.length)
    await expect(
      new CaveSource().fetchMeshes({ datasetId: DATASET, neuronIds: ids }),
    ).rejects.toThrow(/no level of detail, so each one is several hundred requests/)
  })
})

// ---------------------------------------------------------------------------

describe('a wired annotation chain', () => {
  const chain = {
    kind: 'annotations' as const,
    sources: ['seaTable:base=main&table=info'],
    table: makeTable(
      tableSchema(column('neuronId', 'str'), column('side', 'str')),
      {
        neuronId: ['720575940628857210', '720575940626838909', '999'],
        side: ['left', 'right', 'nobody'],
      },
    ),
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
    kind: 'annotations' as const,
    sources: ['seaTable:base=main&table=info'],
    table: makeTable(
      tableSchema(column('neuronId', 'str'), column('side', 'str')),
      {
        // A repeat, because an annotation base is somebody's spreadsheet and can hold two rows
        // for one neuron — and a repeated id is double-counted by anything summing a weight.
        neuronId: ['720575940628857210', '999', '720575940628857210'],
        side: ['left', 'right', 'left'],
      },
    ),
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
      new CaveSource().neuronIndex({ datasetId: 'minnie65_public:1300' }),
    ).rejects.toThrow(/no wiring for the CAVE datastack "minnie65_public"/)
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
