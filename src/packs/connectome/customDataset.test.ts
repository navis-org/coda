/**
 * The Custom Dataset node, end to end: a neuron table from one place, geometry from a dataset
 * somewhere else, and the query nodes below it reading the result as an ordinary Dataset.
 *
 * What is worth pinning is the seam rather than any one function. The failures this node can have
 * are all silent — a capability read off the wrong id refuses nothing or everything, a geometry
 * attribute table carrying the delegate's columns breaks every picker after a Run, and a type
 * without a neuron schema leaves Explore browsing a list of bare ids — so each test asks the
 * question the way a downstream node asks it.
 */

import { readFileSync } from 'node:fs'
import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { CodaGraph } from '../../core/graph'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import { ID_COLUMN_NAME } from '../../core/ids'
import { inferGraph } from '../../core/inference'
import { registerNode } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import type { TableSchema } from '../../core/types'
import { T, attributeSchema, column, datasetRef, tableSchema } from '../../core/types'
import type { CellValue, DatasetValue } from '../../core/values'
import { isDatasetValue, isTableValue, tableFromRows } from '../../core/values'
import { CompositeSource } from '../../data/custom/CompositeSource'
import { resetCustomDatasets } from '../../data/custom/layout'
import { resetEdgeSets } from '../../data/edges/store'
import { holdLocalFile } from '../../data/files/registry'
import { connectivityFor } from '../../data/queries'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource, requireSource } from '../../data/source'
import { sourceSupports } from '../../nodes/lib/datasetParam'
import '../../nodes'
import { node } from '../../test/graph'

const TYPE = 'connectome:customDataset'
const MOCK = 'dataset.mock.opticlobe'

/**
 * A table node whose rows each test sets, standing in for an upload or a sheet: what matters is
 * that the neuron table arrives from *somewhere other* than the geometry's dataset, keyed by a
 * column that is not called `neuronId`.
 */
let rows: Array<Record<string, CellValue>> = []
let schema: TableSchema = tableSchema(column('root_id', 'str'), column('cell_type', 'str'))
registerNode({
  type: 'test.custom.table',
  label: 'Table (test)',
  category: 'utility',
  cost: 'cheap',
  inputs: [],
  outputs: [{ id: 'out', label: 'Out', type: T.table() }],
  inferOutputs: () => ({ out: T.table(schema) }),
  evaluate: () => ({ out: tableFromRows(schema, rows) }),
})

/** The edge list, the same way: a table from somewhere, with columns named as a file names them. */
let edgeRows: Array<Record<string, CellValue>> = []
const EDGE_SCHEMA: TableSchema = tableSchema(
  column('pre_root_id', 'str'),
  column('post_root_id', 'str'),
  column('syn_count', 'i64'),
)
let edgeSchema = EDGE_SCHEMA
registerNode({
  type: 'test.custom.edges',
  label: 'Edges (test)',
  category: 'utility',
  cost: 'cheap',
  inputs: [],
  outputs: [{ id: 'out', label: 'Out', type: T.table() }],
  inferOutputs: () => ({ out: T.table(edgeSchema) }),
  evaluate: () => ({ out: tableFromRows(edgeSchema, edgeRows) }),
})

/** A synapse table: one row per connection, coordinates in voxels, a score and a carried column. */
let synapseRows: Array<Record<string, CellValue>> = []
const SYNAPSE_SCHEMA: TableSchema = tableSchema(
  column('pre_pt_root_id', 'str'),
  column('post_pt_root_id', 'str'),
  column('x', 'i64'),
  column('y', 'i64'),
  column('z', 'i64'),
  column('score', 'f64'),
  column('nt', 'str'),
)
registerNode({
  type: 'test.custom.synapses',
  label: 'Synapses (test)',
  category: 'utility',
  cost: 'cheap',
  inputs: [],
  outputs: [{ id: 'out', label: 'Out', type: T.table() }],
  inferOutputs: () => ({ out: T.table(SYNAPSE_SCHEMA) }),
  evaluate: () => ({ out: tableFromRows(SYNAPSE_SCHEMA, synapseRows) }),
})

const mock = new MockSource({ latencyMs: 0 })
let mockIds: string[] = []

