/**
 * The Profile node's contract.
 *
 * Two properties carry the design and neither is visible in the widget: the node is a *tap*
 * (its pass-through must not downgrade a Neurons edge), and paging must not invalidate
 * anything while pinning must. The staleness assertions below are the only place that second
 * property is checked — get it wrong and the symptom is a graph that quietly goes stale
 * whenever someone browses, which reads as a bug in the scheduler rather than here.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import '../index'

const source: DataSource = new MockSource({ latencyMs: 0 })

function makeScheduler(): Scheduler {
  return new Scheduler({
    resolveSource: (id) => {
      if (id !== 'mock') throw new Error(`unexpected source ${id}`)
      return source
    },
  })
}

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** dataset → find(LC.*) → profile */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('profile-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*', status: 'Traced' }))
  g = addNode(g, node('prof', 'out.profile', params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'prof',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'prof',
    targetHandle: 'neurons',
  })
  return g
}

describe('out.profile — types', () => {
  it('passes a Neurons edge through as Neurons, not Table', () => {
    // A viewer dropped mid-chain must not downgrade the edge, or every node after it loses
    // the bodyId guarantee its column pickers rely on.
    const inference = inferGraph(pipeline())
    expect(inference.nodes['prof']?.outputs['out']?.kind).toBe('neurons')
    expect(inference.nodes['prof']?.outputs['current']?.kind).toBe('neurons')
  })

  it('advertises the incoming column schema on both ports before anything runs', () => {
    const inference = inferGraph(pipeline())
    expect(
      schemaOf(inference.nodes['prof']?.outputs['out'])?.columns.map((c) => c.name),
    ).toContain('bodyId')
    expect(
      schemaOf(inference.nodes['prof']?.outputs['current'])?.columns.map((c) => c.name),
    ).toContain('type')
  })

  it('accepts a plain Table, since bodyId is a validation question and not a type one', () => {
    const def = requireNodeDef('out.profile')
    expect(def.inputs?.find((p) => p.id === 'neurons')?.type.kind).toBe('table')
  })
})

describe('out.profile — validation', () => {
  /**
   * Read through `inferGraph` rather than by calling `validate` directly: inference is what
   * the editor actually runs, so this also proves the issue reaches the node badge instead of
   * merely being returned by a function nobody calls.
   */
  function issues(graph: CodaGraph, id: string): string[] {
    return (inferGraph(graph).nodes[id]?.issues ?? []).map((issue) => issue.message)
  }

  it('says nothing when the incoming table has a bodyId', () => {
    expect(issues(pipeline(), 'prof')).toEqual([])
  })

  it('names the columns the table does have when bodyId is missing', () => {
    let g = pipeline()
    g = addNode(g, node('sel', 'core.select', { columns: ['type'] }))
    g = addEdge(g, {
      source: 'find',
      sourceHandle: 'neurons',
      target: 'sel',
      targetHandle: 'in',
    })
    g = {
      ...g,
      edges: g.edges.filter((e) => !(e.target === 'prof' && e.targetHandle === 'neurons')),
    }
    g = addEdge(g, {
      source: 'sel',
      sourceHandle: 'out',
      target: 'prof',
      targetHandle: 'neurons',
    })

    const reported = issues(g, 'prof')
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('bodyId')
    // The point of the message is that it says what you *do* have, so the fix is obvious.
    expect(reported[0]).toContain('type')
  })

  it('stays quiet on an unknown schema rather than guessing', () => {
    // A raw Cypher result may well have a bodyId. Refusing it before anything has run would
    // be a guess dressed up as an error.
    let g = emptyGraph('unknown-schema')
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
    g = addNode(g, node('raw', 'neuron.rawCypher'))
    g = addNode(g, node('prof', 'out.profile'))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'raw',
      targetHandle: 'dataset',
    })
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'prof',
      targetHandle: 'dataset',
    })
    g = addEdge(g, {
      source: 'raw',
      sourceHandle: 'result',
      target: 'prof',
      targetHandle: 'neurons',
    })
    expect(issues(g, 'prof')).toEqual([])
  })
})

describe('out.profile — evaluate', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = makeScheduler()
  })

  it('passes the input through untouched', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.output('prof', 'out')).toBe(scheduler.output('find', 'neurons'))
  })

  it('emits the pinned neuron, at full width, on Current', async () => {
    await scheduler.run(pipeline(), { mode: 'full' })
    const table = scheduler.output('find', 'neurons')
    if (!isTableValue(table)) throw new Error('expected a table')
    const pinned = String(table.data['bodyId']?.[1])

    const second = makeScheduler()
    await second.run(pipeline({ selection: [pinned] }), { mode: 'full' })
    const current = second.output('prof', 'current')
    if (!isTableValue(current)) throw new Error('expected a table')

    expect(current.length).toBe(1)
    expect(String(current.data['bodyId']?.[0])).toBe(pinned)
    // Full width, not just the id — the whole point is that Current is usable downstream.
    expect(current.schema.columns.length).toBe(table.schema.columns.length)
    expect(current.kind).toBe('neurons')
  })

  it('emits nothing rather than everything when nothing is pinned', async () => {
    // Widening an empty pin to "all of them" would send a Skeletons node wired to Current off
    // to fetch the whole input the moment someone unpinned.
    await scheduler.run(pipeline(), { mode: 'full' })
    const current = scheduler.output('prof', 'current')
    if (!isTableValue(current)) throw new Error('expected a table')
    expect(current.length).toBe(0)
  })
})

describe('out.profile — provenance', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = makeScheduler()
  })

  it('browsing is free — paging leaves the node ok and re-runs nothing', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    const paged = setNodeParam(graph, 'prof', 'page', 7)
    scheduler.refreshStates(paged)
    expect(scheduler.info('prof').state).toBe('ok')

    const summary = await scheduler.run(paged, { mode: 'full' })
    expect(summary.executed).toEqual([])
  })

  it('the partner threshold and row count are free too', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    let changed = setNodeParam(graph, 'prof', 'minWeight', 25)
    changed = setNodeParam(changed, 'prof', 'topN', 40)
    scheduler.refreshStates(changed)
    // Neither can change a byte of what either port carries — the outputs are the
    // pass-through and the pinned row — so neither may invalidate a downstream result.
    expect(scheduler.info('prof').state).toBe('ok')
  })

  it('pinning is a decision — the selection marks the node stale', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    const pinned = setNodeParam(graph, 'prof', 'selection', ['12345'])
    scheduler.refreshStates(pinned)
    expect(scheduler.info('prof').state).toBe('stale')
  })

  it('is cheap, because evaluate touches no network', () => {
    expect(requireNodeDef('out.profile').cost).toBe('cheap')
  })

  it('marks paging presentational on the param itself', () => {
    // Asserted directly as well as through the scheduler: this is the one flag that, if
    // dropped, fails no type check and produces a graph going stale whenever anyone browses.
    const params = requireNodeDef('out.profile').params ?? []
    expect(params.find((p) => p.id === 'page')?.presentational).toBe(true)
    expect(params.find((p) => p.id === 'minWeight')?.presentational).toBe(true)
    expect(params.find((p) => p.id === 'topN')?.presentational).toBe(true)
    expect(params.find((p) => p.id === 'selection')?.presentational).toBeFalsy()
  })
})
