/**
 * The Describe Table node's contract.
 *
 * The arithmetic is `describeOps.test.ts`'s. What is pinned here is the shape, and the two
 * things about it that no type check can see: that the tap really is a tap — so a viewer
 * dropped mid-chain cannot change what reaches the nodes after it — and that the Summary port
 * is typed exactly at edit time, which is the whole reason `describeSchema` takes no arguments.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { requireNodeDef } from '../../core/registry'
import type { Scheduler } from '../../core/scheduler'
import { columnNames, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import { describeSchema } from '../lib/describeOps'
import '../index'
import { defaultOutputPorts } from '../../core/ports'
import { searchFor } from '../../test/findNeurons'
import { node } from '../../test/graph'
import { mockScheduler } from '../../test/scheduler'

const source: DataSource = new MockSource({ latencyMs: 0 })

/** dataset → find(LC.*) → describe */
function pipeline(): CodaGraph {
  let g = emptyGraph('describe-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(
    g,
    node('find', 'neuron.findNeurons', searchFor({ type: 'LC.*', status: 'Traced' })),
  )
  g = addNode(g, node('desc', 'out.describe'))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'desc',
    targetHandle: 'in',
  })
  return g
}

describe('out.describe — types', () => {
  /* A link dragged off the node starts at the pass-through, as it does on `out.table`. */
  it('keeps Table as the first output', () => {
    expect(defaultOutputPorts(requireNodeDef('out.describe')).map((p) => p.id)).toEqual([
      'out',
      'summary',
    ])
  })

  it('passes neurons-ness along the tap and never along the summary', () => {
    const inference = inferGraph(pipeline())
    // Downgrading the tap would cost every node after it the neuronId guarantee its column
    // pickers rely on; promoting the summary would offer a table of column *names* to
    // Connectivity, which would fail at run time on an id column holding the string "column".
    expect(inference.nodes['desc']?.outputs['out']?.kind).toBe('neurons')
    expect(inference.nodes['desc']?.outputs['summary']?.kind).toBe('table')
  })

  /*
   * The summary's columns are decided by the statistics, not by the data — so unlike Pivot,
   * this port is fully typed before anything has run and a picker downstream fills at once.
   */
  it('types the summary port exactly, with nothing wired to it', () => {
    const bare = addNode(emptyGraph('bare'), node('desc', 'out.describe'))
    expect(columnNames(schemaOf(inferGraph(bare).nodes['desc']?.outputs['summary']))).toEqual(
      columnNames(describeSchema()),
    )
  })
})

describe('out.describe — evaluate', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = mockScheduler(source)
  })

  it('passes the input through untouched, by identity', async () => {
    await scheduler.run(pipeline(), { mode: 'full' })
    expect(scheduler.output('desc', 'out')).toBe(scheduler.output('find', 'neurons'))
  })

  it('emits one summary row per column of the input', async () => {
    await scheduler.run(pipeline(), { mode: 'full' })
    const input = scheduler.output('find', 'neurons')
    const summary = scheduler.output('desc', 'summary')
    if (!isTableValue(input) || !isTableValue(summary)) throw new Error('expected tables')

    expect(input.length).toBeGreaterThan(0)
    expect(summary.data['column']).toEqual(columnNames(input.schema))
    expect(columnNames(summary.schema)).toEqual(columnNames(describeSchema()))
  })

  it('reports no warning on a table this size', async () => {
    await scheduler.run(pipeline(), { mode: 'full' })
    expect(scheduler.info('desc').state).toBe('ok')
    expect(scheduler.warning('desc')).toBeUndefined()
  })
})