beforeAll(async () => {
  registerSource(mock)
  registerSource(new CompositeSource())
  // The mock family's own id, read the way its node reads it — and some of its neurons, so the
  // neuron table names ids the geometry part really has.
  const scheduler = await run(addNode(emptyGraph('ids'), node('ds', MOCK)))
  const dataset = scheduler.output('ds', 'dataset') as DatasetValue
  const index = await mock.neuronIndex({ datasetId: dataset.datasetId })
  mockIds = (index.data[ID_COLUMN_NAME] ?? []).slice(0, 3).map(String)
})

beforeEach(() => {
  resetCustomDatasets()
  resetEdgeSets()
  edgeSchema = EDGE_SCHEMA
  // 1 → 2 twice, 1 → 3 and 3 → 1: as rows, `1 → 2` weighs 2 when counted.
  synapseRows = [
    { pre_pt_root_id: '1', post_pt_root_id: '2', x: 1, y: 2, z: 3, score: 0.9, nt: 'ACh' },
    { pre_pt_root_id: '1', post_pt_root_id: '2', x: 4, y: 5, z: 6, score: 0.2, nt: 'ACh' },
    { pre_pt_root_id: '1', post_pt_root_id: '3', x: 7, y: 8, z: 9, score: 0.8, nt: 'GABA' },
    { pre_pt_root_id: '3', post_pt_root_id: '1', x: 1, y: 1, z: 1, score: 0.7, nt: 'Glu' },
  ]
  // 1 → 2 twice (summed), 1 → 3, 3 → 1.
  edgeRows = [
    { pre_root_id: '1', post_root_id: '2', syn_count: 4 },
    { pre_root_id: '1', post_root_id: '2', syn_count: 1 },
    { pre_root_id: '1', post_root_id: '3', syn_count: 2 },
    { pre_root_id: '3', post_root_id: '1', syn_count: 7 },
  ]
  schema = tableSchema(column('root_id', 'str'), column('cell_type', 'str'))
  rows = [
    { root_id: mockIds[0]!, cell_type: 'T4' },
    { root_id: mockIds[1]!, cell_type: 'T5' },
    { root_id: mockIds[2]!, cell_type: 'LT1' },
  ]
})

function wire(
  graph: CodaGraph,
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
) {
  return addEdge(graph, { source, sourceHandle, target, targetHandle })
}

/** A full Run over every registered source — the mock and the composite both. */
async function run(graph: CodaGraph) {
  const scheduler = new Scheduler({ resolveSource: (id) => requireSource(id) })
  await scheduler.run(graph, { mode: 'full' })
  return scheduler
}

/**
 * A Custom Dataset `c`, with whichever parts are asked for wired into it. Its id column is
 * `root_id` unless another is named; `null` leaves the declared default in place.
 */
function customGraph(parts: {
  neurons?: boolean
  edges?: boolean
  synapses?: boolean
  meshes?: boolean
  skeletons?: boolean
  idColumn?: string | null
  params?: Record<string, unknown>
}) {
  const { idColumn = 'root_id' } = parts
  let graph = addNode(
    emptyGraph('custom'),
    node('c', TYPE, { ...(idColumn === null ? {} : { idColumn }), ...parts.params }),
  )
  if (parts.synapses) {
    graph = addNode(graph, node('s', 'test.custom.synapses'))
    graph = wire(graph, 's', 'out', 'c', 'synapses')
  }
  if (parts.edges) {
    graph = addNode(graph, node('e', 'test.custom.edges'))
    graph = wire(graph, 'e', 'out', 'c', 'edges')
  }
  if (parts.neurons) {
    graph = addNode(graph, node('t', 'test.custom.table'))
    graph = wire(graph, 't', 'out', 'c', 'neurons')
  }
  if (parts.meshes || parts.skeletons) {
    graph = addNode(graph, node('ds', MOCK))
    if (parts.meshes) graph = wire(graph, 'ds', 'dataset', 'c', 'meshes')
    if (parts.skeletons) graph = wire(graph, 'ds', 'dataset', 'c', 'skeletons')
  }
  return graph
}

function issues(graph: CodaGraph, id: string): string[] {
  return inferGraph(graph).nodes[id]?.issues.map((issue) => issue.message) ?? []
}

