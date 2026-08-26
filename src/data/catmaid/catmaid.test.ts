/**
 * CATMAID against recorded responses.
 *
 * The fixtures are real, trimmed: `annotationlist.json` covers the three label shapes that
 * matter (a type with a `#`, one without, and a free-text name that disagrees with both), and
 * `compact-detail.json` is a genuine 60-node subtree of skeleton 16 with its root intact.
 *
 * What is tested here is what would produce a **plausible wrong answer** rather than an error:
 * the confidence-bucket sum, the parent rebuild, the list encoding, and which route a request
 * can take. Everything shaped like plumbing is left to `live.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import annotationListFixture from './__fixtures__/annotationlist.json'
import compactDetailFixtureRaw from './__fixtures__/compact-detail.json'
import connectivityFixture from './__fixtures__/connectivity.json'
import linksFixture from './__fixtures__/links.json'
import projectsFixture from './__fixtures__/projects.json'
import volumeFixture from './__fixtures__/volume-485.json'
import volumesFixture from './__fixtures__/volumes.json'
import { resetCache } from '../cache'
import { resetIndexLoads } from '../neuronIndex'
import { CatmaidSource } from './CatmaidSource'
import type { AnnotationListResponse } from './api'
import { synapseWeight } from './api'
import { labelsForSkeleton, readVocabulary, typeFromLabel } from './annotations'
import { encodeParams, forgetCatmaidRoutes } from './client'
import {
  credentialsFor,
  hostPattern,
  listInstances,
  matchesHost,
  resetCredentials,
  setInstances,
} from './credentials'
import { parseX3dMesh } from './x3d'

const SERVER = 'https://catmaid.example.org'
const annotations = annotationListFixture as unknown as AnnotationListResponse
/** The JSON import widens the tuple to a union; the fixture really is `[nodes, links, tags]`. */
const compactDetailFixture = compactDetailFixtureRaw as unknown as {
  skeletonId: number
  skeleton: [unknown[], unknown[], Record<string, number[]>]
}

/** Every request the stub saw, so a test can assert on what went over the wire. */
let calls: { url: string; method: string; body: string; headers: Record<string, string> }[] = []

function stubFetch(route: (path: string) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input)
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>,
      )) {
        headers[key.toLowerCase()] = value
      }
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: String(init?.body ?? ''),
        headers,
      })
      const body = route(url)
      if (body === undefined) {
        return Promise.resolve(new Response('{"detail":"not stubbed"}', { status: 404 }))
      }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    }),
  )
}

/**
 * Route on the **path**, with the query string stripped.
 *
 * Matching on the whole URL is how a stub comes to answer `/skeletons/16/compact-detail?…` with
 * the skeleton *list*, because the query defeats an `endsWith`. That is a bug in the harness
 * that reads exactly like a bug in the decoder.
 */
function defaultRoutes(url: string): unknown {
  const path = url.split('?')[0] ?? ''
  if (path.endsWith('/projects/')) return projectsFixture
  if (path.endsWith('/compact-detail')) return compactDetailFixture.skeleton
  if (path.endsWith('/skeleton/annotationlist')) return annotations
  if (path.endsWith('/skeletons/connectivity')) return connectivityFixture
  if (path.endsWith('/skeletons/summary')) return {}
  if (path.endsWith('/skeletons/cable-length')) return {}
  if (path.endsWith('/connectors/links/')) return linksFixture
  if (/\/volumes\/\d+$/.test(path)) return volumeFixture
  if (path.endsWith('/volumes/')) return volumesFixture
  if (path.endsWith('/skeletons/')) return [16, 430, 6582]
  return undefined
}

function source(): CatmaidSource {
  return new CatmaidSource(SERVER, 'catmaid-test', 'CATMAID (test)')
}

beforeEach(() => {
  calls = []
  resetCredentials()
  forgetCatmaidRoutes()
  // The index cache is module-level and shared, so without this a later test is served the
  // table an earlier one built and makes no request at all — which reads as a routing bug.
  resetCache()
  resetIndexLoads()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetCredentials()
  forgetCatmaidRoutes()
})

