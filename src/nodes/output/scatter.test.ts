/**
 * The Scatter node's contract.
 *
 * Two properties carry the design and neither is visible in the picture. The node is a *tap*
 * — its pass-through must not downgrade a Neurons edge — and its drawing knobs must all be
 * free while its two data knobs must not. `Max points` is the one to watch: it thins the
 * picture and nothing else, so a graph that went stale when somebody raised it would be
 * wrong in a way that reads as a scheduler bug rather than as a flag on a param.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import type { ColumnParam } from '../../core/node'
import { defaultParams, resolveColumn } from '../../core/node'
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

/** dataset → find(LC.*) → scatter */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('scatter-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*', status: 'Traced' }))
  g = addNode(g, node('plot', 'out.scatter', params))
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'plot', targetHandle: 'in' })
  return g
}

describe('out.scatter — types', () => {
  it('keeps a Neurons edge Neurons on both ports', () => {
    // A viewer dropped mid-chain must not downgrade the edge, and a lassoed cluster is still
    // neurons — which is what keeps it pluggable straight back into Connectivity or 3D.
    const inference = inferGraph(pipeline())
    expect(inference.nodes['plot']?.outputs['out']?.kind).toBe('neurons')
    expect(inference.nodes['plot']?.outputs['selected']?.kind).toBe('neurons')
  })

  it('advertises the incoming schema on both ports before anything runs', () => {
    const inference = inferGraph(pipeline())
    for (const port of ['out', 'selected']) {
      const names = schemaOf(inference.nodes['plot']?.outputs[port])?.columns.map((c) => c.name)
      expect(names, port).toContain('bodyId')
      expect(names, port).toContain('pre')
    }
  })

  it('accepts a plain Table, since numeric columns are a validation question', () => {
    expect(requireNodeDef('out.scatter').inputs?.[0]?.type.kind).toBe('table')
  })

  it('opens on two different axes rather than plotting a column against itself', () => {
    // An empty default resolves to "the first compatible column", which is the same answer
    // for both axes — so an unconfigured node would draw a diagonal that looks like a bug.
    // Read through the real resolver, since that is what infer, validate, evaluate and the
    // cache key all use.
    const def = requireNodeDef('out.scatter')
    const params = defaultParams(def)
    const inputs = inferGraph(pipeline()).nodes['plot']!.inputs
    const pick = (id: string) =>
      resolveColumn(def.params!.find((p) => p.id === id) as ColumnParam, params, inputs)
    expect(pick('x')).toBe('pre')
    expect(pick('y')).toBe('post')
    expect(pick('x')).not.toBe(pick('y'))
  })
})

describe('out.scatter — evaluate', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = makeScheduler()
  })

  it('passes the input straight through, identically', () => {
    return scheduler.run(pipeline(), { mode: 'full' }).then(() => {
      expect(scheduler.output('plot', 'out')).toBe(scheduler.output('find', 'neurons'))
    })
  })

  it('resolves a selection through the ID column', async () => {
    await scheduler.run(pipeline(), { mode: 'full' })
    const table = scheduler.output('find', 'neurons')
    if (!isTableValue(table)) throw new Error('expected a table')
    const picked = [String(table.data['bodyId']?.[2]), String(table.data['bodyId']?.[5])]

    const second = makeScheduler()
    await second.run(pipeline({ selection: picked }), { mode: 'full' })
    const selected = second.output('plot', 'selected')
    if (!isTableValue(selected)) throw new Error('expected a table')

    expect(selected.length).toBe(2)
    expect(selected.data['bodyId']?.map(String).sort()).toEqual([...picked].sort())
    // Full width, not just the id — the point is that Selected is usable downstream.
    expect(selected.schema.columns.length).toBe(table.schema.columns.length)
    expect(selected.kind).toBe('neurons')
  })

  it('falls back to the row index when no ID column is chosen', async () => {
    // The tables least likely to carry an id — an uploaded CSV of embeddings, a groupBy
    // roll-up — are exactly the ones a scatter is for, and a dead lasso there would be worse
    // than a fragile selection the caption admits to.
    await scheduler.run(pipeline({ idColumn: '', selection: ['0', '3'] }), { mode: 'full' })
    const selected = scheduler.output('plot', 'selected')
    if (!isTableValue(selected)) throw new Error('expected a table')
    const all = scheduler.output('find', 'neurons')
    if (!isTableValue(all)) throw new Error('expected a table')

    expect(selected.length).toBe(2)
    expect(selected.data['bodyId']?.[0]).toBe(all.data['bodyId']?.[0])
    expect(selected.data['bodyId']?.[1]).toBe(all.data['bodyId']?.[3])
  })

  it('emits nothing rather than everything when nothing is selected', async () => {
    // Widening an empty selection to "all of them" would send anything wired downstream off
    // to work on the whole input the moment someone cleared it.
    await scheduler.run(pipeline(), { mode: 'full' })
    const selected = scheduler.output('plot', 'selected')
    if (!isTableValue(selected)) throw new Error('expected a table')
    expect(selected.length).toBe(0)
    // Of the right schema, so a downstream column picker still populates.
    expect(selected.schema.columns.map((c) => c.name)).toContain('bodyId')
  })

  it('keeps the table order, so two ways of picking the same set agree', async () => {
    await scheduler.run(pipeline(), { mode: 'full' })
    const table = scheduler.output('find', 'neurons')
    if (!isTableValue(table)) throw new Error('expected a table')
    const ids = [String(table.data['bodyId']?.[4]), String(table.data['bodyId']?.[1])]

    const forwards = makeScheduler()
    await forwards.run(pipeline({ selection: ids }), { mode: 'full' })
    const backwards = makeScheduler()
    await backwards.run(pipeline({ selection: [...ids].reverse() }), { mode: 'full' })

    const a = forwards.output('plot', 'selected')
    const b = backwards.output('plot', 'selected')
    if (!isTableValue(a) || !isTableValue(b)) throw new Error('expected tables')
    expect(a.data['bodyId']).toEqual(b.data['bodyId'])
  })
})

