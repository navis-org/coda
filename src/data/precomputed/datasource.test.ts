/**
 * A precomputed URL as a datasource: what the probe makes of an `info`, and what the source
 * built on it will and will not answer.
 *
 * The mesh *reading* is covered next door in `precomputed.test.ts` against real bucket bytes.
 * What is here is the layer above it — classification, memoisation and the refusals — which is
 * where a wrong answer is quiet rather than loud: a source that reports "no meshes" during the
 * second before its probe lands puts a refusal on a node that is perfectly fine, and a source
 * that answers `findNeurons` with an empty table reports a bucket as a connectome with no
 * neurons in it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RestoreFetch } from '../../test/precomputedStubs'
import { DRACO_INFO, serveJson, volumeInfo } from '../../test/precomputedStubs'
import { parseNgSource } from '../neuroglancer/sourceUrl'
import { resetTransport } from './transport'
import { PrecomputedSource, datasourceLabel } from './PrecomputedSource'
import { peekPrecomputed, probePrecomputed, resetPrecomputedProbes } from './probe'
import { tableFrom } from './segmentProperties'
import { precomputedSourceFor } from './registry'

let restore: RestoreFetch = () => {}

/** `serveJson`, remembering the restore so each case can replace the stub freely. */
function serve(docs: Readonly<Record<string, unknown>>): { urls: string[] } {
  const served = serveJson(docs)
  restore = served.restore
  return served
}

function sourceFor(spec: string): PrecomputedSource {
  const ref = parseNgSource(spec)
  if (!ref) throw new Error(`test spec did not parse: ${spec}`)
  return new PrecomputedSource(ref)
}

beforeEach(() => {
  resetPrecomputedProbes()
  resetTransport()
})

afterEach(() => restore())

