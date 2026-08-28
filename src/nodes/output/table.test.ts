/**
 * The Table node's contract, now that it has two ports doing two different things.
 *
 * The property that carries the design is invisible in the widget: `Table` is a tap and
 * `Filtered` is not, so a filter is *data* and has to reach the provenance key, while a page
 * size and the filter row's own visibility must not. Get either wrong and the symptom is a
 * graph that goes stale when somebody changes a page size, or a `Filtered` port whose rows
 * silently disagree with the table drawn above it — neither of which fails a type check.
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
import { encodeClauses } from '../lib/tableFilter'
import '../index'
import { defaultOutputPorts } from '../../core/ports'

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

const filters = (...pairs: Array<[string, string]>) =>
  encodeClauses(pairs.map(([column, expression]) => ({ column, expression })))

/** dataset → find(LC.*) → table */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('table-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*', status: 'Traced' }))
  g = addNode(g, node('tbl', 'out.table', params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'tbl',
    targetHandle: 'in',
  })
  return g
}

describe('out.table — types', () => {
  it('advertises both ports as what arrived, kind included', () => {
    // A subset of neurons is still neurons: downgrading either port to Table would cost every
    // node after it the neuronId guarantee its column pickers rely on.
    const inference = inferGraph(pipeline())
    expect(inference.nodes['tbl']?.outputs['out']?.kind).toBe('neurons')
    expect(inference.nodes['tbl']?.outputs['filtered']?.kind).toBe('neurons')
    expect(
      schemaOf(inference.nodes['tbl']?.outputs['filtered'])?.columns.map((c) => c.name),
    ).toContain('type')
  })

  /**
   * Second, so every graph saved before the port existed keeps its socket position and a link
   * dragged off the node still starts at the pass-through.
   */
  it('keeps Table as the first output', () => {
    const def = requireNodeDef('out.table')
    expect(defaultOutputPorts(def).map((p) => p.id)).toEqual(['out', 'filtered'])
  })
})

describe('out.table — evaluate', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = makeScheduler()
  })

  it('passes the input through untouched on Table', async () => {
    await scheduler.run(pipeline(), { mode: 'full' })
    expect(scheduler.output('tbl', 'out')).toBe(scheduler.output('find', 'neurons'))
  })

  it('carries the same table on Filtered when nothing is filtered', async () => {
    // Identity rather than a copy: nothing was cut, so there is nothing to allocate.
    await scheduler.run(pipeline(), { mode: 'full' })
    expect(scheduler.output('tbl', 'filtered')).toBe(scheduler.output('find', 'neurons'))
  })

  it('emits only the matching rows on Filtered, leaving Table whole', async () => {
    await scheduler.run(pipeline({ filters: filters(['type', '==LC4']) }), { mode: 'full' })
    const all = scheduler.output('tbl', 'out')
    const some = scheduler.output('tbl', 'filtered')
    if (!isTableValue(all) || !isTableValue(some)) throw new Error('expected tables')

    expect(some.length).toBeGreaterThan(0)
    expect(some.length).toBeLessThan(all.length)
    expect(new Set(some.data['type'] as string[])).toEqual(new Set(['LC4']))
    // The tap is still a tap.
    expect(all.length).toBe((scheduler.output('find', 'neurons') as typeof all).length)
    expect(some.kind).toBe('neurons')
  })

  /**
   * A control nobody has finished typing must not block the graph. `out.table` is a tap, so a
   * refusal here reaches every node downstream of the *pass-through* as well — invariant 5's
   * corollary in the place it costs most.
   */
  it('runs rather than throwing when a clause cannot be applied', async () => {
    const summary = await scheduler.run(
      pipeline({ filters: filters(['nosuch', '>1'], ['type', '~^LC[']) }),
      { mode: 'full' },
    )
    expect(summary.failed).toEqual([])
    expect(summary.executed).toContain('tbl')
    expect(scheduler.info('tbl').state).toBe('ok')
    // Unapplied, so nothing is cut — a broken clause shows more rows, never fewer.
    expect(scheduler.output('tbl', 'filtered')).toBe(scheduler.output('find', 'neurons'))
  })

  it('reports what it could not apply, on the node', () => {
    const issues =
      inferGraph(pipeline({ filters: filters(['nosuch', '>1']) })).nodes['tbl']?.issues ?? []
    expect(issues.map((i) => i.message)).toEqual([
      'Filter on "nosuch": the table has no such column',
    ])
  })
})

describe('out.table — provenance', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = makeScheduler()
  })

  /**
   * The three flags, asserted through the scheduler rather than by reading the definition,
   * because that is where getting one wrong actually shows up.
   */
  it('reading is free — the page size and the filter row stale nothing', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.info('tbl').state).toBe('ok')

    const paged = setNodeParam(graph, 'tbl', 'pageSize', '25')
    scheduler.refreshStates(paged)
    expect(scheduler.info('tbl').state).toBe('ok')

    const shown = setNodeParam(paged, 'tbl', 'showFilters', true)
    scheduler.refreshStates(shown)
    expect(scheduler.info('tbl').state).toBe('ok')
  })

  it('filtering is a decision — it marks the node stale', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.info('tbl').state).toBe('ok')

    const filtered = setNodeParam(graph, 'tbl', 'filters', filters(['type', '==LC4']))
    scheduler.refreshStates(filtered)
    expect(scheduler.info('tbl').state).toBe('stale')
  })

  /**
   * The bill this design signs, stated so nobody is surprised by it later: a cache key is one
   * per *node*, so a filter reaches a chain hanging off the **pass-through** too, whose bytes
   * did not change. It lands as `blocked` rather than `stale` — that node's own key is
   * unchanged, and what stops it is the upstream one being stale — which is the same edge the
   * exporter's unwired/blocked split travels down. Same trade `out.network`'s filters make.
   */
  it('reaches a node wired to the untouched Table port as well', async () => {
    let graph = pipeline()
    graph = addNode(graph, node('sort', 'core.sort', { column: 'neuronId' }))
    graph = addEdge(graph, {
      source: 'tbl',
      sourceHandle: 'out',
      target: 'sort',
      targetHandle: 'in',
    })
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.info('sort').state).toBe('ok')

    const filtered = setNodeParam(graph, 'tbl', 'filters', filters(['type', '==LC4']))
    scheduler.refreshStates(filtered)
    expect(scheduler.info('tbl').state).toBe('stale')
    expect(scheduler.info('sort').state).toBe('blocked')
  })
})
