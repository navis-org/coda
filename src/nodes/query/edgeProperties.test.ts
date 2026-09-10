/**
 * Edge properties on the three nodes that read a connection, through the real scheduler against
 * the mock — whose two properties are one of each shape fish2 has: `weightAxonDendrite` broken
 * down by region, `weightHP` not.
 *
 * `data/neuprint/edgeProperties.test.ts` pins the query text. This is the half it cannot see: the
 * columns a card advertises being the ones its run builds (invariant 3), the parts of a split
 * adding back to the whole, a property with no breakdown coming back empty rather than repeated
 * on every region's row, and each card saying what is wrong before anybody presses Run.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import type { TableValue } from '../../core/values'
import { isMatrixValue, isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource, requireSource } from '../../data/source'
import { readEdgeProperties } from '../lib/connectivityOps'
import '../index'
import { searchFor } from '../../test/findNeurons'
import { node } from '../../test/graph'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

const BOTH = ['weightAxonDendrite', 'weightHP']
/** A seed type whose every connection has a regional breakdown — `connectivity.test.ts`' pick. */
const SPLITTING_TYPE = 'Dm8'

function wire(g: CodaGraph, source: string, handle: string, target: string, into: string) {
  return addEdge(g, { source, sourceHandle: handle, target, targetHandle: into })
}

/** dataset → find → the node under test, on the given ports. */
function graph(
  type: string,
  params: Record<string, unknown>,
  ports: Record<string, 'dataset' | 'neurons'>,
  seedType = 'LC4',
): CodaGraph {
  let g = emptyGraph('edge-properties')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(
    g,
    node('find', 'neuron.findNeurons', searchFor({ type: seedType, status: 'Traced' })),
  )
  g = addNode(g, node('n', type, params))
  g = wire(g, 'ds', 'dataset', 'find', 'dataset')
  for (const [port, from] of Object.entries(ports)) {
    g = wire(g, from === 'dataset' ? 'ds' : 'find', from, 'n', port)
  }
  return g
}

const connectivity = (params: Record<string, unknown> = {}, seedType?: string) =>
  graph('neuron.connectivity', params, { dataset: 'dataset', neurons: 'neurons' }, seedType)

async function run(g: CodaGraph): Promise<Scheduler> {
  const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
  await sched.run(g, { mode: 'full' })
  return sched
}

async function connections(params: Record<string, unknown>, seedType?: string) {
  const table = (await run(connectivity(params, seedType))).output('n', 'connections')
  if (!isTableValue(table)) throw new Error(`expected a table, got ${JSON.stringify(table)}`)
  return table
}

function advertised(params: Record<string, unknown>): string[] | undefined {
  const declared = inferGraph(connectivity(params)).nodes.n?.outputs.connections
  return declared && 'schema' in declared
    ? declared.schema?.columns.map((c) => c.name)
    : undefined
}

function issues(g: CodaGraph): string[] {
  return (inferGraph(g).nodes.n?.issues ?? []).map((i) => i.message)
}

/** A property's total per connection, over however many rows the connection came back as. */
function perPair(table: TableValue, column: string): Map<string, number> {
  const sums = new Map<string, number>()
  for (let row = 0; row < table.length; row++) {
    const key = `${table.data.preId?.[row]}>${table.data.postId?.[row]}`
    sums.set(key, (sums.get(key) ?? 0) + Number(table.data[column]?.[row] ?? 0))
  }
  return sums
}