describe('probing a precomputed directory', () => {
  it('follows a segmentation volume down to the mesh directory it names', async () => {
    const base = 'https://storage.googleapis.com/bucket/seg'
    serve({
      [`${base}/info`]: volumeInfo({ mesh: 'meshes', skeletons: 'skeletons', segmentProperties: 'props' }),
      [`${base}/meshes/info`]: DRACO_INFO,
    })

    const probe = await probePrecomputed(base)
    expect(probe.ok && probe.source.kind).toBe('volume')
    expect(probe.ok && probe.source.meshUrl).toBe(`${base}/meshes`)
    expect(probe.ok && probe.source.skeletonUrl).toBe(`${base}/skeletons`)
    expect(probe.ok && probe.source.segmentPropertiesUrl).toBe(`${base}/props`)
    expect(probe.ok && probe.source.summary).toBe('segmentation · multi-resolution meshes · skeletons')
  })

  it('distinguishes flat meshes from multi-resolution ones', async () => {
    // The distinction male-CNS turns on: its volume names a mesh directory like every other
    // dataset, and what is in it arrives at full resolution whatever Detail is set to. "Has
    // meshes" would not tell anybody that.
    const base = 'https://storage.googleapis.com/flat/seg'
    serve({
      [`${base}/info`]: volumeInfo({ mesh: 'm' }),
      [`${base}/m/info`]: { '@type': 'neuroglancer_legacy_mesh' },
    })
    const probe = await probePrecomputed(base)
    expect(probe.ok && probe.source.mesh?.format).toBe('legacy')
    expect(probe.ok && probe.source.summary).toBe('segmentation · full-resolution meshes')
  })

  it('opens an unsharded multi-resolution directory, which used to be refused', async () => {
    // hemibrain's region shells are built this way — `v1.2/rois/mesh` publishes `1` and `1.index`
    // side by side rather than shard files — so "no source in use is built this way" stopped
    // being true when ROI Meshes had to work here.
    const base = 'https://storage.googleapis.com/unsharded/seg'
    serve({
      [`${base}/info`]: volumeInfo({ mesh: 'm' }),
      [`${base}/m/info`]: { '@type': 'neuroglancer_multilod_draco' },
    })
    const probe = await probePrecomputed(base)
    expect(probe.ok && probe.source.mesh?.format).toBe('multilod-draco')
    expect(probe.ok && probe.source.mesh?.info?.sharding).toBeUndefined()
    expect(probe.ok && probe.source.summary).toBe('segmentation · multi-resolution meshes')
  })

  it('reads an info with no @type as a legacy mesh directory', async () => {
    // `openMeshSource` treats it as one — banc's bucket needs that — and the two must agree, or
    // a URL this calls unreadable fetches perfectly well.
    const base = 'https://storage.googleapis.com/banc/meshes'
    serve({ [`${base}/info`]: { scales: [] } })
    const probe = await probePrecomputed(base)
    expect(probe.ok && probe.source.kind).toBe('meshes')
    expect(probe.ok && probe.source.meshUrl).toBe(base)
  })

  it('reports an image volume as one, with no geometry to fetch', async () => {
    const base = 'https://storage.googleapis.com/em/image'
    serve({ [`${base}/info`]: volumeInfo({ type: 'image' }) })
    const probe = await probePrecomputed(base)
    expect(probe.ok && probe.source.meshUrl).toBeUndefined()
    expect(probe.ok && probe.source.summary).toBe('image')
  })

  it('keeps the volume when its mesh directory cannot be read', async () => {
    // Reporting the whole URL as unreadable because of a subdirectory would hide the part that
    // did work. The mesh fetch says so properly when somebody asks for geometry.
    const base = 'https://storage.googleapis.com/half/seg'
    serve({
      [`${base}/info`]: volumeInfo({ mesh: 'm' }),
    })
    const probe = await probePrecomputed(base)
    expect(probe.ok && probe.source.meshUrl).toBe(`${base}/m`)
    expect(probe.ok && probe.source.mesh?.format).toBeUndefined()
  })

  it('reads each info once, so the first Run costs no requests of its own', async () => {
    /*
     * The three-reads-of-one-document trap. `openMeshSource` reads the mesh `info` and then
     * `readMultiResInfo` reads it again to get the sharding spec, and the probe had read it
     * before either — so a pasted segmentation cost four requests for two documents, and the
     * mesh `info` three of them. `fetchInfo`'s memo collapses that, and the probe holding the
     * opened `MeshSource` is what leaves nothing for the fetch to re-read.
     */
    const base = 'https://storage.googleapis.com/counted/seg'
    const served = serve({
      [`${base}/info`]: volumeInfo({ mesh: 'm' }),
      [`${base}/m/info`]: DRACO_INFO,
    })

    const probe = await probePrecomputed(base)
    expect(served.urls).toEqual([`${base}/info`, `${base}/m/info`])

    // And the source hands the already-opened directory to the fetch.
    expect(probe.ok && probe.source.mesh?.format).toBe('multilod-draco')
    await sourceFor('gs://counted/seg').fetchMeshes({ datasetId: '', neuronIds: [] })
    expect(served.urls).toHaveLength(2)
  })

  it('names a kind it knows, and the raw @type for one it does not', async () => {
    // The two fallbacks and the order between them: a recognised kind prints its own name, and
    // only a format this build has never met prints the string out of the file.
    serve({ [`${'https://storage.googleapis.com/ann/x'}/info`]: { '@type': 'neuroglancer_annotations_v1' } })
    const annotations = await probePrecomputed('https://storage.googleapis.com/ann/x')
    expect(annotations.ok && annotations.source.summary).toBe('annotations')

    serve({ [`${'https://storage.googleapis.com/odd/x'}/info`]: { '@type': 'neuroglancer_mesh_v9' } })
    const odd = await probePrecomputed('https://storage.googleapis.com/odd/x')
    expect(odd.ok && odd.source.kind).toBe('unknown')
    expect(odd.ok && odd.source.summary).toBe('neuroglancer_mesh_v9')
  })

  it('remembers a failure, so a bad URL is asked once', async () => {
    // The node above is `cheap`: it re-runs on an edit rather than on Run, and the one thing
    // anybody edits on it is this URL. Re-requesting per peek is invariant 6's hazard.
    const base = 'https://storage.googleapis.com/nope/seg'
    const served = serve({})
    expect((await probePrecomputed(base)).ok).toBe(false)
    expect((await probePrecomputed(base)).ok).toBe(false)
    expect(served.urls).toHaveLength(1)
  })

  it('re-reads a failure on retry and never re-reads a success', async () => {
    const base = 'https://storage.googleapis.com/flaky/seg'
    const served = serve({})
    await probePrecomputed(base)
    serve({ [`${base}/info`]: { '@type': 'neuroglancer_legacy_mesh' } })
    expect((await probePrecomputed(base, { retry: true })).ok).toBe(true)
    // A published `info` does not change under a fixed URL, so retry must not re-ask now.
    const after = serve({})
    expect((await probePrecomputed(base, { retry: true })).ok).toBe(true)
    expect(after.urls).toHaveLength(0)
    expect(served.urls).toHaveLength(1)
  })

  it('answers a peek with nothing until the probe has settled', async () => {
    const base = 'https://storage.googleapis.com/slow/seg'
    serve({ [`${base}/info`]: { '@type': 'neuroglancer_legacy_mesh' } })
    expect(peekPrecomputed(base)).toBeUndefined()
    await probePrecomputed(base)
    expect(peekPrecomputed(base)?.ok).toBe(true)
    // Trailing slashes are the same directory, or a card and its node disagree about what is known.
    expect(peekPrecomputed(`${base}/`)?.ok).toBe(true)
  })
})

