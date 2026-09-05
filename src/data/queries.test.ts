/**
 * The funnel: which of the two answers a connectivity question gets.
 *
 * The delegation cases are dull and the refusal is the point. A dataset naming an edge set this
 * browser does not have must **stop**, because the alternative — asking the backend — is a green
 * node holding a plausible table that answers a different question from the one its author saw.
 * That is the single most consequential rule in the feature, so it is asserted from both sides:
 * the message names the set, and the source is never called.
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../core/types'
import type { TableValue } from '../core/values'
import { makeMatrix, tableFromRows } from '../core/values'
import { EdgeSetBuilder } from './edges/encode'
import { resetEdgeSets, saveEdgeSet } from './edges/store'
import { adjacencyFor, connectivityFor, pathStepFor, synapseTotalsFor } from './queries'
import type { DataSource, SourceSchemas } from './source'
import { CANONICAL_SCHEMAS } from './source'

const NEURONS = tableSchema(column('neuronId', 'str'), column('type', 'str'))

/** Two LC4s onto one PLP1, plus a run onward — enough for a hop and a matrix. */
const ROWS: [string, string, number][] = [
  ['1', '2', 10],
  ['1', '3', 2],
  ['4', '2', 5],
  ['2', '5', 7],
]

const INDEX: TableValue = tableFromRows(NEURONS, [
  { neuronId: '1', type: 'LC4' },
  { neuronId: '4', type: 'LC4' },
  { neuronId: '2', type: 'PLP1' },
  { neuronId: '3', type: 'PLP1' },
  { neuronId: '5', type: null },
])

function stubSource(over: Partial<DataSource> = {}): DataSource {
  const schemas: SourceSchemas = {
    ...CANONICAL_SCHEMAS,
    // A string-id backend, like CAVE: the wide-id guard only bites on `i64`.
    connectivity: tableSchema(
      column('neuronId', 'str'),
      column('neuronType', 'str'),
      column('partnerId', 'str'),
      column('partnerType', 'str'),
      column('weight', 'i64', 'synapses'),
    ),
  }
  return {
    id: 'stub',
    label: 'Stub',
    capabilities: { neuronIndex: true, paths: false } as DataSource['capabilities'],
    schemas,
    listDatasets: vi.fn(async () => []),
    peekDatasets: () => [],
    peekDataset: () => undefined,
    findNeurons: vi.fn(async () => INDEX),
    neuronIndex: vi.fn(async () => INDEX),
    fetchConnectivity: vi.fn(async () => tableFromRows(schemas.connectivity, [])),
    fetchAdjacency: vi.fn(async () => makeMatrix([], [], new Float64Array(0), 'synapses')),
    ...over,
  } as DataSource
}

async function attach(rows = ROWS, name = 'my edges') {
  const b = new EdgeSetBuilder()
  for (const [pre, post, w] of rows) b.add(pre, post, w)
  const meta = await saveEdgeSet(b.finish(), { name, origin: 'edges.csv' })
  return { id: meta.id, name: meta.name }
}

const rowsOf = (table: TableValue) =>
  Array.from({ length: table.length }, (_, i) =>
    Object.fromEntries(table.schema.columns.map((c) => [c.name, table.data[c.name]![i]])),
  )

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetEdgeSets()
})

describe('with nothing attached', () => {
  it('delegates all three to the source', async () => {
    // `paths: true` beside the method, because those two are one claim: `canTracePaths` refuses
    // a source that supplies `fetchPathStep` and declares it cannot trace, which used to be
    // accepted here and refused by the node.
    const source = stubSource({
      capabilities: { neuronIndex: true, paths: true } as DataSource['capabilities'],
      fetchPathStep: vi.fn(async () => tableFromRows(CANONICAL_SCHEMAS.connectivity, [])),
    })
    await connectivityFor(source, { datasetId: 'd', neuronIds: ['1'], direction: 'outputs' })
    await adjacencyFor(source, { datasetId: 'd', sourceIds: ['1'], targetIds: ['2'] })
    await pathStepFor(source, { datasetId: 'd', direction: 'outputs', collapseTypes: false })
    expect(source.fetchConnectivity).toHaveBeenCalledOnce()
    expect(source.fetchAdjacency).toHaveBeenCalledOnce()
    expect(source.fetchPathStep).toHaveBeenCalledOnce()
  })
})