describe('Connectivity — Edge properties', () => {
  it('advertises the columns it builds, after the weight and before hop', async () => {
    const params = { edgeProperties: BOTH }
    const built = (await connections(params)).schema.columns.map((c) => c.name)
    expect(advertised(params)).toEqual(built)
    expect(built.indexOf('weightAxonDendrite')).toBe(built.indexOf('weight') + 1)
    expect(built.indexOf('weightHP')).toBeLessThan(built.indexOf('hop'))
  })

  it('adds nothing when none are chosen, which is every graph saved before the control', async () => {
    const built = (await connections({})).schema.columns.map((c) => c.name)
    expect(built).not.toContain('weightAxonDendrite')
    expect(advertised({})).toEqual(built)
  })

  it('fills every row, a compartment count never above the weight', async () => {
    const table = await connections({ edgeProperties: BOTH })
    expect(table.length).toBeGreaterThan(0)
    for (let row = 0; row < table.length; row++) {
      const part = table.data.weightAxonDendrite?.[row]
      expect(typeof part).toBe('number')
      expect(part as number).toBeLessThanOrEqual(Number(table.data.weight?.[row]))
      expect(typeof table.data.weightHP?.[row]).toBe('number')
    }
  })

  it('splits a regional property with the connection: the parts add back to the whole', async () => {
    const params = { edgeProperties: BOTH }
    const whole = perPair(await connections(params, SPLITTING_TYPE), 'weightAxonDendrite')
    const split = await connections({ ...params, splitByRoi: true }, SPLITTING_TYPE)
    const parts = perPair(split, 'weightAxonDendrite')
    expect([...parts.keys()].sort()).toEqual([...whole.keys()].sort())
    for (const [pair, value] of whole) expect(parts.get(pair)).toBe(value)
    // Strictly more rows, or nothing was split and the equality above is vacuous.
    expect(split.length).toBeGreaterThan(whole.size)
  })

  it('leaves a property with no breakdown empty per region, never the whole value repeated', async () => {
    const split = await connections({ edgeProperties: BOTH, splitByRoi: true }, SPLITTING_TYPE)
    expect(split.length).toBeGreaterThan(0)
    expect(split.data.weightHP?.every((cell) => cell === null)).toBe(true)
  })

  it('says so on the card, and says nothing about a property that does split', () => {
    const whole = issues(connectivity({ edgeProperties: ['weightHP'], splitByRoi: true }))
    expect(whole.some((m) => m.startsWith('weightHP is not broken down by region'))).toBe(true)
    expect(
      issues(connectivity({ edgeProperties: ['weightAxonDendrite'], splitByRoi: true })),
    ).toEqual([])
  })

  it('names a property the dataset does not publish, and what it does publish', () => {
    const said = issues(connectivity({ edgeProperties: ['weightNope'] }))
    expect(
      said.some(
        (m) => m.includes('"weightNope"') && m.includes('weightAxonDendrite, weightHP'),
      ),
    ).toBe(true)
  })

  it('changes the cache key, so choosing a property does not serve the table without it', async () => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(connectivity({}), { mode: 'full' })
    await sched.run(connectivity({ edgeProperties: ['weightHP'] }), { mode: 'full' })
    const table = sched.output('n', 'connections')
    if (!isTableValue(table)) throw new Error('expected a table')
    expect(table.data.weightHP).toBeDefined()
  })

  it('never sends a name the edge list already spends on something else', () => {
    expect(readEdgeProperties(['hop', 'weightHP', '', 'weightHP', 'preId', 3])).toEqual([
      'weightHP',
    ])
  })
})

describe('Adjacency — Weight', () => {
  function adjacency(params: Record<string, unknown> = {}): CodaGraph {
    let g = graph(
      'neuron.adjacency',
      params,
      { dataset: 'dataset', sources: 'neurons' },
      'LC.*',
    )
    g = addNode(g, node('all', 'neuron.findNeurons', searchFor({ type: '', status: 'Traced' })))
    g = wire(g, 'ds', 'dataset', 'all', 'dataset')
    return wire(g, 'all', 'neurons', 'n', 'targets')
  }

  async function matrix(params: Record<string, unknown>) {
    const value = (await run(adjacency(params))).output('n', 'matrix')
    if (!isMatrixValue(value)) throw new Error('expected a matrix')
    return value
  }

  it('fills each cell from the chosen property, on the same axes as the weight', async () => {
    const plain = await matrix({})
    const byProperty = await matrix({ weight: 'weightAxonDendrite' })
    expect(byProperty.rowLabels).toEqual(plain.rowLabels)
    expect(byProperty.colLabels).toEqual(plain.colLabels)
    let total = 0
    let partial = 0
    plain.values.forEach((value, i) => {
      const cell = byProperty.values[i] ?? 0
      expect(cell).toBeLessThanOrEqual(value)
      total += value
      partial += cell
    })
    // Neither the weight again nor nothing at all.
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(total)
  })

  it('names a property the dataset does not publish on the card', () => {
    expect(
      issues(adjacency({ weight: 'weightNope' })).some((m) => m.includes('"weightNope"')),
    ).toBe(true)
    expect(issues(adjacency({}))).toEqual([])
  })
})

describe('Neuron Profile — Count by', () => {
  const profile = (params: Record<string, unknown>) =>
    graph('out.profile', params, { dataset: 'dataset', neurons: 'neurons' })

  it('names a property the dataset does not publish on the card', () => {
    expect(
      issues(profile({ countBy: 'weightNope' })).some((m) => m.includes('"weightNope"')),
    ).toBe(true)
    expect(issues(profile({ countBy: 'weightAxonDendrite' }))).toEqual([])
  })

  it('stays presentational, so choosing one re-runs nothing', () => {
    const param = requireNodeDef('out.profile').params?.find((p) => p.id === 'countBy')
    expect(param?.presentational).toBe(true)
  })
})
