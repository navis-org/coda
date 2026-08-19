/**
 * The Select One contract.
 *
 * Two properties carry the design and neither shows up in the widget: **stepping must not
 * invalidate anything while committing must**, and **an index past the end emits nothing rather
 * than the nearest element**. The first is the reason the node exists in this shape at all — get
 * it wrong and the symptom is a graph going stale whenever somebody browses, which reads as a
 * scheduler bug. The second is the honest half of choosing a position over an identity: the
 * alternative is a different neuron arriving under the same number with nothing saying it moved.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { schemaOf } from '../../core/types'
import { isMeshesValue, isSkeletonsValue, isTableValue } from '../../core/values'
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

/** dataset → find(LC.*) → selectOne, with an optional geometry node in between. */
function pipeline(params: Record<string, unknown> = {}, via?: 'skeletons' | 'meshes'): CodaGraph {
  let g = emptyGraph('select-one-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  // Narrowed for the geometry branches: `Max neurons` on the morphology nodes is a refusal
  // ceiling, not a truncation, so a wide population errors there rather than fetching a few.
  const pattern = via ? 'LC4' : 'LC.*'
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: pattern, status: 'Traced' }))
  g = addNode(g, node('pick', 'core.selectOne', params))
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })

  if (!via) {
    g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'pick', targetHandle: 'in' })
    return g
  }

  const type = via === 'skeletons' ? 'neuron.skeletons' : 'neuron.meshes'
  const port = via === 'skeletons' ? 'skeletons' : 'meshes'
  g = addNode(g, node('geo', type, { limit: 100 }))
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'geo', targetHandle: 'dataset' })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'geo', targetHandle: 'neurons' })
  g = addEdge(g, { source: 'geo', sourceHandle: port, target: 'pick', targetHandle: 'in' })
  return g
}

describe('core.selectOne — types', () => {
  it('passes the input type through, so nothing downstream loses a column picker', () => {
    // Taking one element changes the length, never the kind or the schema. A Neurons edge that
    // came out as a plain Table would cost every node after it the bodyId guarantee.
    const inference = inferGraph(pipeline())
    expect(inference.nodes['pick']?.outputs['item']?.kind).toBe('neurons')
    expect(
      schemaOf(inference.nodes['pick']?.outputs['item'])?.columns.map((c) => c.name),
    ).toContain('bodyId')
  })

  it('carries a geometry kind through as itself', () => {
    expect(inferGraph(pipeline({}, 'skeletons')).nodes['pick']?.outputs['item']?.kind).toBe(
      'skeletons',
    )
    expect(inferGraph(pipeline({}, 'meshes')).nodes['pick']?.outputs['item']?.kind).toBe('meshes')
  })

  it('takes an any port, because the type system cannot say "a collection"', () => {
    const def = requireNodeDef('core.selectOne')
    expect(def.inputs?.find((p) => p.id === 'in')?.type.kind).toBe('any')
  })
})

describe('core.selectOne — validation', () => {
  function issues(graph: CodaGraph, id: string): string[] {
    return (inferGraph(graph).nodes[id]?.issues ?? []).map((issue) => issue.message)
  }

  it('says nothing about a collection it can step through', () => {
    expect(issues(pipeline(), 'pick')).toEqual([])
    expect(issues(pipeline({}, 'meshes'), 'pick')).toEqual([])
  })

  it('adds nothing of its own to an empty socket', () => {
    /*
     * An unwired input is a graph somebody has not finished, and the framework already says so
     * ("Input \"Items\" is not connected") — so this node's `validate` must stay quiet rather
     * than complaining a second time about the same fact. Two messages about one thing is how
     * the real one stops being read.
     */
    let g = emptyGraph('unwired')
    g = addNode(g, node('pick', 'core.selectOne'))
    expect(issues(g, 'pick')).toEqual(['Input "Items" is not connected'])
  })

  it('names the kind when what arrived has no elements', () => {
    // The refusal is a validation question rather than a link the editor silently declines,
    // which is the same call `out.profile` makes about needing a bodyId.
    let g = emptyGraph('matrix-in')
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
    g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*' }))
    g = addNode(g, node('conn', 'neuron.connectivity'))
    g = addNode(g, node('piv', 'core.pivot', {
      rows: 'preType', columns: 'postType', value: 'weight', agg: 'sum',
    }))
    g = addNode(g, node('pick', 'core.selectOne'))
    g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })
    g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'conn', targetHandle: 'dataset' })
    g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'conn', targetHandle: 'neurons' })
    g = addEdge(g, { source: 'conn', sourceHandle: 'edges', target: 'piv', targetHandle: 'in' })
    g = addEdge(g, { source: 'piv', sourceHandle: 'matrix', target: 'pick', targetHandle: 'in' })

    const reported = issues(g, 'pick')
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('matrix')
  })
})

