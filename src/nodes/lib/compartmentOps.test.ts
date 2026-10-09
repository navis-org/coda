/**
 * The split of a set, on this side of the bridge.
 *
 * The algorithm is `topology.py`'s and is checked against navis by `pnpm probe:split`; vitest has
 * no Pyodide, so the engine is mocked and what is checked is the bookkeeping either side of it —
 * which synapses went to which neuron's nodes, and which labels came back to which item. Both fail
 * by splitting the *wrong neuron*, which draws.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { PointsValue, SkeletonsValue } from '../../core/values'
import { makeTable } from '../../core/values'
import type * as TopologyBridge from '../../pyodide/topology'
import type { SplitCompartmentsRequest } from '../../pyodide/topology'
import type { SplitCorrection } from './splitCorrections'
import {
  correctSplit,
  labelSynapses,
  labelledSynapsesSchema,
  readSplitSettings,
  sitesByNeuron,
  splitSkeletons,
  splitSummarySchema,
  splitSummaryTable,
  withSplit,
} from './compartmentOps'

vi.mock('../../pyodide/topology', async (importOriginal) => ({
  ...(await importOriginal<typeof TopologyBridge>()),
  runSplitCompartments: vi.fn(),
}))
const { runSplitCompartments } = await import('../../pyodide/topology')
const mockedRun = vi.mocked(runSplitCompartments)

/** Two neurons on one line, three nodes and two, ids that sort the other way round. */
function skeletons(): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [
      {
        id: '22',
        positions: new Float32Array([0, 0, 0, 1000, 0, 0, 2000, 0, 0]),
        radii: new Float32Array(3),
        parents: new Int32Array([-1, 0, 1]),
      },
      {
        id: '11',
        positions: new Float32Array([50_000, 0, 0, 51_000, 0, 0]),
        radii: new Float32Array(2),
        parents: new Int32Array([-1, 0]),
      },
    ],
    attributes: makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['22', '11'] }),
    bounds: { min: [0, 0, 0], max: [51_000, 0, 0] },
    units: 'nm',
  }
}

/** A cloud listing neuron 11 first, with one row whose neuron cannot be read. */
function cloud(): PointsValue {
  const rows: [string | null, string, number][] = [
    ['11', 'pre', 51_000],
    ['22', 'post', 0],
    ['22', 'pre', 2000],
    ['22', 'pre', 1900],
    [null, 'pre', 1000],
  ]
  return {
    kind: 'points',
    positions: Float32Array.from(rows.flatMap(([, , x]) => [x, 0, 0])),
    attributes: makeTable(tableSchema(column('neuronId', 'str'), column('polarity', 'str')), {
      neuronId: rows.map(([id]) => id),
      polarity: rows.map(([, polarity]) => polarity),
    }),
    bounds: { min: [0, 0, 0], max: [51_000, 0, 0] },
    units: 'nm',
  }
}

/** What the engine would answer: a label per node equal to its global index, every neuron ok. */
function echo(request: SplitCompartmentsRequest) {
  const nodes = request.parents.length
  return Promise.resolve({
    compartment: Int32Array.from({ length: nodes }, (_, i) => i),
    status: new Int32Array(request.offsets.length - 1),
  })
}

const SETTINGS = { flowThresh: 0.9, splitVal: 1, heal: false }

beforeEach(() => {
  mockedRun.mockReset()
})

describe('sitesByNeuron', () => {
  it('buckets by neuron and drops a row whose neuron cannot be read', () => {
    const sites = sitesByNeuron(cloud())
    expect([...sites.keys()].sort()).toEqual(['11', '22'])
    expect(sites.get('22')!.sites.map((s) => s.polarity)).toEqual(['post', 'pre', 'pre'])
    // The rows come along, so an answer per site can be written back to the row it came from.
    expect(sites.get('22')!.rows).toEqual([1, 2, 3])
  })
})

