import { beforeEach, describe, expect, it } from 'vitest'

import { MockSource } from '../data/mock/MockSource'
import type { DataSource } from '../data/source'
import '../nodes'
import type { CodaGraph, GraphNode } from './graph'
import { addEdge, addNode, emptyGraph, setNodeParam } from './graph'
import { inferGraph } from './inference'
import { T, column, tableSchema } from './types'
import { defaultParams } from './node'
import { registerNode, requireNodeDef } from './registry'
import { Scheduler } from './scheduler'
import { isTableValue, tableFromRows } from './values'

/** Zero-latency source so tests don't wait on the simulated round trip. */
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
  const def = requireNodeDef(type)
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(def), ...params } as GraphNode['params'],
  }
}

/** dataset -> findNeurons(LC.*) -> filter(size >= 0) -> table */
function pipeline(): CodaGraph {
  let g = emptyGraph('scheduler-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*', status: 'Traced' }))
  g = addNode(g, node('filter', 'core.filter', { column: 'size', op: 'ge', value: '0' }))
  g = addNode(g, node('view', 'out.table'))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'filter',
    targetHandle: 'in',
  })
  g = addEdge(g, { source: 'filter', sourceHandle: 'out', target: 'view', targetHandle: 'in' })
  return g
}

describe('hybrid evaluation', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = makeScheduler()
  })

  it('runs cheap nodes but defers expensive ones in auto mode', async () => {
    const graph = pipeline()
    const summary = await scheduler.run(graph, { mode: 'auto' })

    // Dataset is cheap and runs; findNeurons is expensive and waits for Run.
    expect(summary.executed).toEqual(['ds'])
    expect(summary.deferred).toEqual(['find'])
    expect(scheduler.info('ds').state).toBe('ok')
    expect(scheduler.info('find').state).toBe('stale')
    // Downstream of a deferred node cannot run — it has no input.
    expect(scheduler.info('filter').state).toBe('blocked')
    expect(scheduler.info('view').state).toBe('blocked')
  })

  it('runs everything in full mode', async () => {
    const graph = pipeline()
    const summary = await scheduler.run(graph, { mode: 'full' })

    expect(summary.failed).toEqual([])
    expect(summary.executed).toEqual(['ds', 'find', 'filter', 'view'])
    for (const id of ['ds', 'find', 'filter', 'view']) {
      expect(scheduler.info(id).state, id).toBe('ok')
    }

    const out = scheduler.output('view', 'out')
    expect(isTableValue(out)).toBe(true)
    if (isTableValue(out)) {
      expect(out.length).toBeGreaterThan(0)
      // Only LC* types survived the query.
      const types = new Set(out.data.type as string[])
      for (const t of types) expect(t.startsWith('LC')).toBe(true)
    }
  })

  it('reuses the cache when nothing changed', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })
    const second = await scheduler.run(graph, { mode: 'full' })
    expect(second.executed).toEqual([])
  })

  it('re-runs only the affected subtree after a cheap param change', async () => {
    let graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    graph = setNodeParam(graph, 'filter', 'value', '400000')
    const summary = await scheduler.run(graph, { mode: 'auto' })

    // The expensive query is untouched; only filter and its dependent re-execute.
    expect(summary.executed).toEqual(['filter', 'view'])
    expect(scheduler.info('find').state).toBe('ok')

    const out = scheduler.output('view', 'out')
    if (!isTableValue(out)) throw new Error('expected a table')
    for (const size of out.data.size as number[]) expect(size).toBeGreaterThanOrEqual(400_000)
  })

  it('marks the downstream chain stale/blocked when an expensive param changes', async () => {
    let graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    graph = setNodeParam(graph, 'find', 'typePattern', 'T4.*')
    scheduler.refreshStates(graph)

    expect(scheduler.info('find').state).toBe('stale')
    expect(scheduler.info('filter').state).toBe('blocked')
    expect(scheduler.info('ds').state).toBe('ok')
  })

  it('restores cache validity when a param change is undone', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    const changed = setNodeParam(graph, 'find', 'typePattern', 'T4.*')
    scheduler.refreshStates(changed)
    expect(scheduler.info('find').state).toBe('stale')

    // Provenance keys are content-independent, so reverting makes the old entry valid
    // again with no re-execution. This is what makes undo cheap.
    scheduler.refreshStates(graph)
    expect(scheduler.info('find').state).toBe('ok')
    const summary = await scheduler.run(graph, { mode: 'full' })
    expect(summary.executed).toEqual([])
  })

  it('reports an evaluation failure on the offending node and blocks downstream', async () => {
    let graph = pipeline()
    graph = setNodeParam(graph, 'filter', 'value', 'not-a-number')
    const summary = await scheduler.run(graph, { mode: 'full' })

    expect(summary.failed).toEqual(['filter'])
    expect(scheduler.info('filter').state).toBe('error')
    expect(scheduler.info('filter').error).toMatch(/not a number/)
    expect(scheduler.info('view').state).toBe('blocked')
  })

  it('does not execute a node with unconnected required inputs', async () => {
    let graph = emptyGraph()
    graph = addNode(graph, node('filter', 'core.filter'))
    const summary = await scheduler.run(graph, { mode: 'full' })
    expect(summary.executed).toEqual([])
    expect(scheduler.info('filter').state).toBe('error')
    expect(scheduler.info('filter').error).toMatch(/not connected/)
  })

  it('skips disabled nodes and blocks their dependents', async () => {
    let graph = pipeline()
    graph = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === 'filter' ? { ...n, disabled: true } : n)),
    }
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.info('filter').state).toBe('disabled')
    expect(scheduler.info('view').state).toBe('blocked')
  })

  it('ignores presentational params in the cache key', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    // `pageSize` on out.table only changes how the result is displayed. If it entered the
    // provenance key, paging through a table would mark the node stale — and, worse,
    // invalidate everything downstream of it.
    const restyled = setNodeParam(graph, 'view', 'pageSize', '25')
    scheduler.refreshStates(restyled)
    expect(scheduler.info('view').state).toBe('ok')

    const summary = await scheduler.run(restyled, { mode: 'full' })
    expect(summary.executed).toEqual([])
    expect(scheduler.output('view', 'out')).toBeDefined()
  })

  it('still keys on params that change the output', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })
    // Contrast with the test above: `value` on the filter is not presentational.
    const changed = setNodeParam(graph, 'filter', 'value', '999')
    scheduler.refreshStates(changed)
    expect(scheduler.info('filter').state).toBe('stale')
  })

  it('limits a targeted run to the node and its ancestors', async () => {
    const graph = pipeline()
    const summary = await scheduler.run(graph, { mode: 'full', targets: ['filter'] })
    expect(summary.executed).toEqual(['ds', 'find', 'filter'])
    expect(scheduler.info('view').state).not.toBe('ok')
  })
})

