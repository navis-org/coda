/**
 * The Bar Chart node's contract.
 *
 * It had no node-level coverage at all — only the viewer's geometry in `viewers.test.tsx` —
 * which is how it kept the same refusal `out.scatter` was fixed for: `evaluate` threw when it
 * could not resolve a column, blocking everything downstream over a picture nobody could
 * configure yet. See invariant 5's corollary in CLAUDE.md.
 */

import { describe, expect, it } from 'vitest'

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

/** dataset → find → bar chart */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('bar-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { status: 'Traced' }))
  g = addNode(g, node('bar', 'out.barChart', params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'bar', targetHandle: 'in' })
  return g
}

/** dataset → find → groupBy → pivot → bar chart */
function pivoted(): CodaGraph {
  let g = emptyGraph('bar-pivot')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { status: 'Traced' }))
  g = addNode(
    g,
    node('grp', 'core.groupBy', { by: ['type', 'status'], agg: 'sum', value: 'pre' }),
  )
  g = addNode(
    g,
    node('piv', 'core.pivot', {
      rows: 'type',
      columns: 'status',
      agg: 'sum',
      value: 'sum_pre',
    }),
  )
  g = addNode(g, node('bar', 'out.barChart'))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'grp', targetHandle: 'in' })
  g = addEdge(g, { source: 'grp', sourceHandle: 'out', target: 'piv', targetHandle: 'in' })
  g = addEdge(g, { source: 'piv', sourceHandle: 'table', target: 'bar', targetHandle: 'in' })
  return g
}

function issues(graph: CodaGraph, id: string): string[] {
  return (inferGraph(graph).nodes[id]?.issues ?? []).map((issue) => issue.message)
}

describe('out.barChart — the tap', () => {
  it('passes the input through untouched', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline(), { mode: 'full' })
    expect(scheduler.output('bar', 'out')).toBe(scheduler.output('find', 'neurons'))
  })

  it('advertises the incoming schema before anything has run', () => {
    const names = schemaOf(inferGraph(pipeline()).nodes['bar']?.outputs['out'])?.columns.map(
      (c) => c.name,
    )
    expect(names).toContain('pre')
  })

  it('is cheap', () => {
    expect(requireNodeDef('out.barChart').cost).toBe('cheap')
  })
})

describe('out.barChart — an input whose schema is not known yet', () => {
  it('confirms the premise: the pivot advertises no schema before it runs', () => {
    // If pivot ever learns to infer its columns statically, the rest of this block tests
    // nothing.
    expect(schemaOf(inferGraph(pivoted()).nodes['bar']?.inputs['in'])).toBeUndefined()
  })

  it('says nothing rather than claiming the table has no numeric column', () => {
    expect(issues(pivoted(), 'bar')).toEqual([])
  })

  it('runs and passes the table on instead of blocking everything downstream', async () => {
    // The regression: this used to throw "No numeric column to plot" while holding a table
    // whose numeric column was sitting right there, so a reloaded `Pivot → Bar Chart` failed
    // on its first Run.
    const scheduler = makeScheduler()
    const summary = await scheduler.run(pivoted(), { mode: 'full' })
    expect(summary.executed).toContain('bar')
    expect(scheduler.info('bar').state).toBe('ok')
    expect(scheduler.output('bar', 'out')).toBe(scheduler.output('piv', 'table'))
  })

  it('resolves its columns once the run has published the schema', async () => {
    const graph = pivoted()
    const scheduler = makeScheduler()
    await scheduler.run(graph, { mode: 'full' })
    const produced = scheduler.output('piv', 'table')
    if (!isTableValue(produced)) throw new Error('expected a table')

    const warm = inferGraph(graph, { observedSchemas: { piv: produced.schema } })
    expect(schemaOf(warm.nodes['bar']?.inputs['in'])?.columns.map((c) => c.name)).toContain(
      'Traced',
    )
  })
})

describe('out.barChart — what it warns about', () => {
  /** dataset → find → select(columns) → bar chart */
  function narrowed(columns: string[]): CodaGraph {
    let g = pipeline()
    g = addNode(g, node('sel', 'core.select', { columns }))
    g = addEdge(g, {
      source: 'find',
      sourceHandle: 'neurons',
      target: 'sel',
      targetHandle: 'in',
    })
    g = { ...g, edges: g.edges.filter((e) => e.target !== 'bar') }
    return addEdge(g, { source: 'sel', sourceHandle: 'out', target: 'bar', targetHandle: 'in' })
  }

  it('leaves a table with nothing numeric to the shared column check', () => {
    // One fact, one message. The node used to add "No numeric column available to plot"
    // beside this, which is the same thing said twice on one badge.
    expect(issues(narrowed(['type']), 'bar')).toEqual([
      'No columns of type i64/f64 available for "Value"',
    ])
  })

  it('is a warning and not a refusal — the table still flows', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(narrowed(['type']), { mode: 'full' })
    expect(scheduler.info('bar').state).toBe('ok')
    expect(scheduler.output('bar', 'out')).toBe(scheduler.output('sel', 'out'))
  })

  it('still catches a stack that would draw one segment per bar', () => {
    // The one thing the resolver cannot see: stacking a column by itself is a legal pick and
    // a meaningless picture.
    let g = setNodeParam(pipeline(), 'bar', 'useSeries', true)
    g = setNodeParam(g, 'bar', 'category', 'type')
    g = setNodeParam(g, 'bar', 'series', 'type')
    expect(issues(g, 'bar')).toEqual(['Stack-by and Category are the same column'])
  })

  it('keeps quiet about the same pair while stacking is off', () => {
    let g = setNodeParam(pipeline(), 'bar', 'category', 'type')
    g = setNodeParam(g, 'bar', 'series', 'type')
    expect(issues(g, 'bar')).toEqual([])
  })
})
