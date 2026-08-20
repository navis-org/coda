/**
 * The Paths node, driven through the real scheduler against the mock connectome.
 *
 * `lib/pathOps.test.ts` pins the search against a hand-written graph. This covers the half
 * that file cannot, because its fake source is already type-level by construction:
 *
 *  - that the schemas the node *advertises* at edit time are the ones it *builds* (invariant 3);
 *  - that `Collapse types` reaches the source and changes what a hop is, rather than only
 *    relabelling the picture afterwards;
 *  - that the layout output actually places the network it came with;
 *  - and that "no route" is an answer rather than an error.
 *
 * The mock's optic lobe is a real feed-forward circuit — L1 → Tm3 → LC4 → DNp02 — which is
 * what makes a path query answerable here at all.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { availableColumns, defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { getColumn, isLayoutValue, isNetworkValue, isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource, requireSource } from '../../data/source'
import '../index'

const DATASET = 'optic-lobe-mini'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** dataset → (find sources, find targets) → paths */
function pipeline(params: Record<string, unknown> = {}, from = 'L1', to = 'DNp02'): CodaGraph {
  let g = emptyGraph('paths-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('src', 'neuron.findNeurons', { typePattern: from, status: 'Traced' }))
  g = addNode(g, node('dst', 'neuron.findNeurons', { typePattern: to, status: 'Traced' }))
  g = addNode(g, node('paths', 'neuron.paths', params))
  const wire = (source: string, handle: string, target: string, into: string) => {
    g = addEdge(g, { source, sourceHandle: handle, target, targetHandle: into })
  }
  wire('ds', 'dataset', 'src', 'dataset')
  wire('ds', 'dataset', 'dst', 'dataset')
  wire('ds', 'dataset', 'paths', 'dataset')
  wire('src', 'neurons', 'paths', 'sources')
  wire('dst', 'neurons', 'paths', 'targets')
  return g
}

async function run(params: Record<string, unknown> = {}, from = 'L1', to = 'DNp02') {
  const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
  await sched.run(pipeline(params, from, to), { mode: 'full' })
  const network = sched.output('paths', 'network')
  const layout = sched.output('paths', 'layout')
  const table = sched.output('paths', 'paths')
  if (!isNetworkValue(network)) throw new Error(`expected a network, got ${String(network)}`)
  if (!isLayoutValue(layout)) throw new Error(`expected a layout, got ${String(layout)}`)
  if (!isTableValue(table)) throw new Error(`expected a table, got ${String(table)}`)
  return { network, layout, table, info: sched.info('paths') }
}

describe('Paths output shape', () => {
  it('advertises the columns it actually builds', async () => {
    const declared = inferGraph(pipeline()).nodes.paths?.outputs
    const nodeColumns =
      declared?.network?.kind === 'network'
        ? declared.network.nodeSchema?.columns.map((c) => c.name)
        : undefined
    const edgeColumns =
      declared?.network?.kind === 'network'
        ? declared.network.edgeSchema?.columns.map((c) => c.name)
        : undefined
    expect(nodeColumns).toEqual(['id', 'type', 'bodyId', 'role', 'hop', 'paths'])
    expect(edgeColumns).toEqual(['source', 'target', 'weight', 'pairs', 'paths', 'hop'])

    const { network, table } = await run()
    expect(network.nodes.schema.columns.map((c) => c.name)).toEqual(nodeColumns)
    expect(network.edges.schema.columns.map((c) => c.name)).toEqual(edgeColumns)
    expect(table.schema.columns.map((c) => c.name)).toEqual([
      'rank',
      'source',
      'target',
      'hops',
      'bottleneck',
      'path',
    ])
  })

  it('advertises a Layout socket, and fills it for every node it drew', async () => {
    const { network, layout } = await run()
    expect(layout.algorithm).toBe('ELK layered')
    for (const id of getColumn(network.nodes, 'id')) {
      const at = layout.positions[String(id)]
      expect(at, `no position for ${String(id)}`).toBeDefined()
      expect(Number.isFinite(at?.x)).toBe(true)
      expect(Number.isFinite(at?.y)).toBe(true)
    }
    // ELK layered spreads along the flow axis; a layout that placed everything at the origin
    // would satisfy every assertion above.
    const xs = Object.values(layout.positions).map((p) => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0)
  })
})

describe('Paths against the mock optic lobe', () => {
  it('finds the L1 → Tm3 → LC4 → DNp02 route and orients every edge forwards', async () => {
    const { network, table } = await run({ maxHops: 3, minWeight: 1, topN: 0 })
    expect(table.length).toBeGreaterThan(0)

    const routes = getColumn(table, 'path').map(String)
    expect(routes.some((route) => route.includes('L1') && route.includes('DNp02'))).toBe(true)

    // Every edge runs from a shallower hop to a deeper one — that is what "feed-forward" means
    // here, and a pruning pass that kept the back-edges would fail this and nothing else.
    const ids = getColumn(network.nodes, 'id').map(String)
    const hops = getColumn(network.nodes, 'hop').map(Number)
    const depth = new Map(ids.map((id, i) => [id, hops[i] ?? 0]))
    const sources = getColumn(network.edges, 'source').map(String)
    const targets = getColumn(network.edges, 'target').map(String)
    for (let i = 0; i < network.edges.length; i++) {
      const from = depth.get(sources[i] ?? '')
      const to = depth.get(targets[i] ?? '')
      expect(from).toBeDefined()
      expect(to).toBeDefined()
      expect(Number(to)).toBeGreaterThan(Number(from))
    }
  })

  it('marks the two ends, so a colour encoding has something honest to read', async () => {
    const { network } = await run({ maxHops: 3, minWeight: 1, topN: 5 })
    const roles = getColumn(network.nodes, 'role').map(String)
    expect(roles).toContain('source')
    expect(roles).toContain('target')
    expect(new Set(roles).size).toBeGreaterThan(1)
  })

  it('N strongest counts routes, and the bottleneck falls down the ranking', async () => {
    // Three lamina cells to two descending neurons: seven routes at three hops, all of them
    // through the LC4 / T4-LPLC2 pathways the mock wires up.
    const wide = ['L1|L2|L3', 'DNp02|DNp11'] as const
    const all = await run({ maxHops: 3, minWeight: 1, topN: 0 }, ...wide)
    expect(all.table.length).toBeGreaterThan(3)

    const few = await run({ maxHops: 3, minWeight: 1, topN: 3 }, ...wide)
    expect(few.table.length).toBe(3)

    const bottlenecks = getColumn(few.table, 'bottleneck').map(Number)
    for (let i = 1; i < bottlenecks.length; i++) {
      expect(Number(bottlenecks[i])).toBeLessThanOrEqual(Number(bottlenecks[i - 1]))
    }
    // The shortlist is the *top* of the full ranking, not the first three found.
    expect(bottlenecks[0]).toBe(Math.max(...getColumn(all.table, 'bottleneck').map(Number)))
  })

  it('Min synapses reaches the source rather than filtering afterwards', async () => {
    const loose = await run({ maxHops: 3, minWeight: 1, topN: 0 })
    const tight = await run({ maxHops: 3, minWeight: 100_000, topN: 0 })
    expect(loose.table.length).toBeGreaterThan(0)
    // Nothing in the mock carries a hundred thousand synapses, so a threshold that never left
    // the node would leave this identical to the loose run.
    expect(tight.table.length).toBe(0)
    expect(tight.network.nodes.length).toBe(0)
  })

  it('answers "not connected" with an empty network rather than an error', async () => {
    const { info, network, table } = await run({ maxHops: 1, minWeight: 1 }, 'L1', 'DNp02')
    // One hop from a lamina monopolar cell to a descending neuron: no such connection exists.
    expect(table.length).toBe(0)
    expect(network.nodes.length).toBe(0)
    expect(info.state).not.toBe('error')
  })
})

describe('Collapse types', () => {
  it('names nodes by cell type, and the weights are population totals', async () => {
    const { network } = await run({ maxHops: 3, minWeight: 1, topN: 5, collapseTypes: true })
    const ids = getColumn(network.nodes, 'id').map(String)
    expect(ids).toContain('LC4')
    // A type-level id is a name, never a body id.
    expect(ids.every((id) => !/^\d+$/.test(id))).toBe(true)
    // `pairs` is how many neuron-to-neuron connections were merged; above one is the whole
    // point of collapsing, and would be flat 1 if the aggregation had not happened.
    expect(Math.max(...getColumn(network.edges, 'pairs').map(Number))).toBeGreaterThan(1)
    expect(getColumn(network.nodes, 'bodyId').every((id) => id === null)).toBe(true)
  })

  it('switched off, traces individual neurons instead', async () => {
    const { network } = await run({ maxHops: 3, minWeight: 1, topN: 5, collapseTypes: false })
    const ids = getColumn(network.nodes, 'id').map(String)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every((id) => /^\d+$/.test(id))).toBe(true)
    // Each edge is one neuron pair, so nothing was merged.
    expect(getColumn(network.edges, 'pairs').every((n) => Number(n) === 1)).toBe(true)
    // The type still rides along as an attribute, which is what a label encoding reads.
    expect(getColumn(network.nodes, 'type').map(String)).toContain('LC4')
  })
})