describe('schema propagation', () => {
  it('carries query schemas into downstream column pickers', () => {
    const inference = inferGraph(pipeline())
    const filterInput = inference.nodes.filter?.inputs.in
    expect(filterInput?.kind).toBe('neurons')
    const columns =
      filterInput && 'schema' in filterInput ? filterInput.schema?.columns : undefined
    expect(columns?.map((c) => c.name)).toEqual([
      'neuronId',
      'type',
      'instance',
      'status',
      'size',
      'pre',
      'post',
    ])
  })

  it('recomputes the output schema of a group-by from its params', () => {
    let graph = emptyGraph()
    graph = addNode(graph, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
    graph = addNode(graph, node('find', 'neuron.findNeurons'))
    graph = addNode(graph, node('conn', 'neuron.connectivity'))
    graph = addNode(
      graph,
      node('grp', 'core.groupBy', { by: ['postType'], agg: 'sum', value: 'weight' }),
    )
    graph = addEdge(graph, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'find',
      targetHandle: 'dataset',
    })
    graph = addEdge(graph, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'conn',
      targetHandle: 'dataset',
    })
    graph = addEdge(graph, {
      source: 'find',
      sourceHandle: 'neurons',
      target: 'conn',
      targetHandle: 'neurons',
    })
    graph = addEdge(graph, {
      source: 'conn',
      sourceHandle: 'connections',
      target: 'grp',
      targetHandle: 'in',
    })

    const out = inferGraph(graph).nodes.grp?.outputs.out
    const names =
      out && 'schema' in out
        ? out.schema?.columns.map((c) => `${c.name}:${c.dtype}`)
        : undefined
    expect(names).toEqual(['postType:str', 'n:i64', 'sum_weight:i64'])

    // Switching to mean changes the dtype of the aggregate column.
    const asMean = setNodeParam(graph, 'grp', 'agg', 'mean')
    const meanOut = inferGraph(asMean).nodes.grp?.outputs.out
    const meanNames =
      meanOut && 'schema' in meanOut ? meanOut.schema?.columns.map((c) => c.name) : undefined
    expect(meanNames).toEqual(['postType', 'n', 'mean_weight'])
  })

  it('flags a type-incompatible link as an error', () => {
    let graph = emptyGraph()
    graph = addNode(graph, node('ds', 'neuron.dataset'))
    graph = addNode(graph, node('norm', 'core.normalize'))
    graph = addEdge(graph, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'norm',
      targetHandle: 'in',
    })
    const issues = inferGraph(graph).nodes.norm?.issues ?? []
    expect(issues.some((i) => i.severity === 'error' && /Matrix/.test(i.message))).toBe(true)
  })
})

