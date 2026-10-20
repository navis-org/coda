/**
 * What the Neuroglancer node itself answers for the export fixture's two cards, recorded so the
 * documents can be run against the same inputs and compared.
 *
 * The goldens say what the emitters write; nothing there says it agrees with the node. So this runs
 * the real `evaluate` — the scene, the colours, the edits, `Selected` — over a committed published
 * scene, neuron table and lookup, with each card's params read off the fixture graph rather than
 * restated, and writes the answer to `__fixtures__/neuroglancer.json`. `probe-py-helpers.py` and
 * `probe-r-helpers.R` execute the golden's cells against the same inputs and compare the decoded
 * link and the `Selected` rows with it. Regenerate with `pnpm export:golden`, like the goldens.
 *
 * The inputs are chosen to disagree with a careless translation: categories tied on count (the
 * alphabetical tie-break), a blank category, a repeated id and an id neuroglancer cannot read, an
 * edit of each kind, and a published scene with the keys `buildScene` overrides.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { CodaGraph } from '../core/graph'
import type { EvalContext, ParamValues } from '../core/node'
import { defaultParams, findParam, resolveColumn } from '../core/node'
import { requireNodeDef } from '../core/registry'
import type { CodaType } from '../core/types'
import { T, column, tableSchema } from '../core/types'
import type { CellValue, DatasetValue, TableValue, Value } from '../core/values'
import { asString, tableFromRows } from '../core/values'
import type { DatastackInfo } from '../data/cave/api'
import { caveScene } from '../data/cave/scene'
import type { NgScene } from '../data/neuroglancer/scene'
import { splitSceneUrl } from '../data/neuroglancer/scene'
import type { DataSource } from '../data/source'
import { CANONICAL_SCHEMAS } from '../data/source'
import { caveGraph, everythingGraph } from './fixture'
import '../nodes'

const FIXTURE = new URL('./__fixtures__/neuroglancer.json', import.meta.url).pathname

/** neuPrint's shape, trimmed: the keys `buildScene` overrides and a layer per role. */
const PUBLISHED: NgScene = {
  dimensions: { x: [8e-9, 'm'], y: [8e-9, 'm'], z: [8e-9, 'm'] },
  position: [17000.5, 20000, 18000],
  projectionScale: 91364.04452716278,
  layout: 'xy',
  showSlices: true,
  selectedLayer: { layer: 'hemibrain:v1.2.1', visible: true, size: 350 },
  badlayers: ['old-roi'],
  layers: [
    {
      type: 'image',
      name: 'em',
      source: 'precomputed://gs://neuroglancer-janelia-flyem-hemibrain/emdata/clahe_yz/jpeg',
    },
    {
      type: 'segmentation',
      name: 'hemibrain:v1.2.1',
      source: {
        url: 'precomputed://gs://neuroglancer-janelia-flyem-hemibrain/v1.2/segmentation',
        subsources: { default: true, meshes: true },
      },
      segmentColors: { '5813105172': '#ff0000' },
      selectedAlpha: 0.2,
    },
    {
      type: 'segmentation',
      name: 'roi',
      source: 'precomputed://gs://neuroglancer-janelia-flyem-hemibrain/v1.2/rois',
      segments: ['1', '2'],
    },
    {
      type: 'annotation',
      name: 'synapses',
      source: 'precomputed://gs://neuroglancer-janelia-flyem-hemibrain/v1.2/synapses',
    },
  ],
}

/** The input table: every rule the colour and the edits have to get right, in eight rows. */
const NEURONS = [
  { neuronId: '1001', type: 'LC4' },
  { neuronId: '1002', type: 'Mi1' },
  { neuronId: '1003', type: 'lc10' },
  { neuronId: '1004', type: null },
  { neuronId: '1005', type: 'LC4' },
  { neuronId: '1003', type: 'T4(a)' },
  { neuronId: 'LC4', type: 'T4_a' },
  { neuronId: null, type: 'T4a' },
]

/** What the dataset answers for a neuron added in the viewer; `998` is added and not listed. */
const LOOKUP = [{ neuronId: '999', type: 'Tm1', instance: 'Tm1_R' }]

const CAVE_INFO = {
  segmentation_source:
    'graphene://https://prod.flywire-daf.com/segmentation/1.0/flywire_public',
  aligned_volume: { image_source: 'precomputed://gs://flywire_em/aligned/v1' },
  viewer_resolution_x: 4,
  viewer_resolution_y: 4,
  viewer_resolution_z: 40,
  viewer_site: 'https://ngl.flywire.ai',
} as unknown as DatastackInfo

