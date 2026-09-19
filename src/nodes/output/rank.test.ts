/**
 * The Rank Plot node's contract.
 *
 * The ranking and the share are `rankSeries.test.ts`'. What is pinned here is the part only the
 * node decides, and each is a thing no type check sees:
 *
 *  - the table passes through **by identity**, which is what makes every drawing control
 *    presentational and therefore what stops a restyle staling the query above it;
 *  - `Selected` resolves by id rather than by rank, so it survives an upstream re-run;
 *  - both ports keep the input's `neurons`-ness, so a selected head of the ranking wires
 *    straight back into a query;
 *  - and `validate` catches the one pairing the resolver cannot see — a column that is already
 *    a logarithm, logged again.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultOutputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { getColumn, isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import '../index'
import { searchFor } from '../../test/findNeurons'
import { node } from '../../test/graph'

const source: DataSource = new MockSource({ latencyMs: 0 })

/** dataset → find(LC.*) → connectivity → out.rank */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('rank-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(
    g,
    node('find', 'neuron.findNeurons', searchFor({ type: 'LC.*', status: 'Traced' })),
  )
  g = addNode(g, node('conn', 'neuron.connectivity', { direction: 'downstream', minWeight: 3 }))
  g = addNode(g, node('rank', 'out.rank', { value: 'weight', ...params }))
  for (const [from, handle, to, target] of [
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'conn', 'dataset'],
    ['find', 'neurons', 'conn', 'neurons'],
    ['conn', 'connections', 'rank', 'in'],
  ] as const) {
    g = addEdge(g, { source: from, sourceHandle: handle, target: to, targetHandle: target })
  }
  return g
}

async function run(graph: CodaGraph) {
  const scheduler = new Scheduler({ resolveSource: () => source })
  await scheduler.run(graph, { mode: 'full' })
  return scheduler
}

describe('out.rank — types', () => {
  it('keeps Table as the first output, so a dragged link continues the chain', () => {
    expect(defaultOutputPorts(requireNodeDef('out.rank')).map((p) => p.id)).toEqual([
      'out',
      'selected',
    ])
  })

  it('is cheap: nothing here fetches and nothing here computes over a value', () => {
    expect(requireNodeDef('out.rank').cost).toBe('cheap')
  })

  it('passes the input type through whole on both ports, before anything runs', () => {
    const types = inferGraph(pipeline()).nodes['rank']
    expect(types?.outputs['out']).toEqual(types?.inputs['in'])
    // `Selected` is a subset of the same rows, so it is the same type — which is what lets a
    // picker downstream of it fill at edit time.
    expect(types?.outputs['selected']).toEqual(types?.inputs['in'])
  })

  /**
   * `out.scatter`'s split exactly, and the reason is invariant 4: `idColumn` decides what a
   * selected point is *called*, so it decides which rows `Selected` carries. Marking it
   * presentational would let a stale downstream result survive a change to the very thing
   * identifying the rows.
   */
  it('marks everything presentational but the selection and the id column', () => {
    const def = requireNodeDef('out.rank')
    const plain = (def.params ?? []).filter((p) => p.presentational !== true).map((p) => p.id)
    expect(plain).toEqual(['idColumn', 'selection'])
  })

  it('leaves the flag picker optional, so an empty one flags nothing', () => {
    // `resolveColumn` rule 3 hands a *required* picker still on its declared default the first
    // compatible column — which here would ring rows by whatever column came first.
    const def = requireNodeDef('out.rank')
    const flag = (def.params ?? []).find((p) => p.id === 'flagColumn')
    expect(flag).toMatchObject({ optional: true, default: '' })
  })
})

/**
 * Over a real Influence chain, because that is the table this catches a mistake on and its
 * schema is declared at edit time — `influenceSchema` names both columns before anything runs,
 * so no query is needed to reach the case.
 */
