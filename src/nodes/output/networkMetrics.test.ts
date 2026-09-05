/**
 * The Network Metrics node's contract.
 *
 * The arithmetic is `networkMetrics.test.ts`'s, including the agreement with networkx. What is
 * pinned here is the shape, and specifically the three things about it that no type check sees:
 * that the pass-through carries the metrics onward, that all three ports are exactly typed
 * *before* anything runs, and that the scatter's column pickers are offered the schema this node
 * is about to produce rather than the one arriving at its input.
 *
 * That last one is the interesting failure. A `column` param reads `attributeSchema` off the type
 * at `from` by default, and on this node that is the incoming network — which carries none of the
 * metrics, so the picker would offer `degreeIn` from `net.build` and nothing else, and the plot
 * this node exists for would be unreachable. `schemaFrom` is what corrects it, and nothing else
 * would notice if it were dropped.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { defaultOutputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { attributeSchema, columnNames } from '../../core/types'
import { getColumn, isNetworkValue, isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import { METRIC_COLUMNS, networkSummarySchema, nodeStatsSchema } from '../lib/networkMetrics'
import '../index'

const source: DataSource = new MockSource({ latencyMs: 0 })

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** dataset → find(LC.*) → connectivity → net.build → net.metrics */
function pipeline(): CodaGraph {
  let g = emptyGraph('metrics-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*', status: 'Traced' }))
  g = addNode(g, node('conn', 'neuron.connectivity', { direction: 'downstream', minWeight: 3 }))
  g = addNode(
    g,
    node('net', 'net.build', { source: 'preType', target: 'postType', weight: 'weight' }),
  )
  g = addNode(g, node('metrics', 'net.metrics'))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'conn',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'conn',
    targetHandle: 'neurons',
  })
  g = addEdge(g, {
    source: 'conn',
    sourceHandle: 'connections',
    target: 'net',
    targetHandle: 'edges',
  })
  g = addEdge(g, {
    source: 'net',
    sourceHandle: 'network',
    target: 'metrics',
    targetHandle: 'in',
  })
  return g
}

describe('net.metrics — types', () => {
  it('keeps Network as the first output, so a dragged link continues the chain', () => {
    expect(defaultOutputPorts(requireNodeDef('net.metrics')).map((p) => p.id)).toEqual([
      'out',
      'nodes',
      'summary',
    ])
  })

  it('is cheap, because everything on it is a linear pass but one', () => {
    // The exception is the triangle count, which measures itself and warns. If this ever needs
    // to become `expensive`, the metric that made it so belongs on `net.centrality` instead.
    expect(requireNodeDef('net.metrics').cost).toBe('cheap')
  })

  it('types both tables exactly before anything has run', () => {
    const types = inferGraph(pipeline()).nodes['metrics']
    expect(types?.outputs['nodes']).toEqual({ kind: 'table', schema: nodeStatsSchema() })
    expect(types?.outputs['summary']).toEqual({ kind: 'table', schema: networkSummarySchema() })
  })

  it('folds the metric columns into the pass-through network`s node schema', () => {
    const types = inferGraph(pipeline()).nodes['metrics']
    const names = columnNames(attributeSchema(types?.outputs['out'], 'nodes'))
    for (const metric of METRIC_COLUMNS) expect(names).toContain(metric)
    // Written over, never beside: `net.build` emits `degreeIn` itself, and two columns of that
    // name would give a picker downstream two answers to one question.
    expect(names.filter((name) => name === 'degreeIn')).toHaveLength(1)
    expect(names[0]).toBe('id')
  })

  it('keeps the edge schema untouched — this node reads links and writes none', () => {
    const inference = inferGraph(pipeline())
    expect(
      columnNames(attributeSchema(inference.nodes['metrics']?.outputs['out'], 'edges')),
    ).toEqual(columnNames(attributeSchema(inference.nodes['net']?.outputs['network'], 'edges')))
  })

  it('offers the metrics to the scatter`s pickers, not just the incoming columns', () => {
    /*
     * The `schemaFrom` test, and the reason it is worth its own case: without it the pickers
     * read the *input* network, which has no `clustering` at all, and the node's declared
     * default would resolve to something else with nothing to say so.
     */
    const def = requireNodeDef('net.metrics')
    const params = def.params ?? []
    const inference = inferGraph(pipeline())
    const inputs = inference.nodes['metrics']?.inputs ?? {}
    for (const id of ['plotX', 'plotY']) {
      const param = params.find((p) => p.id === id)
      expect(param?.kind).toBe('column')
      const schema = (
        param as { schemaFrom?: (i: unknown, p: unknown) => unknown }
      ).schemaFrom?.(inputs, {})
      expect(columnNames(schema as never)).toContain('clustering')
    }
  })

  it('marks every setting presentational, since none of them can change a port', () => {
    // Invariant 4: a param that cannot change what `evaluate` returns is excluded from the
    // provenance key, and one that *can* must never be marked this way.
    for (const param of requireNodeDef('net.metrics').params ?? []) {
      expect([param.id, param.presentational]).toEqual([param.id, true])
    }
  })
})