describe('PrecomputedSource', () => {
  it('publishes segment ids as text', () => {
    // Invariant 8: a male-CNS or FlyWire root id is eighteen digits, and an `i64` column would
    // hold a rounded copy — a different neuron, with nothing to say so.
    const source = sourceFor('gs://bucket/seg')
    expect(source.schemas.morphology.columns[0]).toMatchObject({ name: 'neuronId', dtype: 'str' })
  })

  it('refuses nothing before its probe has landed', async () => {
    // The unresolved-refuses-nothing rule. A pessimistic default puts "This data source has no
    // meshes" on a perfectly good Meshes node for the first second of every load.
    const base = 'https://storage.googleapis.com/late/seg'
    serve({ [`${base}/info`]: volumeInfo({ type: 'image' }) })
    const source = sourceFor('gs://late/seg')
    expect(source.capabilities.meshes).toBe(true)
    expect(source.capabilities.skeletons).toBe(true)
    expect(source.capabilitiesFor()).toBeUndefined()

    await probePrecomputed(base)
    expect(source.capabilitiesFor()).toEqual({
      meshes: false,
      skeletons: false,
      neuronIndex: false,
      roiMeshes: false,
    })
  })

  it('says nothing about capabilities when the probe failed, rather than "no meshes"', async () => {
    // "Nobody could read this" and "there are no meshes here" are different, and the node
    // holding the URL is already reporting the first. A second refusal downstream would name
    // the wrong cause.
    const base = 'https://storage.googleapis.com/gone/seg'
    serve({})
    const source = sourceFor('gs://gone/seg')
    await probePrecomputed(base)
    expect(source.capabilitiesFor()).toBeUndefined()
  })

  it('re-opens a mesh directory the probe failed to open, rather than reporting no meshes', async () => {
    /*
     * `tryOpen` swallows a transient failure, and the probe is then cached as a **success** with
     * no opened directory — while `capabilitiesFor`, which reads `meshUrl`, still says the source
     * has meshes. Refusing on the opened copy meant one CORS blip produced "publishes no meshes"
     * for the rest of the session, on a source that has them.
     */
    const base = 'https://storage.googleapis.com/blip/seg'
    serve({ [`${base}/info`]: volumeInfo({ mesh: 'm' }) }) // `m/info` 404s: the blip.
    const probe = await probePrecomputed(base)
    expect(probe.ok && probe.source.meshUrl).toBe(`${base}/m`)
    expect(probe.ok && probe.source.mesh).toBeUndefined()

    const source = sourceFor('gs://blip/seg')
    expect(source.capabilitiesFor()).toMatchObject({ meshes: true })

    // The directory answers now. The Run must reach it rather than repeating a stale verdict.
    serve({ [`${base}/info`]: volumeInfo({ mesh: 'm' }), [`${base}/m/info`]: DRACO_INFO })
    const meshes = await source.fetchMeshes({ datasetId: source.datasetId, neuronIds: [] })
    expect(meshes.items).toEqual([])
  })

  it('does not remember an abort as a verdict about the URL', async () => {
    // Cancelling a run says nothing about the bytes. Remembered, it left "This operation was
    // aborted" on a card with a perfectly good URL until the next explicit Run.
    const base = 'https://storage.googleapis.com/cancelled/seg'
    const controller = new AbortController()
    const previous = globalThis.fetch
    globalThis.fetch = (() => {
      controller.abort()
      return Promise.reject(new DOMException('Aborted', 'AbortError'))
    }) as typeof fetch
    restore = () => void (globalThis.fetch = previous)

    await expect(probePrecomputed(base, { signal: controller.signal })).rejects.toThrow(/Abort/)
    expect(peekPrecomputed(base)).toBeUndefined()

    serve({ [`${base}/info`]: volumeInfo({ mesh: 'm' }), [`${base}/m/info`]: DRACO_INFO })
    expect((await probePrecomputed(base)).ok).toBe(true)
  })

  it('refuses a neuron query by naming the way in', async () => {
    // An empty table here would read as "this dataset has no neurons" under a green node. The
    // source has to be readable first, or the more useful message is the one about the URL.
    const base = 'https://storage.googleapis.com/plain/seg'
    serve({ [`${base}/info`]: { '@type': 'neuroglancer_legacy_mesh' } })
    const source = sourceFor('gs://plain/seg')
    await expect(source.findNeurons({ datasetId: source.datasetId })).rejects.toThrow(/Input IDs/)
    await expect(
      source.fetchConnectivity({
        datasetId: source.datasetId,
        neuronIds: [],
        direction: 'outputs',
      }),
    ).rejects.toThrow(/not connectivity/)
  })

  it('names what it found when there is no geometry to fetch', async () => {
    const base = 'https://storage.googleapis.com/em2/image'
    serve({ [`${base}/info`]: volumeInfo({ type: 'image' }) })
    const source = sourceFor('gs://em2/image')
    await expect(source.fetchMeshes({ datasetId: source.datasetId, neuronIds: ['1'] })).rejects.toThrow(
      /publishes no meshes — it is image/,
    )
  })

  it('answers an empty id list without touching the network', async () => {
    const served = serve({})
    const source = sourceFor('gs://bucket/seg')
    const meshes = await source.fetchMeshes({ datasetId: source.datasetId, neuronIds: [] })
    expect(meshes.items).toHaveLength(0)
    expect(meshes.units).toBe('nm')
    expect(served.urls).toHaveLength(0)
  })
})

