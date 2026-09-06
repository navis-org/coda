/**
 * The Find Neurons node, driven through the real scheduler against the mock connectome.
 *
 * `data/filterRows.test.ts` pins what a row *means* and `data/neuprint/neuprint.test.ts` pins
 * what it compiles to. What only this level can check is the three things the node itself is
 * responsible for, each of which fails silently:
 *
 *  - **What an alpha-era file does now.** The five named params are gone; the fifty tests that
 *    wrote `{ typePattern: 'LC.*' }` say it in rows (`test/findNeurons.ts`), which is the
 *    migration a load-time one could never have performed. What is left is a saved file holding
 *    keys no definition declares, and the only thing that makes that safe is the rule above:
 *    such a node asks nothing, so it returns nothing and says so.
 *  - **The empty node.** No rows means *no neurons* — decided at the node, where an empty
 *    `FindNeuronsRequest.rows` one layer down still means "no narrowing" because `neuronIndex`
 *    and Explore share the method. A node that got this backwards would fire an unbounded
 *    `MATCH (n:Neuron)` at a shared production server. Which of the three controls counts as
 *    asking something is the other half (`In ROI` does, `Limit` does not), and it is the half
 *    that is easy to get subtly wrong without any test failing.
 *  - **The size of the answer.** A count past `FOUND_NEURONS_WARN` is said out loud, and an
 *    ordinary one is not.
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
import { isTableValue, tableFromRows } from '../../core/values'
import type { TableValue } from '../../core/values'
import { encodeRows } from '../../data/filterRows'
import type { FilterRow } from '../../data/filterRows'
import { MockSource } from '../../data/mock/MockSource'
import { mockDatasetIds } from '../../data/mock/generate'
import type { DataSource } from '../../data/source'
import { CANONICAL_SCHEMAS, registerSource, requireSource } from '../../data/source'
import { rowsFromParams } from '../lib/findNeuronsRows'
import '../index'

const DATASET = mockDatasetIds()[0]!

/**
 * A source with more neurons than the mock can hold, for the one branch 401 neurons cannot reach.
 *
 * Registered rather than borrowed. The threshold is about the *size of an answer*, and every
 * connectome that would cross it is one no test may talk to — so the alternative to four lines
 * here is a warning path that ships untested, which for a message nobody sees until a real
 * dataset produces it is the worst place to find out it was never wired up.
 */
const CROWDED_ID = 'test.crowded'
const CROWDED_ROWS = 10_001
const CROWDED = {
  id: CROWDED_ID,
  label: 'Crowded',
  capabilities: { neuronIndex: false, roiFilter: false },
  schemas: CANONICAL_SCHEMAS,
  listDatasets: async () => [{ id: 'big', label: 'Big', rois: [] }],
  peekDatasets: () => [{ id: 'big', label: 'Big', rois: [] }],
  peekDataset: () => ({ id: 'big', label: 'Big', rois: [] }),
  findNeurons: async () =>
    tableFromRows(
      CANONICAL_SCHEMAS.neurons,
      Array.from({ length: CROWDED_ROWS }, (_, i) => ({ neuronId: i + 1 })),
      'neurons',
    ),
} as unknown as DataSource

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
  registerSource(CROWDED)
})

/** A region the mock actually publishes, so the roi arm is exercised rather than approximated. */
function mockRoi(): string {
  const roi = requireSource('mock').peekDataset(DATASET)?.rois?.[0]
  if (!roi) throw new Error('the mock dataset publishes no regions')
  return roi
}

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

async function ran(
  params: Record<string, unknown> = {},
): Promise<{ table: TableValue; warning: string | undefined }> {
  const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
  const summary = await sched.run(pipeline(params), { mode: 'full' })
  expect(summary.failed).toEqual([])
  const value = sched.output('find', 'neurons')
  if (!isTableValue(value)) throw new Error('expected a neuron table')
  return { table: value, warning: sched.warning('find') }
}