const CAVE_LABELS = [
  { neuronId: '720575940600000001', type: 'DNa02', side: 'left' },
  { neuronId: '720575940600000002', type: 'DNa02', side: 'right' },
]

const CAVE_NEURONS = [{ neuronId: '720575940600000002', type: 'DNa02' }]

function table(rows: ReadonlyArray<Record<string, CellValue>>): TableValue {
  const names = Object.keys(rows[0]!)
  return tableFromRows(tableSchema(...names.map((n) => column(n, 'str'))), [...rows], 'neurons')
}

function stubSource(
  scene: NgScene,
  viewerSite: string | undefined,
  lookup: TableValue,
): DataSource {
  return {
    id: 'stub',
    label: 'Stub',
    capabilities: { viewerScene: true },
    schemas: CANONICAL_SCHEMAS,
    fetchViewerScene: () => Promise.resolve(scene),
    peekDataset: () => (viewerSite ? { viewerSite } : undefined),
    findNeurons: () => Promise.resolve(lookup),
  } as unknown as DataSource
}

function paramsOf(graph: CodaGraph, id: string): ParamValues {
  const node = graph.nodes.find((n) => n.id === id)
  if (!node) throw new Error(`no node ${id} in the fixture`)
  return { ...defaultParams(requireNodeDef('out.neuroglancer')), ...node.params } as ParamValues
}

async function answer(
  params: ParamValues,
  datasetId: string,
  neurons: TableValue,
  source: DataSource,
): Promise<{
  base: string
  state: NgScene
  selected: { columns: string[]; rows: unknown[][] }
}> {
  const def = requireNodeDef('out.neuroglancer')
  const inputs: Record<string, Value | undefined> = {
    dataset: { kind: 'dataset', sourceId: 'stub', datasetId, label: datasetId } as DatasetValue,
    neurons,
  }
  const types: Record<string, CodaType | undefined> = {
    dataset: T.dataset('stub', datasetId),
    neurons: T.neurons(neurons.schema),
  }
  const ctx = {
    params,
    refresh: false,
    reportFetched: () => undefined,
    warn: () => undefined,
    publish: () => undefined,
    input: (port: string) => inputs[port],
    inputKey: (port: string) => (inputs[port] ? port : undefined),
    column: (paramId: string) => {
      const p = findParam(def, paramId)
      return p && p.kind === 'column' ? resolveColumn(p, params, types) : undefined
    },
    columns: () => [],
    inputPorts: () => [],
    outputPorts: () => [],
    resolveSource: () => source,
    signal: new AbortController().signal,
    progress: () => {},
  } as unknown as EvalContext
  const out = await def.evaluate(ctx)
  const split = splitSceneUrl(asString(out['url']))
  if (!split) throw new Error('no scene in the link')
  const selected = out['selected'] as TableValue
  const columns = selected.schema.columns.map((c) => c.name)
  const rows = Array.from({ length: selected.length }, (_, row) =>
    columns.map((name) => selected.data[name]?.[row] ?? null),
  )
  return { base: split.base, state: split.scene, selected: { columns, rows } }
}

describe('the Neuroglancer cards the export fixture carries', () => {
  it('answer what the committed record says, which is what the probes compare against', async () => {
    const neuprint = await answer(
      paramsOf(everythingGraph(), 'ng'),
      'hemibrain:v1.2.1',
      table(NEURONS),
      stubSource(PUBLISHED, undefined, table(LOOKUP)),
    )
    const cave = await answer(
      paramsOf(caveGraph(), 'ngCave'),
      'flywire_fafb_public:783',
      table(CAVE_NEURONS),
      stubSource(
        caveScene('flywire_fafb_public', CAVE_INFO)!,
        CAVE_INFO.viewer_site,
        table(CAVE_LABELS),
      ),
    )
    const record = {
      neuprint: { published: PUBLISHED, neurons: NEURONS, lookup: LOOKUP, expected: neuprint },
      cave: { info: CAVE_INFO, labels: CAVE_LABELS, neurons: CAVE_NEURONS, expected: cave },
    }
    const text = `${JSON.stringify(record, null, 2)}\n`
    if (process.env.UPDATE_GOLDEN) writeFileSync(FIXTURE, text)
    expect(text).toEqual(readFileSync(FIXTURE, 'utf-8'))
  })
})
