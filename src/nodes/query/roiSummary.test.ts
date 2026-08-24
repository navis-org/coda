/**
 * The two whole-dataset ROI nodes.
 *
 * The decoders are covered against real recorded replies in `data/neuprint/neuprint.test.ts`;
 * this is about the node shapes, and nearly everything here follows from one asymmetry that was
 * measured rather than assumed:
 *
 *   `roicompleteness` publishes the **nesting** ROI list — hemibrain returns 229 rows of which
 *   63 tile the volume — while `roiconnectivity` publishes only the primary set, and its
 *   `roi_names` is byte-for-byte hemibrain's `primary_rois`.
 *
 * So one node needs a filter whose default is the whole point of it, and the other must not
 * grow one. A reader coming to these two side by side would reasonably expect them to match;
 * they must not, and this is where that is written down.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { columnNames, schemaOf } from '../../core/types'
import { getColumn, isMatrixValue, isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'

import '../index'

const DATASET = 'optic-lobe-mini'

let source: DataSource

beforeEach(() => {
  source = new MockSource({ latencyMs: 0 })
})

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

/** A Dataset wired to one of the two nodes, and nothing else. */
function graph(type: string, params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('roi-summary-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('roi', type, params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'roi',
    targetHandle: 'dataset',
  })
  return g
}

describe('neuron.roiCompleteness', () => {
  it('answers from a Dataset alone, with no neurons wired', async () => {
    // The distinguishing property of both nodes: they ask about the volume, not about a body
    // id list, so they are the only query nodes that run with one wire.
    const scheduler = makeScheduler()
    await scheduler.run(graph('neuron.roiCompleteness'), { mode: 'full' })

    const out = scheduler.output('roi', 'completeness')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.length).toBeGreaterThan(0)
    expect(columnNames(out.schema)).toEqual([
      'roi',
      'pre',
      'post',
      'totalPre',
      'totalPost',
      'preCompleteness',
      'postCompleteness',
      'primary',
    ])
  })

  it('advertises the schema it returns, before anything has run', () => {
    // Fixed rather than discovered, unlike most query nodes here — so a column picker
    // downstream is populated the moment the wire is made rather than after the first Run.
    const out = inferGraph(graph('neuron.roiCompleteness')).nodes['roi']?.outputs[
      'completeness'
    ]
    expect(columnNames(schemaOf(out))).toContain('preCompleteness')
  })

  it('derives each fraction from the counts beside it', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(graph('neuron.roiCompleteness'), { mode: 'full' })
    const out = scheduler.output('roi', 'completeness')
    if (!isTableValue(out)) throw new Error('expected a table')

    const pre = getColumn(out, 'pre') as number[]
    const totalPre = getColumn(out, 'totalPre') as number[]
    const fraction = getColumn(out, 'preCompleteness') as number[]
    for (let row = 0; row < out.length; row++) {
      if (totalPre[row]! > 0) expect(fraction[row]).toBeCloseTo(pre[row]! / totalPre[row]!, 10)
    }
    // Not a flat 100%: a mock that answered "everything is reconstructed" would draw a bar
    // chart of identical bars and prove nothing about the arithmetic.
    expect(new Set(fraction).size).toBeGreaterThan(1)
    expect(Math.max(...fraction)).toBeLessThanOrEqual(1)
  })

  it('keeps a region whose summability is unknown, rather than dropping it', async () => {
    /*
     * Null `primary` means the source could not say — `Meta.primaryRois` had not arrived —
     * which is a different answer from "this region nests inside another one". Dropping those
     * would empty the table on a dataset whose metadata is merely late, and an empty result
     * reads as a dataset with no regions rather than as an answer nobody has yet.
     */
    const mock = new MockSource({ latencyMs: 0 })
    source = Object.assign(Object.create(Object.getPrototypeOf(mock) as object), mock, {
      fetchRoiCompleteness: async (req: { datasetId: string }) => {
        const table = await MockSource.prototype.fetchRoiCompleteness.call(mock, req)
        return {
          ...table,
          data: { ...table.data, primary: table.data['primary']!.map(() => null) },
        }
      },
    }) as DataSource

    const scheduler = makeScheduler()
    await scheduler.run(graph('neuron.roiCompleteness', { primaryOnly: true }), {
      mode: 'full',
    })
    const out = scheduler.output('roi', 'completeness')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.length).toBeGreaterThan(0)
  })

  it('drops the nested regions when the filter is on, and keeps them when it is off', async () => {
    // The mock's regions are flat, so nothing is nested and both runs agree — which is the
    // honest thing to assert against it. What the filter must never do is cut a primary row.
    const on = makeScheduler()
    await on.run(graph('neuron.roiCompleteness', { primaryOnly: true }), { mode: 'full' })
    const off = makeScheduler()
    await off.run(graph('neuron.roiCompleteness', { primaryOnly: false }), { mode: 'full' })

    const kept = on.output('roi', 'completeness')
    const all = off.output('roi', 'completeness')
    if (!isTableValue(kept) || !isTableValue(all)) throw new Error('expected tables')
    expect(kept.length).toBe(all.length)
    expect(new Set(getColumn(kept, 'primary'))).toEqual(new Set([true]))
  })
})

