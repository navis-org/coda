/**
 * The Neuroglancer node: what ends up in the link.
 *
 * The link *is* the output, so the things worth pinning are the ones that would otherwise
 * produce a scene that loads fine and shows the wrong thing — segments on the wrong layer,
 * colours that disagree with the 3D view, a stale link surviving a restyle.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { EvalContext, NodeDefinition, ParamValues } from '../../core/node'
import { defaultParams, findParam, resolveColumn } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import type { CodaType } from '../../core/types'
import { T, column, tableSchema } from '../../core/types'
import type { DatasetValue, TableValue, Value } from '../../core/values'
import { asString, num, tableFromRows } from '../../core/values'
import type { NgScene } from '../../data/neuroglancer/scene'
import { parseSceneUrl } from '../../data/neuroglancer/scene'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import { registerSource, requireSource } from '../../data/source'
import { resolveColor } from '../../ui/encoding'
import { readColorSpec } from '../lib/encodingParams'
import '../index'

const NEURON_SCHEMA = tableSchema(
  column('bodyId', 'i64'),
  column('type', 'str'),
  column('size', 'i64', 'voxels'),
)

/** manc's real published shape, trimmed: an EM layer, the neuron layer, an ROI layer. */
const PUBLISHED: NgScene = {
  position: [1, 2, 3],
  projectionScale: 91364,
  layout: '3d',
  layers: [
    { type: 'image', name: 'em', source: 'precomputed://gs://b/em' },
    { type: 'segmentation', name: 'manc:v1.2.3', source: 'precomputed://gs://b/seg' },
    { type: 'segmentation', name: 'neuropils', source: 'precomputed://gs://b/roi' },
  ],
}

const DATASET_INFO = { id: 'manc:v1.2.3', label: 'manc v1.2.3', rois: [], statuses: [] }

const DATASET: DatasetValue = {
  kind: 'dataset',
  sourceId: 'stub',
  datasetId: 'manc:v1.2.3',
  label: 'manc v1.2.3',
}

function neurons(rows: Array<{ bodyId: number; type: string; size?: number }>): TableValue {
  return tableFromRows(
    NEURON_SCHEMA,
    rows.map((r) => ({ bodyId: r.bodyId, type: r.type, size: r.size ?? 100 })),
    'neurons',
  )
}

/**
 * A source that publishes a scene and nothing else — this node needs no other capability.
 *
 * `null` means "asked, there isn't one", which is a different answer from the default and has
 * to be spelled differently: passing `undefined` would just re-select the default parameter.
 */
function stubSource(scene: NgScene | null = PUBLISHED, id = 'stub'): DataSource {
  return {
    id,
    label: 'Stub',
    capabilities: {
      rawQuery: false,
      skeletons: false,
      meshes: false,
      synapses: false,
      neuronIndex: false,
      viewerScene: scene !== null,
    },
    fetchViewerScene: () => Promise.resolve(scene ?? undefined),
    // Enough of a listing for the generic dataset node to resolve an id, which is all the
    // scheduler-level test below needs from it.
    listDatasets: () => Promise.resolve([DATASET_INFO]),
    peekDatasets: () => [DATASET_INFO],
    peekDataset: () => DATASET_INFO,
  } as unknown as DataSource
}

/**
 * An EvalContext by hand, rather than a graph and a Scheduler.
 *
 * `column` has to resolve exactly as the scheduler's does — infer, evaluate and the cache key
 * all read through it — so it is wired through the same `resolveColumn`.
 */