describe('which instance a request uses', () => {
  it('accepts every spelling of a host somebody might paste', () => {
    for (const typed of [
      'https://catmaid.example.org',
      'catmaid.example.org/',
      'http://catmaid.example.org:8080/catmaid/',
      'CATMAID.example.org',
    ]) {
      expect(hostPattern(typed)).toBe('catmaid.example.org')
    }
  })

  it('matches a wildcard at any depth, but never across a label boundary', () => {
    expect(matchesHost('*.virtualflybrain.org', 'catmaid-fafb.virtualflybrain.org')).toBe(true)
    expect(matchesHost('*.virtualflybrain.org', 'a.b.virtualflybrain.org')).toBe(true)
    // The literal dot is required, which is what stops a pattern reaching a host somebody else
    // registered — this is the case that would leak a token.
    expect(matchesHost('*.virtualflybrain.org', 'notvirtualflybrain.org')).toBe(false)
    expect(matchesHost('*.virtualflybrain.org', 'virtualflybrain.org')).toBe(false)
    expect(matchesHost('*.virtualflybrain.org', 'virtualflybrain.org.evil.com')).toBe(false)
  })

  it('refuses a pattern with no literal characters rather than matching everything', () => {
    expect(matchesHost('*', 'anything.example.org')).toBe(false)
    expect(matchesHost('*.*', 'anything.example.org')).toBe(false)
  })

  it('prefers the most specific row, not the first', () => {
    setInstances([
      { server: '*.example.org', token: 'wide' },
      { server: 'special.example.org', token: 'exact' },
      { server: '*.sub.example.org', token: 'narrower' },
    ])
    expect(credentialsFor('https://special.example.org')?.token).toBe('exact')
    expect(credentialsFor('https://other.example.org')?.token).toBe('wide')
    expect(credentialsFor('https://a.sub.example.org')?.token).toBe('narrower')
    expect(credentialsFor('https://elsewhere.com')).toBeUndefined()
  })

  it('drops a row carrying no credential at all', () => {
    setInstances([
      { server: 'a.example.org' },
      { server: 'b.example.org', token: 't' },
      { server: '', token: 'nowhere' },
    ])
    expect(listInstances().map((entry) => entry.server)).toEqual(['b.example.org'])
  })

  it('sends the token and basic auth on different headers, since both may be needed', async () => {
    setInstances([
      { server: 'catmaid.example.org', token: 'tok', httpUser: 'alice', httpPassword: 'p@ss' },
    ])
    stubFetch(defaultRoutes)
    await source().listDatasets()
    const call = calls[0]!
    // CATMAID's own middleware says why these are two headers: `X-Authorization` exists "to
    // prevent conflicts with, e.g., HTTP server basic authentication".
    expect(call.headers['x-authorization']).toBe('Token tok')
    expect(call.headers.authorization).toBe(`Basic ${btoa('alice:p@ss')}`)
  })

  /*
   * Only the CATMAID token bypasses CSRF — it is what reaches
   * `CsrfBypassTokenAuthenticationMiddleware`. Basic auth satisfies the web server in front and
   * leaves CSRF where it was, so a POST with basic auth alone still has to take the relay.
   */
  it('does not let basic auth alone send a POST direct', async () => {
    setInstances([{ server: 'catmaid.example.org', httpUser: 'alice', httpPassword: 'p' }])
    stubFetch(defaultRoutes)
    await source().neuronIndex({ datasetId: '1' })
    for (const post of calls.filter((call) => call.method === 'POST')) {
      expect(post.url.startsWith('/cm/')).toBe(true)
    }
  })
})

describe('encoding a request', () => {
  /*
   * The documented `skeleton_ids[]` form returns only the *last* id — a short answer rather than
   * an error, which is the worst way for this to fail. Nothing here may ever emit it.
   */
  it('writes lists indexed, never with bare brackets', () => {
    const encoded = decodeURIComponent(encodeParams({ skeleton_ids: [16, 27, 717] }))
    expect(encoded).toBe('skeleton_ids[0]=16&skeleton_ids[1]=27&skeleton_ids[2]=717')
    expect(encoded).not.toContain('skeleton_ids[]')
  })

  it('drops undefined rather than sending the string "undefined"', () => {
    expect(encodeParams({ a: 1, b: undefined })).toBe('a=1')
  })
})

