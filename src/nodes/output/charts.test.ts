/**
 * The three label-shaped charts, as nodes.
 *
 * `out.histogram`, `out.pie` and `out.distribution` are one test file because they make one set
 * of claims: each is a **tap** whose `out` is the input unchanged, each resolves a selection
 * that is a *label or a range* rather than a set of row ids, and each has exactly one column
 * param that is deliberately **not** `presentational` — the one the selection is resolved
 * against. That last pair is the thing worth guarding: get it backwards and a stale downstream
 * result survives a change to the very column that decides which rows `Selected` carries
 * (invariant 4), with nothing failing to say so.
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

/** dataset → find → chart */
function pipeline(type: string, params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('chart-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { status: 'Traced' }))
  g = addNode(g, node('chart', type, params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'chart', targetHandle: 'in' })
  return g
}

/** dataset → find → groupBy → pivot → chart. The pivot publishes no schema until it has run. */
function pivoted(type: string): CodaGraph {
  let g = emptyGraph('chart-pivot')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { status: 'Traced' }))
  g = addNode(g, node('grp', 'core.groupBy', { by: ['type', 'status'], agg: 'sum', value: 'pre' }))
  g = addNode(
    g,
    node('piv', 'core.pivot', { rows: 'type', columns: 'status', agg: 'sum', value: 'sum_pre' }),
  )
  g = addNode(g, node('chart', type))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'grp', targetHandle: 'in' })
  g = addEdge(g, { source: 'grp', sourceHandle: 'out', target: 'piv', targetHandle: 'in' })
  g = addEdge(g, { source: 'piv', sourceHandle: 'table', target: 'chart', targetHandle: 'in' })
  return g
}

function issues(graph: CodaGraph, id: string): string[] {
  return (inferGraph(graph).nodes[id]?.issues ?? []).map((issue) => issue.message)
}

const TYPES = ['out.histogram', 'out.pie', 'out.distribution'] as const

describe.each(TYPES)('%s — the tap', (type) => {
  it('passes the input through untouched', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline(type), { mode: 'full' })
    expect(scheduler.output('chart', 'out')).toBe(scheduler.output('find', 'neurons'))
  })

  it('advertises the incoming schema before anything has run', () => {
    const names = schemaOf(inferGraph(pipeline(type)).nodes['chart']?.outputs['out'])?.columns.map(
      (c) => c.name,
    )
    expect(names).toContain('pre')
  })

  it('keeps neurons-ness on Selected, so a subset plugs straight back in', () => {
    const inferred = inferGraph(pipeline(type)).nodes['chart']
    expect(inferred?.outputs['selected']?.kind).toBe('neurons')
  })

  it('is cheap', () => {
    expect(requireNodeDef(type).cost).toBe('cheap')
  })

  it('runs and passes the table on where the schema has not arrived yet', async () => {
    // A reloaded `Pivot → chart` resolves no columns until the pivot has run. Refusing there
    // would block every node downstream over a picture nobody could configure — invariant 5's
    // corollary.
    const scheduler = makeScheduler()
    const summary = await scheduler.run(pivoted(type), { mode: 'full' })
    expect(summary.executed).toContain('chart')
    expect(scheduler.info('chart').state).toBe('ok')
    expect(scheduler.output('chart', 'out')).toBe(scheduler.output('piv', 'table'))
  })

  it('says nothing rather than claiming a table that has not published a schema has no columns', () => {
    expect(issues(pivoted(type), 'chart')).toEqual([])
  })

  it('yields an empty Selected with nothing chosen', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline(type), { mode: 'full' })
    const selected = scheduler.output('chart', 'selected')
    expect(isTableValue(selected) && selected.length).toBe(0)
  })
})

/**
 * The param split, stated as a test because the two halves are invisible from the outside and
 * only one of them can be right. The selection-resolving column must reach the cache key; every
 * knob that only changes the drawing must not.
 */
describe.each([
  {
    type: 'out.histogram',
    resolving: 'value',
    from: 'pre',
    to: 'post',
    style: ['binMode', 'auto', 'fixed'],
    drawing: ['binMode', 'bins', 'series', 'logX', 'normalize'],
  },
  {
    type: 'out.pie',
    resolving: 'category',
    from: 'type',
    to: 'status',
    style: ['shape', 'donut', 'pie'],
    drawing: ['value', 'shape', 'sortSlices', 'maxSlices', 'sliceLabels'],
  },
  {
    type: 'out.distribution',
    resolving: 'group',
    from: 'type',
    to: 'status',
    style: ['style', 'box', 'violin'],
    drawing: ['value', 'style', 'points', 'whiskers', 'logAxis', 'maxGroups'],
  },
] as const)('$type — what is presentational', ({ type, resolving, from, to, style, drawing }) => {
  const def = requireNodeDef(type)
  const param = (id: string) => def.params?.find((p) => p.id === id)

  it(`keeps "${resolving}" out of the presentational set — it decides which rows Selected carries`, () => {
    expect(param(resolving)?.presentational).not.toBe(true)
  })

  it('marks every drawing knob presentational, so restyling stales nothing', () => {
    for (const id of drawing) expect([id, param(id)?.presentational]).toEqual([id, true])
  })

  it('leaves the selection itself out of the presentational set', () => {
    expect(param('selection')?.presentational).not.toBe(true)
  })

  /*
   * The end-to-end version of the two claims above, which is the one that would actually
   * catch a mistake: the cache key is built inside the scheduler, so asserting on the flags
   * alone would pass a definition whose flag never reached it.
   */
  it('re-uses the cached result across a restyle, and not across a column change', async () => {
    const scheduler = makeScheduler()
    const base = setNodeParam(
      setNodeParam(pipeline(type, { value: 'pre' }), 'chart', resolving, from),
      'chart',
      style[0],
      style[1],
    )
    await scheduler.run(base, { mode: 'full' })

    const restyled = setNodeParam(base, 'chart', style[0], style[2])
    expect((await scheduler.run(restyled, { mode: 'full' })).executed).not.toContain('chart')

    const recolumned = setNodeParam(base, 'chart', resolving, to)
    expect((await scheduler.run(recolumned, { mode: 'full' })).executed).toContain('chart')
  })
})

