/**
 * The Download node.
 *
 * The node itself does almost nothing, and that is the contract worth pinning. Writing a file is
 * a *side effect*, and the two places it obviously belongs are both wrong:
 *
 *  - **not in `evaluate`** — `src/nodes` is headless, and a cache hit means `evaluate` never
 *    runs, so a download performed there would fire on the first Run and silently not on the
 *    second;
 *  - **not on the 180ms pass** — a `cheap` node writes a file per keystroke, which is why this
 *    one is `expensive` for a reason that has nothing to do with how long it takes.
 *
 * The pass-through matters too: a Download dropped mid-chain must be invisible to everything
 * after it, in type and in value.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { columnNames, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import { mockDatasetIds } from '../../data/mock/generate'
import { registerSource, requireSource } from '../../data/source'
import '../index'

const DATASET = mockDatasetIds()[0]!

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

function makeScheduler(): Scheduler {
  return new Scheduler({ resolveSource: (id) => requireSource(id) })
}

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** dataset → find → download → sort, so the pass-through has something after it. */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('download-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('dl', 'out.download', params))
  g = addNode(g, node('sort', 'core.sort', { column: 'neuronId' }))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'dl', targetHandle: 'in' })
  g = addEdge(g, { source: 'dl', sourceHandle: 'out', target: 'sort', targetHandle: 'in' })
  return g
}

describe('out.download — the tap', () => {
  it('passes the value through by reference, not by copy', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline(), { mode: 'full' })
    // Identity, because a Download node dropped mid-chain has no business allocating a second
    // copy of a 165k-row table just by being there.
    expect(scheduler.output('dl', 'out')).toBe(scheduler.output('find', 'neurons'))
  })

  it('passes the type through untouched, Neurons included', () => {
    const inference = inferGraph(pipeline())
    const out = inference.nodes['dl']?.outputs['out']
    expect(out?.kind).toBe('neurons')
    expect(columnNames(schemaOf(out))).toContain('neuronId')
    // Which is the point: nothing after it can tell it is there.
    expect(columnNames(schemaOf(inference.nodes['sort']?.outputs['out']))).toContain('type')
  })

  it('accepts anything, because it does not care what it is carrying', () => {
    const def = requireNodeDef('out.download')
    expect(def.inputs?.[0]?.type.kind).toBe('any')
    // A Network is not a Table, and this is the only node in the tree that takes both.
    let g = emptyGraph('any')
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
    g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4' }))
    g = addNode(g, node('conn', 'neuron.connectivity', { direction: 'outputs' }))
    g = addNode(g, node('net', 'net.build'))
    g = addNode(g, node('dl', 'out.download'))
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
    g = addEdge(g, { source: 'net', sourceHandle: 'network', target: 'dl', targetHandle: 'in' })

    const issues = inferGraph(g).nodes['dl']?.issues ?? []
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(inferGraph(g).nodes['dl']?.outputs['out']?.kind).toBe('network')
  })
})

describe('out.download — when it runs', () => {
  it('is expensive, so it cannot write a file per keystroke', async () => {
    // Nothing here is slow. `cheap` re-runs on the 180ms pass after every edit, and a node
    // whose purpose is a side effect must never be on that pass.
    expect(requireNodeDef('out.download').cost).toBe('expensive')
    const scheduler = makeScheduler()
    const summary = await scheduler.run(pipeline(), { mode: 'auto' })
    expect(summary.executed).not.toContain('dl')
  })

  it('reports itself as executed exactly once for an unchanged graph', async () => {
    // This is the whole of what bounds "on every run": the driver watches `executed`, and a
    // Run over a graph nobody touched re-executes nothing, so it writes nothing.
    const scheduler = makeScheduler()
    const graph = pipeline()
    const first = await scheduler.run(graph, { mode: 'full' })
    expect(first.executed).toContain('dl')

    const second = await scheduler.run(graph, { mode: 'full' })
    expect(second.executed).not.toContain('dl')
  })

  it('re-executes when the data upstream actually changes', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline(), { mode: 'full' })
    let changed = pipeline()
    changed = {
      ...changed,
      nodes: changed.nodes.map((n) =>
        n.id === 'find' ? { ...n, params: { ...n.params, typePattern: 'LC6' } } : n,
      ),
    }
    expect((await scheduler.run(changed, { mode: 'full' })).executed).toContain('dl')
  })

  it('re-runs nothing at all when only its own settings change', async () => {
    /*
     * Every param here is `presentational`, because none of them can change what `evaluate`
     * returns — they decide what is *written*. Without that, renaming a file would invalidate
     * this node's key and, through it, the entire graph downstream: minutes of queries re-run
     * for a change to a string.
     *
     * The consequence, asserted rather than left implicit: changing a setting and pressing Run
     * writes nothing, because nothing re-executed. The card's button is what covers that.
     */
    const scheduler = makeScheduler()
    await scheduler.run(pipeline(), { mode: 'full' })

    for (const params of [
      { filename: 'lc4' },
      { format: 'json' },
      { timestamp: true },
      { onRun: false },
    ]) {
      const summary = await scheduler.run(pipeline(params), { mode: 'full' })
      expect(summary.executed).toEqual([])
    }
  })
})

describe('out.download — refusals', () => {
  it('blocks rather than emitting undefined with nothing connected', async () => {
    // The port is required so the scheduler blocks first; the throw exists because
    // `ctx.input` cannot know that, and an undefined output would fail somewhere else.
    let g = emptyGraph('empty')
    g = addNode(g, node('dl', 'out.download'))
    g = addNode(g, node('sort', 'core.sort'))
    g = addEdge(g, { source: 'dl', sourceHandle: 'out', target: 'sort', targetHandle: 'in' })

    const scheduler = makeScheduler()
    await scheduler.run(g, { mode: 'full' })
    // `error`, not `blocked`: an unconnected *required* port is the node's own problem, which
    // inference reports on it; `blocked` is what its downstream gets.
    expect(scheduler.info('dl').state).toBe('error')
    expect(scheduler.info('sort').state).toBe('blocked')
    expect(scheduler.output('dl', 'out')).toBeUndefined()
  })

  it('never writes anything from evaluate', async () => {
    // `evaluate` returns the input and touches nothing else. If a download were ever moved in
    // here it would fire once and then never again, because of the cache — and this is the
    // assertion that would fail rather than the behaviour quietly changing.
    const scheduler = makeScheduler()
    await scheduler.run(pipeline(), { mode: 'full' })
    const out = scheduler.output('dl', 'out')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.length).toBeGreaterThan(0)
  })
})