async function run(params: Record<string, unknown> = {}): Promise<TableValue> {
  return (await ran(params)).table
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
  it('returns nothing when nothing is asked, and says so', async () => {
    // Not the seam's rule: an empty `FindNeuronsRequest.rows` still means "no narrowing" one
    // layer down, because `neuronIndex` and Explore share the method. `asksNothing` is where
    // the node departs from it, and the departure is the thing worth pinning — a regression
    // here is an unbounded `MATCH (n:Neuron)` at whatever server is wired up.
    const { table, warning } = await ran()
    expect(table.length).toBe(0)
    expect(warning).toMatch(/no filters/i)
  })

  it('keeps the dataset schema on the empty answer', async () => {
    // Invariant 3 across the short-circuit: `inferOutputs` advertises the dataset's own neuron
    // schema, so a node returning `CANONICAL_SCHEMAS` — or a bare table — here would empty every
    // column picker downstream on Run, which reads as a broken dataset rather than an empty card.
    const wired = await run(rows({ field: 'type', op: 'is', values: ['T4a'] }))
    expect((await run()).schema).toEqual(wired.schema)
  })

  it('treats a region as a filter, since it is a question that just cannot be a row', async () => {
    const { table, warning } = await ran({ roi: mockRoi() })
    expect(table.length).toBeGreaterThan(0)
    expect(warning).toBeUndefined()
  })

  it('does not treat a limit as one, since a cap is not a question', async () => {
    // The half of the rule that is easiest to get backwards: `limit: 3` used to mean "three
    // neurons of whatever the backend returned first", which is a sample rather than an answer.
    expect((await run({ limit: 3 })).length).toBe(0)
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

  it('caps at the limit once something is actually being asked', async () => {
    expect(
      (await run({ ...rows({ field: 'type', op: 'notEmpty', values: [] }), limit: 3 })).length,
    ).toBe(3)
  })

  it('stays quiet about an ordinary answer', async () => {
    // The other half of the threshold, and the half that decides whether anyone reads it: a
    // warning on every run is a warning nobody reads. `docs/limits.md` records that for the
    // channel as a whole.
    const { warning } = await ran(rows({ field: 'type', op: 'notEmpty', values: [] }))
    expect(warning).toBeUndefined()
  })

  it('says so when the answer is a population rather than a selection', async () => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    let g = emptyGraph('crowded')
    g = addNode(g, node('ds', 'neuron.dataset', { source: CROWDED_ID, dataset: 'big' }))
    // Any row at all: the point is the count that comes back, not what was asked for.
    g = addNode(
      g,
      node('find', 'neuron.findNeurons', rows({ field: 'type', op: 'notEmpty', values: [] })),
    )
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'find',
      targetHandle: 'dataset',
    })
    expect((await sched.run(g, { mode: 'full' })).failed).toEqual([])
    expect(sched.warning('find')).toMatch(/10,001 neurons matched/)
  })
})

describe('the params that used to be the card', () => {
  /*
   * `typePattern`, `instancePattern`, `status` and `minSize` are gone. What is worth pinning is
   * not their absence — the definition says that — but the *behaviour of a file that still holds
   * them*, which is the only case a load-time migration would have been for and the one nobody
   * can hand-edit. `normalizeParams` reads only declared params, so such a node asks nothing;
   * combined with `asksNothing` that makes it return no neurons and say so, rather than sending
   * the unbounded query the old "no rows means everything" rule would have. That ordering is the
   * whole reason the two changes went in separately, and it is invisible from the definition.
   */
  it('no longer declares them', () => {
    const declared = new Set(requireNodeDef('neuron.findNeurons').params?.map((p) => p.id))
    for (const id of ['typePattern', 'instancePattern', 'status', 'minSize']) {
      expect(declared.has(id), id).toBe(false)
    }
    // `roi` stayed, and it is the one that could not have become a row: a region is not a column.
    expect(declared.has('roi')).toBe(true)
  })

  it('answers an alpha-era graph with nothing, rather than with the dataset', async () => {
    const { table, warning } = await ran({ typePattern: 'T4a', status: 'Traced' })
    expect(table.length).toBe(0)
    expect(warning).toMatch(/no filters/i)
  })

  it('ignores them entirely rather than half-reading them', () => {
    expect(rowsFromParams({ typePattern: 'LC.*', status: 'Traced', filters: [] })).toEqual([])
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

  it('reports a regex that does not compile', () => {
    expect(issues(rows({ field: 'type', op: 'matches', values: ['LC('] }))).toEqual([
      expect.stringContaining('Invalid regex'),
    ])
  })

  it('says nothing about a node nobody has configured', () => {
    expect(issues({})).toEqual([])
  })
})
