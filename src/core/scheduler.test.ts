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
import type { Value } from './values'
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

/**
 * Partial results published mid-run.
 *
 * The mechanism the 3D viewer streams through: a fetch node hands over what has arrived, the
 * value on its output port grows, and `ValuePreview`'s `out.viewer3d` branch — which reads its
 * *inputs* rather than its own output — draws it. Nothing downstream re-runs, which is the whole
 * reason this is cheap enough to do four times a second.
 *
 * What has to be true is the part that is easy to get wrong: a preview is **not** a cache entry.
 * A half-finished value stored under the node's provenance key would claim to be the answer for
 * that key, so a cancelled run would leave a scene that looks complete and that no later run
 * would even be scheduled to fix.
 */
describe('publishing a partial result', () => {
  const ROW = tableSchema(column('x', 'i64'))
  const rows = (n: number) => tableFromRows(ROW, Array.from({ length: n }, (_, x) => ({ x })))

  /** A node that publishes `steps` growing tables, then optionally throws. */
  function register(type: string, steps: number, fail = false) {
    registerNode({
      type,
      label: type,
      category: 'utility',
      cost: 'cheap',
      inputs: [],
      outputs: [{ id: 'out', label: 'Out', type: T.table() }],
      inferOutputs: () => ({ out: T.table() }),
      evaluate: (ctx) => {
        for (let n = 1; n <= steps; n++) {
          ctx.publish({ out: rows(n) })
          seen.push(rowCount(scheduler.output('n', 'out')))
        }
        if (fail) throw new Error('nope')
        return { out: rows(steps + 1) }
      },
    })
  }

  const rowCount = (value: Value | undefined) => (isTableValue(value) ? value.length : -1)

  let scheduler: Scheduler
  let seen: number[]

  function graphOver(type: string): CodaGraph {
    return addNode(emptyGraph('publish-test'), { id: 'n', type, position: { x: 0, y: 0 }, params: {} })
  }

  beforeEach(() => {
    scheduler = makeScheduler()
    seen = []
  })

  it('shows what has been published while the node is still running', async () => {
    register('test.publish.growing', 3)
    const g = graphOver('test.publish.growing')
    await scheduler.run(g, { mode: 'full' })
    // Read from inside `evaluate`, which is the only moment a preview is the visible value.
    expect(seen).toEqual([1, 2, 3])
  })

  it('hands over to the real result the moment the node settles', async () => {
    register('test.publish.settles', 2)
    const g = graphOver('test.publish.settles')
    await scheduler.run(g, { mode: 'full' })
    // Three rows, not the two the last publish carried.
    expect(rowCount(scheduler.output('n', 'out'))).toBe(3)
  })

  it('drops a partial when the run fails rather than leaving it on screen', async () => {
    /*
     * The geometry is still in `geometryCache`, so the next run redraws it at once — but a
     * half-filled scene standing next to an `error` badge, with nothing saying which half, is
     * exactly the "looks complete but isn't" failure the previews map exists to avoid.
     */
    register('test.publish.fails', 2, true)
    const g = graphOver('test.publish.fails')
    await scheduler.run(g, { mode: 'full' })
    expect(scheduler.info('n').state).toBe('error')
    expect(scheduler.output('n', 'out')).toBeUndefined()
  })
})

/**
 * The warning channel: `ctx.warn`, and where what it says lives afterwards.
 *
 * The behaviour worth pinning is not that a string comes back — it is *when*. A guard rail's
 * whole value is that it speaks before the expensive part, next to a Cancel button, and that
 * what it said stays attached to the result rather than to the run that produced it. Both of
 * those are easy to lose to a refactor and neither shows up in a type.
 */