describe('net.metrics — values', () => {
  it('passes the network on with the metrics written onto it, and fills both tables', async () => {
    const scheduler = new Scheduler({ resolveSource: () => source })
    await scheduler.run(pipeline(), { mode: 'full' })
    expect(scheduler.info('metrics').state).toBe('ok')

    const out = scheduler.output('metrics', 'out')
    const nodes = scheduler.output('metrics', 'nodes')
    const summary = scheduler.output('metrics', 'summary')
    if (!isNetworkValue(out) || !isTableValue(nodes) || !isTableValue(summary)) {
      throw new Error('metrics did not produce a network and two tables')
    }

    // The tap carries the same graph, not a narrowed one: this node measures, it never filters.
    const upstream = scheduler.output('net', 'network')
    if (!isNetworkValue(upstream)) throw new Error('no upstream network')
    expect(out.nodes.length).toBe(upstream.nodes.length)
    expect(out.edges).toBe(upstream.edges)

    expect(nodes.length).toBe(out.nodes.length)
    expect(summary.length).toBe(1)
    expect(getColumn(summary, 'nodes')[0]).toBe(out.nodes.length)
    expect(getColumn(summary, 'links')[0]).toBe(out.edges.length)
    // The two halves of the same numbers, so a downstream join on `id` cannot disagree with an
    // encoding read off the network.
    expect(getColumn(out.nodes, 'degree')).toEqual(getColumn(nodes, 'degree'))
  })

  it('says nothing on the ordinary chain, where the roll-ups are always written over', async () => {
    /*
     * The overwrite warning is `evaluate`'s, and it has to stay quiet here or it fires on every
     * graph anybody builds: `net.build` emits `degreeIn`, `degreeOut`, `weightIn` and
     * `weightOut` itself, so those four are overwritten every single time. `ROLLUPS` is imported
     * from `networkOps` rather than retyped, which is what keeps this exemption in step with the
     * set it names.
     */
    const scheduler = new Scheduler({ resolveSource: () => source })
    await scheduler.run(pipeline(), { mode: 'full' })
    expect(scheduler.info('metrics').state).toBe('ok')
    expect(scheduler.warning('metrics')).toBeUndefined()
  })

  it('refuses a table on the Network socket, naming the port', async () => {
    let g = emptyGraph('metrics-bad')
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
    g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*' }))
    g = addNode(g, node('metrics', 'net.metrics'))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'find',
      targetHandle: 'dataset',
    })
    /*
     * A neuron table on a Network socket. The editor would refuse the wire and a hand-edited
     * document would not — and what catches it is the *type* check rather than `evaluate`, which
     * is the better of the two answers: it says which port and what arrived, and it says so
     * without running anything. `evaluate`'s own `isNetworkValue` guard stays as the backstop
     * for a value that types as a network and is not one.
     */
    g = addEdge(g, {
      source: 'find',
      sourceHandle: 'neurons',
      target: 'metrics',
      targetHandle: 'in',
    })
    const scheduler = new Scheduler({ resolveSource: () => source })
    await scheduler.run(g, { mode: 'full' })
    expect(scheduler.info('metrics').state).toBe('error')
    expect(scheduler.info('metrics').error).toMatch(/Network/)
  })
})
