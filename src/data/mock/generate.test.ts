import { describe, expect, it } from 'vitest'

import { MockSource } from './MockSource'
import { getConnectome, mockDatasetIds } from './generate'

describe('mock connectomes', () => {
  it('exposes the expected datasets', () => {
    expect(mockDatasetIds()).toEqual(['optic-lobe-mini'])
  })

  it('is deterministic across calls', () => {
    const a = getConnectome('optic-lobe-mini')!
    const b = getConnectome('optic-lobe-mini')!
    expect(a).toBe(b) // memoised
    expect(a.neurons.length).toBeGreaterThan(100)
    expect(a.connections.length).toBeGreaterThan(500)
  })

  it('gives every neuron a unique neuron id', () => {
    for (const id of mockDatasetIds()) {
      const c = getConnectome(id)!
      expect(new Set(c.neurons.map((n) => n.neuronId)).size).toBe(c.neurons.length)
    }
  })

  it('keeps per-ROI counts consistent with neuron totals', () => {
    const c = getConnectome('optic-lobe-mini')!
    const perNeuron = new Map<number, { pre: number; post: number }>()
    for (const rc of c.roiCounts) {
      const acc = perNeuron.get(rc.neuronId) ?? { pre: 0, post: 0 }
      acc.pre += rc.pre
      acc.post += rc.post
      perNeuron.set(rc.neuronId, acc)
    }
    // Every neuron with a ROI preference should have its synapses fully accounted for.
    for (const neuron of c.neurons) {
      const sums = perNeuron.get(neuron.neuronId)
      if (!sums) continue
      expect(sums.pre).toBe(neuron.pre)
      expect(sums.post).toBe(neuron.post)
    }
  })

  it('derives synapse totals from the connection list', () => {
    const c = getConnectome('optic-lobe-mini')!
    const totalPre = c.neurons.reduce((sum, n) => sum + n.pre, 0)
    const totalWeight = c.connections.reduce((sum, e) => sum + e.weight, 0)
    expect(totalPre).toBe(totalWeight)
  })

  it('contains the LC -> descending-neuron structure the demos rely on', () => {
    const c = getConnectome('optic-lobe-mini')!
    const lc4 = c.neurons.filter((n) => n.type === 'LC4')
    expect(lc4.length).toBeGreaterThan(0)
    const partners = new Set<string>()
    for (const n of lc4) {
      for (const e of c.out.get(n.neuronId) ?? []) {
        partners.add(c.byId.get(e.post)?.type ?? '?')
      }
    }
    expect(partners.has('DNp02')).toBe(true)
  })
})

