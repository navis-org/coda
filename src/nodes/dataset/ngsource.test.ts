/**
 * The Neuroglancer Source node.
 *
 * What is worth checking here is the seam rather than the parsing, which `sourceUrl.test.ts`
 * covers: that pasting a URL registers a source the *rest of the graph* can resolve, and that
 * the three geometry nodes downstream see it as an ordinary Dataset socket. That is the whole
 * claim the node makes, and it fails silently — a node whose type carries no `sourceId` still
 * looks fine on the canvas and simply leaves every column picker below it empty.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import type { ParamValues } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { attributeSchema, datasetRef } from '../../core/types'
import { isDatasetValue } from '../../core/values'
import { requireSource } from '../../data/source'
import { probePrecomputed, resetPrecomputedProbes } from '../../data/precomputed/probe'
import { resetTransport } from '../../data/precomputed/transport'
import type { RestoreFetch } from '../../test/precomputedStubs'
import { DRACO_INFO, serveJson, volumeInfo } from '../../test/precomputedStubs'
import '../index'

const TYPE = 'dataset.ngsource'
const SPEC = 'precomputed://gs://flyem-male-cns/v1.0/segmentation/'
const BASE = 'https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation'

let restore: RestoreFetch = () => {}

/** A bucket serving a segmentation volume with multi-resolution meshes under it. */
function serveSegmentation(docs: Readonly<Record<string, unknown>> = {}): void {
  restore = serveJson({
    [`${BASE}/info`]: volumeInfo({ mesh: 'meshes' }),
    [`${BASE}/meshes/info`]: DRACO_INFO,
    ...docs,
  }).restore
}

function ctxFor(params: ParamValues) {
  const def = requireNodeDef(TYPE)
  return makeInferContext(def, { ...defaultParams(def), ...params }, {})
}

function issues(params: ParamValues): string[] {
  return requireNodeDef(TYPE).validate?.(ctxFor(params)) ?? []
}

function node(id: string, type: string, params: ParamValues = {}) {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params },
  }
}

beforeEach(() => {
  resetPrecomputedProbes()
  resetTransport()
  serveSegmentation()
})

afterEach(() => restore())

