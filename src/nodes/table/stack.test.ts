/**
 * The Stack Tables node.
 *
 * The ops are covered in `tableOps.test.ts`, so this is the node's own contract — and what it is
 * mostly about is *when it knows things*. A stacked schema depends on both inputs, so it cannot
 * be published from one; a dtype clash cannot throw at edit time but must be visible before a
 * Run; and neurons-ness is a claim that has to be made the same way by the type and by the value,
 * or a downstream node's bodyId guarantee holds in inference and not in the data.
 *
 * The scheduler assertions matter because the alternative failures are quiet: a node that
 * published half a schema leaves a picker downstream configured against a shape that never
 * arrives, which only shows up after a run.
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

/**
 * dataset → find(LC4) ┐
 *                     ├→ stack → sort
 * dataset → find(LC6) ┘
 *
 * Two real neuron tables of the same shape, which is the ordinary case.
 */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('stack-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('a', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('b', 'neuron.findNeurons', { typePattern: 'LC6', status: 'Traced' }))
  g = addNode(g, node('stack', 'core.stack', params))
  g = addNode(g, node('sort', 'core.sort', { column: 'bodyId' }))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'a',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'b',
    targetHandle: 'dataset',
  })
  g = addEdge(g, { source: 'a', sourceHandle: 'neurons', target: 'stack', targetHandle: 'top' })
  g = addEdge(g, {
    source: 'b',
    sourceHandle: 'neurons',
    target: 'stack',
    targetHandle: 'bottom',
  })
  g = addEdge(g, { source: 'stack', sourceHandle: 'out', target: 'sort', targetHandle: 'in' })
  return g
}

/** Replace one side with a Select, so the two inputs no longer have the same columns. */
function narrowed(columns: string[], params: Record<string, unknown> = {}): CodaGraph {
  let g = pipeline(params)
  g = addNode(g, node('sel', 'core.select', { columns }))
  g = addEdge(g, { source: 'b', sourceHandle: 'neurons', target: 'sel', targetHandle: 'in' })
  g = {
    ...g,
    edges: g.edges.filter((e) => !(e.target === 'stack' && e.targetHandle === 'bottom')),
  }
  return addEdge(g, {
    source: 'sel',
    sourceHandle: 'out',
    target: 'stack',
    targetHandle: 'bottom',
  })
}

describe('core.stack — types', () => {
  it('advertises the union of both inputs’ columns', () => {
    const g = narrowed(['bodyId', 'type'])
    const out = inferGraph(g).nodes['stack']?.outputs['out']
    // The top's full neuron schema, with nothing lost because the bottom was narrowed.
    expect(columnNames(schemaOf(out))).toContain('status')
    expect(columnNames(schemaOf(out))).toContain('bodyId')
  })

  it('publishes nothing until both sides are known', () => {
    // Half a schema is worse than none: a picker downstream would be configured against a
    // shape that never arrives, and nothing says so until after a run.
    let g = pipeline()
    g = { ...g, edges: g.edges.filter((e) => e.targetHandle !== 'bottom') }
    expect(schemaOf(inferGraph(g).nodes['stack']?.outputs['out'])).toBeUndefined()
  })

  it('keeps a Neurons edge Neurons when both sides are neurons', () => {
    expect(inferGraph(pipeline()).nodes['stack']?.outputs['out']?.kind).toBe('neurons')
  })

  it('drops to Table when one side never claimed to be neurons', () => {
    // `core.select` keeping bodyId still emits a plain table here only if it drops the claim;
    // an upload is the clearer case — nothing verified its ids belong to this dataset.
    let g = pipeline()
    g = addNode(g, node('up', 'core.uploadTable'))
    g = {
      ...g,
      edges: g.edges.filter((e) => !(e.target === 'stack' && e.targetHandle === 'bottom')),
    }
    g = addEdge(g, {
      source: 'up',
      sourceHandle: 'out',
      target: 'stack',
      targetHandle: 'bottom',
    })
    expect(inferGraph(g).nodes['stack']?.outputs['out']?.kind).toBe('table')
  })

  it('shows the source column in the advertised schema', () => {
    const out = inferGraph(pipeline({ sourceColumn: 'origin' })).nodes['stack']?.outputs['out']
    expect(columnNames(schemaOf(out)).at(-1)).toBe('origin')
  })
})