describe('inference', () => {
  it('publishes the neuron table’s schema, keyed by neuronId, on the type', () => {
    const type = inferGraph(customGraph({ neurons: true })).nodes['c']?.outputs.dataset
    expect(datasetRef(type)?.sourceId).toBe('custom')
    // What every picker downstream offers, before anything has run.
    expect(
      type?.kind === 'dataset' ? type.annotations?.columns.map((c) => c.name) : [],
    ).toEqual([ID_COLUMN_NAME, 'cell_type'])
  })

  it('answers capabilities for the layout before a Run, per part', () => {
    const both = inferGraph(customGraph({ neurons: true, meshes: true })).nodes['c']?.outputs
      .dataset
    expect(sourceSupports(both, 'neuronIndex')).toBe(true)
    expect(sourceSupports(both, 'meshes')).toBe(true)
    expect(sourceSupports(both, 'skeletons')).toBe(false)
    expect(sourceSupports(both, 'synapses')).toBe(false)

    const bare = inferGraph(customGraph({ meshes: true })).nodes['c']?.outputs.dataset
    expect(sourceSupports(bare, 'neuronIndex')).toBe(false)
  })

  it('lets a Meshes node below it refuse when no geometry part is wired', () => {
    let graph = customGraph({ neurons: true })
    graph = addNode(graph, node('m', 'neuron.meshes'))
    graph = wire(graph, 'c', 'dataset', 'm', 'dataset')
    expect(issues(graph, 'm')).toContain('This data source has no meshes')
  })
})

describe('validate', () => {
  it('asks for a part when nothing is wired', () => {
    const graph = addNode(emptyGraph('empty'), node('c', TYPE))
    expect(issues(graph, 'c')).toEqual([expect.stringMatching(/Wire at least one part/)])
  })

  it('asks for the id column rather than substituting another one', () => {
    // The default is `neuronId`, which this table does not have. A required picker would have
    // taken `root_id` — or `cell_type` — without a word.
    const graph = customGraph({ neurons: true, idColumn: null })
    expect(issues(graph, 'c')).toContain(
      'Pick which column of the Neurons table holds the neuron id.',
    )
    expect(inferGraph(graph).nodes['c']?.outputs.dataset).not.toHaveProperty('annotations')
  })

  it('refuses a decimal id column, before and at Run', async () => {
    schema = tableSchema(column('root_id', 'f64'), column('cell_type', 'str'))
    rows = [{ root_id: 1.5, cell_type: 'T4' }]
    const graph = customGraph({ neurons: true })
    expect(issues(graph, 'c')).toEqual([expect.stringMatching(/decimals/)])
    expect((await run(graph)).output('c', 'dataset')).toBeUndefined()
  })
})

describe('a run', () => {
  it('labels Input IDs from the neuron table and fetches meshes from the other dataset', async () => {
    let graph = customGraph({ neurons: true, meshes: true })
    graph = addNode(
      graph,
      node('ids', 'neuron.inputIds', { ids: mockIds.slice(0, 2).join(', ') }),
    )
    graph = wire(graph, 'c', 'dataset', 'ids', 'dataset')
    graph = addNode(graph, node('m', 'neuron.meshes'))
    graph = wire(graph, 'c', 'dataset', 'm', 'dataset')
    graph = wire(graph, 'ids', 'neurons', 'm', 'neurons')

    const scheduler = await run(graph)
    const found = scheduler.output('ids', 'neurons')
    expect(isTableValue(found) ? found.data.cell_type : []).toEqual(['T4', 'T5'])

    const meshes = scheduler.output('m', 'meshes')
    expect(meshes?.kind).toBe('meshes')
    if (meshes?.kind !== 'meshes') return
    expect(meshes.items.map((item) => item.id)).toEqual(mockIds.slice(0, 2))
    // Invariant 3: the attribute table is the one inference promised, not the delegate's own.
    const inferred = attributeSchema(inferGraph(graph).nodes['m']?.outputs.meshes)
    expect(meshes.attributes.schema).toEqual(inferred)
    expect(meshes.attributes.data.cell_type).toEqual(['T4', 'T5'])
  })

  it('publishes a build id on the value, apart from the type’s layout id', async () => {
    const graph = customGraph({ neurons: true, meshes: true })
    const scheduler = await run(graph)
    const value = scheduler.output('c', 'dataset')
    const typeId = datasetRef(inferGraph(graph).nodes['c']?.outputs.dataset)?.datasetId
    expect(isDatasetValue(value) && value.datasetId.startsWith(`${typeId}/`)).toBe(true)
  })

  it('keys two id columns of one table as two datasets', async () => {
    schema = tableSchema(column('root_id', 'str'), column('alt_id', 'str'))
    rows = [{ root_id: mockIds[0]!, alt_id: mockIds[1]! }]
    const graph = (idColumn: string) => customGraph({ neurons: true, idColumn })
    const first = (await run(graph('root_id'))).output('c', 'dataset') as DatasetValue
    const second = (await run(graph('alt_id'))).output('c', 'dataset') as DatasetValue
    expect(first.datasetId).not.toBe(second.datasetId)
    expect(first.annotations?.key).not.toBe(second.annotations?.key)
  })
})