describe('core.selectOne — evaluate', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = makeScheduler()
  })

  it('emits the chosen row, at full width', async () => {
    await scheduler.run(pipeline({ selected: 2 }), { mode: 'full' })
    const all = scheduler.output('find', 'neurons')
    const item = scheduler.output('pick', 'item')
    if (!isTableValue(all) || !isTableValue(item)) throw new Error('expected tables')

    expect(item.length).toBe(1)
    expect(item.data['bodyId']?.[0]).toBe(all.data['bodyId']?.[2])
    // Full width, not just an id — the point is that the element is usable downstream.
    expect(item.schema.columns.length).toBe(all.schema.columns.length)
    expect(item.kind).toBe('neurons')
  })

  it('emits nothing rather than the nearest element when the index is past the end', async () => {
    // The state an upstream filter leaves behind. Clamping would answer with a different neuron
    // under the same number, which is the one failure this node must not have.
    await scheduler.run(pipeline({ selected: 99_999 }), { mode: 'full' })
    const item = scheduler.output('pick', 'item')
    if (!isTableValue(item)) throw new Error('expected a table')
    expect(item.length).toBe(0)
    // Still the same schema, so a column picker downstream does not empty out.
    expect(item.schema.columns.length).toBeGreaterThan(0)
  })

  it('takes one skeleton and re-measures its bounds', async () => {
    await scheduler.run(pipeline({ selected: 1 }, 'skeletons'), { mode: 'full' })
    const all = scheduler.output('geo', 'skeletons')
    const item = scheduler.output('pick', 'item')
    if (!isSkeletonsValue(all) || !isSkeletonsValue(item)) throw new Error('expected skeletons')

    expect(all.items.length).toBeGreaterThan(1)
    expect(item.items.length).toBe(1)
    expect(item.items[0]?.bodyId).toBe(all.items[1]?.bodyId)
    // The attribute table is one row per item in the same order, so both halves must move.
    expect(item.attributes.length).toBe(1)
    expect(item.attributes.data['bodyId']?.[0]).toBe(all.attributes.data['bodyId']?.[1])
    /*
     * Bounds are a roll-up, exactly as a network's degrees are. One skeleton still claiming the
     * box of the four it came from frames a 3D viewer on empty space around it, which reads as
     * a broken renderer rather than as a selection.
     */
    expect(item.bounds).not.toEqual(all.bounds)
    for (let axis = 0; axis < 3; axis++) {
      expect(item.bounds.min[axis]!).toBeGreaterThanOrEqual(all.bounds.min[axis]!)
      expect(item.bounds.max[axis]!).toBeLessThanOrEqual(all.bounds.max[axis]!)
    }
  })

  it('takes one mesh and keeps the level of detail', async () => {
    await scheduler.run(pipeline({ selected: 0 }, 'meshes'), { mode: 'full' })
    const all = scheduler.output('geo', 'meshes')
    const item = scheduler.output('pick', 'item')
    if (!isMeshesValue(all) || !isMeshesValue(item)) throw new Error('expected meshes')

    expect(item.items.length).toBe(1)
    expect(item.attributes.length).toBe(1)
    // The LOD is a fact about the fetch, and taking one neuron out does not re-fetch it — so
    // the viewer's `mesh LOD n/m` caption must not disappear on a selection.
    expect(item.detail).toEqual(all.detail)
  })
})

describe('core.selectOne — provenance', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = makeScheduler()
  })

  it('stepping is free — the view index leaves the node ok and re-runs nothing', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    const stepped = setNodeParam(graph, 'pick', 'index', 5)
    scheduler.refreshStates(stepped)
    expect(scheduler.info('pick').state).toBe('ok')

    const summary = await scheduler.run(stepped, { mode: 'full' })
    expect(summary.executed).toEqual([])
  })

  it('the Live mode itself is free, because evaluate never reads it', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    // `live` decides what the *buttons write*, not what comes out. In the key it would make
    // switching modes invalidate every downstream result — the Download-filename bug.
    const toggled = setNodeParam(graph, 'pick', 'live', true)
    scheduler.refreshStates(toggled)
    expect(scheduler.info('pick').state).toBe('ok')
  })

  it('committing is a decision — the emitted index marks the node stale', async () => {
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    const committed = setNodeParam(graph, 'pick', 'selected', 3)
    scheduler.refreshStates(committed)
    expect(scheduler.info('pick').state).toBe('stale')
  })

  it('marks the split on the params themselves', () => {
    // Asserted directly as well as through the scheduler: dropping either flag fails no type
    // check, and the symptom lands nowhere near this node.
    const params = requireNodeDef('core.selectOne').params ?? []
    expect(params.find((p) => p.id === 'index')?.presentational).toBe(true)
    expect(params.find((p) => p.id === 'index')?.internal).toBe(true)
    expect(params.find((p) => p.id === 'live')?.presentational).toBe(true)
    expect(params.find((p) => p.id === 'selected')?.presentational).toBeFalsy()
    // A committed choice is a decision, so it stays countable in the card's "… 1 changed" hint.
    expect(params.find((p) => p.id === 'selected')?.internal).toBeFalsy()
  })

  it('is cheap, because evaluate touches no network', () => {
    expect(requireNodeDef('core.selectOne').cost).toBe('cheap')
  })
})