/**
 * The region gate, which has to live here rather than only on the card.
 *
 * A `validate` issue is a **warning**, so a graph repointed at a backend that cannot split still
 * runs — and a source that cannot split does not fail, it *ignores* the two request fields. So
 * without this the node would advertise a `roi` column, the source would return whole-connection
 * weights, and the column would be filled with nothing. A wrong number wearing the right name,
 * which is what these two capabilities exist to prevent.
 */
describe('the region options against a source that cannot answer them', () => {
  const cannot = () =>
    stubSource({
      capabilities: {
        neuronIndex: true,
        connectivityRois: false,
        synapseTotals: false,
      } as DataSource['capabilities'],
    })

  it('refuses rather than returning whole-connection weights under a roi column', async () => {
    const source = cannot()
    await expect(
      connectivityFor(source, {
        datasetId: 'd',
        neuronIds: ['1'],
        direction: 'outputs',
        splitByRoi: true,
      }),
    ).rejects.toThrow(/cannot break a connection down by region/)
    // And it refused *before* asking, rather than filtering an answer afterwards.
    expect(source.fetchConnectivity).not.toHaveBeenCalled()
  })

  it('refuses a region restriction too, not only the split', async () => {
    await expect(
      connectivityFor(cannot(), {
        datasetId: 'd',
        neuronIds: ['1'],
        direction: 'outputs',
        rois: ['LO(R)'],
      }),
    ).rejects.toThrow(/cannot break a connection down by region/)
  })

  it('lets a node with the region controls untouched straight through', async () => {
    // Every graph written before these controls existed is in this state, and it must not
    // acquire an error it did not ask for.
    const source = cannot()
    await connectivityFor(source, { datasetId: 'd', neuronIds: ['1'], direction: 'outputs' })
    expect(source.fetchConnectivity).toHaveBeenCalledOnce()
  })

  it('refuses synapse totals through the same predicate the node asks', async () => {
    await expect(
      synapseTotalsFor(cannot(), {
        datasetId: 'd',
        neuronIds: ['1'],
        side: 'inputs',
        basis: 'all',
      }),
    ).rejects.toThrow(/does not publish per-neuron synapse totals/)
  })

  it('refuses a source declaring the capability but supplying no method', async () => {
    // The pair is one claim — `pathStepFor`'s recorded incident, where a funnel checking only
    // for the method accepted a source the node had already refused.
    await expect(
      synapseTotalsFor(
        stubSource({
          capabilities: {
            neuronIndex: true,
            synapseTotals: true,
          } as DataSource['capabilities'],
        }),
        { datasetId: 'd', neuronIds: ['1'], side: 'inputs', basis: 'all' },
      ),
    ).rejects.toThrow(/does not publish per-neuron synapse totals/)
  })
})