describe('the source', () => {
  const source = new CompositeSource()

  const built = async (parts: { neurons?: boolean; meshes?: boolean }) =>
    (await run(customGraph(parts))).output('c', 'dataset') as DatasetValue

  it('anchors a label pattern the way every other local source does', async () => {
    const dataset = await built({ neurons: true })
    const table = await source.findNeurons({
      datasetId: dataset.datasetId,
      annotations: dataset.annotations,
      labels: { field: 'cell_type', values: ['T.'], regex: true },
    })
    // `T.` matches T4 and T5 and not LT1 — `anchoredPattern`'s `^(?:…)$`.
    expect(table.data.cell_type).toEqual(['T4', 'T5'])
  })

  it('answers typed ids with no neuron table, and refuses a question it cannot answer', async () => {
    const dataset = await built({ meshes: true })
    const ids = await source.findNeurons({
      datasetId: dataset.datasetId,
      neuronIds: ['7', '7', '8'],
    })
    expect(ids.data[ID_COLUMN_NAME]).toEqual(['7', '8'])
    await expect(source.findNeurons({ datasetId: dataset.datasetId })).rejects.toThrow(
      /no neuron table/,
    )
  })

  it('refuses a layout id, which is all a reference port is ever handed', async () => {
    const graph = customGraph({ neurons: true })
    const layoutId = datasetRef(inferGraph(graph).nodes['c']?.outputs.dataset)?.datasetId ?? ''
    await expect(source.neuronIndex({ datasetId: layoutId })).rejects.toThrow(/not run yet/)
  })

  it('says when the geometry part comes back short, and suspects the ids when it is empty', async () => {
    // The mock skips an id it does not have, which is how a real segmentation answers too.
    const dataset = await built({ meshes: true })
    const warnings: string[] = []
    const onWarn = (message: string) => warnings.push(message)
    await source.fetchMeshes({
      datasetId: dataset.datasetId,
      neuronIds: ['999999999999'],
      onWarn,
    })
    await source.fetchMeshes({
      datasetId: dataset.datasetId,
      neuronIds: [mockIds[0]!, '999999999999'],
      onWarn,
    })
    expect(warnings).toEqual([
      expect.stringMatching(/uses the same ids as the neuron table/),
      expect.stringMatching(/^1 of 2 neurons have no mesh/),
    ])
  })
})