describe('MockSource', () => {
  const source = new MockSource({ latencyMs: 0 })

  it('lists datasets with ROIs and statuses', async () => {
    const datasets = await source.listDatasets()
    expect(datasets.map((d) => d.id)).toEqual(['optic-lobe-mini'])
    expect(datasets[0]!.rois).toContain('ME(R)')
    expect(datasets[0]!.statuses).toContain('Traced')
    expect(source.peekDataset('optic-lobe-mini')?.label).toBe('Demo Data')
  })

  it('anchors type regexes the way Neo4j =~ does', async () => {
    const table = await source.findNeurons({
      datasetId: 'optic-lobe-mini',
      rows: [{ field: 'type', op: 'matches', values: ['LC.*'] }],
    })
    const types = new Set(table.data.type as string[])
    expect(types).toEqual(new Set(['LC4', 'LC6', 'LC9', 'LC11']))
    // LPLC1/LPLC2 contain "LC" but are not a full match.
    expect(types.has('LPLC2')).toBe(false)
  })

  it('returns the canonical neuron schema', async () => {
    const table = await source.findNeurons({
      datasetId: 'optic-lobe-mini',
      rows: [{ field: 'type', op: 'matches', values: ['LC4'] }],
    })
    expect(table.kind).toBe('neurons')
    expect(table.schema.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'type',
      'instance',
      'status',
      'size',
      'pre',
      'post',
    ])
  })

  it('filters by status and size', async () => {
    const all = await source.findNeurons({ datasetId: 'optic-lobe-mini' })
    const traced = await source.findNeurons({
      datasetId: 'optic-lobe-mini',
      rows: [{ field: 'status', op: 'is', values: ['Traced'] }],
    })
    expect(traced.length).toBeLessThan(all.length)
    expect(new Set(traced.data.status as string[])).toEqual(new Set(['Traced']))
  })

  it('respects the limit', async () => {
    const table = await source.findNeurons({ datasetId: 'optic-lobe-mini', limit: 5 })
    expect(table.length).toBe(5)
  })

  it('fetches downstream partners sorted by weight', async () => {
    const lc4 = await source.findNeurons({
      datasetId: 'optic-lobe-mini',
      rows: [{ field: 'type', op: 'matches', values: ['LC4'] }],
    })
    const conn = await source.fetchConnectivity({
      datasetId: 'optic-lobe-mini',
      neuronIds: lc4.data.neuronId!.map(String),
      direction: 'outputs',
      minWeight: 1,
    })
    expect(conn.length).toBeGreaterThan(0)
    const weights = conn.data.weight as number[]
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]!).toBeLessThanOrEqual(weights[i - 1]!)
    }
    expect(new Set(conn.data.partnerType as string[]).has('DNp02')).toBe(true)
  })

  it('honours minWeight', async () => {
    const lc4 = await source.findNeurons({
      datasetId: 'optic-lobe-mini',
      rows: [{ field: 'type', op: 'matches', values: ['LC4'] }],
    })
    const conn = await source.fetchConnectivity({
      datasetId: 'optic-lobe-mini',
      neuronIds: lc4.data.neuronId!.map(String),
      direction: 'outputs',
      minWeight: 20,
    })
    for (const w of conn.data.weight as number[]) expect(w).toBeGreaterThanOrEqual(20)
  })

  it('builds a type-level adjacency matrix', async () => {
    const lc = await source.findNeurons({
      datasetId: 'optic-lobe-mini',
      rows: [{ field: 'type', op: 'matches', values: ['LC.*'] }],
    })
    const dn = await source.findNeurons({
      datasetId: 'optic-lobe-mini',
      rows: [{ field: 'type', op: 'matches', values: ['DNp.*'] }],
    })
    const m = await source.fetchAdjacency({
      datasetId: 'optic-lobe-mini',
      sourceIds: lc.data.neuronId!.map(String),
      targetIds: dn.data.neuronId!.map(String),
      groupByType: true,
    })
    expect(m.rowLabels).toEqual(
      ['LC4', 'LC6', 'LC9', 'LC11'].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      ),
    )
    expect(m.colLabels).toEqual(['DNp02', 'DNp11'])
    const total = [...m.values].reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(0)
  })

  it('rejects an unknown dataset with a helpful message', async () => {
    await expect(source.findNeurons({ datasetId: 'nope' })).rejects.toThrow(/Available/)
  })

  it('reports an invalid regex instead of matching nothing', async () => {
    await expect(
      source.findNeurons({
        datasetId: 'optic-lobe-mini',
        rows: [{ field: 'type', op: 'matches', values: ['['] }],
      }),
    ).rejects.toThrow(/Invalid regex for "type"/)
  })

  it('refuses a row naming a field this dataset does not have', async () => {
    // `prepareFieldTerms` would mark it unknown and match no row, which answers a query with
    // nothing at all — indistinguishable from a dataset that genuinely holds no such neurons.
    await expect(
      source.findNeurons({
        datasetId: 'optic-lobe-mini',
        rows: [{ field: 'hemilineage', op: 'is', values: ['x'] }],
      }),
    ).rejects.toThrow(/no "hemilineage"/)
  })
})
