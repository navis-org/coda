/**
 * The Explore node's ports, driven through the real scheduler against the mock connectome.
 *
 * `neuronSearch.test.ts` pins the query language and `ui/explore/explore.test.tsx` the widget.
 * What neither covers is what the *node* hands downstream, which is the whole point of `All`:
 * the index is already in memory, so the third port must be the untouched table rather than a
 * second search — a port that quietly narrowed with the search box would look like it worked
 * right up until someone typed something.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { isTableValue } from '../../core/values'
import type { TableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import { mockDatasetIds } from '../../data/mock/generate'
import { registerSource, requireSource } from '../../data/source'
import '../index'

const DATASET = mockDatasetIds()[0]!

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** dataset → explore */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('explore-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('explore', 'neuron.explore', params))
  return addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'explore',
    targetHandle: 'dataset',
  })
}

async function ports(params: Record<string, unknown> = {}) {
  const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
  const summary = await sched.run(pipeline(params), { mode: 'full' })
  expect(summary.failed).toEqual([])
  const table = (id: string): TableValue => {
    const value = sched.output('explore', id)
    if (!isTableValue(value)) throw new Error(`expected a table on ${id}`)
    return value
  }
  return { hits: table('hits'), selected: table('selected'), all: table('all') }
}

describe('Explore: the All port', () => {
  it('carries the whole index, whatever the search says', async () => {
    const { hits, all } = await ports()
    const searched = await ports({ query: 'LC4' })

    expect(all.length).toBeGreaterThan(0)
    // An empty query matches everything, so this is the one case where the two agree.
    expect(hits.length).toBe(all.length)
    expect(searched.hits.length).toBeLessThan(all.length)
    expect(searched.all.length).toBe(all.length)
  })

  it('ignores Max hits, which caps only the search result', async () => {
    const { hits, all } = await ports({ limit: 3 })
    expect(hits.length).toBe(3)
    expect(all.length).toBeGreaterThan(3)
  })

  it('is inferred with the same neuron schema it evaluates', async () => {
    const declared = inferGraph(pipeline()).nodes.explore?.outputs.all
    const advertised =
      declared && 'schema' in declared ? declared.schema?.columns.map((c) => c.name) : undefined
    expect(advertised?.length).toBeGreaterThan(0)

    const { all } = await ports()
    expect(all.schema.columns.map((c) => c.name)).toEqual(advertised)
  })

  it('does not disturb the two ports every existing graph is wired to', async () => {
    const { hits, selected, all } = await ports({ query: 'LC4' })
    const ids = (t: TableValue) => (t.data.bodyId ?? []).slice(0, 2)
    // Nothing ticked, so Selected stays empty however much the other two carry.
    expect(selected.length).toBe(0)
    expect(hits.length).toBeGreaterThan(0)

    const picked = await ports({ query: 'LC4', selection: ids(all) })
    expect(picked.selected.length).toBe(2)
  })
})