describe('the source seam', () => {
  /*
   * `MockSource.fetchPathStep` is asserted directly, because the property that matters is one
   * the node cannot show on its own: the grouping happens *in the source*, before the
   * traversal ever sees a row. That is what makes the type-level search possible at all — a
   * client-side collapse would have to download every neuron of every frontier type first.
   */
  it('aggregates a hop to types, summing over every neuron pair', async () => {
    const source = new MockSource({ latencyMs: 0 })
    const collapsed = await source.fetchPathStep({
      datasetId: DATASET,
      types: ['LC4'],
      direction: 'outputs',
      collapseTypes: true,
    })
    const perNeuron = await source.fetchPathStep({
      datasetId: DATASET,
      types: ['LC4'],
      direction: 'outputs',
      collapseTypes: false,
    })

    expect(collapsed.length).toBeGreaterThan(0)
    expect(collapsed.length).toBeLessThan(perNeuron.length)
    expect(getColumn(collapsed, 'source').every((key) => key === 'LC4')).toBe(true)
    expect(getColumn(collapsed, 'sourceId').every((id) => id === null)).toBe(true)

    // The collapsed weight for a pair is the sum of the neuron-level ones it stands for.
    const targets = getColumn(collapsed, 'target').map(String)
    const weights = getColumn(collapsed, 'weight').map(Number)
    const first = targets[0]
    const expected = getColumn(perNeuron, 'weight')
      .filter((_, i) => {
        const type = getColumn(perNeuron, 'targetType')[i]
        return type !== null && String(type) === first
      })
      .reduce<number>((sum, w) => sum + Number(w), 0)
    expect(weights[0]).toBe(expected)
  })

  it('applies the threshold after the sum, not before', async () => {
    const source = new MockSource({ latencyMs: 0 })
    const request = {
      datasetId: DATASET,
      types: ['LC4'],
      direction: 'outputs' as const,
      collapseTypes: true,
    }
    const all = await source.fetchPathStep(request)
    const weights = getColumn(all, 'weight').map(Number)
    const cut = Math.max(...weights)
    const tight = await source.fetchPathStep({ ...request, minWeight: cut })

    expect(tight.length).toBeGreaterThan(0)
    expect(getColumn(tight, 'weight').every((w) => Number(w) >= cut)).toBe(true)
    // A per-connection threshold would have cut this to nothing: no single LC4→partner
    // connection in the mock carries the population's whole synapse count.
    expect(cut).toBeGreaterThan(
      Math.max(
        ...getColumn(
          await source.fetchPathStep({ ...request, collapseTypes: false }),
          'weight',
        ).map(Number),
      ),
    )
  })
})