describe('an edge list', () => {
  /** The three pickers, set to this table's columns. */
  const PICKED = { pre: 'pre_root_id', post: 'post_root_id', weight: 'syn_count' }

  it('turns on the connectivity capabilities, and neurons, before a Run', () => {
    const type = inferGraph(customGraph({ edges: true, params: PICKED })).nodes['c']?.outputs
      .dataset
    expect(type?.kind === 'dataset' && type.edges).toBe(true)
    expect(sourceSupports(type, 'paths')).toBe(true)
    expect(sourceSupports(type, 'synapseTotals')).toBe(true)
    // No neuron table: the ids the list mentions are the neurons.
    expect(sourceSupports(type, 'neuronIndex')).toBe(true)
  })

  it('asks for each end, naming the column the importer would guess, rather than substituting', () => {
    // The defaults `pre` / `post` / `weight` are not in this table.
    const found = issues(customGraph({ edges: true }), 'c')
    expect(found).toContain(
      'Pick the Edges column holding the presynaptic id — "pre_root_id" looks like it.',
    )
    expect(found).toContain(
      'Pick the Edges column holding the postsynaptic id — "post_root_id" looks like it.',
    )
    // The untouched default counts rows, and says which column looks like a weight.
    expect(found).toContainEqual(
      expect.stringMatching(/no "weight" column, so each row counts as one — "syn_count"/),
    )
  })

  it('answers Connectivity from the list, weights summed per pair', async () => {
    let graph = customGraph({ edges: true, params: PICKED })
    graph = addNode(graph, node('ids', 'neuron.inputIds', { ids: '1' }))
    graph = wire(graph, 'c', 'dataset', 'ids', 'dataset')
    graph = addNode(graph, node('conn', 'neuron.connectivity', { direction: 'outputs' }))
    graph = wire(graph, 'c', 'dataset', 'conn', 'dataset')
    graph = wire(graph, 'ids', 'neurons', 'conn', 'neurons')

    const table = (await run(graph)).output('conn', 'connections')
    expect(isTableValue(table)).toBe(true)
    if (!isTableValue(table)) return
    const post = table.data.postId ?? []
    const weight = table.data.weight ?? []
    expect(Object.fromEntries(post.map((id, i) => [id, weight[i]]))).toEqual({ '2': 5, '3': 2 })
  })

  it('says a weight column holding text is why rows are counted', () => {
    edgeSchema = tableSchema(
      column('pre_root_id', 'str'),
      column('post_root_id', 'str'),
      column('weight', 'str'),
    )
    const params = { pre: 'pre_root_id', post: 'post_root_id' }
    const found = issues(customGraph({ edges: true, params }), 'c')
    expect(found).toContainEqual(expect.stringMatching(/"weight" column does not hold numbers/))
    expect(found).not.toContainEqual(expect.stringMatching(/There is no "weight" column/))
  })

  it('says how many rows it left out, on the card that asked', async () => {
    edgeRows.push(
      { pre_root_id: '1', post_root_id: '4', syn_count: null },
      { pre_root_id: '1', post_root_id: '', syn_count: 3 },
    )
    let graph = customGraph({ edges: true, params: PICKED })
    graph = addNode(graph, node('ids', 'neuron.inputIds', { ids: '1' }))
    graph = wire(graph, 'c', 'dataset', 'ids', 'dataset')
    graph = addNode(graph, node('conn', 'neuron.connectivity', { direction: 'outputs' }))
    graph = wire(graph, 'c', 'dataset', 'conn', 'dataset')
    graph = wire(graph, 'ids', 'neurons', 'conn', 'neurons')
    const scheduler = await run(graph)
    expect(scheduler.warning('conn')).toMatch(/2 rows of the edge list .* were left out/)
  })

  it('counts rows when no weight column is chosen', async () => {
    const dataset = (
      await run(customGraph({ edges: true, params: { ...PICKED, weight: '' } }))
    ).output('c', 'dataset') as DatasetValue
    const table = await connectivityFor(new CompositeSource(), {
      ...dataset,
      neuronIds: ['1'],
      direction: 'outputs',
    })
    expect(table.data.weight).toEqual(expect.arrayContaining([2, 1]))
  })

  it('counts rows on the untouched default weight, and refuses a chosen column that is gone', async () => {
    const byDefault = (
      await run(customGraph({ edges: true, params: { pre: PICKED.pre, post: PICKED.post } }))
    ).output('c', 'dataset') as DatasetValue
    const table = await connectivityFor(new CompositeSource(), {
      ...byDefault,
      neuronIds: ['1'],
      direction: 'outputs',
    })
    expect(table.data.weight).toEqual(expect.arrayContaining([2, 1]))

    const gone = customGraph({ edges: true, params: { ...PICKED, weight: 'synapses' } })
    expect((await run(gone)).output('c', 'dataset')).toBeUndefined()
  })

  it('names its neurons from the list when no neuron table is wired', async () => {
    const dataset = (await run(customGraph({ edges: true, params: PICKED }))).output(
      'c',
      'dataset',
    ) as DatasetValue
    const index = await new CompositeSource().neuronIndex({ datasetId: dataset.datasetId })
    expect(index.data[ID_COLUMN_NAME]).toEqual(['1', '2', '3'])
  })

  it('keys the set by its input and columns, and says how to rebuild one no longer held', async () => {
    const first = (await run(customGraph({ edges: true, params: PICKED }))).output(
      'c',
      'dataset',
    ) as DatasetValue
    const again = (await run(customGraph({ edges: true, params: PICKED }))).output(
      'c',
      'dataset',
    ) as DatasetValue
    const unweighted = (
      await run(customGraph({ edges: true, params: { ...PICKED, weight: '' } }))
    ).output('c', 'dataset') as DatasetValue
    expect(again.edges?.id).toBe(first.edges?.id)
    expect(unweighted.edges?.id).not.toBe(first.edges?.id)

    resetEdgeSets()
    await expect(
      connectivityFor(new CompositeSource(), {
        ...first,
        neuronIds: ['1'],
        direction: 'outputs',
      }),
    ).rejects.toThrow(
      /no longer held in this tab\. Select the dataset node it is wired into, press Invalidate/,
    )
  })
})