function evalContext(
  def: NodeDefinition,
  params: ParamValues,
  table: TableValue | undefined,
  source: DataSource,
): EvalContext {
  const inputs: Record<string, Value | undefined> = { dataset: DATASET, neurons: table }
  const types: Record<string, CodaType | undefined> = {
    dataset: T.dataset('stub', 'manc:v1.2.3'),
    // Undefined, not an empty type: an unconnected port has no type at all, which is what
    // makes the column params resolve to nothing.
    neurons: table ? T.neurons(table.schema) : undefined,
  }
  return {
    params,
    input: (portId) => inputs[portId],
    column: (paramId) => {
      const p = findParam(def, paramId)
      return p && p.kind === 'column' ? resolveColumn(p, params, types) : undefined
    },
    columns: () => [],
    resolveSource: () => source,
    signal: new AbortController().signal,
    progress: () => {},
  }
}

const def = () => requireNodeDef('out.neuroglancer')

/** `null` means the port is unconnected — `undefined` would just re-select the default. */
async function sceneFrom(
  overrides: Record<string, unknown> = {},
  table: TableValue | null = neurons([
    { bodyId: 10001, type: 'DNa02' },
    { bodyId: 10002, type: 'DNa02' },
    { bodyId: 10003, type: 'DNp01' },
  ]),
  source = stubSource(),
): Promise<{ url: string; scene: NgScene }> {
  const d = def()
  const params = { ...defaultParams(d), ...overrides } as ParamValues
  const out = await d.evaluate(evalContext(d, params, table ?? undefined, source))
  const url = asString(out['url'])
  const scene = parseSceneUrl(url)
  if (!scene) throw new Error(`no scene in ${url.slice(0, 80)}`)
  return { url, scene }
}

const layersOf = (scene: NgScene) => scene['layers'] as Array<Record<string, unknown>>

beforeAll(() => {
  // Registration is a module side effect of `../index`; fail loudly rather than mysteriously.
  expect(def().type).toBe('out.neuroglancer')
  // `validate` reads capabilities out of the *registry*, so an unregistered source would be
  // assumed capable and the edit-time warning would silently never fire.
  registerSource(stubSource(PUBLISHED))
  registerSource(stubSource(null, 'sceneless'))
  // For the scheduler check below, which needs a real dataset node to feed the port.
  registerSource(new MockSource({ latencyMs: 0 }))
})

describe('the scene it builds', () => {
  it('puts the body ids on the dataset layer and keeps the published camera', () => {
    return sceneFrom().then(({ scene }) => {
      expect(layersOf(scene)[1]!['segments']).toEqual(['10001', '10002', '10003'])
      expect(layersOf(scene)[2]!['segments']).toBeUndefined()
      expect(scene['position']).toEqual([1, 2, 3])
      expect(scene['projectionScale']).toBe(91364)
    })
  })

  it('deduplicates repeated ids', async () => {
    // A join upstream can easily produce one row per partner, i.e. the same neuron many times.
    const { scene } = await sceneFrom(
      {},
      neurons([
        { bodyId: 7, type: 'A' },
        { bodyId: 7, type: 'A' },
        { bodyId: 8, type: 'B' },
      ]),
    )
    expect(layersOf(scene)[1]!['segments']).toEqual(['7', '8'])
  })
})

