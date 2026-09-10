/**
 * The Sample node's contract.
 *
 * Three things carry it, and none is visible on the card. The node is a *subset* — schema
 * untouched, neurons-ness intact, rows in the input's own order — so anything wired after it
 * keeps working. The random mode is reproducible, because a cache key is provenance and a
 * draw that varied per call would make a result disagree with the key that stands for it. And
 * the seed takes part in that key only while the random mode is chosen: `visibleIf` is what
 * keeps a seed nobody can see from staling a graph, which is the same rule that stops a
 * switched-off aggregation column doing it.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import type { Scheduler } from '../../core/scheduler'
import { schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import '../index'
import { searchFor } from '../../test/findNeurons'
import { node } from '../../test/graph'
import { mockScheduler } from '../../test/scheduler'

const source: DataSource = new MockSource({ latencyMs: 0 })

function makeScheduler(): Scheduler {
  return mockScheduler(source)
}

/** dataset → find(LC.*) → sample */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('sample-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(
    g,
    node('find', 'neuron.findNeurons', searchFor({ type: 'LC.*', status: 'Traced' })),
  )
  g = addNode(g, node('smp', 'core.sample', params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'smp', targetHandle: 'in' })
  return g
}

async function rows(graph: CodaGraph, scheduler = makeScheduler()): Promise<number[]> {
  await scheduler.run(graph, { mode: 'full' })
  const out = scheduler.output('smp', 'out')
  if (!isTableValue(out)) throw new Error('expected a table')
  return (out.data['neuronId'] ?? []).map(Number)
}

describe('core.sample — types', () => {
  it('keeps a Neurons edge Neurons, so a sample still plugs into Connectivity', () => {
    const inference = inferGraph(pipeline())
    expect(inference.nodes['smp']?.outputs['out']?.kind).toBe('neurons')
  })

  it('advertises the incoming columns before anything has run', () => {
    const inference = inferGraph(pipeline())
    const names = schemaOf(inference.nodes['smp']?.outputs['out'])?.columns.map((c) => c.name)
    expect(names).toContain('neuronId')
    expect(names).toContain('type')
  })
})

describe('core.sample — modes', () => {
  it('takes the top, the bottom and every Nth of the same table', async () => {
    const all = await rows(pipeline({ mode: 'head', count: 1_000_000 }))
    expect(all.length).toBeGreaterThan(10)

    expect(await rows(pipeline({ mode: 'head', count: 4 }))).toEqual(all.slice(0, 4))
    expect(await rows(pipeline({ mode: 'tail', count: 4 }))).toEqual(all.slice(-4))
    expect(await rows(pipeline({ mode: 'stride', step: 3 }))).toEqual(
      all.filter((_, i) => i % 3 === 0),
    )
  })

  it('draws a random subset in the input order, without repeats', async () => {
    const all = await rows(pipeline({ mode: 'head', count: 1_000_000 }))
    const drawn = await rows(pipeline({ mode: 'random', count: 5, seed: 1 }))

    expect(drawn).toHaveLength(5)
    expect(new Set(drawn).size).toBe(5)
    for (const id of drawn) expect(all).toContain(id)
    // A random subset of a table somebody sorted is still sorted: this samples, and the
    // shuffle that would answer a different question would be a different node.
    expect(drawn.map((id) => all.indexOf(id))).toEqual(
      [...drawn.map((id) => all.indexOf(id))].sort((a, b) => a - b),
    )
    expect(drawn).not.toEqual(all.slice(0, 5))
  })

  it('warns when a stride of 1 leaves the node doing nothing', () => {
    const issues = inferGraph(pipeline({ mode: 'stride', step: 1 })).nodes['smp']?.issues ?? []
    expect(issues.map((i) => i.message).join(' ')).toContain('keeps every row')
    expect(
      inferGraph(pipeline({ mode: 'stride', step: 2 })).nodes['smp']?.issues ?? [],
    ).toEqual([])
  })

  /*
   * A node stored without a key — an older file, a hand edit, an assistant plan — is keyed on the
   * declared default (`normalizeParams`), so that is what it has to compute. It used to read
   * `count ?? 0` and answer an empty table under a key that said a hundred rows.
   */
  it('reads an absent count, step or seed as its declared default', async () => {
    const all = await rows(pipeline({ mode: 'head', count: 1_000_000 }))
    const absent = (params: Record<string, unknown>): CodaGraph => {
      const graph = pipeline(params)
      const stored = graph.nodes.find((n) => n.id === 'smp')!.params as Record<string, unknown>
      for (const key of ['count', 'step', 'seed']) delete stored[key]
      return graph
    }
    expect(await rows(absent({ mode: 'head' }))).toEqual(all.slice(0, 100))
    expect(await rows(absent({ mode: 'stride' }))).toEqual(all.filter((_, i) => i % 10 === 0))
    expect(await rows(absent({ mode: 'random' }))).toEqual(
      await rows(pipeline({ mode: 'random', count: 100, seed: 1 })),
    )
  })
})

describe('core.sample — provenance', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = makeScheduler()
  })

  it('reproduces a draw across sessions, which is what the cache key stands for', async () => {
    const graph = pipeline({ mode: 'random', count: 6, seed: 42 })
    expect(await rows(graph)).toEqual(await rows(graph, makeScheduler()))
  })

  it('a new seed is a new result, and re-runs to get it', async () => {
    const graph = pipeline({ mode: 'random', count: 6, seed: 42 })
    const first = await rows(graph, scheduler)

    const reseeded = setNodeParam(graph, 'smp', 'seed', 43)
    scheduler.refreshStates(reseeded)
    expect(scheduler.info('smp').state).toBe('stale')

    const summary = await scheduler.run(reseeded, { mode: 'full' })
    expect(summary.executed).toContain('smp')
    const second = scheduler.output('smp', 'out')
    if (!isTableValue(second)) throw new Error('expected a table')
    expect((second.data['neuronId'] ?? []).map(Number)).not.toEqual(first)
  })

  it('the seed costs nothing while the mode it belongs to is not chosen', async () => {
    // `visibleIf` keeps a hidden param out of the key. Without that, bumping a seed nobody
    // can see would stale a Top-N sample and everything downstream of it.
    const graph = pipeline({ mode: 'head', count: 5 })
    await scheduler.run(graph, { mode: 'full' })

    const reseeded = setNodeParam(graph, 'smp', 'seed', 99)
    scheduler.refreshStates(reseeded)
    expect(scheduler.info('smp').state).toBe('ok')
    expect((await scheduler.run(reseeded, { mode: 'full' })).executed).toEqual([])
  })
})