describe('inference', () => {
  it('registers a source and puts its id on the type', () => {
    // Everything downstream — `schemasFromType`, `sourceSupports`, the 3D viewer's colour picker
    // — resolves that id out of the registry. Without it the node looks fine and feeds nothing.
    const def = requireNodeDef(TYPE)
    const out = def.inferOutputs?.(ctxFor({ url: SPEC }))
    const ref = datasetRef(out?.dataset)
    expect(ref?.sourceId).toBe(
      `precomputed:precomputed://gs://flyem-male-cns/v1.0/segmentation`,
    )
    expect(ref?.datasetId).toBe('precomputed://gs://flyem-male-cns/v1.0/segmentation')
    expect(() => requireSource(ref!.sourceId!)).not.toThrow()
  })

  it('emits a bare Dataset while the box is empty', () => {
    // The ordinary state of a freshly added node. `inferOutputs` may not throw (invariant 2).
    const out = requireNodeDef(TYPE).inferOutputs?.(ctxFor({ url: '' }))
    expect(out?.dataset?.kind).toBe('dataset')
    expect(datasetRef(out?.dataset)?.sourceId).toBeUndefined()
  })

  it('advertises segment ids as text to a Meshes node wired to it', async () => {
    // Invariant 8 across the seam: an `i64` column here holds a rounded copy of an eighteen-digit
    // root id, which is a different neuron with nothing to say so.
    await probePrecomputed(BASE)
    let graph = addNode(emptyGraph('t'), node('src', TYPE, { url: SPEC }))
    graph = addNode(graph, node('m', 'neuron.meshes'))
    graph = addEdge(graph, {
      source: 'src',
      sourceHandle: 'dataset',
      target: 'm',
      targetHandle: 'dataset',
    })

    const result = inferGraph(graph)
    const columns = attributeSchema(result.nodes['m']?.outputs['meshes'])?.columns ?? []
    expect(columns.map((c) => c.name)).toEqual(['neuronId', 'points', 'cableLength'])
    expect(columns[0]?.dtype).toBe('str')
    // And no "This data source has no meshes": the probe says there are. (The unwired Neurons
    // socket is a separate, correct complaint.)
    expect(result.nodes['m']?.issues.map((i) => i.message)).toEqual([
      'Input "Neurons" is not connected',
    ])
  })

  it('fills the ROI Meshes region picker from the sidecar’s labels', async () => {
    // The pairing that makes region shells reachable at all: without names the picker offers
    // eighteen-digit segment ids, which is why the capability is gated on both halves.
    serveSegmentation({
      [`${BASE}/info`]: volumeInfo({ mesh: 'meshes', segmentProperties: 'props' }),
      [`${BASE}/props/info`]: {
        '@type': 'neuroglancer_segment_properties',
        inline: {
          ids: ['1', '2'],
          properties: [{ id: 'label', type: 'label', values: ['EB', 'FB'] }],
        },
      },
    })
    await probePrecomputed(BASE)
    // Through the source, which is what the picker's own peek starts — one path, one download.
    await requireSource(
      `precomputed:precomputed://gs://flyem-male-cns/v1.0/segmentation`,
    ).neuronIndex?.({ datasetId: 'precomputed://gs://flyem-male-cns/v1.0/segmentation' })

    let graph = addNode(emptyGraph('t'), node('src', TYPE, { url: SPEC }))
    graph = addNode(graph, node('r', 'neuron.roiMeshes'))
    graph = addEdge(graph, {
      source: 'src',
      sourceHandle: 'dataset',
      target: 'r',
      targetHandle: 'dataset',
    })
    const result = inferGraph(graph)
    expect(result.nodes['r']?.issues.map((i) => i.message)).toEqual([])

    const param = (requireNodeDef('neuron.roiMeshes').params ?? []).find((p) => p.id === 'rois')
    const ctx = makeInferContext(
      requireNodeDef('neuron.roiMeshes'),
      defaultParams(requireNodeDef('neuron.roiMeshes')),
      { dataset: result.nodes['src']?.outputs['dataset'] },
    )
    const options =
      param?.kind === 'multiEnum' && typeof param.options === 'function'
        ? param.options(ctx)
        : []
    expect(options.map((o) => o.value)).toEqual(['EB', 'FB'])
  })

  it('lets an ROI Meshes node refuse a source that publishes no names', async () => {
    await probePrecomputed(BASE)
    let graph = addNode(emptyGraph('t'), node('src', TYPE, { url: SPEC }))
    graph = addNode(graph, node('r', 'neuron.roiMeshes'))
    graph = addEdge(graph, {
      source: 'src',
      sourceHandle: 'dataset',
      target: 'r',
      targetHandle: 'dataset',
    })
    expect(inferGraph(graph).nodes['r']?.issues.map((i) => i.message)).toContain(
      'This dataset publishes no region meshes',
    )
  })

  it('lets a Skeletons node take it when the source names a skeleton directory', async () => {
    serveSegmentation({
      [`${BASE}/info`]: volumeInfo({ mesh: 'meshes', skeletons: 'sk' }),
      [`${BASE}/sk/info`]: { '@type': 'neuroglancer_skeletons' },
    })
    await probePrecomputed(BASE)
    let graph = addNode(emptyGraph('t'), node('src', TYPE, { url: SPEC }))
    graph = addNode(graph, node('s', 'neuron.skeletons'))
    graph = addEdge(graph, {
      source: 'src',
      sourceHandle: 'dataset',
      target: 's',
      targetHandle: 'dataset',
    })
    expect(inferGraph(graph).nodes['s']?.issues.map((i) => i.message)).toEqual([
      'Input "Neurons" is not connected',
    ])
  })

  it('lets a Skeletons node refuse a source that names none', async () => {
    // Most segmentations name no skeleton directory at all, so this is the ordinary answer
    // rather than an edge case — and it has to be given before a Run, not after one.
    await probePrecomputed(BASE)
    let graph = addNode(emptyGraph('t'), node('src', TYPE, { url: SPEC }))
    graph = addNode(graph, node('s', 'neuron.skeletons'))
    graph = addEdge(graph, {
      source: 'src',
      sourceHandle: 'dataset',
      target: 's',
      targetHandle: 'dataset',
    })
    expect(inferGraph(graph).nodes['s']?.issues.map((i) => i.message)).toContain(
      'This dataset has no skeletons',
    )
  })

  it('lets a Meshes node refuse a source that turns out to hold an image stack', async () => {
    serveSegmentation({
      [`${BASE}/info`]: volumeInfo({ type: 'image' }),
    })
    await probePrecomputed(BASE)
    let graph = addNode(emptyGraph('t'), node('src', TYPE, { url: SPEC }))
    graph = addNode(graph, node('m', 'neuron.meshes'))
    graph = addEdge(graph, {
      source: 'src',
      sourceHandle: 'dataset',
      target: 'm',
      targetHandle: 'dataset',
    })
    expect(inferGraph(graph).nodes['m']?.issues.map((i) => i.message)).toContain(
      'This data source has no meshes',
    )
  })
})