function influenceChain(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('rank-log-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', searchFor({ type: 'LC4' })))
  g = addNode(g, node('inf', 'neuron.influence', {}))
  g = addNode(g, node('rank', 'out.rank', params))
  for (const [from, handle, to, target] of [
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'inf', 'dataset'],
    ['find', 'neurons', 'inf', 'neurons'],
    ['inf', 'influence', 'rank', 'in'],
  ] as const) {
    g = addEdge(g, { source: from, sourceHandle: handle, target: to, targetHandle: target })
  }
  return g
}

const messages = (graph: CodaGraph) =>
  (inferGraph(graph).nodes['rank']?.issues ?? []).map((issue) => issue.message)

describe('out.rank — validate', () => {
  it('says nothing on an ordinary numeric column', () => {
    expect(messages(influenceChain({ value: 'influence' }))).toEqual([])
  })

  it('catches a column that is already a logarithm', () => {
    // An Influence table carries both `influence` and `influenceLog`, and the second is
    // `log(max(x, e^-24)) + 24`. Logged again it is very nearly a straight line whatever the
    // data does — a clean-looking power law for reasons that have nothing to do with the
    // connectome, which is the worst kind of wrong figure: a plausible one.
    expect(messages(influenceChain({ value: 'influenceLog', valueLog: true }))).toContainEqual(
      expect.stringMatching(/already a logarithm/),
    )
  })

  it('says nothing about it once the log is off', () => {
    expect(messages(influenceChain({ value: 'influenceLog', valueLog: false }))).toEqual([])
  })
})

describe('out.rank — evaluate', () => {
  it('hands the table on by identity, not as a copy', async () => {
    const scheduler = await run(pipeline())
    const arrived = scheduler.output('conn', 'connections')
    const left = scheduler.output('rank', 'out')
    expect(isTableValue(left)).toBe(true)
    expect(left).toBe(arrived)
  })

  it('emits nothing on Selected until something is clicked', async () => {
    const scheduler = await run(pipeline())
    const selected = scheduler.output('rank', 'selected')
    expect(isTableValue(selected)).toBe(true)
    if (isTableValue(selected)) expect(selected.length).toBe(0)
  })

  it('resolves a selection by id, in the table’s own order', async () => {
    const before = await run(pipeline()).then((scheduler) =>
      scheduler.output('conn', 'connections'),
    )
    expect(isTableValue(before)).toBe(true)
    if (!isTableValue(before)) return
    const all = getColumn(before, 'preId').map(String)
    // A connectivity table is one row per *connection*, so an id names several rows. Picking the
    // second distinct id and asking for it back is the case: a selection names rows, not ids.
    const wanted = [...new Set(all)][1]!
    const expected = all.filter((id) => id === wanted)
    expect(expected.length).toBeGreaterThan(1)

    const scheduler = await run(pipeline({ idColumn: 'preId', selection: [wanted] }))
    const selected = scheduler.output('rank', 'selected')
    expect(isTableValue(selected)).toBe(true)
    if (!isTableValue(selected)) return
    // Every row the id names, in the table's own order — a subset is a subset, which is what
    // every node downstream already expects.
    expect(getColumn(selected, 'preId').map(String)).toEqual(expected)
  })

  it('ignores a selected id the table no longer has, rather than blocking', async () => {
    // Invariant 5's corollary: a stale control is no reason for `evaluate` to stop everything
    // downstream. An upstream filter that removed the row somebody clicked is the case.
    const scheduler = await run(pipeline({ selection: ['not-a-row'] }))
    expect(scheduler.info('rank').state).toBe('ok')
    const selected = scheduler.output('rank', 'selected')
    if (isTableValue(selected)) expect(selected.length).toBe(0)
  })

  it('does not refuse over an unpicked Value column', async () => {
    // `out` is the input unchanged, so a drawing that cannot be configured must not block the
    // pipeline — the failure `out.scatter` and `out.barChart` each record.
    const scheduler = await run(pipeline({ value: '' }))
    expect(scheduler.info('rank').state).toBe('ok')
    expect(scheduler.output('rank', 'out')).toBe(scheduler.output('conn', 'connections'))
  })
})
