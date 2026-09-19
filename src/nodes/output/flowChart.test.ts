/**
 * The Flow Chart node's contract.
 *
 * The layering is `flowChartOps.test.ts`' and the geometry is `flowChartLayout.test.ts`'. What is
 * pinned here is the part only the node decides, and every one of the four is a thing no type
 * check sees:
 *
 *  - the network passes through **by identity**, which is what makes every drawing control
 *    presentational and therefore what stops a restyle staling the `expensive` query above it;
 *  - the selection leaves as a `Neurons` table carrying the network's own node attributes;
 *  - `Selected` is typed exactly before anything runs, so a picker downstream of it fills at
 *    edit time;
 *  - and the crowding warning is an `evaluate` warning rather than a `validate` issue, because
 *    a node count is data.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultOutputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { columnNames } from '../../core/types'
import { getColumn, isNetworkValue, isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import { FLOW_NODES_WARN } from '../lib/flowChartOps'
import '../index'
import { searchFor } from '../../test/findNeurons'
import { node } from '../../test/graph'

const source: DataSource = new MockSource({ latencyMs: 0 })

/** dataset → find(LC.*) → connectivity → net.build → out.flowChart */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('flowchart-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(
    g,
    node('find', 'neuron.findNeurons', searchFor({ type: 'LC.*', status: 'Traced' })),
  )
  g = addNode(g, node('conn', 'neuron.connectivity', { direction: 'downstream', minWeight: 3 }))
  g = addNode(
    g,
    node('net', 'net.build', { source: 'preType', target: 'postType', weight: 'weight' }),
  )
  g = addNode(g, node('flow', 'out.flowChart', params))
  for (const [from, handle, to, target] of [
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'conn', 'dataset'],
    ['find', 'neurons', 'conn', 'neurons'],
    ['conn', 'connections', 'net', 'edges'],
    ['net', 'network', 'flow', 'in'],
  ] as const) {
    g = addEdge(g, { source: from, sourceHandle: handle, target: to, targetHandle: target })
  }
  return g
}

async function run(graph: CodaGraph) {
  const scheduler = new Scheduler({ resolveSource: () => source })
  await scheduler.run(graph, { mode: 'full' })
  return scheduler
}

describe('out.flowChart — types', () => {
  it('keeps Network as the first output, so a dragged link continues the chain', () => {
    expect(defaultOutputPorts(requireNodeDef('out.flowChart')).map((p) => p.id)).toEqual([
      'out',
      'selected',
    ])
  })

  it('is cheap: nothing here fetches and nothing here computes over a value', () => {
    expect(requireNodeDef('out.flowChart').cost).toBe('cheap')
  })

  it('types Selected as the network node table with a neuronId in front, before any run', () => {
    const types = inferGraph(pipeline()).nodes['flow']
    const selected = types?.outputs['selected']
    expect(selected?.kind).toBe('neurons')
    const names = selected?.kind === 'neurons' ? columnNames(selected.schema) : []
    expect(names[0]).toBe('neuronId')
    // Everything `net.build` puts on a node, and no second `neuronId`.
    expect(names).toContain('degreeIn')
    expect(names.filter((n) => n === 'neuronId')).toHaveLength(1)
  })

  it('passes the network type through whole, so downstream pickers see the real schema', () => {
    const types = inferGraph(pipeline()).nodes['flow']
    expect(types?.outputs['out']).toEqual(types?.inputs['in'])
  })

  /**
   * Every control but the selection is presentational, and that is the node's whole contract:
   * a figure gets restyled twenty times and none of it may stale the query above it.
   */
  it('marks every control but the selection presentational', () => {
    const def = requireNodeDef('out.flowChart')
    const plain = (def.params ?? []).filter((p) => p.presentational !== true).map((p) => p.id)
    expect(plain).toEqual(['selection'])
  })
})

describe('out.flowChart — evaluate', () => {
  it('hands the network on by identity, not as a copy', async () => {
    const scheduler = await run(pipeline())
    const arrived = scheduler.output('net', 'network')
    const left = scheduler.output('flow', 'out')
    expect(isNetworkValue(left)).toBe(true)
    // Identity, which is what makes the drawing controls free: a copy would be a new object on
    // every run and no cheaper, but it would invite somebody to fold into it.
    expect(left).toBe(arrived)
  })

  it('emits nothing on Selected until something is clicked', async () => {
    const scheduler = await run(pipeline())
    const selected = scheduler.output('flow', 'selected')
    expect(isTableValue(selected)).toBe(true)
    if (isTableValue(selected)) expect(selected.length).toBe(0)
  })

  it('carries a clicked node’s own attributes out beside its id', async () => {
    // The ids are cell type names here, `net.build` having been given `preType`/`postType` —
    // which is the case `selectionSchema`'s comment is about: a type-level selection flows on
    // as type names under a column called `neuronId` and fails loudly at the next query.
    const first = await run(pipeline()).then((scheduler) => {
      const network = scheduler.output('net', 'network')
      return isNetworkValue(network) ? String(getColumn(network.nodes, 'id')[0]) : ''
    })
    expect(first).not.toBe('')

    const scheduler = await run(pipeline({ selection: [first] }))
    const selected = scheduler.output('flow', 'selected')
    expect(isTableValue(selected)).toBe(true)
    if (!isTableValue(selected)) return
    expect(selected.length).toBe(1)
    expect(getColumn(selected, 'neuronId')).toEqual([first])
    // An attribute the network carried, so a selection arrives downstream annotated.
    expect(selected.schema.columns.map((c) => c.name)).toContain('degreeOut')
  })

  it('ignores a selected id the network no longer has, rather than blocking', async () => {
    // Invariant 5's corollary: a stale control is no reason for `evaluate` to stop everything
    // downstream. An upstream filter that removed the node somebody had clicked is the case.
    const scheduler = await run(pipeline({ selection: ['not-a-node'] }))
    expect(scheduler.info('flow').state).toBe('ok')
    const selected = scheduler.output('flow', 'selected')
    if (isTableValue(selected)) expect(selected.length).toBe(0)
  })

  /**
   * The warning is raised from `evaluate` and not from `validate`, because a network's node
   * count is a fact about a *value* and `validate` has only types. The pipeline here is well
   * under the threshold, so what is pinned is the quiet direction — a warning nobody asked for
   * on every ordinary graph is the failure that teaches people to ignore the channel.
   */
  it('says nothing about crowding on a graph that is not crowded', async () => {
    const scheduler = await run(pipeline())
    const network = scheduler.output('net', 'network')
    expect(isNetworkValue(network)).toBe(true)
    if (isNetworkValue(network)) expect(network.nodes.length).toBeLessThan(FLOW_NODES_WARN)
    expect(scheduler.warning('flow')).toBeUndefined()
  })
})