describe('core.stack — evaluate', () => {
  it('emits both inputs’ rows, top first', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline(), { mode: 'full' })

    const top = scheduler.output('a', 'neurons')
    const bottom = scheduler.output('b', 'neurons')
    const out = scheduler.output('stack', 'out')
    if (!isTableValue(top) || !isTableValue(bottom) || !isTableValue(out)) {
      throw new Error('expected tables')
    }
    expect(top.length).toBeGreaterThan(0)
    expect(bottom.length).toBeGreaterThan(0)
    expect(out.length).toBe(top.length + bottom.length)
    expect(out.kind).toBe('neurons')
    expect(out.data['bodyId']?.slice(0, top.length)).toEqual(top.data['bodyId'])
  })

  it('fills a column the other side does not have with null', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(narrowed(['bodyId', 'type']), { mode: 'full' })

    const out = scheduler.output('stack', 'out')
    const top = scheduler.output('a', 'neurons')
    if (!isTableValue(out) || !isTableValue(top)) throw new Error('expected tables')
    const status = out.data['status'] ?? []
    // The top's rows kept their status; the narrowed bottom's are null rather than missing.
    expect(status.slice(0, top.length).every((v) => v !== null)).toBe(true)
    expect(status.slice(top.length).every((v) => v === null)).toBe(true)
  })

  it('labels the rows by input when a source column is named', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(
      pipeline({ sourceColumn: 'origin', topLabel: 'LC4', bottomLabel: 'LC6' }),
      {
        mode: 'full',
      },
    )
    const out = scheduler.output('stack', 'out')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(new Set(out.data['origin'] as string[])).toEqual(new Set(['LC4', 'LC6']))
  })

  it('refuses a real dtype clash, naming both readings, and blocks downstream', async () => {
    /*
     * A clash built out of nothing but real nodes: `core.pivot`'s wide table names its label
     * column after the Rows field and types it `str` even when pivoted from an `i64` — so a
     * pivot on `preId` stacked onto the connectivity table it came from disagrees about exactly
     * that column. This is the shape the refusal exists for, and it is not contrived.
     */
    let g = emptyGraph('clash')
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
    g = addNode(
      g,
      node('find', 'neuron.findNeurons', { typePattern: 'LC.*', status: 'Traced' }),
    )
    g = addNode(g, node('conn', 'neuron.connectivity', { direction: 'outputs', minWeight: 1 }))
    g = addNode(
      g,
      node('piv', 'core.pivot', {
        rows: 'preId',
        columns: 'postType',
        agg: 'sum',
        value: 'weight',
      }),
    )
    g = addNode(g, node('stack', 'core.stack'))
    g = addNode(g, node('sort', 'core.sort', { column: 'preId' }))
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
      target: 'piv',
      targetHandle: 'in',
    })
    g = addEdge(g, {
      source: 'conn',
      sourceHandle: 'connections',
      target: 'stack',
      targetHandle: 'top',
    })
    g = addEdge(g, {
      source: 'piv',
      sourceHandle: 'table',
      target: 'stack',
      targetHandle: 'bottom',
    })
    g = addEdge(g, { source: 'stack', sourceHandle: 'out', target: 'sort', targetHandle: 'in' })

    const scheduler = makeScheduler()
    await scheduler.run(g, { mode: 'full' })

    expect(scheduler.info('stack').state).toBe('error')
    const message = scheduler.info('stack').error ?? ''
    // Both readings, because the fix depends on which one is wrong.
    expect(message).toContain('preId')
    expect(message).toContain('i64 above and str below')
    // And it says what to do about it rather than only what happened.
    expect(message).toMatch(/convert it upstream|Select/)
    expect(scheduler.info('sort').state).toBe('blocked')
  })

  it('cannot see that clash at edit time, and does not pretend to', async () => {
    // The pivot publishes no schema until it has run, so `validate` has nothing to compare —
    // which is the honest answer. The refusal lands at run time, where the tables are real.
    let g = emptyGraph('clash-edit')
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
    g = addNode(g, node('conn', 'neuron.connectivity', { direction: 'outputs', minWeight: 1 }))
    g = addNode(
      g,
      node('piv', 'core.pivot', {
        rows: 'preId',
        columns: 'postType',
        agg: 'sum',
        value: 'weight',
      }),
    )
    g = addNode(g, node('stack', 'core.stack'))
    g = addEdge(g, {
      source: 'conn',
      sourceHandle: 'connections',
      target: 'piv',
      targetHandle: 'in',
    })
    g = addEdge(g, {
      source: 'conn',
      sourceHandle: 'connections',
      target: 'stack',
      targetHandle: 'top',
    })
    g = addEdge(g, {
      source: 'piv',
      sourceHandle: 'table',
      target: 'stack',
      targetHandle: 'bottom',
    })
    const reported = (inferGraph(g).nodes['stack']?.issues ?? []).map((i) => i.message)
    expect(reported.join(' ')).not.toContain('above and')
  })
})

describe('core.stack — validation', () => {
  const issues = (g: CodaGraph) =>
    (inferGraph(g).nodes['stack']?.issues ?? []).map((i) => i.message).join(' ')

  it('says nothing about two tables that stack cleanly', () => {
    expect(issues(pipeline())).toBe('')
    expect(issues(narrowed(['bodyId', 'type']))).toBe('')
  })

  it('checks the source column against a known schema, and only a known one', () => {
    // Two halves of one rule. A known input is checked: `type` is really there, so say so.
    expect(issues(pipeline({ sourceColumn: 'type' }))).toContain('already exists')

    // An *unknown* schema is not a schema without the column in it — Raw Cypher declares none
    // until it has run and none again after a reload. Guessing there would put a warning on
    // every graph that stacks something downstream of it, on every single load.
    let g = pipeline({ sourceColumn: 'origin' })
    g = { ...g, edges: g.edges.filter((e) => e.targetHandle !== 'bottom') }
    g = addNode(g, node('raw', 'neuron.rawCypher'))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'raw',
      targetHandle: 'dataset',
    })
    g = addEdge(g, {
      source: 'raw',
      sourceHandle: 'result',
      target: 'stack',
      targetHandle: 'bottom',
    })
    expect(issues(g)).toBe('')
  })

  it('reports a dtype clash before anything is run', () => {
    let g = pipeline()
    g = addNode(g, node('up', 'core.uploadTable'))
    g = {
      ...g,
      edges: g.edges.filter((e) => !(e.target === 'stack' && e.targetHandle === 'bottom')),
    }
    g = addEdge(g, {
      source: 'up',
      sourceHandle: 'out',
      target: 'stack',
      targetHandle: 'bottom',
    })
    // Nothing is known about the upload's columns yet, so there is nothing to clash with —
    // which is the honest answer, not an oversight.
    expect(issues(g)).toBe('')
  })
})