describe('validate', () => {
  it('asks for a URL rather than reporting a broken one', () => {
    expect(issues({ url: '' })[0]).toMatch(/Paste a neuroglancer source URL/)
  })

  it('names the format when it is one Coda cannot read', () => {
    // A graphene source is a CAVE datastack, and the message says where to go instead.
    expect(
      issues({ url: 'graphene://middleauth+https://cave.example.org/seg/table/x' })[0],
    ).toMatch(/CAVE dataset node/)
  })

  it('names a location it cannot fetch from', () => {
    // A local path out of a desktop neuroglancer parses perfectly well and names a directory
    // that is not on this machine, which is a different problem from a bad URL.
    expect(issues({ url: 'precomputed://file:///data/seg' })[0]).toMatch(
      /not a location Coda can fetch/,
    )
    expect(issues({ url: 'brainmaps://12345:fafb:v1' })[0]).toMatch(/this one is brainmaps/)
  })

  it('stays silent while the probe is still in flight', () => {
    // The same silence `versionsFor` keeps for a listing that has not landed. Reporting it would
    // put a warning on every one of these cards for the first second of every load.
    expect(issues({ url: SPEC })).toEqual([])
  })

  it('reports what the probe found once it has', async () => {
    serveSegmentation({
      [`${BASE}/info`]: volumeInfo({ type: 'image' }),
    })
    await probePrecomputed(BASE)
    expect(issues({ url: SPEC })[0]).toMatch(/there is no geometry here/)
  })

  it('reports an unreadable URL with the reason the transport gave', async () => {
    restore = serveJson({}).restore
    await probePrecomputed(BASE)
    expect(issues({ url: SPEC })[0]).toMatch(/Could not read gs:\/\/flyem-male-cns/)
  })
})

describe('evaluate', () => {
  it('produces a dataset value naming the source and what was found at it', async () => {
    const graph = addNode(emptyGraph('t'), node('src', TYPE, { url: SPEC }))
    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await scheduler.run(graph, { mode: 'full' })

    const value = scheduler.output('src', 'dataset')
    expect(isDatasetValue(value)).toBe(true)
    if (!isDatasetValue(value)) return
    expect(value.datasetId).toBe('precomputed://gs://flyem-male-cns/v1.0/segmentation')
    // The label is the whole of what a downstream card can show: there is no version dropdown
    // and no Description companion to say what is at the other end.
    expect(value.label).toBe(
      'flyem-male-cns/segmentation · segmentation · multi-resolution meshes',
    )
  })

  it('fails with the transport\u2019s reason rather than an empty dataset', async () => {
    restore = serveJson({}).restore
    const graph = addNode(emptyGraph('t'), node('src', TYPE, { url: SPEC }))
    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.output('src', 'dataset')).toBeUndefined()
  })

  it('does not re-request a URL it already knows is unreachable', async () => {
    /*
     * Invariant 6, arriving by the back door. A node whose `evaluate` throws is not cached, so it
     * re-runs on every auto pass — and a run that retried on its own then re-requested a dead URL
     * a few times a second. `validate` cannot stop it: its strings are warnings, not errors.
     */
    const served = serveJson({})
    restore = served.restore
    const graph = addNode(emptyGraph('t'), node('src', TYPE, { url: SPEC }))
    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })

    await scheduler.run(graph, { mode: 'full' })
    await scheduler.run(graph, { mode: 'full' })
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.output('src', 'dataset')).toBeUndefined()
    expect(served.urls).toHaveLength(1)
  })

  it('reads again when Clear Cache says to', async () => {
    // The way back from a transient failure, and the one control that already means "drop what
    // you are holding and read again".
    restore = serveJson({}).restore
    const graph = addNode(emptyGraph('t'), node('src', TYPE, { url: SPEC }))
    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.output('src', 'dataset')).toBeUndefined()

    serveSegmentation()
    scheduler.clearNodeCache(graph, 'src')
    await scheduler.run(graph, { mode: 'full' })
    expect(isDatasetValue(scheduler.output('src', 'dataset'))).toBe(true)
  })
})