describe('which route a request may take', () => {
  it('sends a GET direct, with no token', async () => {
    stubFetch(defaultRoutes)
    await source().listDatasets()
    expect(calls[0]?.url.startsWith(SERVER)).toBe(true)
    expect(calls[0]?.headers['x-authorization']).toBeUndefined()
  })

  /*
   * The whole reason this backend has a relay. An anonymous POST cannot succeed direct — CSRF
   * wants a Referer a browser may not set and a cookie it will not send — so issuing one to find
   * out is a request spent confirming what the protocol already says.
   */
  it('sends an anonymous POST only to the relay, never direct', async () => {
    stubFetch(defaultRoutes)
    await source().neuronIndex({ datasetId: '1' })
    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts.length).toBeGreaterThan(0)
    for (const post of posts) {
      expect(post.url.startsWith('/cm/')).toBe(true)
      expect(post.url.startsWith(SERVER)).toBe(false)
    }
  })

  it('sends a POST direct once a token is set, and names the header CATMAID allows', async () => {
    setInstances([{ server: 'catmaid.example.org', token: 'abc123' }])
    stubFetch(defaultRoutes)
    await source().neuronIndex({ datasetId: '1' })
    const post = calls.find((call) => call.method === 'POST')
    expect(post?.url.startsWith(SERVER)).toBe(true)
    expect(post?.headers['x-authorization']).toBe('Token abc123')
  })

  it('strips a pasted "Token " prefix rather than sending it twice', () => {
    setInstances([{ server: 'catmaid.example.org', token: 'Token abc123' }])
    stubFetch(defaultRoutes)
    return source()
      .neuronIndex({ datasetId: '1' })
      .then(() => {
        const post = calls.find((call) => call.method === 'POST')
        expect(post?.headers['x-authorization']).toBe('Token abc123')
      })
  })
})

describe('reading labels out of the annotation graph', () => {
  const vocabulary = readVocabulary(annotations)

  it('finds the meta-annotations the instance actually uses', () => {
    expect(vocabulary.metaAnnotations).toContain('neuron name')
    expect(vocabulary.typeAnnotations.size).toBeGreaterThan(0)
  })

  it('splits a type from its instance at the "#"', () => {
    expect(typeFromLabel('Uniglomerular mALT VA6 adPN#R1')).toBe('Uniglomerular mALT VA6 adPN')
    expect(typeFromLabel("KC#12-a'b'")).toBe('KC')
    // No hash means the label *is* the type — `DNp32_R`, `Mi1_R`.
    expect(typeFromLabel('DNp32_R')).toBe('DNp32_R')
  })

  it('derives a type the free-text name does not carry', () => {
    // Skeleton 430 is named "La Grosse Cellule LGC 431 JS" and annotated `DNp32_R`. Reading the
    // name would give neither a type nor anything joinable.
    const labels = labelsForSkeleton(annotations, vocabulary, 430)
    expect(labels.name).toContain('La Grosse Cellule')
    expect(labels.type).toBe('DNp32_R')
  })

  it('keeps the whole label as the instance, so the "#" split loses nothing', () => {
    const labels = labelsForSkeleton(annotations, vocabulary, 16)
    expect(labels.instance).toBe('Uniglomerular mALT VA6 adPN#R1')
    expect(labels.type).toBe('Uniglomerular mALT VA6 adPN')
    expect(labels.instance?.startsWith(labels.type ?? '')).toBe(true)
  })

  it('puts the ontology term in its own column, not in the annotations bag', () => {
    const labels = labelsForSkeleton(annotations, vocabulary, 16)
    expect(labels.ontology).toMatch(/^FBbt:/)
    expect(labels.annotations ?? '').not.toContain(labels.ontology ?? 'FBbt:')
  })

  it('joins the leftovers with the separator Explore splits on, and never the type', () => {
    const labels = labelsForSkeleton(annotations, vocabulary, 16)
    expect(labels.annotations).toContain('Paper:')
    expect(labels.annotations).not.toContain('#R1')
    // `'; '` is `JOIN_SEPARATOR`; a second spelling is a row of tags nobody can read.
    if (labels.annotations?.includes(';')) expect(labels.annotations).toContain('; ')
  })

  it('answers null rather than empty strings for a skeleton it has never seen', () => {
    const labels = labelsForSkeleton(annotations, vocabulary, 999_999)
    expect(labels).toEqual({
      name: null,
      type: null,
      instance: null,
      ontology: null,
      annotations: null,
    })
  })
})