describe('a synapse table', () => {
  /** Voxels of 4 × 4 × 40 nm, and the neurotransmitter carried. */
  const SYN = { synCarry: ['nt'], voxelSize: '4, 4, 40' }
  const built = async (params: Record<string, unknown> = SYN) =>
    (await run(customGraph({ synapses: true, params }))).output('c', 'dataset') as DatasetValue

  it('publishes synapses, with the carried column, and connectivity, before a Run', () => {
    const graph = customGraph({ synapses: true, params: SYN })
    const type = inferGraph(graph).nodes['c']?.outputs.dataset
    expect(sourceSupports(type, 'synapses')).toBe(true)
    expect(sourceSupports(type, 'paths')).toBe(true)
    let below = addNode(graph, node('syn', 'neuron.synapses'))
    below = wire(below, 'c', 'dataset', 'syn', 'dataset')
    const points = inferGraph(below).nodes['syn']?.outputs.points
    expect(attributeSchema(points)?.columns.map((c) => c.name)).toEqual([
      ID_COLUMN_NAME,
      'partnerId',
      'polarity',
      'nt',
    ])
  })

  it('asks for the position columns it cannot find, naming the likely ones', () => {
    synapseRows = []
    const graph = customGraph({
      synapses: true,
      params: { ...SYN, synPosition: ['nope', 'y', 'z'] },
    })
    expect(issues(graph, 'c')).toContain(
      'Pick three Synapses position columns, x, y and z in that order — "x", "y", "z" look like them.',
    )
  })

  it('draws a neuron’s synapses in nanometres, oriented and carrying the extra column', async () => {
    let graph = customGraph({ synapses: true, params: SYN })
    graph = addNode(graph, node('ids', 'neuron.inputIds', { ids: '1' }))
    graph = wire(graph, 'c', 'dataset', 'ids', 'dataset')
    graph = addNode(graph, node('syn', 'neuron.synapses'))
    graph = wire(graph, 'c', 'dataset', 'syn', 'dataset')
    graph = wire(graph, 'ids', 'neurons', 'syn', 'neurons')

    const points = (await run(graph)).output('syn', 'points')
    expect(points?.kind).toBe('points')
    if (points?.kind !== 'points') return
    // Neuron 1 is pre on three rows and post on one.
    expect(points.attributes.data.polarity).toEqual(['pre', 'pre', 'pre', 'post'])
    expect(points.attributes.data.partnerId).toEqual(['2', '2', '3', '3'])
    expect(points.attributes.data.nt).toEqual(['ACh', 'ACh', 'GABA', 'Glu'])
    expect([...points.positions.slice(0, 3)]).toEqual([4, 8, 120])
    expect(points.units).toBe('nm')
    // A table cannot say which template space it is in, so none is claimed.
    expect(points.space).toBeUndefined()
    // Invariant 3: the attributes are the schema inference promised.
    expect(points.attributes.schema).toEqual(
      attributeSchema(inferGraph(graph).nodes['syn']?.outputs.points),
    )
  })

  it('warns that Min confidence was ignored, a synapse table carrying no score', async () => {
    const dataset = await built()
    const warnings: string[] = []
    const points = await new CompositeSource().fetchSynapses({
      datasetId: dataset.datasetId,
      neuronIds: ['1'],
      polarity: 'pre',
      minConfidence: 0.5,
      unit: 'links',
      onWarn: (message) => warnings.push(message),
    })
    expect(points.attributes.length).toBe(3)
    expect(warnings).toEqual([expect.stringMatching(/Min confidence was ignored/)])
  })

  it('answers synapses between two sets, oriented', async () => {
    const dataset = await built()
    const points = await new CompositeSource().fetchSynapsesBetween({
      datasetId: dataset.datasetId,
      sourceIds: ['1'],
      targetIds: ['2'],
      location: 'pre',
    })
    expect(points.attributes.data[ID_COLUMN_NAME]).toEqual(['1', '1'])
    expect(points.attributes.data.partnerId).toEqual(['2', '2'])
    // One position per synapse, end unknown: the column that names the drawn end stays empty.
    expect(points.attributes.data.polarity).toEqual([null, null])
  })

  it('answers Connectivity from its rows, counted per pair, when no edge list is wired', async () => {
    const dataset = await built()
    const table = await connectivityFor(new CompositeSource(), {
      ...dataset,
      neuronIds: ['1'],
      direction: 'outputs',
    })
    expect(dataset.edges?.name).toBe('the Synapses table')
    const post = table.data.partnerId ?? []
    const weight = table.data.weight ?? []
    expect(Object.fromEntries(post.map((id, i) => [id, weight[i]]))).toEqual({ '2': 2, '3': 1 })
  })
})

