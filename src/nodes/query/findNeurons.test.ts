/**
 * The Find Neurons node, driven through the real scheduler against the mock connectome.
 *
 * `data/filterRows.test.ts` pins what a row *means* and `data/neuprint/neuprint.test.ts` pins
 * what it compiles to. What only this level can check is the three things the node itself is
 * responsible for, each of which fails silently:
 *
 *  - **The legacy bridge.** Some fifty tests, six starter graphs and every saved file build this
 *    node by writing `{ typePattern: 'LC.*' }`. A migration could not reach any of them, so the
 *    old params are folded into rows instead — and if that fold ever stopped happening, every one
 *    of those graphs would quietly return the whole dataset rather than erroring.
 *  - **The empty node.** No rows means everything, which is the opposite of what an empty
 *    `IDs from Label` means, and the difference is deliberate. A node that got this backwards
 *    would fire an unbounded query at a shared production server.
 *  - **Edit-time refusal.** A row naming a field the dataset does not publish has to be reported
 *    by `validate`, because the alternatives at run time are a refusal against a live server or a
 *    broader answer that looks correct.
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
import { encodeRows } from '../../data/filterRows'
import type { FilterRow } from '../../data/filterRows'
import { MockSource } from '../../data/mock/MockSource'
import { mockDatasetIds } from '../../data/mock/generate'
import { registerSource, requireSource } from '../../data/source'
import { rowsFromParams } from '../lib/findNeuronsRows'
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

function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('find-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('find', 'neuron.findNeurons', params))
  return addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
}

async function run(params: Record<string, unknown> = {}): Promise<TableValue> {
  const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
  const summary = await sched.run(pipeline(params), { mode: 'full' })
  expect(summary.failed).toEqual([])
  const value = sched.output('find', 'neurons')
  if (!isTableValue(value)) throw new Error('expected a neuron table')
  return value
}

/** The node's `validate` messages, with the dataset wired so a real schema is in hand. */
function issues(params: Record<string, unknown>): string[] {
  const found = inferGraph(pipeline(params)).nodes.find?.issues ?? []
  return found.map((issue) => (typeof issue === 'string' ? issue : issue.message))
}

const rows = (...list: FilterRow[]) => ({ filters: encodeRows(list) })
const typesIn = (table: TableValue) =>
  [...new Set((table.data['type'] ?? []).map((v) => String(v)))].sort()

describe('filtering', () => {
  it('returns everything when nothing is asked', async () => {
    // The opposite of `IDs from Label`, whose empty state is empty. A pattern that narrows
    // nothing is everything; a lookup of nothing is nothing.
    const all = await run()
    expect(all.length).toBeGreaterThan(0)
  })

  it('narrows on a field the dataset publishes', async () => {
    const table = await run(rows({ field: 'type', op: 'is', values: ['T4a'] }))
    expect(typesIn(table)).toEqual(['T4a'])
  })

  it('ANDs its rows', async () => {
    const both = await run(
      rows(
        { field: 'type', op: 'startsWith', values: ['T4'] },
        { field: 'status', op: 'is', values: ['Traced'] },
      ),
    )
    const wider = await run(rows({ field: 'type', op: 'startsWith', values: ['T4'] }))
    expect(both.length).toBeGreaterThan(0)
    expect(both.length).toBeLessThanOrEqual(wider.length)
  })

  it('says a set in one row, which is how OR is spelled here', async () => {
    const table = await run(rows({ field: 'type', op: 'isIn', values: ['T4a', 'T4b'] }))
    expect(typesIn(table)).toEqual(['T4a', 'T4b'])
  })

  it('caps at the limit', async () => {
    expect((await run({ limit: 3 })).length).toBe(3)
  })
})

describe('the legacy params', () => {
  it('folds each of the four into the row it used to compile to', () => {
    expect(
      rowsFromParams({
        typePattern: 'LC.*',
        instancePattern: 'foo',
        status: 'Traced',
        minSize: 50_000,
        filters: [],
      }),
    ).toEqual([
      { field: 'type', op: 'matches', values: ['LC.*'] },
      { field: 'instance', op: 'matches', values: ['foo'] },
      { field: 'status', op: 'is', values: ['Traced'] },
      { field: 'size', op: 'ge', values: ['50000'] },
    ])
  })

  it('contributes nothing when they are at their defaults', () => {
    // What makes "a new Find Neurons filters nothing" true. `defaultParams` writes every default
    // into every node, so an unset legacy param and an absent one have to be the same thing.
    expect(rowsFromParams(defaultParams(requireNodeDef('neuron.findNeurons')))).toEqual([])
  })

  it('still runs a graph built the old way', async () => {
    // The property every saved file, starter graph and older test depends on.
    const table = await run({ typePattern: 'T4a' })
    expect(typesIn(table)).toEqual(['T4a'])
  })

  it('anchors a legacy pattern exactly as the old query did', async () => {
    // `=~` matches the whole value, so `T4` matches none of T4a/T4b/T4c. Getting this wrong
    // would silently widen every graph saved before the rows existed.
    expect((await run({ typePattern: 'T4' })).length).toBe(0)
    expect(typesIn(await run({ typePattern: 'T4.' }))).toEqual(['T4a', 'T4b', 'T4c', 'T4d'])
  })

  it('ANDs the old params with any new rows', async () => {
    const table = await run({
      typePattern: 'T4.',
      ...rows({ field: 'type', op: 'is', values: ['T4a'] }),
    })
    expect(typesIn(table)).toEqual(['T4a'])
  })
})

describe('what the card says before anything runs', () => {
  it('reports a field this dataset does not publish', () => {
    // Knowable at edit time because a Dataset socket carries its schema — which is what lets
    // this be a badge rather than a refusal against a live server.
    expect(issues(rows({ field: 'hemilineage', op: 'is', values: ['x'] }))).toEqual([
      expect.stringContaining('no "hemilineage"'),
    ])
  })

  it('reports a regex that does not compile, wherever it came from', () => {
    expect(issues(rows({ field: 'type', op: 'matches', values: ['LC('] }))).toEqual([
      expect.stringContaining('Invalid regex'),
    ])
    expect(issues({ typePattern: 'LC(' })).toEqual([expect.stringContaining('Invalid regex')])
  })

  it('says nothing about a node nobody has configured', () => {
    expect(issues({})).toEqual([])
  })
})