describe('connectivity', () => {
  /*
   * The trap. CATMAID reports synapse counts bucketed by confidence 1–5, and the weight is the
   * *sum*. Almost everything sits in the last bucket, so taking that alone looks right and
   * undercounts by about a percent — measured on skeleton 16, 3,039 against a true 3,070.
   */
  it('sums the confidence buckets rather than taking the last', () => {
    expect(synapseWeight([1, 0, 0, 0, 12])).toBe(13)
    expect(synapseWeight([0, 0, 0, 0, 19])).toBe(19)
    expect(synapseWeight(undefined)).toBe(0)
  })

  it('answers query-relative rows, with the queried neuron always in neuronId', async () => {
    setInstances([{ server: 'catmaid.example.org', token: 't' }])
    stubFetch(defaultRoutes)
    const table = await source().fetchConnectivity({
      datasetId: '1',
      neuronIds: ['16'],
      direction: 'outputs',
    })
    expect(table.length).toBeGreaterThan(0)
    expect(new Set(table.data.neuronId)).toEqual(new Set([16]))
    const weights = (table.data.weight ?? []).map(Number)
    // Every weight is a sum of its bucket array, so none can be zero for a listed partner.
    for (const weight of weights) expect(weight).toBeGreaterThan(0)
  })

  it('applies minWeight to the summed weight', async () => {
    setInstances([{ server: 'catmaid.example.org', token: 't' }])
    stubFetch(defaultRoutes)
    const table = await source().fetchConnectivity({
      datasetId: '1',
      neuronIds: ['16'],
      direction: 'outputs',
      minWeight: 1_000_000,
    })
    expect(table.length).toBe(0)
  })
})