describe('a synapse table from a Link Table file', () => {
  it('looks each neuron up in the file, with the ids exact', async () => {
    const bytes = readFileSync('src/data/files/__fixtures__/synapses.parquet')
    const fileId = holdLocalFile(new File([bytes], 'synapses.parquet', { lastModified: 1 }))
    let graph = addNode(
      emptyGraph('file'),
      node('c', TYPE, {
        synPre: 'pre_pt_root_id',
        synPost: 'post_pt_root_id',
        // The fixture has no coordinates; any three numeric columns stand in for them.
        synPosition: ['size', 'size', 'score'],
        synCarry: ['region'],
      }),
    )
    graph = addNode(
      graph,
      node('f', 'core.linkTable', { fileId, fileName: 'synapses.parquet' }),
    )
    graph = wire(graph, 'f', 'file', 'c', 'synapses')
    await run(graph) // reads the footer, so the pickers resolve
    const dataset = (await run(graph)).output('c', 'dataset') as DatasetValue
    const id = '720575940600000001'
    const points = await new CompositeSource().fetchSynapses({
      datasetId: dataset.datasetId,
      neuronIds: [id],
      polarity: 'pre',
      unit: 'links',
    })
    expect(points.attributes.data[ID_COLUMN_NAME]).toEqual([id, id, id])
    expect(points.attributes.data.region).toHaveLength(3)
    // Rows 3–5 of the fixture: size 13, 14, 15.
    expect([...points.positions].filter((_, i) => i % 3 === 0)).toEqual([13, 14, 15])
  })

  it('reads through a Filter Table between them: the lookup, then the condition on what it fetched', async () => {
    const bytes = readFileSync('src/data/files/__fixtures__/synapses.parquet')
    const fileId = holdLocalFile(new File([bytes], 'synapses.parquet', { lastModified: 1 }))
    let graph = addNode(
      emptyGraph('file'),
      node('c', TYPE, {
        synPre: 'pre_pt_root_id',
        synPost: 'post_pt_root_id',
        synPosition: ['size', 'size', 'score'],
      }),
    )
    graph = addNode(
      graph,
      node('f', 'core.linkTable', { fileId, fileName: 'synapses.parquet' }),
    )
    // A confidence threshold: scores run 0.0 … 1.1 by tenths, so rows 0–3 are dropped.
    graph = addNode(
      graph,
      node('flt', 'core.filterTable', { column: 'score', op: 'ge', value: '0.4' }),
    )
    graph = wire(graph, 'f', 'file', 'flt', 'in')
    graph = wire(graph, 'flt', 'out', 'c', 'synapses')
    await run(graph)
    const dataset = (await run(graph)).output('c', 'dataset') as DatasetValue
    const source = new CompositeSource()
    // Rows 3–5 are this neuron's; row 3 (score 0.3) fails the condition.
    const id = '720575940600000001'
    const points = await source.fetchSynapses({
      datasetId: dataset.datasetId,
      neuronIds: [id],
      polarity: 'pre',
      unit: 'links',
    })
    expect([...points.positions].filter((_, i) => i % 3 === 0)).toEqual([14, 15])
    // Connectivity counted from the same table counts only the synapses that passed.
    const counted = await connectivityFor(source, {
      ...dataset,
      neuronIds: [id],
      direction: 'outputs',
    })
    expect((counted.data.weight ?? []).reduce((a, b) => Number(a) + Number(b), 0)).toBe(2)
  })
})
