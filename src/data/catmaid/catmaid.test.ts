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

  it('refuses a set past the ceiling, naming why the ceiling is low', async () => {
    stubFetch(defaultRoutes)
    const many = Array.from({ length: 500 }, (_, i) => String(i + 1))
    await expect(source().fetchSkeletons({ datasetId: '1', neuronIds: many })).rejects.toThrow(
      /uncompressed/,
    )
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
   * The other half, and the half that matters: a node's `status` default survives into the
   * request whatever the picker offers, so a source publishing no statuses must also *ignore*
   * the parameter. Filtering on it drops every row for a value nobody chose — which is live on
   * CAVE today, and is not repeated here.
   */
  it('ignores a status filter rather than dropping every row', async () => {
    setInstances([{ server: 'catmaid.example.org', token: 't' }])
    stubFetch(defaultRoutes)
    const all = await source().findNeurons({ datasetId: '1' })
    const filtered = await source().findNeurons({ datasetId: '1', statuses: ['Traced'] })
    expect(all.length).toBeGreaterThan(0)
    expect(filtered.length).toBe(all.length)
  })

  /*
   * The opposite call to `statuses`, and the difference is that somebody chose it. `volumeList`
   * fills `DatasetInfo.rois` with eighty real neuropils so the ROIs viewer can draw them — which
   * also populates Find Neurons' **In ROI** — and `findNeurons` had no way to honour it. Ignoring
   * a region somebody picked returns a result that is too *large* and looks exactly like a
   * correct one; `Min size` is the same, since CATMAID measures a neuron in nodes and cable
   * rather than voxels.
   */
  it('refuses a region or size filter rather than quietly not applying it', async () => {
    setInstances([{ server: 'catmaid.example.org', token: 't' }])
    stubFetch(defaultRoutes)
    await expect(source().findNeurons({ datasetId: '1', roi: 'AL_R' })).rejects.toThrow(
      /In ROI/,
    )
    await expect(source().findNeurons({ datasetId: '1', minSize: 1000 })).rejects.toThrow(
      /Min size/,
    )
    // Neither is sent unless it was set: both default to a value the node drops.
    expect((await source().findNeurons({ datasetId: '1' })).length).toBeGreaterThan(0)
  })

  it('refuses a dataset id that is not a project number', async () => {
    stubFetch(defaultRoutes)
    await expect(source().findNeurons({ datasetId: 'hemibrain' })).rejects.toThrow(/project/)
  })
})