describe('with an edge set attached', () => {
  it('answers connectivity query-relative, with types from the dataset', async () => {
    const edges = await attach()
    const source = stubSource()
    const table = await connectivityFor(source, {
      datasetId: 'd',
      neuronIds: ['2'],
      direction: 'inputs',
      edges,
    })
    // `neuronId` is always the neuron asked about, whichever way the synapse points.
    expect(rowsOf(table)).toEqual([
      { neuronId: '2', neuronType: 'PLP1', partnerId: '1', partnerType: 'LC4', weight: 10 },
      { neuronId: '2', neuronType: 'PLP1', partnerId: '4', partnerType: 'LC4', weight: 5 },
    ])
    expect(source.fetchConnectivity).not.toHaveBeenCalled()
  })

  it('leaves a partner the dataset does not type as null rather than inventing one', async () => {
    const edges = await attach()
    const table = await connectivityFor(stubSource(), {
      datasetId: 'd',
      neuronIds: ['2'],
      direction: 'outputs',
      edges,
    })
    expect(rowsOf(table)).toEqual([
      { neuronId: '2', neuronType: 'PLP1', partnerId: '5', partnerType: null, weight: 7 },
    ])
  })

  it('cuts on weight', async () => {
    const edges = await attach()
    const table = await connectivityFor(stubSource(), {
      datasetId: 'd',
      neuronIds: ['1'],
      direction: 'outputs',
      minWeight: 5,
      edges,
    })
    expect(table.length).toBe(1)
  })

  it('builds an adjacency matrix, grouped by type on request', async () => {
    const edges = await attach()
    const source = stubSource()
    const plain = await adjacencyFor(source, {
      datasetId: 'd',
      sourceIds: ['1', '4'],
      targetIds: ['2'],
      edges,
    })
    expect(plain.rowLabels).toEqual(['1', '4'])
    expect([...plain.values]).toEqual([10, 5])

    const grouped = await adjacencyFor(source, {
      datasetId: 'd',
      sourceIds: ['1', '4'],
      targetIds: ['2'],
      groupByType: true,
      edges,
    })
    expect(grouped.rowLabels).toEqual(['LC4'])
    expect([...grouped.values]).toEqual([15])
    expect(source.fetchAdjacency).not.toHaveBeenCalled()
  })

  it('traces a hop on a source that declares it cannot', async () => {
    // The unlock: CAVE has no server-side aggregation and no `fetchPathStep` at all, so Paths
    // refuses outright there. A local edge set answers a hop, which is what makes the node
    // reachable rather than merely faster.
    const edges = await attach()
    const source = stubSource()
    expect(source.fetchPathStep).toBeUndefined()
    const table = await pathStepFor(source, {
      datasetId: 'd',
      types: ['LC4'],
      direction: 'outputs',
      collapseTypes: true,
      edges,
    })
    expect(rowsOf(table)).toEqual([
      expect.objectContaining({ source: 'LC4', target: 'PLP1', weight: 17, pairs: 3 }),
    ])
  })
})

describe('when the edge set is not in this browser', () => {
  it('refuses by name and never asks the backend', async () => {
    const source = stubSource()
    const missing = { id: 'not-here', name: 'FlyWire 783' }
    await expect(
      connectivityFor(source, {
        datasetId: 'd',
        neuronIds: ['1'],
        direction: 'outputs',
        edges: missing,
      }),
    ).rejects.toThrow(/FlyWire 783/)
    // The whole rule: falling back would be a green node answering a different question.
    expect(source.fetchConnectivity).not.toHaveBeenCalled()
  })

  it('refuses on all three, not only the one somebody tested', async () => {
    const source = stubSource({
      capabilities: { neuronIndex: true, paths: true } as DataSource['capabilities'],
      fetchPathStep: vi.fn(async () => tableFromRows(CANONICAL_SCHEMAS.connectivity, [])),
    })
    const edges = { id: 'not-here', name: 'gone' }
    await expect(
      adjacencyFor(source, { datasetId: 'd', sourceIds: ['1'], targetIds: ['2'], edges }),
    ).rejects.toThrow(/not in this browser/)
    await expect(
      pathStepFor(source, {
        datasetId: 'd',
        direction: 'outputs',
        collapseTypes: false,
        edges,
      }),
    ).rejects.toThrow(/not in this browser/)
    expect(source.fetchAdjacency).not.toHaveBeenCalled()
    expect(source.fetchPathStep).not.toHaveBeenCalled()
  })
})

describe('when the ids cannot survive the dataset', () => {
  it('refuses an eighteen-digit edge list against a numeric-id dataset', async () => {
    // Silent otherwise: 720575940628857210 in an `i64` column is 720575940628857344, a different
    // neuron, and every row downstream would name neurons that do not exist.
    const edges = await attach([['720575940628857210', '720575940628857211', 4]], 'flywire')
    const source = stubSource({ schemas: CANONICAL_SCHEMAS })
    await expect(
      connectivityFor(source, {
        datasetId: 'd',
        neuronIds: ['720575940628857210'],
        direction: 'outputs',
        edges,
      }),
    ).rejects.toThrow(/too wide/)
  })

  it('accepts a neuPrint-width edge list against the same dataset', async () => {
    const edges = await attach([['1001', '1002', 4]], 'hemibrain')
    const source = stubSource({ schemas: CANONICAL_SCHEMAS })
    const table = await connectivityFor(source, {
      datasetId: 'd',
      neuronIds: ['1001'],
      direction: 'outputs',
      edges,
    })
    // And they arrive as numbers, because that is what the dataset's own schema declares.
    expect(table.data.neuronId![0]).toBe(1001)
  })
})
