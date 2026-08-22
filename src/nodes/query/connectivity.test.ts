/**
 * The Connectivity node, driven through the real scheduler against the mock connectome.
 *
 * `connectivityOps.test.ts` pins the traversal against a hand-written graph. This covers the
 * half that file cannot: that the schema the node *advertises* at edit time is the schema it
 * *builds* at run time (invariant 3), and that the params reach the source — a `hops` that
 * quietly never left the node would still produce a perfectly valid one-hop table.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource, requireSource } from '../../data/source'
import '../index'

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

/** dataset → find → connectivity */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('connectivity-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('conn', 'neuron.connectivity', params))
  const wire = (source: string, handle: string, target: string, into: string) => {
    g = addEdge(g, { source, sourceHandle: handle, target, targetHandle: into })
  }
  wire('ds', 'dataset', 'find', 'dataset')
  wire('ds', 'dataset', 'conn', 'dataset')
  wire('find', 'neurons', 'conn', 'neurons')
  return g
}

function scheduler() {
  return new Scheduler({ resolveSource: (id) => requireSource(id) })
}

async function connections(params: Record<string, unknown> = {}) {
  const sched = scheduler()
  await sched.run(pipeline(params), { mode: 'full' })
  const table = sched.output('conn', 'connections')
  if (!isTableValue(table)) throw new Error(`expected a table, got ${JSON.stringify(table)}`)
  return table
}

describe('Connectivity output shape', () => {
  it('advertises the columns it actually builds', async () => {
    const declared = inferGraph(pipeline()).nodes.conn?.outputs.connections
    const advertised =
      declared && 'schema' in declared ? declared.schema?.columns.map((c) => c.name) : undefined
    expect(advertised).toEqual([
      'preId',
      'preType',
      'postId',
      'postType',
      'weight',
      'hop',
      'direction',
    ])

    const table = await connections()
    expect(table.schema.columns.map((c) => c.name)).toEqual(advertised)
  })

  it('carries hop and direction even at the default one hop downstream', async () => {
    const table = await connections()
    expect(table.length).toBeGreaterThan(0)
    expect(new Set(table.data.hop)).toEqual(new Set([1]))
    expect(new Set(table.data.direction)).toEqual(new Set(['downstream']))
  })
})

describe('direction', () => {
  it('orients an upstream row pre → post, so preId is the partner', async () => {
    const seeds = new Set((await connections()).data.preId?.map(Number))
    const upstream = await connections({ direction: 'inputs' })
    // Every row is an edge *into* a seed: the seeds are on the post side now.
    for (const id of upstream.data.postId ?? []) expect(seeds.has(Number(id))).toBe(true)
    expect(new Set(upstream.data.direction)).toEqual(new Set(['upstream']))
  })

  it('queries both ways for "both" and returns strictly more than either alone', async () => {
    const spy = vi.spyOn(MockSource.prototype, 'fetchConnectivity')
    try {
      const both = await connections({ direction: 'both' })
      expect(spy.mock.calls.map((c) => c[0].direction).sort()).toEqual(['inputs', 'outputs'])

      const out = await connections({ direction: 'outputs' })
      const inn = await connections({ direction: 'inputs' })
      expect(both.length).toBeGreaterThan(Math.max(out.length, inn.length))
      expect(both.length).toBeLessThanOrEqual(out.length + inn.length)
    } finally {
      spy.mockRestore()
    }
  })

  it('never emits the same edge twice, whatever the direction', async () => {
    const table = await connections({ direction: 'both', hops: 2 })
    const pairs = (table.data.preId ?? []).map((pre, i) => `${pre}>${table.data.postId?.[i]}`)
    expect(new Set(pairs).size).toBe(pairs.length)
  })
})

describe('hops', () => {
  it('reaches the source as a second round of queries', async () => {
    const spy = vi.spyOn(MockSource.prototype, 'fetchConnectivity')
    try {
      await connections({ hops: 2 })
      expect(spy.mock.calls.length).toBe(2)
      // The second round asks about the neurons the first one found, not the seeds again.
      const first = new Set(spy.mock.calls[0]?.[0].neuronIds)
      const second = spy.mock.calls[1]?.[0].neuronIds ?? []
      expect(second.length).toBeGreaterThan(0)
      expect(second.some((id) => !first.has(id))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('adds hop-2 rows without dropping the hop-1 ones', async () => {
    const one = await connections()
    const two = await connections({ hops: 2 })
    expect(new Set(two.data.hop)).toEqual(new Set([1, 2]))
    expect(two.length).toBeGreaterThan(one.length)

    const oneHopPairs = new Set(
      (one.data.preId ?? []).map((pre, i) => `${pre}>${one.data.postId?.[i]}`),
    )
    const twoHopPairs = new Set(
      (two.data.preId ?? []).map((pre, i) => `${pre}>${two.data.postId?.[i]}`),
    )
    for (const pair of oneHopPairs) expect(twoHopPairs.has(pair)).toBe(true)
  })

  it('changes the cache key, so lifting Hops does not reuse the shallow result', async () => {
    const sched = scheduler()
    await sched.run(pipeline({ hops: 1 }), { mode: 'full' })
    const shallow = sched.output('conn', 'connections')
    await sched.run(pipeline({ hops: 2 }), { mode: 'full' })
    const deep = sched.output('conn', 'connections')
    if (!isTableValue(shallow) || !isTableValue(deep)) throw new Error('expected tables')
    expect(deep.length).toBeGreaterThan(shallow.length)
  })
})

describe('warnings', () => {
  it('says so when the hop count and the weight cut multiply badly', () => {
    const quiet = inferGraph(pipeline({ hops: 3, minWeight: 10 })).nodes.conn?.issues ?? []
    expect(quiet).toEqual([])

    const loud = inferGraph(pipeline({ hops: 3, minWeight: 1 })).nodes.conn?.issues ?? []
    expect(loud.some((i) => /Raise Min weight/.test(i.message))).toBe(true)
    // A warning, never a refusal — the graph stays runnable.
    expect(loud.every((i) => i.severity === 'warning')).toBe(true)
  })
})