/**
 * Both outputs into one Network node — the wiring this node exists to be used in.
 *
 * It is asserted through `availableColumns` rather than through the types alone, because that
 * is where it was actually noticed: `topoSort` counted a second wire between the same pair of
 * nodes as a cycle, inference dropped the Network node's input types, and every column picker
 * on it came up empty while a result cached from before the layout wire stayed on screen. The
 * network still *had* a weight — the tooltip said so — and there was no way to bind it.
 */
describe('Paths feeding a Network node', () => {
  function wired(): CodaGraph {
    let g = pipeline()
    g = addNode(g, node('net', 'out.network'))
    g = addEdge(g, {
      source: 'paths',
      sourceHandle: 'network',
      target: 'net',
      targetHandle: 'in',
    })
    g = addEdge(g, {
      source: 'paths',
      sourceHandle: 'layout',
      target: 'net',
      targetHandle: 'layout',
    })
    return g
  }

  it('leaves the Network node its schemas, both wires connected', () => {
    const inferred = inferGraph(wired()).nodes['net']
    expect(inferred?.issues ?? []).toEqual([])
    expect(inferred?.inputs['in']?.kind).toBe('network')
    expect(inferred?.inputs['layout']?.kind).toBe('layout')
  })

  it('offers weight to the link width picker', () => {
    const inputs = inferGraph(wired()).nodes['net']?.inputs ?? {}
    const params = requireNodeDef('out.network').params ?? []
    const find = (id: string) => params.find((p) => p.id === id)

    const width = find('edgeSizeBy')
    expect(width?.kind).toBe('column')
    if (width?.kind !== 'column') throw new Error('edgeSizeBy is not a column param')
    expect(availableColumns(width, inputs, {})).toContain('weight')

    // And the node half is unaffected, which is what says the whole input resolved rather
    // than the edge schema alone.
    const colour = find('nodeColorBy')
    if (colour?.kind !== 'column') throw new Error('nodeColorBy is not a column param')
    expect(availableColumns(colour, inputs, {})).toContain('type')
  })
})