describe('what a node warns about', () => {
  function register(type: string, opts: { twice?: boolean; fail?: boolean } = {}): void {
    registerNode({
      type,
      label: type,
      category: 'utility',
      cost: 'cheap',
      inputs: [],
      outputs: [{ id: 'out', label: 'Out', type: T.table() }],
      inferOutputs: () => ({ out: T.table() }),
      evaluate: (ctx) => {
        ctx.warn('this is large')
        if (opts.twice) ctx.warn('this is large')
        // Read back from inside `evaluate`: the point of the live map is that the card can
        // show this while the node is still working.
        heardWhileRunning = scheduler.warning('n')
        if (opts.fail) throw new Error('nope')
        return { out: tableFromRows(tableSchema(column('a', 'i64')), [{ a: 1 }]) }
      },
    })
  }

  let scheduler: Scheduler
  let heardWhileRunning: string | undefined

  const graphOver = (type: string): CodaGraph =>
    addNode(emptyGraph('warn-test'), { id: 'n', type, position: { x: 0, y: 0 }, params: {} })

  beforeEach(() => {
    scheduler = makeScheduler()
    heardWhileRunning = undefined
  })

  it('is readable while the node is still running', async () => {
    register('test.warn.live')
    await scheduler.run(graphOver('test.warn.live'), { mode: 'full' })
    expect(heardWhileRunning).toBe('this is large')
  })

  it('stays with the result, so a run that answers from cache still carries it', async () => {
    register('test.warn.cached')
    const g = graphOver('test.warn.cached')
    await scheduler.run(g, { mode: 'full' })
    await scheduler.run(g, { mode: 'full' })
    // Nothing re-ran the second time; the caveat is about the value, not about the run.
    expect(scheduler.warning('n')).toBe('this is large')
    expect(scheduler.info('n').state).toBe('ok')
  })

  it('collapses repeats, so a warning raised in a loop says its piece once', async () => {
    register('test.warn.repeats', { twice: true })
    await scheduler.run(graphOver('test.warn.repeats'), { mode: 'full' })
    expect(scheduler.warning('n')).toBe('this is large')
  })

  it('is dropped when the run fails, where the error is the only thing worth reading', async () => {
    register('test.warn.fails', { fail: true })
    await scheduler.run(graphOver('test.warn.fails'), { mode: 'full' })
    expect(scheduler.info('n').state).toBe('error')
    expect(scheduler.warning('n')).toBeUndefined()
  })

  it('says nothing for a node that warned about nothing', async () => {
    await scheduler.run(pipeline(), { mode: 'full' })
    expect(scheduler.warning('filter')).toBeUndefined()
  })
})

/**
 * Loops.
 *
 * The properties that matter are the ones whose failure does not look like a failure: a region
 * that runs the wrong number of times, a Collect that quietly holds only the last pass, a key
 * that never settles so the loop appears to hang, and an index that leaks into the document.
 */