describe('skeletons', () => {
  it('rebuilds parents as indices, keeping exactly one root', async () => {
    stubFetch(defaultRoutes)
    const skeletons = await source().fetchSkeletons({ datasetId: '1', neuronIds: ['16'] })
    const item = skeletons.items[0]!
    const points = item.positions.length / 3
    expect(points).toBe(compactDetailFixture.skeleton[0].length)

    // CATMAID names a parent by *node id*; emitting those would satisfy the type and break every
    // consumer that walks the array once — the SWC writer included.
    expect([...item.parents].filter((parent) => parent === -1)).toHaveLength(1)
    for (const parent of item.parents) expect(parent).toBeLessThan(points)
  })

  it('declares nanometres, so NBLAST does not refuse it', async () => {
    stubFetch(defaultRoutes)
    const skeletons = await source().fetchSkeletons({ datasetId: '1', neuronIds: ['16'] })
    expect(skeletons.units).toBe('nm')
  })

  it('claims no template space, because project 1 is only FAFB on Virtual Fly Brain', async () => {
    /*
     * The positional-id rule, demonstrated by the fixture rather than argued: this source is
     * `catmaid-test`, not the bare `catmaid` that *is* VFB's deployment, so its project 1 is
     * whatever this server numbered first. Answering FAFB14 here would put somebody's neurons
     * through a mirror fitted for a different animal. See `spaceForDataset`.
     */
    stubFetch(defaultRoutes)
    const skeletons = await source().fetchSkeletons({ datasetId: '1', neuronIds: ['16'] })
    expect(skeletons.space).toBeUndefined()
  })

  it('clamps an unset radius to zero rather than drawing a negative tube', async () => {
    stubFetch(defaultRoutes)
    const skeletons = await source().fetchSkeletons({ datasetId: '1', neuronIds: ['16'] })
    for (const radius of skeletons.items[0]!.radii) expect(radius).toBeGreaterThanOrEqual(0)
  })

  it('fetches only the neurons it has not already downloaded', async () => {
    /*
     * The end-to-end half of `geometryCache.test.ts`, at a real source, because a cache that
     * works in isolation and is wired in wrongly is exactly as useless as no cache.
     *
     * What it stands in for, measured with a scheduler probe: a morphology node's provenance key
     * is `hash(type, params, upstream keys)`, so it re-runs on *any* change to its Neurons input
     * — widening a type pattern from `LC4` to `LC4|LC6` asked for 21 ids of which 12 had just
     * been fetched, and an upstream Filter edit that kept every row asked for the same 12 again.
     * Each of those is a megabyte of uncompressed skeleton on this backend.
     *
     * CATMAID is also where the *decision* to cache lives: unlike a neuPrint body or a CAVE root
     * id, a skeleton here is live tracing data. It is held for the session anyway, and Clear
     * Cache on the node is the way back — which is what `refresh` below stands for.
     */
    stubFetch(defaultRoutes)
    const detail = () => calls.filter((c) => c.url.includes('/compact-detail')).length

    await source().fetchSkeletons({ datasetId: '1', neuronIds: ['16'] })
    expect(detail()).toBe(1)

    const both = await source().fetchSkeletons({ datasetId: '1', neuronIds: ['16', '430'] })
    // One more request, not two — and the held neuron is still in the answer, in the order asked.
    expect(detail()).toBe(2)
    expect(both.items.map((item) => item.id)).toEqual(['16', '430'])

    // Clear Cache reaches it. Without this the cache would be a one-way door for a backend whose
    // skeletons somebody is actively editing.
    await source().fetchSkeletons({ datasetId: '1', neuronIds: ['16'], refresh: true })
    expect(detail()).toBe(3)
  })

  it('reports the age of a held skeleton rather than passing it off as fresh', async () => {
    // `ctx.reportFetched` is what puts `cached 12m ago ⟳` in the card's foot. A cache with no
    // channel for this is the "control that looks like it worked" `dataCache` exists to prevent.
    stubFetch(defaultRoutes)
    await source().fetchSkeletons({ datasetId: '1', neuronIds: ['16'] })
    const stored = Date.now()

    const ages: number[] = []
    await source().fetchSkeletons({
      datasetId: '1',
      neuronIds: ['16'],
      onFetched: (at) => ages.push(at),
    })
    expect(ages).toHaveLength(1)
    expect(ages[0]).toBeLessThanOrEqual(stored)
  })

  it('says what a large set costs on this backend, and fetches it', async () => {
    // It refused at two hundred, on the reasoning that a couple of minutes is too long — which
    // is not a call this layer gets to make for somebody with a tracing question about four
    // hundred neurons. It says the number of minutes instead.
    stubFetch(defaultRoutes)
    const many = Array.from({ length: 500 }, (_, i) => String(i + 1))
    const said: string[] = []
    await source().fetchSkeletons({
      datasetId: '1',
      neuronIds: many,
      onWarn: (message) => said.push(message),
    })
    expect(said.join(' ')).toMatch(/uncompressed/)
    expect(said.join(' ')).toMatch(/Fetching anyway/)
  })
})

describe('synapses', () => {
  it('labels polarity per relation, since a both-ends cloud is two populations', async () => {
    stubFetch(defaultRoutes)
    const points = await source().fetchSynapses({ datasetId: '1', neuronIds: ['16'] })
    expect(points.units).toBe('nm')
    expect(new Set(points.attributes.data.polarity)).toEqual(new Set(['pre', 'post']))
    expect(points.positions.length).toBe(points.attributes.length * 3)
  })

  it('asks for one relation only when a polarity is given', async () => {
    stubFetch(defaultRoutes)
    await source().fetchSynapses({ datasetId: '1', neuronIds: ['16'], polarity: 'pre' })
    const relations = calls.filter((call) => call.url.includes('connectors/links'))
    expect(relations).toHaveLength(1)
    expect(decodeURIComponent(relations[0]!.url)).toContain('relation_type=presynaptic_to')
  })
})

describe('volumes as region meshes', () => {
  it('reads the column table rather than assuming records', async () => {
    stubFetch(defaultRoutes)
    const meshes = await source().fetchRoiMeshes({ datasetId: '1' })
    // `{columns, data}`, not `VolumeRow[]` — the obvious reading yields undefined for every
    // field with no error at all.
    expect(meshes.items.map((item) => item.id).sort()).toEqual(['LAL_L', 'MB_PED_R'])
  })

  it('marks every region primary, because CATMAID volumes do not nest', async () => {
    stubFetch(defaultRoutes)
    const meshes = await source().fetchRoiMeshes({ datasetId: '1' })
    expect(new Set(meshes.attributes.data.primary)).toEqual(new Set([true]))
  })
})

