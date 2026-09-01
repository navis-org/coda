/**
 * The Network Centrality node's contract.
 *
 * The arithmetic — including the agreement with networkx — is `networkCentrality.test.ts` in
 * `nodes/lib`. What is pinned here is the shape, and the one property of it that would fail
 * silently: **the declared schema and the emitted columns are driven by the same reader.**
 * `centralityOptions` is that reader, and a node whose `inferOutputs` said `betweenness` while
 * `evaluate` produced nothing of the sort would give every downstream picker a column that is
 * never filled — a failure that shows up only after a Run, on a node that costs minutes.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { attributeSchema, columnNames } from '../../core/types'
import { isNetworkValue, isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import { centralitySummarySchema } from '../lib/networkCentrality'
import { centralityOptions } from './networkCentrality'
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

/** dataset → find(LC.*) → connectivity → net.build → net.centrality */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('centrality-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*', status: 'Traced' }))
  g = addNode(g, node('conn', 'neuron.connectivity', { direction: 'downstream', minWeight: 3 }))
  g = addNode(
    g,
    node('net', 'net.build', { source: 'preType', target: 'postType', weight: 'weight' }),
  )
  g = addNode(g, node('central', 'net.centrality', params))
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'conn', targetHandle: 'dataset' })
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
    target: 'central',
    targetHandle: 'in',
  })
  return g
}

describe('net.centrality — types', () => {
  it('is expensive, which is the whole reason it is not part of net.metrics', () => {
    // `cost` is a property of the node *type* (invariant 6), so one node holding both halves
    // would make reading a graph's node count wait for a shortest-path sweep.
    expect(requireNodeDef('net.centrality').cost).toBe('expensive')
  })

  it('offers only the columns its switches asked for', () => {
    const types = inferGraph(pipeline({ eigenvector: false, communities: false })).nodes['central']
    expect(columnNames(attributeSchema(types?.outputs['nodes']))).toEqual([
      'id',
      'betweenness',
      'closeness',
      'pagerank',
    ])

    const all = inferGraph(pipeline({ eigenvector: true })).nodes['central']
    expect(columnNames(attributeSchema(all?.outputs['nodes']))).toContain('eigenvector')
  })

  it('keeps the summary constant-width whatever was computed', () => {
    // The asymmetry with the node half is deliberate: the summary's use is being stacked across
    // runs, and a Collect of five summaries whose columns depend on each run's settings is five
    // different tables. See `centralitySummarySchema`.
    for (const params of [{}, { betweenness: false, closeness: false }, { eigenvector: true }]) {
      const types = inferGraph(pipeline(params)).nodes['central']
      expect(types?.outputs['summary']).toEqual({
        kind: 'table',
        schema: centralitySummarySchema(),
      })
    }
  })

  it('folds its columns into the pass-through network, keeping what was there', () => {
    const types = inferGraph(pipeline()).nodes['central']
    const names = columnNames(attributeSchema(types?.outputs['out'], 'nodes'))
    expect(names[0]).toBe('id')
    expect(names).toContain('degreeIn')
    expect(names).toContain('betweenness')
  })

  it('refuses a graph with every measure switched off', () => {
    const off = {
      betweenness: false,
      closeness: false,
      pagerank: false,
      eigenvector: false,
      communities: false,
    }
    const issues = inferGraph(pipeline(off)).nodes['central']?.issues ?? []
    expect(issues.map((i) => i.message).join(' ')).toMatch(/at least one measure/i)
  })

  it('reads its params through one function, so the schema and the values cannot disagree', () => {
    // `centralityOptions` is what `inferOutputs`, `validate` and `evaluate` all call. Reading
    // `ctx.params.betweenness` in any one of them is how a declared column stops being filled.
    const defaults = centralityOptions(defaultParams(requireNodeDef('net.centrality')))
    expect(defaults.betweenness).toBe(true)
    expect(defaults.eigenvector).toBe(false)
    expect(defaults.samples).toBe(0)
  })
})

describe('net.centrality — values', () => {
  it('emits exactly the columns it declared, and writes them onto the network', async () => {
    const scheduler = new Scheduler({ resolveSource: () => source })
    const graph = pipeline({ eigenvector: true, samples: 0 })
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.info('central').state).toBe('ok')

    const declared = columnNames(
      attributeSchema(inferGraph(graph).nodes['central']?.outputs['nodes']),
    )
    const nodes = scheduler.output('central', 'nodes')
    const out = scheduler.output('central', 'out')
    const summary = scheduler.output('central', 'summary')
    if (!isTableValue(nodes) || !isNetworkValue(out) || !isTableValue(summary)) {
      throw new Error('centrality did not produce a table, a network and a summary')
    }

    expect(columnNames(nodes.schema)).toEqual(declared)
    for (const name of declared) {
      if (name === 'id') continue
      expect(out.nodes.data[name]).toEqual(nodes.data[name])
    }
    expect(summary.length).toBe(1)
    expect(summary.data['sources']?.[0]).toBe(out.nodes.length)
    expect(Number(summary.data['modularity']?.[0])).toBeGreaterThan(0)
  })

  it('gives the same answer twice — the seed is the node`s, not Math.random`s', async () => {
    // Invariant 4: the cache key is provenance, so `evaluate` has to be deterministic. Louvain's
    // random walk and the pivot draw are the two places that could quietly not be.
    const graph = pipeline({ samples: 4, seed: 3 })
    const first = new Scheduler({ resolveSource: () => source })
    await first.run(graph, { mode: 'full' })
    const second = new Scheduler({ resolveSource: () => source })
    await second.run(graph, { mode: 'full' })

    const a = first.output('central', 'nodes')
    const b = second.output('central', 'nodes')
    if (!isTableValue(a) || !isTableValue(b)) throw new Error('no node stats')
    expect(b.data).toEqual(a.data)
  })

  it('leaves the diameter empty when the sweep was sampled', async () => {
    const scheduler = new Scheduler({ resolveSource: () => source })
    await scheduler.run(pipeline({ samples: 3 }), { mode: 'full' })
    const summary = scheduler.output('central', 'summary')
    if (!isTableValue(summary)) throw new Error('no summary')
    expect(summary.data['sources']?.[0]).toBe(3)
    // A sampled maximum is a lower bound with no error bar, so it says nothing rather than
    // something that reads like an answer. The mean is still an estimate worth reporting.
    expect(summary.data['diameter']?.[0]).toBeNull()
    expect(summary.data['meanPathLength']?.[0]).not.toBeNull()
  })
})