describe('with no neurons', () => {
  it('still builds the published scene, just with nothing selected', async () => {
    // A dataset alone is a legitimate thing to look at: the published state already frames
    // the volume with its EM and ROI meshes.
    const { scene } = await sceneFrom({}, null)
    expect(layersOf(scene)[1]!['segments']).toEqual([])
    expect(scene['position']).toEqual([1, 2, 3])
    expect(layersOf(scene)).toHaveLength(3)
  })

  it('treats an empty neuron table the same way', async () => {
    // What an untouched Explore selection produces, and what a starter graph opens in.
    const { scene } = await sceneFrom({}, neurons([]))
    expect(layersOf(scene)[1]!['segments']).toEqual([])
  })

  it('runs to a scene with only a Dataset wired, through the real scheduler', async () => {
    /*
     * The symptom, at the level it was reported. With the port required, the scheduler marked
     * the node `blocked`, never called evaluate, and the card sat behind "No result yet"
     * however valid the dataset was. A port-flag assertion alone would not have caught that —
     * this drives the scheduler and checks it actually produced a link.
     */
    let graph = addNode(emptyGraph('ngl'), {
      id: 'ds',
      type: 'neuron.dataset',
      position: { x: 0, y: 0 },
      params: {
        ...defaultParams(requireNodeDef('neuron.dataset')),
        source: 'stub',
        dataset: 'manc:v1.2.3',
      },
    })
    graph = addNode(graph, {
      id: 'ngl',
      type: 'out.neuroglancer',
      position: { x: 300, y: 0 },
      params: defaultParams(def()),
    })
    graph = addEdge(graph, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'ngl',
      targetHandle: 'dataset',
    })

    const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })
    const summary = await scheduler.run(graph, { mode: 'full' })

    expect(summary.failed).toEqual([])
    expect(scheduler.info('ngl').state).toBe('ok')
    const scene = parseSceneUrl(asString(scheduler.output('ngl', 'url')))
    expect(scene && layersOf(scene)[1]!['segments']).toEqual([])
  })

  it('still refuses something that is connected but is not a table', async () => {
    const d = def()
    const params = defaultParams(d)
    const ctx = evalContext(d, params, undefined, stubSource())
    const wrong = { ...ctx, input: (port: string) => (port === 'dataset' ? DATASET : num(1)) }
    await expect(d.evaluate(wrong)).rejects.toThrow(/not a table/)
  })
})

