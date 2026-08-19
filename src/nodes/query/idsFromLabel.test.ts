/**
 * The IDs from Label node, driven through the real scheduler against the mock connectome.
 *
 * `lib/labelLookup.test.ts` pins the label arithmetic. What only this level can check is the
 * pair of properties the node is built around: that the two ways of naming labels reach the
 * *same* query, and that an unconfigured node is empty rather than the whole dataset — the
 * failure there is silent and expensive, since an empty pattern one node over means everything.
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

/** dataset → idsFromLabel, plus an optional find → labels wire. */
function pipeline(
  params: Record<string, unknown> = {},
  wire?: Record<string, unknown>,
): CodaGraph {
  let g = emptyGraph('labels-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('lookup', 'neuron.idsFromLabel', params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'lookup',
    targetHandle: 'dataset',
  })
  if (wire) {
    g = addNode(g, node('find', 'neuron.findNeurons', wire))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'find',
      targetHandle: 'dataset',
    })
    g = addEdge(g, {
      source: 'find',
      sourceHandle: 'neurons',
      target: 'lookup',
      targetHandle: 'labels',
    })
  }
  return g
}

async function run(params: Record<string, unknown> = {}, wire?: Record<string, unknown>) {
  const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
  const summary = await sched.run(pipeline(params, wire), { mode: 'full' })
  expect(summary.failed).toEqual([])
  const value = sched.output('lookup', 'neurons')
  if (!isTableValue(value)) throw new Error('expected a neuron table')
  return value
}

function typesIn(table: TableValue): string[] {
  return [...new Set((table.data['type'] ?? []).map((v) => String(v)))].sort()
}

describe('IDs from Label', () => {
  it('resolves a typed label to the neurons carrying it', async () => {
    const table = await run({ labels: 'T4a' })
    expect(table.length).toBeGreaterThan(0)
    expect(typesIn(table)).toEqual(['T4a'])
    // The point of the node: ids, and every one of them distinct.
    const ids = (table.data['bodyId'] ?? []).map(Number)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('takes several labels at once, comma- or newline-separated', async () => {
    expect(typesIn(await run({ labels: 'T4a, T4b' }))).toEqual(['T4a', 'T4b'])
    expect(typesIn(await run({ labels: 'T4a\nT4b' }))).toEqual(['T4a', 'T4b'])
  })

  it('matches exactly by default, so a label is not a prefix of its neighbours', async () => {
    // 'T4' is a real prefix of T4a/T4b/T4c and must match none of them.
    expect((await run({ labels: 'T4' })).length).toBe(0)
  })

  it('treats a label literally, not as a pattern', async () => {
    // Under exact matching '.' is a dot, so this finds nothing rather than every T4.
    expect((await run({ labels: 'T4.' })).length).toBe(0)
    expect(typesIn(await run({ labels: 'T4.', match: 'regex' }))).toEqual([
      'T4a',
      'T4b',
      'T4c',
      'T4d',
    ])
  })

  it('anchors a regex the way the query does', async () => {
    /*
     * Whole-string, same semantics as neuPrint's `=~` and the same the mock reproduces. So a
     * pattern naming a *substring* of a type matches nothing — do not "fix" this into an
     * unanchored search, both sides of the seam depend on it.
     */
    expect((await run({ labels: '4a', match: 'regex' })).length).toBe(0)
    expect(typesIn(await run({ labels: '.*4a', match: 'regex' }))).toEqual(['T4a'])
  })

  it('is case-sensitive until asked otherwise', async () => {
    expect((await run({ labels: 't4a' })).length).toBe(0)
    expect(typesIn(await run({ labels: 't4a', ignoreCase: true }))).toEqual(['T4a'])
    expect(typesIn(await run({ labels: 't4.*', match: 'regex', ignoreCase: true }))).toEqual([
      'T4a',
      'T4b',
      'T4c',
      'T4d',
    ])
  })

  it('reads labels out of a wired column', async () => {
    const table = await run({ column: 'type' }, { typePattern: 'T4a', status: 'Traced' })
    expect(typesIn(table)).toEqual(['T4a'])
  })

  it('unions the typed labels with the wired column rather than one winning', async () => {
    // The failure this guards is silent: either half alone returns a perfectly good table.
    const table = await run(
      { labels: 'Mi1', column: 'type' },
      { typePattern: 'T4a', status: 'Traced' },
    )
    expect(typesIn(table)).toEqual(['Mi1', 'T4a'])
  })

  it('returns an empty table, not the dataset, when nothing has been asked for', async () => {
    const table = await run()
    expect(table.length).toBe(0)
    // Empty of the right shape, so downstream column pickers populate before anyone types.
    expect(table.schema.columns.map((c) => c.name)).toContain('bodyId')
  })

  it('matches on a field other than type', async () => {
    const anyStatus = await run({ field: 'status', labels: 'Anchor', status: '' })
    expect(anyStatus.length).toBeGreaterThan(0)
    expect([...new Set((anyStatus.data['status'] ?? []).map(String))]).toEqual(['Anchor'])
  })

  it('filters by status, defaulting to Traced', async () => {
    const traced = await run({ labels: 'T4a' })
    const all = await run({ labels: 'T4a', status: '' })
    expect(all.length).toBeGreaterThanOrEqual(traced.length)
    expect([...new Set((traced.data['status'] ?? []).map(String))]).toEqual(['Traced'])
  })

  it('advertises the schema it evaluates', async () => {
    const declared = inferGraph(pipeline({ labels: 'T4a' })).nodes.lookup?.outputs.neurons
    const advertised =
      declared && 'schema' in declared ? declared.schema?.columns.map((c) => c.name) : undefined
    expect(advertised?.length).toBeGreaterThan(0)
    expect((await run({ labels: 'T4a' })).schema.columns.map((c) => c.name)).toEqual(advertised)
  })

  it('warns about an unparseable pattern only in regex mode', async () => {
    const issues = (g: CodaGraph) => inferGraph(g).nodes.lookup?.issues ?? []
    expect(issues(pipeline({ labels: 'T4(', match: 'regex' }))).toHaveLength(1)
    expect(issues(pipeline({ labels: 'T4(' }))).toHaveLength(0)
  })
})