describe('the X3D volume mesh', () => {
  const source_ = volumeFixture.mesh

  it('parses a real IndexedTriangleSet', () => {
    const mesh = parseX3dMesh(source_)
    expect(mesh.indices.length % 3).toBe(0)
    expect(mesh.positions.length % 3).toBe(0)
    expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3)
  })

  it('refuses an index outside the vertex list rather than drawing a spike', () => {
    const broken = source_.replace(/index='(\d+)/, "index='99999")
    expect(() => parseX3dMesh(broken)).toThrow(/outside its/)
  })

  it('refuses a ragged coordinate list rather than dropping a corner', () => {
    const broken = source_.replace(
      /point='([^']*)'/,
      (_, points: string) => `point='${points} 1'`,
    )
    expect(() => parseX3dMesh(broken)).toThrow(/whole xyz triples/)
  })

  it('says so when handed something that is not a mesh', () => {
    expect(() => parseX3dMesh('<Nothing/>')).toThrow(/IndexedTriangleSet/)
  })
})

describe('what a CATMAID dataset says about itself', () => {
  it('publishes no statuses, because CATMAID has none', async () => {
    stubFetch(defaultRoutes)
    const datasets = await source().listDatasets()
    expect(datasets[0]?.statuses).toEqual([])
  })

  /*
   * The other half, and it has changed shape rather than gone away.
   *
   * A status filter used to arrive here as a *named field of the request*, carrying a node
   * default of `Traced` that nobody chose — so this source had to ignore it, because filtering
   * would have dropped every row. It is a filter row now, and CATMAID publishes no `status`, so
   * the field is not in the schema, not in the dropdown, and not something a new node can send.
   * What can still arrive is a graph saved against neuPrint and repointed here, and that is a
   * refusal naming the field rather than a silently unnarrowed answer.
   */
  it('refuses a status filter rather than ignoring it or dropping every row', async () => {
    setInstances([{ server: 'catmaid.example.org', token: 't' }])
    stubFetch(defaultRoutes)
    expect((await source().findNeurons({ datasetId: '1' })).length).toBeGreaterThan(0)
    await expect(
      source().findNeurons({
        datasetId: '1',
        rows: [{ field: 'status', op: 'is', values: ['Traced'] }],
      }),
    ).rejects.toThrow(/no "status"/)
  })

  /*
   * A region is the one filter that cannot become a row, because it is not a column in any
   * schema. `volumeList` fills `DatasetInfo.rois` with eighty real neuropils so the ROIs viewer
   * can draw them — which also used to populate Find Neurons' **In ROI** — and `findNeurons` has
   * no way to honour it. Ignoring a region somebody picked returns a result that is too *large*
   * and looks exactly like a correct one, so it is refused; the card no longer offers it at all,
   * because `capabilities.roiFilter` is what the picker reads now rather than the list.
   */
  it('refuses a region filter rather than quietly not applying it', async () => {
    setInstances([{ server: 'catmaid.example.org', token: 't' }])
    stubFetch(defaultRoutes)
    await expect(source().findNeurons({ datasetId: '1', roi: 'AL_R' })).rejects.toThrow(
      /In ROI/,
    )
    // A size filter cannot even be built: CATMAID measures a neuron in nodes and cable rather
    // than voxels, so there is no `size` in its schema for a row to name.
    await expect(
      source().findNeurons({
        datasetId: '1',
        rows: [{ field: 'size', op: 'ge', values: ['1000'] }],
      }),
    ).rejects.toThrow(/no "size"/)
    // Not sent unless it was set: the node drops its default.
    expect((await source().findNeurons({ datasetId: '1' })).length).toBeGreaterThan(0)
  })

  it('refuses a dataset id that is not a project number', async () => {
    stubFetch(defaultRoutes)
    await expect(source().findNeurons({ datasetId: 'hemibrain' })).rejects.toThrow(/project/)
  })
})