describe('splitSkeletons', () => {
  it('counts each neuron’s synapses on its own nodes, matched by id rather than position', async () => {
    let sent: SplitCompartmentsRequest | undefined
    mockedRun.mockImplementation((request) => {
      sent = request
      return echo(request)
    })
    await splitSkeletons(skeletons(), sitesByNeuron(cloud()), SETTINGS)

    // Neuron 22 occupies nodes 0..2, neuron 11 nodes 3..4 — item order, not cloud order. Its one
    // presynapse sits on its second node, at 51 µm.
    expect([...sent!.presynapses]).toEqual([0, 0, 2, 0, 1])
    expect([...sent!.postsynapses]).toEqual([1, 0, 0, 0, 0])
    expect([...sent!.offsets]).toEqual([0, 3, 5])
  })

  it('hands each item back its own slice of the labels, and the statuses in words', async () => {
    mockedRun.mockImplementation((request) =>
      echo(request).then((r) => ({ ...r, status: Int32Array.from([0, 2]) })),
    )
    const split = await splitSkeletons(skeletons(), sitesByNeuron(cloud()), SETTINGS)

    expect(split.labels.map((l) => [...l])).toEqual([
      [0, 1, 2],
      [3, 4],
    ])
    expect(split.status).toEqual(['ok', 'no synapses'])
    expect(split.assignments[0]!.nodeOf.length).toBe(3)
  })

  it('sends a neuron with no synapses as zeros rather than skipping it', async () => {
    let pre: number[] = []
    mockedRun.mockImplementation((request) => {
      pre = [...request.presynapses]
      return echo(request)
    })
    const split = await splitSkeletons(skeletons(), new Map(), SETTINGS)
    expect(pre).toEqual([0, 0, 0, 0, 0])
    expect(split.labels).toHaveLength(2)
  })

  it('sends the coordinates only when healing, the one step that reads them', async () => {
    const lengths: number[] = []
    mockedRun.mockImplementation((request) => {
      lengths.push(request.points.length)
      return echo(request)
    })
    await splitSkeletons(skeletons(), new Map(), SETTINGS)
    await splitSkeletons(skeletons(), new Map(), { ...SETTINGS, heal: true })
    expect(lengths).toEqual([0, 15])
    expect(mockedRun.mock.calls[1]![0]).toMatchObject({ heal: true, flowThresh: 0.9 })
  })

  it('reports progress over its own 0..1, the bridge’s share after the assignment', async () => {
    mockedRun.mockImplementation((request, options) => {
      options?.onProgress?.(0.5, 'neuron 1 of 2')
      return echo(request)
    })
    const seen: [number, string | undefined][] = []
    await splitSkeletons(skeletons(), new Map(), SETTINGS, {
      onProgress: (fraction, note) => seen.push([fraction, note]),
    })
    expect(seen.map(([, note]) => note)).toEqual([
      'assigning synapses to nodes',
      'neuron 1 of 2',
    ])
    expect(seen[0]![0]).toBe(0)
    expect(seen[1]![0]).toBeCloseTo(0.6)
  })
})

/** Neuron 22 dendrite–linker–axon, neuron 11 dendrite–axon; `status` per neuron as sent. */
function answer(status: number[]) {
  return (request: SplitCompartmentsRequest) =>
    Promise.resolve({
      compartment: Int32Array.from([1, 3, 2, 1, 2].slice(0, request.parents.length)),
      status: Int32Array.from(status),
    })
}

describe('readSplitSettings', () => {
  it('reads the three controls, heal only when it is exactly true', () => {
    expect(readSplitSettings({ flowThresh: 0.8, splitVal: 1.2, heal: 'yes' })).toEqual({
      flowThresh: 0.8,
      splitVal: 1.2,
      heal: false,
    })
  })
})

describe('what the split leaves on the values', () => {
  it('stores each label set on its skeleton, and drops a stale one where the split failed', async () => {
    mockedRun.mockImplementation(answer([0, 1]))
    const input = skeletons()
    const stale = {
      ...input,
      items: input.items.map((item) => ({
        ...item,
        split: new Uint8Array(item.parents.length),
      })),
    }
    const split = await splitSkeletons(stale, sitesByNeuron(cloud()), SETTINGS)
    const out = withSplit(stale, split)

    expect([...out.items[0]!.split!]).toEqual([1, 3, 2])
    expect(out.items[1]!.split).toBeUndefined()
    // Everything else about the set rides through.
    expect(out.attributes).toBe(stale.attributes)
    expect(out.items[0]!.positions).toBe(stale.items[0]!.positions)
  })

  it('labels each synapse by the node the split counted it on, null where there is no answer', async () => {
    mockedRun.mockImplementation(answer([0, 0]))
    const points = cloud()
    const synapses = sitesByNeuron(points)
    const split = await splitSkeletons(skeletons(), synapses, SETTINGS)
    const labelled = labelSynapses(points, skeletons(), synapses, split)

    expect(labelled.attributes.data['compartment']).toEqual([
      'axon',
      'dendrite',
      'axon',
      'axon',
      null,
    ])
    expect(labelled.attributes.schema).toEqual(labelledSynapsesSchema(points.attributes.schema))
    expect(labelled.positions).toBe(points.positions)

    mockedRun.mockImplementation(answer([0, 2]))
    const failed = await splitSkeletons(skeletons(), synapses, SETTINGS)
    expect(
      labelSynapses(points, skeletons(), synapses, failed).attributes.data['compartment']![0],
    ).toBeNull()
  })

  it('writes the column over one of the same name, in its slot', () => {
    const schema = tableSchema(column('compartment', 'i64'), column('neuronId', 'str'))
    expect(labelledSynapsesSchema(schema).columns.map((c) => [c.name, c.dtype])).toEqual([
      ['compartment', 'str'],
      ['neuronId', 'str'],
    ])
  })

  it('summarises per neuron with the attributes first, and the schema says what the table holds', async () => {
    mockedRun.mockImplementation(answer([0, 1]))
    const input = skeletons()
    const split = await splitSkeletons(input, sitesByNeuron(cloud()), SETTINGS)
    const summary = splitSummaryTable(input, split, [])

    expect(summary.schema).toEqual(splitSummarySchema(input.attributes.schema))
    expect(Object.keys(summary.data).sort()).toEqual(
      summary.schema.columns.map((c) => c.name).sort(),
    )
    expect(summary.data['neuronId']).toEqual(['22', '11'])
    expect(summary.data['splitStatus']).toEqual(['ok', 'multiple roots'])
    expect(summary.data['cableAxon']![0]).toBeCloseTo(1)
    expect(summary.data['cableAxon']![1]).toBeNull()
  })
})