describe('out.histogram — a selection of ranges', () => {
  it('carries the rows inside the selected bars, and nothing else', async () => {
    const graph = setNodeParam(
      pipeline('out.histogram', { value: 'pre' }),
      'chart',
      'selection',
      ['0:1'],
    )
    const scheduler = makeScheduler()
    await scheduler.run(graph, { mode: 'full' })
    const all = scheduler.output('chart', 'out')
    const selected = scheduler.output('chart', 'selected')
    if (!isTableValue(all) || !isTableValue(selected)) throw new Error('expected tables')
    // Half-open: exactly the rows with no presynapses at all.
    expect(selected.data.pre?.every((cell) => cell === 0)).toBe(true)
    expect(selected.length).toBe(all.data.pre!.filter((cell) => cell === 0).length)
  })

  it('treats a stale range as no rows rather than as a reason to fail', async () => {
    const graph = setNodeParam(
      pipeline('out.histogram', { value: 'pre' }),
      'chart',
      'selection',
      ['-1000:-999'],
    )
    const scheduler = makeScheduler()
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.info('chart').state).toBe('ok')
    const selected = scheduler.output('chart', 'selected')
    expect(isTableValue(selected) && selected.length).toBe(0)
  })

  it('catches splitting a column by itself, which the resolver cannot see', () => {
    let g = pipeline('out.histogram', { value: 'pre' })
    g = setNodeParam(g, 'chart', 'series', 'pre')
    expect(issues(g, 'chart')).toEqual(['Split-by and Value are the same column'])
  })
})

describe.each([
  ['out.pie', 'category'],
  ['out.distribution', 'group'],
] as const)('%s — a selection of labels', (type, columnParam) => {
  it('carries exactly the rows carrying that label', async () => {
    let g = pipeline(type, { value: 'pre' })
    g = setNodeParam(g, 'chart', columnParam, 'status')
    g = setNodeParam(g, 'chart', 'selection', ['Traced'])
    const scheduler = makeScheduler()
    await scheduler.run(g, { mode: 'full' })
    const all = scheduler.output('chart', 'out')
    const selected = scheduler.output('chart', 'selected')
    if (!isTableValue(all) || !isTableValue(selected)) throw new Error('expected tables')
    expect(selected.length).toBe(all.length)
    expect(selected.data.status?.every((cell) => cell === 'Traced')).toBe(true)
  })

  it('treats a label nothing carries as no rows rather than as a failure', async () => {
    let g = pipeline(type, { value: 'pre' })
    g = setNodeParam(g, 'chart', columnParam, 'status')
    g = setNodeParam(g, 'chart', 'selection', ['NotAStatus'])
    const scheduler = makeScheduler()
    await scheduler.run(g, { mode: 'full' })
    expect(scheduler.info('chart').state).toBe('ok')
    expect(isTableValue(scheduler.output('chart', 'selected')) &&
      (scheduler.output('chart', 'selected') as { length: number }).length).toBe(0)
  })
})

describe('the warnings', () => {
  it('leaves a table with nothing numeric to the shared column check', () => {
    // One fact, one message: a node-level "no numeric column" beside it is the same thing said
    // twice on one badge.
    let g = pipeline('out.histogram')
    g = addNode(g, node('sel', 'core.select', { columns: ['type'] }))
    g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'sel', targetHandle: 'in' })
    g = { ...g, edges: g.edges.filter((e) => e.target !== 'chart') }
    g = addEdge(g, { source: 'sel', sourceHandle: 'out', target: 'chart', targetHandle: 'in' })
    expect(issues(g, 'chart')).toEqual(['No columns of type i64/f64 available for "Value"'])
  })

  it('catches a pie whose value is its category', () => {
    let g = pipeline('out.pie')
    g = setNodeParam(g, 'chart', 'category', 'pre')
    g = setNodeParam(g, 'chart', 'value', 'pre')
    expect(issues(g, 'chart')).toEqual(['Value and Category are the same column'])
  })

  it('catches a box plot grouped by the column it is plotting', () => {
    let g = pipeline('out.distribution')
    g = setNodeParam(g, 'chart', 'value', 'pre')
    g = setNodeParam(g, 'chart', 'group', 'pre')
    expect(issues(g, 'chart')).toEqual(['Group-by and Value are the same column'])
  })
})