// ---------------------------------------------------------------------------

/**
 * Clear Cache — the second cache layer, and the one "Invalidate" never reached.
 *
 * Dropping a node's *result* makes it run again; it does not make the run reach the network,
 * because a fetching node reads through `loadCachedTable`, whose IndexedDB entry is keyed by what
 * was fetched rather than by the graph and is kept for a month. So Invalidate cleared the card
 * and the re-run answered in milliseconds with identical bytes — a control that looked like it
 * had worked. `ctx.refresh` is what crosses that gap, and these pin the four things about it that
 * are not obvious from its type.
 */
describe('clearing a node’s data cache', () => {
  let seen: boolean[] = []

  /*
   * Registered once, at collection: `registerNode` refuses a duplicate type, which is the right
   * rule for a registry a saved graph resolves against.
   */
  for (const cost of ['cheap', 'expensive'] as const) {
    registerNode({
      type: `test.refresh.${cost}`,
      label: `refresh ${cost}`,
      category: 'utility',
      cost,
      dataCache: true,
      inputs: [],
      outputs: [{ id: 'out', label: 'Out', type: T.table() }],
      inferOutputs: () => ({ out: T.table() }),
      evaluate: (ctx) => {
        seen.push(ctx.refresh)
        return { out: tableFromRows(tableSchema(column('x', 'i64')), [{ x: 1 }]) }
      },
    })
  }

  /** A one-node graph over the recorder of the given cost. */
  function recorder(cost: 'cheap' | 'expensive') {
    const type = `test.refresh.${cost}`
    let g = emptyGraph('refresh-test')
    g = addNode(g, { id: 'n', type, position: { x: 0, y: 0 }, params: {} })
    return { type, graph: g }
  }

  beforeEach(() => {
    seen = []
  })

  it('is false on an ordinary run, so nothing re-fetches by accident', async () => {
    const { graph } = recorder('cheap')
    const sched = makeScheduler()
    await sched.run(graph, { mode: 'full' })
    expect(seen).toEqual([false])
  })

  it('reaches the next execution, and is spent once', async () => {
    const { graph } = recorder('cheap')
    const sched = makeScheduler()
    await sched.run(graph, { mode: 'full' })

    sched.clearNodeCache(graph, 'n')
    await sched.run(graph, { mode: 'full' })
    // Invalidated as well as flagged, or there would be nothing to re-run: a fresh result is
    // served from the scheduler's own cache without `evaluate` being called at all.
    expect(seen).toEqual([false, true])

    // Spent. A request that stuck would make every later run re-download, which on a 79 MB
    // annotation base is a twenty-second wait somebody asked for exactly once.
    sched.invalidateNode(graph, 'n')
    await sched.run(graph, { mode: 'full' })
    expect(seen).toEqual([false, true, false])
  })

  it('survives a pass that defers the node, rather than being spent by it', async () => {
    /*
     * The reason the flag is spent at *execution* rather than at the top of a run. An expensive
     * node is deferred by the cheap pass, which is the pass that fires on every keystroke — so a
     * request cleared there would be gone before the node ever got its chance, and Clear Cache
     * would work or not depending on whether anybody typed in between.
     */
    const { graph } = recorder('expensive')
    const sched = makeScheduler()
    sched.clearNodeCache(graph, 'n')

    await sched.run(graph, { mode: 'auto' })
    expect(seen).toEqual([])

    await sched.run(graph, { mode: 'full' })
    expect(seen).toEqual([true])
  })

  it('does not outlive the node it was asked for', async () => {
    // Ids are reused across loads, so a pending request left behind by a deleted node would be
    // spent by whatever took its place — a re-download nobody asked for, on a different node.
    const { graph, type } = recorder('cheap')
    const sched = makeScheduler()
    sched.clearNodeCache(graph, 'n')

    // What the store does on any graph change, including a delete.
    sched.refreshStates(emptyGraph('empty'))

    let replaced = emptyGraph('refresh-test')
    replaced = addNode(replaced, { id: 'n', type, position: { x: 0, y: 0 }, params: {} })
    await sched.run(replaced, { mode: 'full' })
    expect(seen).toEqual([false])
  })
})