describe('out.scatter — provenance', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = makeScheduler()
  })

  it('every drawing knob is free, Max points included', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    let changed = setNodeParam(graph, 'plot', 'maxPoints', 500)
    changed = setNodeParam(changed, 'plot', 'opacity', 0.2)
    changed = setNodeParam(changed, 'plot', 'xLog', true)
    changed = setNodeParam(changed, 'plot', 'trend', 'linear')
    changed = setNodeParam(changed, 'plot', 'aspect', 'equal')
    changed = setNodeParam(changed, 'plot', 'pointColorMode', 'categorical')
    scheduler.refreshStates(changed)

    // `out` is the table unchanged and a lasso is tested against every row rather than
    // against the drawn sample, so no output can tell whether a point was painted. That is
    // the difference from the Network viewer's Filter tab, which really does subtract.
    expect(scheduler.info('plot').state).toBe('ok')

    const summary = await scheduler.run(changed, { mode: 'full' })
    expect(summary.executed).toEqual([])
  })

  it('the selection and the ID column are decisions, and stale the node', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    scheduler.refreshStates(setNodeParam(graph, 'plot', 'selection', ['12345']))
    expect(scheduler.info('plot').state).toBe('stale')

    const fresh = makeScheduler()
    await fresh.run(graph, { mode: 'full' })
    // The ID column decides what a selected id *means*, so it decides which rows Selected
    // carries. Presentational here would let a stale downstream result survive it.
    fresh.refreshStates(setNodeParam(graph, 'plot', 'idColumn', 'pre'))
    expect(fresh.info('plot').state).toBe('stale')
  })

  it('is cheap, because evaluate touches no network', () => {
    expect(requireNodeDef('out.scatter').cost).toBe('cheap')
  })

  it('marks the flags directly as well as through the scheduler', () => {
    // Dropped, none of these fails a type check; the symptom is a graph going stale whenever
    // anyone restyles, which reads as a bug somewhere else entirely.
    const params = requireNodeDef('out.scatter').params ?? []
    const flag = (id: string) => params.find((p) => p.id === id)?.presentational
    for (const id of ['x', 'y', 'xLog', 'yLog', 'aspect', 'opacity', 'maxPoints', 'trend']) {
      expect(flag(id), id).toBe(true)
    }
    expect(flag('selection')).toBeFalsy()
    expect(flag('idColumn')).toBeFalsy()
  })
})

describe('out.scatter — the card', () => {
  const def = requireNodeDef('out.scatter')

  it('declares tabs, since the flat rail would be a scroll at this many params', () => {
    // The panel's own admission rule is checked in `ui/params/paramGroups.test.ts`, where the
    // module that applies it lives — `src/nodes` keeps exactly one edge into `src/ui`, and it
    // is Neuroglancer\'s.
    expect(def.paramGroups?.map((g) => g.id)).toEqual(['axes', 'points', 'trend'])
    expect(def.paramGroups?.some((g) => g.affectsData)).toBe(false)
  })

  it('is resizable, and so may declare a default size', () => {
    // `defaultSize` sizes React Flow\'s wrapper, and only a viewer\'s card fills one — see
    // `nodeResize.test.tsx`, which enforces the other direction.
    expect(def.category).toBe('visualisation')
    expect(def.defaultSize).toBeDefined()
  })
})

/**
 * Downstream of a node whose columns are only known once it has run.
 *
 * `core.pivot` is the case: its wide table's columns *are* the distinct values of its Columns
 * field, so it declares `observesOutputSchema` and publishes none until it has run — and none
 * again after a reload, which is how a saved graph opens. This whole block exists because the
 * first version refused there, and the refusal was self-contradicting: it threw "no numeric
 * columns" while holding the table whose numeric column the message went on to list.
 */