describe('synapse flow on the skeletons', () => {
  /** Neuron 22's flow 0, 50, 100; neuron 11's all zero — the shape an unsplit neuron sends. */
  function withFlow(status: number[]) {
    return (request: SplitCompartmentsRequest) =>
      answer(status)(request).then((r) =>
        // Only when asked, as the bridge does.
        request.flow
          ? {
              ...r,
              flow: Float32Array.from([0, 50, 100, 0, 0].slice(0, request.parents.length)),
            }
          : r,
      )
  }

  it('is asked for only when wanted, and comes back as each neuron’s fraction of its peak', async () => {
    mockedRun.mockImplementation(withFlow([0, 2]))
    const plain = await splitSkeletons(skeletons(), new Map(), SETTINGS)
    expect(mockedRun.mock.calls[0]![0].flow).toBeFalsy()
    expect(plain.flow).toBeUndefined()

    const split = await splitSkeletons(skeletons(), new Map(), SETTINGS, { flow: true })
    expect(mockedRun.mock.calls[1]![0].flow).toBe(true)
    expect([...split.flow![0]!]).toEqual([0, 0.5, 1])
    // No peak is no answer, not a neuron that carries no flow.
    expect(split.flow![1]).toBeUndefined()
  })

  it('stores it as a node value where the split worked, replacing a stale one and keeping others', async () => {
    mockedRun.mockImplementation(withFlow([0, 2]))
    const input = skeletons()
    const radius = new Float32Array(3)
    const carried: SkeletonsValue = {
      ...input,
      items: [
        { ...input.items[0]!, nodeValues: { flow: new Float32Array(3), radius } },
        { ...input.items[1]!, nodeValues: { flow: new Float32Array(2) } },
      ],
    }
    const split = await splitSkeletons(carried, new Map(), SETTINGS, { flow: true })
    const out = withSplit(carried, split)

    expect([...out.items[0]!.nodeValues!['flow']!]).toEqual([0, 0.5, 1])
    expect(out.items[0]!.nodeValues!['radius']).toBe(radius)
    // The unsplit neuron loses the old flow and, having nothing else, the map with it.
    expect(out.items[1]!.nodeValues).toBeUndefined()
  })
})

describe('correctSplit', () => {
  it('applies each neuron’s corrections, counts the rest stale, and leaves the others alone', async () => {
    // Neuron 22 split (dendrite, linker, axon); neuron 11 not split.
    mockedRun.mockImplementation(answer([0, 2]))
    const input = skeletons()
    const split = await splitSkeletons(input, new Map(), SETTINGS)
    const corrections: SplitCorrection[] = [
      // Node 1 of neuron 22, outward: nodes 1 and 2 (rooted at 0).
      { neuron: '22', at: [1000, 0, 0], scope: 'distal', to: 'axon' },
      // A neuron with no split, and one not on the input at all.
      { neuron: '11', at: [50_000, 0, 0], scope: 'distal', to: 'axon' },
      { neuron: '99', at: [0, 0, 0], scope: 'distal', to: 'axon' },
    ]
    const corrected = correctSplit(input, split, corrections)

    expect([...corrected.split.labels[0]!]).toEqual([1, 2, 2])
    expect(corrected.split.labels[1]).toBe(split.labels[1])
    expect(corrected.applied).toEqual([1, 0])
    expect(corrected.stale).toBe(2)
    // The summary says which neurons were corrected.
    const summary = splitSummaryTable(input, corrected.split, corrected.applied)
    expect(summary.data['corrections']).toEqual([1, 0])
  })
})