describe('the layer half', () => {
  /** Run the node and return the single layer it emitted. */
  async function layerOf(params: ParamValues): Promise<Record<string, unknown>> {
    const graph = addNode(emptyGraph('t'), node('src', TYPE, { url: SPEC, ...params }))
    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await scheduler.run(graph, { mode: 'full' })
    const value = scheduler.output('src', 'layers')
    if (value?.kind !== 'layers') throw new Error('no layers on the port')
    expect(value.items).toHaveLength(1)
    return value.items[0] as Record<string, unknown>
  }

  it('names the source in neuroglancer’s own spelling, not the one Coda fetches', () => {
    // `parseNgSource` keeps the location in its own scheme precisely for this: a layer pointed at
    // `https://storage.googleapis.com/...` would work only where Coda's proxy decisions do.
    return layerOf({}).then((layer) => {
      expect(layer['source']).toBe('precomputed://gs://flyem-male-cns/v1.0/segmentation')
      expect(layer['type']).toBe('segmentation')
      expect(layer['name']).toBe('segmentation')
    })
  })

  it('reads an image volume as an image layer', async () => {
    serveSegmentation({
      [`${BASE}/info`]: volumeInfo({ type: 'image' }),
    })
    expect((await layerOf({}))['type']).toBe('image')
  })

  it('lets the layer type be overridden for a source the build has not met', async () => {
    expect((await layerOf({ layerType: 'annotation' }))['type']).toBe('annotation')
  })

  it('carries segment ids as text', async () => {
    // Invariant 8 out to the far end: an 18-digit id through `Number` selects a different neuron
    // in somebody else's viewer, with nothing to say so.
    const layer = await layerOf({ segments: '720575940628857210, 720575940624000001\n42' })
    expect(layer['segments']).toEqual(['720575940628857210', '720575940624000001', '42'])
  })

  it('omits segments entirely when none are named', async () => {
    // An empty array and an absent key are not the same thing to neuroglancer, and "show this
    // layer with nothing selected" is what a brain shell or an EM volume wants.
    expect('segments' in (await layerOf({}))).toBe(false)
  })

  it('merges the settings blob over the generated keys, so yours win', async () => {
    const layer = await layerOf({
      settings: '{ "objectAlpha": 0.3, "name": "shell", "segmentDefaultColor": "#88aacc" }',
    })
    expect(layer['objectAlpha']).toBe(0.3)
    expect(layer['segmentDefaultColor']).toBe('#88aacc')
    // Including the generated ones: the field is the escape hatch, so it has to be able to reach
    // everything, and a key it could not override would be an arbitrary exception to explain.
    expect(layer['name']).toBe('shell')
  })

  it('reports a malformed settings blob on the card rather than at Run', () => {
    // The one field here whose mistake is a typo. A missing brace contributing nothing silently
    // would look exactly like a setting neuroglancer had ignored.
    expect(issues({ url: SPEC, settings: '{ "objectAlpha": 0.3' })[0]).toMatch(/not valid JSON/)
    expect(issues({ url: SPEC, settings: '[1, 2]' })[0]).toMatch(/must be a JSON object/)
    expect(issues({ url: SPEC, settings: '  ' })).toEqual([])
  })

  it('chains, because an input port takes exactly one wire', async () => {
    // How more than one extra layer reaches a scene. Wiring order is layer order.
    let graph = addNode(emptyGraph('t'), node('a', TYPE, { url: SPEC, layerName: 'first' }))
    graph = addNode(graph, node('b', TYPE, { url: SPEC, layerName: 'second' }))
    graph = addEdge(graph, {
      source: 'a',
      sourceHandle: 'layers',
      target: 'b',
      targetHandle: 'layers',
    })
    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await scheduler.run(graph, { mode: 'full' })

    const value = scheduler.output('b', 'layers')
    expect(value?.kind === 'layers' && value.items.map((l) => l['name'])).toEqual([
      'first',
      'second',
    ])
  })

  it('still reports a source with no geometry as usable as a layer', async () => {
    // The two halves of this node disagree about an image stack, and the message has to say so:
    // there is nothing for Meshes, and it is a perfectly good layer.
    serveSegmentation({
      [`${BASE}/info`]: volumeInfo({ type: 'image' }),
    })
    await probePrecomputed(BASE)
    expect(issues({ url: SPEC })[0]).toMatch(/still works as a Neuroglancer layer/)
  })
})