describe('neuron.roiConnectivity', () => {
  it('emits a matrix and a table describing one fetch', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(graph('neuron.roiConnectivity'), { mode: 'full' })

    const matrix = scheduler.output('roi', 'matrix')
    const links = scheduler.output('roi', 'links')
    if (!isMatrixValue(matrix)) throw new Error('expected a matrix')
    if (!isTableValue(links)) throw new Error('expected a table')

    // Square over the union of both ends: a region that only ever receives still needs a row,
    // or the diagonal stops meaning self-connection.
    expect(matrix.rowLabels).toEqual(matrix.colLabels)
    const named = new Set([...getColumn(links, 'source'), ...getColumn(links, 'target')])
    expect(new Set(matrix.rowLabels)).toEqual(named)

    /*
     * Every row of the table lands in the cell it names, holding whichever of the two published
     * numbers the node defaults to. Read off the definition rather than named here: which
     * measure leads is a product decision that has already moved once, and this test is about
     * the reshape landing in the right cell, not about which column it reshaped.
     */
    const measure = String(defaultParams(requireNodeDef('neuron.roiConnectivity')).measure)
    const index = new Map(matrix.rowLabels.map((l, i) => [l, i]))
    const source = getColumn(links, 'source')
    const target = getColumn(links, 'target')
    const drawn = getColumn(links, measure) as number[]
    for (let row = 0; row < links.length; row++) {
      const cell =
        matrix.values[
          index.get(String(source[row]))! * matrix.rowLabels.length +
            index.get(String(target[row]))!
        ]
      expect(cell).toBe(drawn[row])
    }
  })

  it('sorts its axes, because the value reaches a provenance key', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(graph('neuron.roiConnectivity'), { mode: 'full' })
    const matrix = scheduler.output('roi', 'matrix')
    if (!isMatrixValue(matrix)) throw new Error('expected a matrix')
    expect(matrix.rowLabels).toEqual([...matrix.rowLabels].sort())
  })

  it('switches which measure fills the cells without changing the table', async () => {
    const counts = makeScheduler()
    await counts.run(graph('neuron.roiConnectivity', { measure: 'count' }), { mode: 'full' })
    const weights = makeScheduler()
    await weights.run(graph('neuron.roiConnectivity', { measure: 'weight' }), { mode: 'full' })

    const a = counts.output('roi', 'matrix')
    const b = weights.output('roi', 'matrix')
    const linksA = counts.output('roi', 'links')
    const linksB = weights.output('roi', 'links')
    if (!isMatrixValue(a) || !isMatrixValue(b)) throw new Error('expected matrices')
    if (!isTableValue(linksA) || !isTableValue(linksB)) throw new Error('expected tables')

    // Both numbers always travel in the table; only the reshape chooses.
    expect(linksA.data).toEqual(linksB.data)
    expect(a.rowLabels).toEqual(b.rowLabels)
    expect([...a.values]).not.toEqual([...b.values])
  })

  it('has no primary-regions filter, unlike its sibling', () => {
    /*
     * Deliberate, and measured: `roiconnectivity`'s `roi_names` is exactly hemibrain's 63
     * `primary_rois`, so the endpoint has already restricted itself and a filter here would be
     * a control that never does anything. `roicompleteness` returns 229 rows over the same
     * dataset, which is why only that one has the param. Two nodes that look like a pair and
     * are not — asserted so nobody tidies them into agreement.
     */
    const def = requireNodeDef('neuron.roiConnectivity')
    expect((def.params ?? []).map((p) => p.id)).not.toContain('primaryOnly')
    expect((requireNodeDef('neuron.roiCompleteness').params ?? []).map((p) => p.id)).toContain(
      'primaryOnly',
    )
  })
})