describe('colour', () => {
  it('starts on a label column, not on bodyId', async () => {
    // `bodyId` is the first compatible column, and a categorical encoding over it caps at
    // eight slots plus grey — so unrelated neurons share a hue and read as a group.
    const { scene } = await sceneFrom()
    const colors = layersOf(scene)[1]!['segmentColors'] as Record<string, string>
    // 10001 and 10002 are both DNa02; 10003 is not.
    expect(colors['10001']).toBe(colors['10002'])
    expect(colors['10001']).not.toBe(colors['10003'])
  })

  it('agrees with what the 3D view would draw for the same column', async () => {
    // The point of borrowing `resolveColor` rather than mapping hues here: one neuron, one
    // colour, whichever viewer is looking at it.
    const table = neurons([
      { bodyId: 1, type: 'DNa02' },
      { bodyId: 2, type: 'DNa02' },
      { bodyId: 3, type: 'DNp01' },
    ])
    const { scene } = await sceneFrom(
      { segmentColorMode: 'categorical', segmentColorBy: 'type' },
      table,
    )
    const colors = layersOf(scene)[1]!['segmentColors'] as Record<string, string>

    const d = def()
    const params = {
      ...defaultParams(d),
      segmentColorMode: 'categorical',
      segmentColorBy: 'type',
    }
    const spec = readColorSpec('segment', params, () => 'type')
    const expected = resolveColor(table, spec, 'dark')
    expect(colors['1']).toBe(expected.at(0))
    expect(colors['3']).toBe(expected.at(2))
    // Same category, same colour; different category, different colour.
    expect(colors['1']).toBe(colors['2'])
    expect(colors['1']).not.toBe(colors['3'])
  })

  it('sends no colours at all in "default" mode, leaving neuroglancer to hash them', async () => {
    // The shortest possible link, and neuroglancer's own per-segment colours are genuinely
    // useful — so this has to mean "say nothing", not "say grey".
    const { scene } = await sceneFrom({ segmentColorMode: 'default' })
    const layer = layersOf(scene)[1]!
    expect(layer['segmentDefaultColor']).toBeUndefined()
    expect(layer['segmentColors']).toEqual({})
    expect(layer['segments']).toEqual(['10001', '10002', '10003'])
  })

  it('makes a shorter link in "default" mode than in a data-driven one', async () => {
    const plain = await sceneFrom({ segmentColorMode: 'default' })
    const byType = await sceneFrom({ segmentColorMode: 'categorical', segmentColorBy: 'type' })
    expect(plain.url.length).toBeLessThan(byType.url.length)
  })

  it('uses one default colour rather than a map when the colour is constant', async () => {
    // A map repeating one value costs ~40 bytes a neuron to say nothing.
    const { scene } = await sceneFrom({ segmentColorMode: 'constant', segmentColor: '1' })
    const layer = layersOf(scene)[1]!
    expect(layer['segmentColors']).toEqual({})
    expect(String(layer['segmentDefaultColor'])).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('guard rails', () => {
  it('refuses more neurons than the limit, and blames the right cost', async () => {
    // Not a fetch limit — nothing is downloaded here. Saying so is what stops this being
    // read as the morphology nodes' ceiling.
    const many = neurons(Array.from({ length: 6 }, (_, i) => ({ bodyId: i + 1, type: 'A' })))
    await expect(sceneFrom({ limit: 5 }, many)).rejects.toThrow(
      /exceeds this node's Max neurons \(5\)/,
    )
    await expect(sceneFrom({ limit: 5 }, many)).rejects.toThrow(/Nothing is downloaded here/)
  })

  it('says so when the dataset publishes no scene', async () => {
    const table = neurons([{ bodyId: 1, type: 'A' }])
    await expect(sceneFrom({}, table, stubSource(null))).rejects.toThrow(
      /publishes no neuroglancer scene/,
    )
  })

  it('warns at edit time rather than waiting for a run', () => {
    const issues =
      def().validate?.({
        params: {},
        inputs: { dataset: T.dataset('sceneless', 'whatever:v1') },
        schema: () => undefined,
        attributes: () => undefined,
        column: () => undefined,
        columns: () => [],
      }) ?? []
    expect(issues.join(' ')).toMatch(/publishes no neuroglancer scene/)
  })
})

describe('the node on the canvas', () => {
  it('opens big enough to be a viewer', () => {
    // Without this it inherits the 360px preview width and a 210px preview cap, which is a
    // letterbox rather than something you can navigate a brain in.
    const size = def().defaultSize
    expect(size?.width).toBeGreaterThanOrEqual(360)
    expect(size?.height).toBeGreaterThanOrEqual(320)
  })

  it('keeps every control out of the node body', () => {
    // All params advanced, i.e. inspector-only: a row of pickers over the embed would take a
    // tenth of the space someone opened this node for.
    const inBody = (def().params ?? []).filter((p) => !p.advanced)
    expect(inBody.map((p) => p.id)).toEqual([])
  })
})

describe('provenance', () => {
  it('marks presentational exactly what cannot reach the URL', () => {
    // Marking a colour param presentational would keep a link showing colours nobody chose:
    // the node would stay `ok` while the URL still carried the old palette. `uiScale` is the
    // other side of the same rule — it scales the iframe and cannot change a byte of output.
    const presentational = (def().params ?? []).filter((p) => p.presentational).map((p) => p.id)
    expect(presentational).toEqual(['uiScale'])
  })

  it('does not let the interface scale change the link', async () => {
    const wide = await sceneFrom({ uiScale: 0.5 })
    const narrow = await sceneFrom({ uiScale: 1.25 })
    expect(wide.url).toBe(narrow.url)
  })

  it('changes the link when the colour column changes', async () => {
    const table = neurons([
      { bodyId: 1, type: 'A', size: 10 },
      { bodyId: 2, type: 'B', size: 20 },
    ])
    const byType = await sceneFrom(
      { segmentColorMode: 'categorical', segmentColorBy: 'type' },
      table,
    )
    const bySize = await sceneFrom(
      { segmentColorMode: 'sequential', segmentColorBy: 'size' },
      table,
    )
    expect(byType.url).not.toBe(bySize.url)
  })

  it('drops the published context layers on request, which is what shortens the link', async () => {
    const all = await sceneFrom({ layers: 'all' })
    const only = await sceneFrom({ layers: 'segmentation' })
    expect(layersOf(only.scene)).toHaveLength(1)
    expect(only.url.length).toBeLessThan(all.url.length)
  })
})