describe('For Each', () => {
  /** Records every value it was handed, so a test can assert what the region actually saw. */
  function recorder(type: string, options: { failOn?: number } = {}) {
    const seen: string[] = []
    registerNode({
      type,
      label: type,
      category: 'utility',
      cost: 'cheap',
      inputs: [{ id: 'in', label: 'In', type: T.any() }],
      outputs: [{ id: 'out', label: 'Out', type: T.any() }],
      inferOutputs: (ctx) => ({ out: ctx.inputs.in ?? T.any() }),
      evaluate: (ctx) => {
        const value = ctx.input('in')
        const ids = isTableValue(value)
          ? (value.data['id'] ?? []).map((c) => String(c)).join('+')
          : ''
        if (options.failOn !== undefined && ctx.iteration?.index === options.failOn) {
          throw new Error('this element is bad')
        }
        seen.push(ids)
        return { out: value! }
      },
    })
    return seen
  }

  const SCHEMA = tableSchema(column('id', 'str'), column('type', 'str'))

  const rowCount2 = (v: Value | undefined) => (isTableValue(v) ? v.length : -1)

  /** A table of `n` rows, `id` = "1".."n", `type` alternating A/B. */
  function rows(n: number) {
    return tableFromRows(
      SCHEMA,
      Array.from({ length: n }, (_, i) => ({ id: String(i + 1), type: i % 2 ? 'B' : 'A' })),
    )
  }

  function source(type: string, n: number) {
    registerNode({
      type,
      label: type,
      category: 'utility',
      cost: 'cheap',
      inputs: [],
      outputs: [{ id: 'out', label: 'Out', type: T.table(SCHEMA) }],
      inferOutputs: () => ({ out: T.table(SCHEMA) }),
      evaluate: () => ({ out: rows(n) }),
    })
  }

  /** `src -> forEach -> body [-> collect]`, with `body` recording what each pass saw. */
  function loopGraph(
    srcType: string,
    bodyType: string,
    options: { collect?: boolean; params?: Record<string, unknown> } = {},
  ): CodaGraph {
    let g = emptyGraph('loop-test')
    g = addNode(g, { id: 'src', type: srcType, position: { x: 0, y: 0 }, params: {} })
    g = addNode(g, node('loop', 'flow.forEach', options.params ?? {}))
    g = addNode(g, { id: 'body', type: bodyType, position: { x: 0, y: 0 }, params: {} })
    g = addEdge(g, { source: 'src', sourceHandle: 'out', target: 'loop', targetHandle: 'in' })
    g = addEdge(g, { source: 'loop', sourceHandle: 'item', target: 'body', targetHandle: 'in' })
    if (options.collect) {
      g = addNode(g, node('sink', 'flow.collect'))
      g = addEdge(g, { source: 'body', sourceHandle: 'out', target: 'sink', targetHandle: 'in' })
    }
    return g
  }

  it('runs the region once per element, in order', async () => {
    source('test.loop.src3', 3)
    const seen = recorder('test.loop.body3')
    const summary = await makeScheduler().run(loopGraph('test.loop.src3', 'test.loop.body3'), {
      mode: 'full',
    })
    expect(seen).toEqual(['1', '2', '3'])
    expect(summary.iterations).toBe(3)
    // A set of ids, so the body appears once however many times it ran — which is exactly why
    // `loopNodes` has to exist for anything acting on a finished run.
    expect(summary.executed.filter((id) => id === 'body')).toHaveLength(1)
    expect(summary.loopNodes).toContain('body')
  })

  it('runs once per group when grouping by a column', async () => {
    source('test.loop.srcG', 4)
    const seen = recorder('test.loop.bodyG')
    await makeScheduler().run(
      loopGraph('test.loop.srcG', 'test.loop.bodyG', {
        params: { mode: 'group', groupBy: 'type' },
      }),
      { mode: 'full' },
    )
    // Two passes, not four: rows 1 and 3 are type A, rows 2 and 4 are type B.
    expect(seen).toEqual(['1+3', '2+4'])
  })

  it('stops after First N without touching the rest', async () => {
    source('test.loop.srcLimit', 10)
    const seen = recorder('test.loop.bodyN')
    await makeScheduler().run(
      loopGraph('test.loop.srcLimit', 'test.loop.bodyN', { params: { limit: 2 } }),
      { mode: 'full' },
    )
    expect(seen).toEqual(['1', '2'])
  })

  /**
   * A batched loop, end to end: fewer passes, each carrying several elements, and a `Collect`
   * that still ends up holding every one of them.
   *
   * This is the loop's answer to parallelism. Threads are the wrong tool — the work is
   * I/O-bound and the main thread is idle during a fetch — but a pass carrying twenty elements
   * hands twenty ids to a backend that already fetches six at a time, where a pass carrying one
   * hands it one.
   */
  it('carries several elements per pass when batched, and collects them all', async () => {
    source('test.loop.srcB', 5)
    const seen = recorder('test.loop.bodyB')
    const scheduler = makeScheduler()
    const g = loopGraph('test.loop.srcB', 'test.loop.bodyB', {
      collect: true,
      params: { batch: 2 },
    })
    const summary = await scheduler.run(g, { mode: 'full' })

    // Three passes over five elements, the last one short.
    expect(seen).toEqual(['1+2', '3+4', '5'])
    expect(summary.iterations).toBe(3)
    const collected = scheduler.output('sink', 'out')
    expect(isTableValue(collected) ? collected.data['id'] : []).toEqual(['1', '2', '3', '4', '5'])
  })

  it('tells the host how many elements a pass carried', async () => {
    source('test.loop.srcBS', 5)
    recorder('test.loop.bodyBS')
    const heard: number[] = []
    const scheduler = new Scheduler({
      resolveSource: () => source as never,
      onIteration: (info) => {
        heard.push(info.size)
      },
    })
    await scheduler.run(
      loopGraph('test.loop.srcBS', 'test.loop.bodyBS', { params: { batch: 2 } }),
      { mode: 'full' },
    )
    // The short last pass reports its real size, which is what stops a filename claiming twenty.
    expect(heard).toEqual([2, 2, 1])
  })

  it('collects every pass rather than the last one', async () => {
    source('test.loop.srcC', 3)
    recorder('test.loop.bodyC')
    const scheduler = makeScheduler()
    await scheduler.run(loopGraph('test.loop.srcC', 'test.loop.bodyC', { collect: true }), {
      mode: 'full',
    })
    const collected = scheduler.output('sink', 'out')
    expect(isTableValue(collected) ? collected.length : -1).toBe(3)
    expect(isTableValue(collected) ? collected.data['id'] : []).toEqual(['1', '2', '3'])
  })

  /**
   * The failure that reads as a hang rather than as a wrong answer.
   *
   * Every node in the region is re-keyed by each pass, Collect included. If the index it settles
   * on and the index `refreshStates` computes afterwards disagree, the loop finishes and the
   * graph immediately reports itself stale — so Run does the whole thing again, for ever.
   */
  it('settles: a second Run over an unchanged graph iterates nothing', async () => {
    source('test.loop.srcS', 3)
    const seen = recorder('test.loop.bodyS')
    const scheduler = makeScheduler()
    const g = loopGraph('test.loop.srcS', 'test.loop.bodyS', { collect: true })
    await scheduler.run(g, { mode: 'full' })
    scheduler.refreshStates(g)
    expect(scheduler.info('loop').state).toBe('ok')
    expect(scheduler.info('sink').state).toBe('ok')

    seen.length = 0
    const again = await scheduler.run(g, { mode: 'full' })
    expect(seen).toEqual([])
    expect(again.iterations).toBe(0)
  })

  it('leaves the document untouched — the index is session state, not a param', async () => {
    source('test.loop.srcD', 4)
    recorder('test.loop.bodyD')
    const g = loopGraph('test.loop.srcD', 'test.loop.bodyD')
    const before = JSON.stringify(g)
    await makeScheduler().run(g, { mode: 'full' })
    expect(JSON.stringify(g)).toBe(before)
  })

  it('carries on past a failing element and says how many failed', async () => {
    source('test.loop.srcF', 4)
    const seen = recorder('test.loop.bodyF', { failOn: 1 })
    const scheduler = makeScheduler()
    await scheduler.run(loopGraph('test.loop.srcF', 'test.loop.bodyF'), { mode: 'full' })
    // Three of four still ran: abandoning them is the refusal docs/limits.md argues against.
    expect(seen).toEqual(['1', '3', '4'])
    expect(scheduler.warning('loop')).toMatch(/1 of 4 failed/)
  })

  it('is deferred whole by the auto pass, so no keystroke fires a loop', async () => {
    source('test.loop.srcA', 3)
    const seen = recorder('test.loop.bodyA')
    const summary = await makeScheduler().run(loopGraph('test.loop.srcA', 'test.loop.bodyA'), {
      mode: 'auto',
    })
    expect(seen).toEqual([])
    expect(summary.deferred).toContain('loop')
  })

  /**
   * A loop stopped part way must not be mistaken for one that finished.
   *
   * Freshness describes a *pass*: cancel at element two and every region entry answers the key
   * for the pass that completed, with `loopIndex` sitting at 1. Without a record of *finishing*,
   * the next Run settles the loop untouched and elements three and four are silently never
   * processed — a green graph that skipped half its work.
   */
  it('re-runs from the start after a cancel, rather than settling', async () => {
    source('test.loop.srcX', 4)
    const seen: string[] = []
    const scheduler = makeScheduler()
    let stopAt: number | undefined = 1
    registerNode({
      type: 'test.loop.bodyX',
      label: 'bodyX',
      category: 'utility',
      cost: 'cheap',
      inputs: [{ id: 'in', label: 'In', type: T.any() }],
      outputs: [{ id: 'out', label: 'Out', type: T.any() }],
      inferOutputs: (ctx) => ({ out: ctx.inputs.in ?? T.any() }),
      evaluate: (ctx) => {
        const value = ctx.input('in')
        seen.push(isTableValue(value) ? String(value.data['id']?.[0]) : '?')
        // Cancel from inside the second pass, which is what a person pressing Cancel does.
        if (ctx.iteration?.index === stopAt) scheduler.cancel()
        return { out: value! }
      },
    })

    const g = loopGraph('test.loop.srcX', 'test.loop.bodyX')
    const first = await scheduler.run(g, { mode: 'full' })
    expect(seen).toEqual(['1', '2'])
    // Two elements were reached; only the first completed a pass, since the second was cancelled
    // inside the body and its result was dropped.
    expect(first.iterations).toBe(1)
    scheduler.refreshStates(g)

    stopAt = undefined
    seen.length = 0
    const again = await scheduler.run(g, { mode: 'full' })
    /*
     * Four passes, from the beginning — not "carry on from two" and not "nothing to do", which
     * is what a settled loop would have answered. `iterations` rather than `seen` is the measure:
     * element 1 legitimately answers from cache the second time round, so it is a pass that the
     * body did not have to execute.
     */
    expect(again.iterations).toBe(4)
    expect(seen).toEqual(['2', '3', '4'])
  })

  /**
   * A `Collect`'s other input is the previous pass's result, which is not in its key and cannot
   * be — so a cache hit must not answer for it mid-pass.
   *
   * The way in is any loop re-run over ground it has covered: cancel at element two, press Run,
   * and pass two hits the entry pass two left behind. It gets skipped, the accumulator is never
   * fed, and the total restarts — the loop finishes holding only its own tail, every node `ok`.
   */
  it('never answers a loop exit from cache mid-pass, so the fold cannot restart', async () => {
    source('test.loop.srcY', 3)
    const scheduler = makeScheduler()
    let cancelAt: number | undefined = 1
    registerNode({
      type: 'test.loop.bodyY',
      label: 'bodyY',
      category: 'utility',
      cost: 'cheap',
      inputs: [{ id: 'in', label: 'In', type: T.any() }],
      outputs: [{ id: 'out', label: 'Out', type: T.any() }],
      inferOutputs: (ctx) => ({ out: ctx.inputs.in ?? T.any() }),
      evaluate: (ctx) => {
        if (ctx.iteration?.index === cancelAt) scheduler.cancel()
        return { out: ctx.input('in')! }
      },
    })

    const g = loopGraph('test.loop.srcY', 'test.loop.bodyY', { collect: true })
    await scheduler.run(g, { mode: 'full' })
    cancelAt = undefined
    scheduler.refreshStates(g)
    await scheduler.run(g, { mode: 'full' })

    const collected = scheduler.output('sink', 'out')
    // Every element, in order. The bug produced ['2', '3'] — element 1 gone, nothing amiss.
    expect(isTableValue(collected) ? collected.data['id'] : []).toEqual(['1', '2', '3'])
  })

  /**
   * A loop inside a loop.
   *
   * `runLoop` used to dispatch its region through `executeNode`, which cannot start a loop — so
   * an inner `For Each` ran once per outer pass and read the *outer* loop's index as its own.
   * Both walks now go through `runNodes`, which is the only place that knows the ordering rule.
   */
  it('runs a loop inside a loop, every inner element against every outer one', async () => {
    source('test.loop.srcNest', 2)
    // Turns one row into three, so the inner loop has something of its own to iterate and the
    // cross product is visible rather than degenerate.
    registerNode({
      type: 'test.loop.fan',
      label: 'fan',
      category: 'utility',
      cost: 'cheap',
      inputs: [{ id: 'in', label: 'In', type: T.any() }],
      outputs: [{ id: 'out', label: 'Out', type: T.table(SCHEMA) }],
      inferOutputs: () => ({ out: T.table(SCHEMA) }),
      evaluate: (ctx) => {
        const value = ctx.input('in')
        const stem = isTableValue(value) ? String(value.data['id']?.[0] ?? '?') : '?'
        return {
          out: tableFromRows(
            SCHEMA,
            [0, 1, 2].map((i) => ({ id: `${stem}-${i}`, type: 'A' })),
          ),
        }
      },
    })
    const seen = recorder('test.loop.bodyNest')

    let g = emptyGraph('nested')
    g = addNode(g, { id: 'src', type: 'test.loop.srcNest', position: { x: 0, y: 0 }, params: {} })
    g = addNode(g, node('outer', 'flow.forEach'))
    g = addNode(g, { id: 'fan', type: 'test.loop.fan', position: { x: 0, y: 0 }, params: {} })
    g = addNode(g, node('inner', 'flow.forEach'))
    g = addNode(g, { id: 'body', type: 'test.loop.bodyNest', position: { x: 0, y: 0 }, params: {} })
    g = addEdge(g, { source: 'src', sourceHandle: 'out', target: 'outer', targetHandle: 'in' })
    g = addEdge(g, { source: 'outer', sourceHandle: 'item', target: 'fan', targetHandle: 'in' })
    g = addEdge(g, { source: 'fan', sourceHandle: 'out', target: 'inner', targetHandle: 'in' })
    g = addEdge(g, { source: 'inner', sourceHandle: 'item', target: 'body', targetHandle: 'in' })

    const summary = await makeScheduler().run(g, { mode: 'full' })
    /*
     * Two outer elements, three inner each. The bug ran the inner loop exactly once per outer
     * pass — `runLoop` dispatched its region through `executeNode`, which cannot start a loop —
     * so the body saw two elements and the inner `For Each` read the outer's index as its own.
     */
    expect(seen).toEqual(['1-0', '1-1', '1-2', '2-0', '2-1', '2-2'])
    // Two outer passes plus three inner passes per outer pass.
    expect(summary.iterations).toBe(8)
  })

  /**
   * Auto-run schedules `runFull`, so `mode` is `'full'` and the `cost: 'expensive'` deferral
   * never fired — any upstream edit re-iterated the whole loop 700ms later, which is exactly
   * what marking `For Each` expensive is documented to prevent.
   */
  it('defers a loop on an automatic run, whatever the mode says', async () => {
    source('test.loop.srcAuto', 3)
    const seen = recorder('test.loop.bodyAuto')
    const summary = await makeScheduler().run(
      loopGraph('test.loop.srcAuto', 'test.loop.bodyAuto'),
      { mode: 'full', automatic: true },
    )
    expect(seen).toEqual([])
    expect(summary.deferred).toContain('loop')
  })

  /** The failure report is a fact about the loop, so it survives the begin node's own throw. */
  it('still says how many elements failed when the loop node itself throws last', async () => {
    source('test.loop.srcW', 2)
    recorder('test.loop.bodyW', { failOn: 0 })
    const scheduler = makeScheduler()
    const g = loopGraph('test.loop.srcW', 'test.loop.bodyW')
    await scheduler.run(g, { mode: 'full' })
    // The begin node survives here; what is pinned is that the count is reported at all.
    expect(scheduler.warning('loop')).toMatch(/1 of 2 failed/)
  })

  it('tells the host about every pass, with the element named', async () => {
    source('test.loop.srcH', 3)
    recorder('test.loop.bodyH')
    const heard: string[] = []
    const scheduler = new Scheduler({
      resolveSource: () => source as never,
      onIteration: (info) => {
        heard.push(`${info.index}/${info.count}:${info.label}`)
      },
    })
    await scheduler.run(loopGraph('test.loop.srcH', 'test.loop.bodyH'), { mode: 'full' })
    // Labelled by the element's own name — what a progress line and a filename both need.
    expect(heard).toEqual(['0/3:A', '1/3:B', '2/3:A'])
  })

  /**
   * A loop runs at the position of the **last** node of its region, not at its begin node.
   *
   * With a body that also takes an input from *beside* the loop, triggering at the begin node
   * runs that body before the branch feeding it has been reached — so it sees nothing, or sees
   * a stale value, on every pass. Only shows up on graphs where the body reads something other
   * than the element, which is most real ones.
   */
  it('waits for a branch that joins the region from outside it', async () => {
    source('test.loop.srcJ', 2)
    source('test.loop.sideJ', 1)
    const seen: string[] = []
    registerNode({
      type: 'test.loop.joinJ',
      label: 'join',
      category: 'utility',
      cost: 'cheap',
      inputs: [
        { id: 'item', label: 'Item', type: T.any() },
        { id: 'side', label: 'Side', type: T.any() },
      ],
      outputs: [{ id: 'out', label: 'Out', type: T.any() }],
      inferOutputs: () => ({ out: T.table(SCHEMA) }),
      evaluate: (ctx) => {
        const item = ctx.input('item')
        const side = ctx.input('side')
        if (!isTableValue(side) || side.length !== 1) throw new Error('side branch was not ready')
        seen.push(isTableValue(item) ? String(item.data['id']?.[0]) : '?')
        return { out: item! }
      },
    })

    let g = emptyGraph('join-test')
    g = addNode(g, { id: 'src', type: 'test.loop.srcJ', position: { x: 0, y: 0 }, params: {} })
    g = addNode(g, node('loop', 'flow.forEach'))
    g = addNode(g, { id: 'join', type: 'test.loop.joinJ', position: { x: 0, y: 0 }, params: {} })
    // Added *after* the join, so the naive topological position of the loop's begin node comes
    // before this branch has run.
    g = addNode(g, { id: 'side', type: 'test.loop.sideJ', position: { x: 0, y: 0 }, params: {} })
    g = addEdge(g, { source: 'src', sourceHandle: 'out', target: 'loop', targetHandle: 'in' })
    g = addEdge(g, { source: 'loop', sourceHandle: 'item', target: 'join', targetHandle: 'item' })
    g = addEdge(g, { source: 'side', sourceHandle: 'out', target: 'join', targetHandle: 'side' })

    await makeScheduler().run(g, { mode: 'full' })
    expect(seen).toEqual(['1', '2'])
  })

  /**
   * An empty collection runs the region **once, on nothing** — not zero times.
   *
   * The tempting reading is "no passes, so nothing to do", and it is what left every node in the
   * region holding the *previous* run's results under an `ok` badge: the port went on carrying
   * last time's element with nothing saying the collection was now empty. So the region computes
   * honestly on an empty input, and `onIteration` — the side effects — does not fire, because no
   * element was iterated.
   */
  it('runs the region once on an empty collection, and writes nothing', async () => {
    source('test.loop.src0', 0)
    const seen = recorder('test.loop.body0')
    const heard: number[] = []
    const scheduler = new Scheduler({
      resolveSource: () => source as never,
      onIteration: (info) => {
        heard.push(info.index)
      },
    })
    await scheduler.run(loopGraph('test.loop.src0', 'test.loop.body0'), { mode: 'full' })
    // One pass over nothing, so the recorder saw an empty id list rather than nothing at all.
    expect(seen).toEqual([''])
    expect(heard).toEqual([])
    expect(scheduler.info('loop').state).toBe('ok')
  })

  /**
   * The stale half of the same bug, stated directly: a loop that had elements and now has none
   * must not leave the old ones on its port.
   */
  it('does not leave the last run’s element on the port when the input empties', async () => {
    let rowCount = 2
    registerNode({
      type: 'test.loop.shrinking',
      label: 'shrinking',
      category: 'utility',
      cost: 'cheap',
      inputs: [],
      outputs: [{ id: 'out', label: 'Out', type: T.table(SCHEMA) }],
      inferOutputs: () => ({ out: T.table(SCHEMA) }),
      evaluate: () => ({ out: rows(rowCount) }),
    })
    recorder('test.loop.bodyShrink')
    const scheduler = makeScheduler()
    const g = loopGraph('test.loop.shrinking', 'test.loop.bodyShrink')
    await scheduler.run(g, { mode: 'full' })
    expect(rowCount2(scheduler.output('loop', 'item'))).toBe(1)

    rowCount = 0
    scheduler.invalidateNode(g, 'src')
    await scheduler.run(g, { mode: 'full' })
    expect(rowCount2(scheduler.output('loop', 'item'))).toBe(0)
  })
})