describe('out.scatter — an input whose schema is not known yet', () => {
  /** dataset → find → groupBy → pivot → scatter */
  function pivoted(params: Record<string, unknown> = {}): CodaGraph {
    let g = emptyGraph('scatter-pivot')
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
    g = addNode(g, node('find', 'neuron.findNeurons', { status: 'Traced' }))
    g = addNode(g, node('grp', 'core.groupBy', { by: ['type', 'status'], agg: 'sum', value: 'pre' }))
    g = addNode(g, node('piv', 'core.pivot', { rows: 'type', columns: 'status', agg: 'sum', value: 'sum_pre' }))
    g = addNode(g, node('plot', 'out.scatter', params))
    g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })
    g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'grp', targetHandle: 'in' })
    g = addEdge(g, { source: 'grp', sourceHandle: 'out', target: 'piv', targetHandle: 'in' })
    g = addEdge(g, { source: 'piv', sourceHandle: 'table', target: 'plot', targetHandle: 'in' })
    return g
  }

  it('confirms the premise: the pivot advertises no schema before it runs', () => {
    // If this ever starts failing because pivot learned to infer its columns statically, the
    // rest of this block is testing nothing.
    expect(schemaOf(inferGraph(pivoted()).nodes['plot']?.inputs['in'])).toBeUndefined()
  })

  it('says nothing rather than claiming the table has no numeric columns', () => {
    // Unknown is not empty. A badge here sits on a node that is only waiting for its input.
    expect(inferGraph(pivoted()).nodes['plot']?.issues ?? []).toEqual([])
  })

  it('runs and passes the table through instead of blocking everything downstream', async () => {
    const scheduler = makeScheduler()
    const summary = await scheduler.run(pivoted(), { mode: 'full' })
    expect(summary.executed).toContain('plot')
    expect(scheduler.info('plot').state).toBe('ok')
    expect(scheduler.output('plot', 'out')).toBe(scheduler.output('piv', 'table'))
  })

  it('resolves its axes once the run has published the schema', async () => {
    // What the store does after a run: re-infer with what the observing nodes actually
    // produced. That is the pass that lets the widget draw without a second Run.
    const graph = pivoted()
    const scheduler = makeScheduler()
    await scheduler.run(graph, { mode: 'full' })
    const produced = scheduler.output('piv', 'table')
    if (!isTableValue(produced)) throw new Error('expected a table')

    const warm = inferGraph(graph, { observedSchemas: { piv: produced.schema } })
    const columns = schemaOf(warm.nodes['plot']?.inputs['in'])?.columns.map((c) => c.name)
    expect(columns).toContain('Traced')
    // And now that it can see, it has something to say: the mock has one status, so the
    // pivot is one numeric column wide and both axes would take it.
    const messages = (warm.nodes['plot']?.issues ?? []).map((i) => i.message)
    // The mock has one status, so the pivot comes out one numeric column wide.
    expect(messages).toContain('Only "Traced" is numeric — X and Y would be the same column')
    // And nothing about the ID column, which is optional: with no `bodyId` here it means
    // row positions, not drift to be reported.
    expect(messages.some((m) => m.includes('bodyId'))).toBe(false)
  })
})

describe('out.scatter — what it warns about once it can see', () => {
  function issues(graph: CodaGraph, id: string): string[] {
    return (inferGraph(graph).nodes[id]?.issues ?? []).map((issue) => issue.message)
  }

  /** dataset → find → select(columns) → scatter */
  function narrowed(columns: string[]): CodaGraph {
    let g = pipeline()
    g = addNode(g, node('sel', 'core.select', { columns }))
    g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'sel', targetHandle: 'in' })
    g = { ...g, edges: g.edges.filter((e) => e.target !== 'plot') }
    return addEdge(g, { source: 'sel', sourceHandle: 'out', target: 'plot', targetHandle: 'in' })
  }

  it('leaves a table with nothing numeric to the shared column check', () => {
    // `validateColumnParams` already names X and Y precisely; a third badge from the node
    // saying the same thing is how a list of issues stops being read.
    const reported = issues(narrowed(['type']), 'plot')
    expect(reported).toEqual([
      'No columns of type i64/f64 available for "X"',
      'No columns of type i64/f64 available for "Y"',
    ])
  })

  it('names the column when only one is numeric, which the shared check cannot see', () => {
    // Two, and both true: `post` really is gone and `pre` really is what Y falls back to —
    // a non-optional picker does reach for the first column, so that message is honest here
    // in a way it never was for the optional ID column.
    expect(issues(narrowed(['type', 'pre']), 'plot')).toEqual([
      'Column "post" is gone — using "pre"',
      'Only "pre" is numeric — X and Y would be the same column',
    ])
  })

  it('is a warning and not a refusal — the table still flows', async () => {
    const g = narrowed(['type'])
    const scheduler = makeScheduler()
    await scheduler.run(g, { mode: 'full' })
    expect(scheduler.info('plot').state).toBe('ok')
    expect(scheduler.output('plot', 'out')).toBe(scheduler.output('sel', 'out'))
  })
})
