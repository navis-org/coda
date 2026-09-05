/**
 * The Adjacency node's two outputs, and the chain the second one exists for.
 *
 * The reshape itself is `tableOps.test.ts`'s — `matrixToLinks` and its schema half, including the
 * zero-dropping rule and the argument for it. What is pinned here is that the two ports describe
 * one fetch and cannot disagree, and that `Links` really does land on `Build Network` without
 * three column pickers being re-chosen by hand. That last one is the whole reason the port was
 * added: before it, a connection matrix could be drawn by the Heatmap and nothing else, because
 * no node in the registry turned a matrix back into an edge list.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams, makeInferContext } from '../../core/node'
import { defaultOutputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { columnNames, schemaOf } from '../../core/types'
import { isMatrixValue, isNetworkValue, isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import { matrixLinksSchema } from '../lib/tableOps'
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

/**
 * dataset → find(LC.\*) onto find(everything) → adjacency → net.build
 *
 * Two different populations rather than one onto itself, and the mock is why: `LC.*` onto `LC.*`
 * is a real 4 × 4 answer with no connections in it at all, so a self-onto-self pipeline would
 * assert nothing about the reshape. `LC.*` onto every Traced neuron is 4 × 34 with 11 links —
 * sparse enough that "the zeros were dropped" is a claim the row count can actually carry.
 */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('adjacency-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*', status: 'Traced' }))
  g = addNode(g, node('all', 'neuron.findNeurons', { typePattern: '', status: 'Traced' }))
  g = addNode(g, node('adj', 'neuron.adjacency', params))
  // `Target` and `Weight` set by hand, which is what a user does — see the picker test below
  // for why the matching column names do not make that unnecessary.
  g = addNode(g, node('net', 'net.build', { target: 'target', weight: 'weight' }))
  for (const id of ['find', 'all', 'adj']) {
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: id,
      targetHandle: 'dataset',
    })
  }
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'adj',
    targetHandle: 'sources',
  })
  g = addEdge(g, {
    source: 'all',
    sourceHandle: 'neurons',
    target: 'adj',
    targetHandle: 'targets',
  })
  g = addEdge(g, { source: 'adj', sourceHandle: 'links', target: 'net', targetHandle: 'edges' })
  return g
}

describe('neuron.adjacency — ports', () => {
  it('keeps Matrix first, so a dragged link starts at the picture', () => {
    // `neuron.roiConnectivity`'s order and its reason: the footer's summary then reads `N × M`.
    expect(defaultOutputPorts(requireNodeDef('neuron.adjacency')).map((p) => p.id)).toEqual([
      'matrix',
      'links',
    ])
  })

  it('types the Links table exactly with nothing wired', () => {
    // A matrix has two axes and a value, whatever the data — so unlike the wide half this shape
    // is a constant, and a picker downstream fills the moment the wire is drawn.
    const bare = addNode(emptyGraph('bare'), node('adj', 'neuron.adjacency'))
    expect(schemaOf(inferGraph(bare).nodes['adj']?.outputs['links'])).toEqual(
      matrixLinksSchema(),
    )
  })

  it('names its columns for Build Network, which still does not resolve two of them', () => {
    /*
     * Written down because the obvious assumption is wrong and costs a wrong graph rather than
     * an error. `net.build`'s `Source` and `Target` declare `default: ''`, which the resolver
     * reads as "first compatible column" and *not* as "the column with my name" — so on this
     * table both land on `source`, every link becomes a self-loop, and the network comes out
     * with one node per source and no edges between anything. `Weight` is `optional`, so empty
     * stays empty and every link weighs 1 rather than its synapse count.
     *
     * So the matching names buy recognition, not resolution. If `net.build` ever gains named
     * defaults this test is what says so.
     */
    expect(columnNames(matrixLinksSchema())).toEqual(['source', 'target', 'weight'])

    let g = emptyGraph('defaults')
    g = addNode(g, node('adj', 'neuron.adjacency'))
    g = addNode(g, node('net', 'net.build'))
    g = addEdge(g, {
      source: 'adj',
      sourceHandle: 'links',
      target: 'net',
      targetHandle: 'edges',
    })
    const def = requireNodeDef('net.build')
    const params = defaultParams(def)
    const ctx = makeInferContext(def, params, inferGraph(g).nodes['net']!.inputs)
    expect(ctx.column('source')).toBe('source')
    expect(ctx.column('target')).toBe('source')
    expect(ctx.column('weight')).toBeUndefined()
  })
})

describe('neuron.adjacency — values', () => {
  it('emits the same connections twice over, as a matrix and as its non-zero cells', async () => {
    const scheduler = new Scheduler({ resolveSource: () => source })
    await scheduler.run(pipeline(), { mode: 'full' })
    expect(scheduler.info('adj').state).toBe('ok')

    const matrix = scheduler.output('adj', 'matrix')
    const links = scheduler.output('adj', 'links')
    if (!isMatrixValue(matrix) || !isTableValue(links)) {
      throw new Error('adjacency did not produce a matrix and a table')
    }

    // Derived from the matrix rather than fetched again, so the two cannot disagree about
    // labels, grouping or weights — `neuron.roiConnectivity`'s rule in the other direction.
    let nonZero = 0
    for (const value of matrix.values) if (value !== 0) nonZero++
    expect(links.length).toBe(nonZero)
    expect(links.length).toBeGreaterThan(0)
    // And strictly fewer rows than cells, or the zeros were not dropped and Build Network is
    // about to be handed a complete graph.
    expect(links.length).toBeLessThan(matrix.values.length)

    const labels = new Set([...matrix.rowLabels, ...matrix.colLabels])
    for (const cell of links.data.source!) expect(labels.has(String(cell))).toBe(true)
    for (const cell of links.data.target!) expect(labels.has(String(cell))).toBe(true)
    for (const cell of links.data.weight!) expect(Number(cell)).not.toBe(0)
  })

  it('reaches Build Network with no columns picked by hand', async () => {
    const scheduler = new Scheduler({ resolveSource: () => source })
    await scheduler.run(pipeline(), { mode: 'full' })
    expect(scheduler.info('net').state).toBe('ok')

    const network = scheduler.output('net', 'network')
    const links = scheduler.output('adj', 'links')
    if (!isNetworkValue(network) || !isTableValue(links)) throw new Error('no network')
    expect(network.nodes.length).toBeGreaterThan(0)
    // One link per row: the reshape already merged whatever the matrix merged, so there are no
    // parallel rows left for `net.build` to aggregate.
    expect(network.edges.length).toBe(links.length)
  })
})