describe('segment properties', () => {
  /** One inline sidecar, as the format spells it. */
  const SIDECAR = {
    '@type': 'neuroglancer_segment_properties',
    inline: {
      ids: ['1', '2', '3'],
      properties: [
        { id: 'label', type: 'label', values: ['AB(L)', 'AL(R)', 'EB'] },
        { id: 'size', type: 'number', data_type: 'uint32', values: [10, 20, 30] },
        { id: 'flags', type: 'tags', tags: ['left', 'right'], values: [[0], [1], []] },
      ],
    },
  }

  it('reads every property type it knows into a named column', () => {
    const table = tableFrom(SIDECAR)
    expect(table.schema.columns.map((c) => [c.name, c.dtype])).toEqual([
      ['neuronId', 'str'],
      ['label', 'str'],
      ['size', 'i64'],
      ['flags', 'str'],
    ])
    // Ids are text all the way through — invariant 8; the sidecar publishes strings already.
    expect(table.data['neuronId']).toEqual(['1', '2', '3'])
    // Tags are index lists into a shared vocabulary, folded with the separator Explore splits on.
    expect(table.data['flags']).toEqual(['left', 'right', ''])
  })

  it('names a label column by its type rather than its id', () => {
    // `label` is a *type* in the format; its id need not be "label". A picker downstream expects
    // one name on every source that publishes one.
    const table = tableFrom({
      '@type': 'neuroglancer_segment_properties',
      inline: { ids: ['1'], properties: [{ id: 'cell_type', type: 'label', values: ['x'] }] },
    })
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'label'])
  })

  it('drops a property whose values do not line up with the ids', () => {
    // Somebody else's bytes. A short array would shift every label onto the wrong segment, which
    // is a table that looks perfectly well-formed and names the wrong neurons.
    const table = tableFrom({
      '@type': 'neuroglancer_segment_properties',
      inline: { ids: ['1', '2'], properties: [{ id: 'label', type: 'label', values: ['only one'] }] },
    })
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId'])
  })

  it('skips a number whose width it cannot name a dtype for', () => {
    // Guessing `f64` would advertise a column whose values may not be numbers at all.
    const table = tableFrom({
      '@type': 'neuroglancer_segment_properties',
      inline: { ids: ['1'], properties: [{ id: 'n', type: 'number', data_type: 'complex64', values: [1] }] },
    })
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId'])
  })

  /** A volume with meshes and a sidecar, which is what an ROI source looks like. */
  function serveRegions(base: string) {
    return serve({
      [`${base}/info`]: volumeInfo({ mesh: 'm', segmentProperties: 'props' }),
      [`${base}/m/info`]: DRACO_INFO,
      [`${base}/props/info`]: SIDECAR,
    })
  }

  it('fills the region list from the labels, and only once asked', async () => {
    // Not read by the probe: it is a separate and much larger document — hemibrain's segmentation
    // publishes 22,706 labelled ids — and the probe runs from an edit-time peek on a `cheap` node.
    const base = 'https://storage.googleapis.com/regions/seg'
    const served = serveRegions(base)
    await probePrecomputed(base)
    expect(served.urls).not.toContain(`${base}/props/info`)

    const source = sourceFor('gs://regions/seg')
    // The first peek cannot answer and starts the load — `peekDatasets`' own rule.
    expect(source.peekDataset(source.datasetId)?.rois).toEqual([])
    // Through the same path the peek started, which is what makes the two share one download.
    await source.neuronIndex({ datasetId: source.datasetId })
    expect(source.peekDataset(source.datasetId)?.rois).toEqual(['AB(L)', 'AL(R)', 'EB'])
  })

  it('advertises the sidecar’s own columns to a query node', async () => {
    // What fills Find Neurons' field dropdown: the columns *this* source publishes rather than a
    // canonical guess. Synchronous, because it is read from `inferOutputs`.
    const base = 'https://storage.googleapis.com/schema/seg'
    serveRegions(base)
    const source = sourceFor('gs://schema/seg')
    await probePrecomputed(base)
    expect(source.schemasFor().neurons.columns.map((c) => c.name)).toEqual(['neuronId'])

    await source.neuronIndex({ datasetId: source.datasetId })
    expect(source.schemasFor().neurons.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'label',
      'size',
      'flags',
    ])
    // Held by identity, or every graph mutation rebuilds it — invariant 7.
    expect(source.schemasFor()).toBe(source.schemasFor())
  })

  it('answers a neuron query out of the sidecar', async () => {
    const base = 'https://storage.googleapis.com/query/seg'
    serveRegions(base)
    const source = sourceFor('gs://query/seg')
    const found = await source.findNeurons({
      datasetId: source.datasetId,
      rows: [{ field: 'label', op: 'matches', values: ['A.*'] }],
    })
    // Anchored, like every other backend: `A.*` matches `AB(L)` and `AL(R)`, not `EB`.
    expect(found.data['neuronId']).toEqual(['1', '2'])
  })

  it('gates browsing and region shells on the sidecar, together', async () => {
    const withProps = 'https://storage.googleapis.com/gated/seg'
    serveRegions(withProps)
    await probePrecomputed(withProps)
    expect(sourceFor('gs://gated/seg').capabilitiesFor()).toEqual({
      meshes: true,
      skeletons: false,
      neuronIndex: true,
      roiMeshes: true,
    })

    // Meshes but no names: the picker would offer eighteen-digit ids, so ROI Meshes declines.
    const bare = 'https://storage.googleapis.com/bare/seg'
    serve({
      [`${bare}/info`]: volumeInfo({ mesh: 'm' }),
      [`${bare}/m/info`]: DRACO_INFO,
    })
    await probePrecomputed(bare)
    expect(sourceFor('gs://bare/seg').capabilitiesFor()).toMatchObject({
      meshes: true,
      neuronIndex: false,
      roiMeshes: false,
    })
  })

  /**
   * The same, with a *legacy* mesh directory.
   *
   * A missing legacy mesh is an answer (`readLegacyMesh` returns undefined) where a missing shard
   * file is a throw — so these two cases can assert on which objects were *asked for* without
   * having to serve real Draco bytes.
   */
  function serveLegacyRegions(base: string) {
    return serve({
      [`${base}/info`]: volumeInfo({ mesh: 'm', segmentProperties: 'props' }),
      [`${base}/m/info`]: { '@type': 'neuroglancer_legacy_mesh' },
      [`${base}/props/info`]: SIDECAR,
    })
  }

  it('asks for every region when the picker is empty on a cold source', async () => {
    /*
     * `[] ?? labelsOf(...)` is `[]`. The stored region list is empty until the sidecar has landed
     * *and* a peek has rebuilt the cache from it, so an ROI Meshes node run with an untouched
     * picker fetched nothing at all — and said nothing about it.
     */
    const base = 'https://storage.googleapis.com/cold/seg'
    const served = serveLegacyRegions(base)
    const source = sourceFor('gs://cold/seg')
    // Deliberately no peek first: this is the node running before anything filled the picker.
    await source.fetchRoiMeshes({ datasetId: source.datasetId })
    // One request per region in the sidecar — three, not none.
    expect(served.urls.filter((u) => u.startsWith(`${base}/m/`) && u.endsWith(':0'))).toEqual([
      `${base}/m/1:0`,
      `${base}/m/2:0`,
      `${base}/m/3:0`,
    ])
  })

  it('reads the sidecar once per ROI fetch, through the cached path', async () => {
    // Half a megabyte on hemibrain. Read directly it was fetched a second time, ignored
    // `refresh`, and handed `idsForLabels` a fresh table each call — defeating its identity memo.
    const base = 'https://storage.googleapis.com/once/seg'
    const served = serveLegacyRegions(base)
    const source = sourceFor('gs://once/seg')
    await source.fetchRoiMeshes({ datasetId: source.datasetId, rois: ['EB'] })
    expect(served.urls.filter((u) => u === `${base}/props/info`)).toHaveLength(1)
  })

  it('refuses a listing when the source publishes no names', async () => {
    const base = 'https://storage.googleapis.com/nameless/seg'
    serve({ [`${base}/info`]: { '@type': 'neuroglancer_legacy_mesh' } })
    const source = sourceFor('gs://nameless/seg')
    await expect(source.neuronIndex({ datasetId: source.datasetId })).rejects.toThrow(
      /no segment properties/,
    )
  })
})

describe('precomputedSourceFor', () => {
  it('gives every spelling of one address the same instance', () => {
    // Two instances would re-probe the same `info` and hand two nodes different dataset ids for
    // one directory, which downstream reads as two datasets.
    const a = precomputedSourceFor('gs://reg/seg/')
    const b = precomputedSourceFor('precomputed://gs://reg/seg')
    const c = precomputedSourceFor('gs://reg/seg|neuroglancer-precomputed:')
    expect(a).toBeDefined()
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('has nothing to register for an empty box', () => {
    // The ordinary state of a freshly added node, and not an error.
    expect(precomputedSourceFor('')).toBeUndefined()
    expect(precomputedSourceFor(undefined)).toBeUndefined()
  })
})

describe('datasourceLabel', () => {
  it('keeps the bucket and the leaf, which is what tells two sources apart', () => {
    expect(datasourceLabel('gs://flyem-male-cns/v1.0/segmentation')).toBe(
      'flyem-male-cns/segmentation',
    )
    expect(datasourceLabel('gs://bucket')).toBe('bucket')
  })
})
