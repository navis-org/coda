/**
 * The Neuron Dendrogram's `evaluate`: the two pass-through ports, and the Points port — the
 * synapses beyond the clicked point, rebuilt at Run exactly as the card builds them.
 */

import { describe, expect, it } from 'vitest'

import type { EvalContext, ParamValues } from '../../core/node'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { DatasetValue, PointsValue, SkeletonsValue, Value } from '../../core/values'
import { makeTable, tableFromRows } from '../../core/values'
import type { DataSource } from '../../data/source'
import { ySkeleton } from '../lib/__fixtures__/ySkeleton'
import '../index'
import { NEURON_DENDROGRAM } from './neuronDendrogram'

const DEF = requireNodeDef(NEURON_DENDROGRAM)

/** The branch point of the Y, clicked, on a tree rooted where the skeleton was. */
const AT_BRANCH_POINT = { focus: '1001:2:1.0000', root: 'source' }

const DATASET: DatasetValue = {
  kind: 'dataset',
  sourceId: 'stub',
  datasetId: 'test:v1',
  label: 'Test',
}

const NEURONS = tableFromRows(tableSchema(column('neuronId', 'i64')), [{ neuronId: 1001 }])

function skeletons(): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [{ ...ySkeleton(), id: '1001' }],
    attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['1001'] }),
    bounds: { min: [0, 0, 0], max: [3000, 2000, 0] },
    units: 'nm',
  }
}

/** An input 400 nm out on 2 → 3, an output half way down 4 → 5, and an input 500 nm from the root. */
function synapses(named: boolean): PointsValue {
  const rows = [
    { neuronId: '1001', partnerType: 'Tm3', polarity: 'post' },
    { neuronId: '1001', partnerType: 'DNp02', polarity: 'pre' },
    { neuronId: '1001', partnerType: 'Mi1', polarity: 'post' },
  ]
  return {
    kind: 'points',
    positions: Float32Array.from([2400, 100, 0, 2050, 1500, 0, 500, 50, 0]),
    attributes: named
      ? tableFromRows(
          tableSchema(
            column('neuronId', 'str'),
            column('partnerType', 'str'),
            column('polarity', 'str'),
          ),
          rows,
        )
      : tableFromRows(
          tableSchema(column('neuronId', 'str'), column('polarity', 'str')),
          rows.map(({ neuronId, polarity }) => ({ neuronId, polarity })),
        ),
    bounds: { min: [0, 0, 0], max: [3000, 2000, 0] },
    units: 'nm',
  }
}

function source(over: Partial<DataSource> = {}): DataSource {
  return {
    id: 'stub',
    label: 'Stub',
    capabilities: { skeletons: true, synapses: true },
    synapseUnits: ['sites'],
    fetchSkeletons: async () => skeletons(),
    fetchSynapses: async () => synapses(true),
    peekDataset: () => undefined,
    ...over,
  } as unknown as DataSource
}

function context(params: Partial<ParamValues>, from: DataSource): EvalContext {
  const inputs: Record<string, Value | undefined> = { dataset: DATASET, neurons: NEURONS }
  return {
    params: { ...defaultParams(DEF), ...params } as ParamValues,
    refresh: false,
    reportFetched: () => undefined,
    warn: () => undefined,
    publish: () => undefined,
    input: (port) => inputs[port],
    inputKey: (port) => (inputs[port] ? `${port}-key` : undefined),
    column: () => undefined,
    columns: () => [],
    inputPorts: () => [],
    outputPorts: () => [],
    resolveSource: () => from,
    signal: new AbortController().signal,
    progress: () => {},
  }
}

const run = (params: Partial<ParamValues>, from = source()) =>
  DEF.evaluate(context(params, from))

describe('Neuron Dendrogram evaluate', () => {
  it('passes the table through and emits an empty cloud with nothing clicked', async () => {
    const out = await run({})
    expect(out['out']).toBe(NEURONS)
    const distal = out['distal'] as PointsValue
    expect(distal.attributes.length).toBe(0)
    expect(distal.attributes.schema.columns.map((c) => c.name)).toEqual([
      'distanceFromPoint',
      'distanceFromRoot',
    ])
  })

  it('emits the synapses beyond the clicked point, with their distances', async () => {
    const out = await run(AT_BRANCH_POINT)
    const distal = out['distal'] as PointsValue
    expect(distal.attributes.data['partnerType']).toEqual(['Tm3', 'DNp02'])
    const from = distal.attributes.data['distanceFromPoint'] as number[]
    expect(from[0]).toBeCloseTo(0.4, 4)
    expect(from[1]).toBeCloseTo(1.5, 4)
  })

  it('reads partners off the link cloud where the site cloud names none, as neuPrint’s does', async () => {
    let asked = 0
    const out = await run(
      AT_BRANCH_POINT,
      source({
        fetchSynapses: async () => synapses(false),
        fetchSynapseLinks: async () => {
          asked++
          return synapses(true)
        },
      } as Partial<DataSource>),
    )
    expect(asked).toBe(1)
    expect((out['distal'] as PointsValue).attributes.data['partnerType']).toEqual([
      'Tm3',
      'DNp02',
    ])
  })

  it('refuses a point the skeleton no longer has, rather than guessing', async () => {
    await expect(run({ focus: '1001:99:0.5000', root: 'source' })).rejects.toThrow(
      /Click it again/,
    )
  })

  it('abandons the synapse fetch it started when the skeleton half fails', async () => {
    let signal: AbortSignal | undefined
    const failing = source({
      fetchSkeletons: async () => ({ ...skeletons(), items: [] }),
      fetchSynapses: async (req: { signal?: AbortSignal }) => {
        signal = req.signal
        return synapses(true)
      },
    } as Partial<DataSource>)
    await expect(run(AT_BRANCH_POINT, failing)).rejects.toThrow(/returned no skeleton/)
    expect(signal?.aborted).toBe(true)
  })

  it('keys on the clicked point and the root, and on nothing the card merely draws', () => {
    // What reaches the provenance key is every param not marked presentational.
    const presentational = (id: string) =>
      DEF.params?.find((p) => p.id === id)?.presentational === true
    for (const id of ['focus', 'root', 'rootNode']) expect(presentational(id), id).toBe(false)
    for (const id of ['page', 'layout', 'metric', 'branchColor', 'branchPalette', 'partners']) {
      expect(presentational(id), id).toBe(true)
    }
  })

  it('offers partner type for the synapse colours, and not the drawn neuron’s own columns', () => {
    const param = DEF.params?.find((p) => p.id === 'colorBy')
    if (param?.kind !== 'enum' || typeof param.options !== 'function')
      throw new Error('colorBy')
    // `type` and `neuronId` are the neuron being drawn — one value on every row of a card.
    const values = param
      .options({ inputs: { dataset: T.dataset('stub', 'test:v1') } } as never)
      .map((o) => o.value)
    expect(values.slice(0, 2)).toEqual(['polarity', 'partnerType'])
    expect(values).not.toContain('type')
    expect(values).not.toContain('neuronId')
  })
})
