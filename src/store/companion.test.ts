/**
 * A dataset node arrives with its Description card.
 *
 * The behaviour is small; what it is easy to get wrong is everything around it. A companion that
 * takes two undos to remove, that reappears after being deleted, or that grows a second copy
 * every time a saved graph is opened would each be worse than not having one — the card is meant
 * to be a default, and a default that cannot be dismissed for good is a nag.
 *
 * Runs against a source registered under neuPrint's own id, so the real `dataset.hemibrain` node
 * resolves through it and nothing here reaches the network.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import type { DataSource, DatasetInfo } from '../data/source'
import { registerSource } from '../data/source'
import { buildStarter } from '../examples/starters'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

const HEMIBRAIN: DatasetInfo = {
  id: 'hemibrain:v1.2.1',
  label: 'hemibrain',
  description: 'A reconstruction of the female central brain.\n\n- Citation: someone (2020)',
  rois: [],
  statuses: ['Traced'],
  version: 'v1.2.1',
}

beforeAll(() => {
  const base: DataSource = new MockSource({ latencyMs: 0 })
  registerSource(
    Object.assign(Object.create(base) as DataSource, {
      id: 'neuprint',
      peekDatasets: () => [HEMIBRAIN],
      peekDataset: (id: string) => (id === HEMIBRAIN.id ? HEMIBRAIN : undefined),
      listDatasets: async () => [HEMIBRAIN],
    }),
  )
})

beforeEach(() => {
  clearStorage()
  useGraphStore.getState().newGraph()
})

const graph = () => useGraphStore.getState().graph
const typesIn = () => graph().nodes.map((n) => n.type)

function add(type: string, at = { x: 100, y: 100 }): string {
  return useGraphStore.getState().addNode(type, at)
}

describe('adding a dataset node', () => {
  it('brings a Description card wired to it', () => {
    const id = add('dataset.hemibrain')
    expect(typesIn()).toEqual(['dataset.hemibrain', 'dataset.description'])

    const card = graph().nodes.find((n) => n.type === 'dataset.description')!
    expect(graph().edges).toHaveLength(1)
    expect(graph().edges[0]).toMatchObject({
      source: id,
      sourceHandle: 'dataset',
      target: card.id,
      targetHandle: 'dataset',
    })
  })

  it('places the card below the node rather than where the pipeline goes', () => {
    const id = add('dataset.hemibrain', { x: 40, y: 60 })
    const host = graph().nodes.find((n) => n.id === id)!
    const card = graph().nodes.find((n) => n.type === 'dataset.description')!
    expect(card.position.x).toBe(host.position.x)
    expect(card.position.y).toBeGreaterThan(host.position.y)
  })

  it('leaves the selection on the node that was asked for', () => {
    const id = add('dataset.hemibrain')
    expect(useGraphStore.getState().selection).toEqual([id])
  })

  it('undoes as one step, not two', () => {
    add('dataset.hemibrain')
    useGraphStore.getState().undo()
    // Both nodes and the edge go together: an add that takes two undos reads as a bug.
    expect(graph().nodes).toHaveLength(0)
    expect(graph().edges).toHaveLength(0)
  })

  it('comes with one for the custom node too, which can point anywhere', () => {
    add('dataset.neuprint')
    expect(typesIn()).toContain('dataset.description')
  })
})

describe('what does not get one', () => {
  it('leaves the synthetic datasets alone — nobody to cite for a generated connectome', () => {
    add('dataset.mock.opticlobe')
    expect(typesIn()).toEqual(['dataset.mock.opticlobe'])
  })

  it('adds nothing beside an ordinary node', () => {
    add('out.table')
    expect(typesIn()).toEqual(['out.table'])
  })

  it('never grows one on load, so a saved graph reproduces exactly', () => {
    const def = requireNodeDef('dataset.hemibrain')
    const saved = addNode(emptyGraph('saved'), {
      id: 'ds',
      type: def.type,
      position: { x: 0, y: 0 },
      params: defaultParams(def),
    })
    useGraphStore.getState().loadGraph(saved)
    expect(typesIn()).toEqual(['dataset.hemibrain'])
  })

  it('stays deleted once deleted — it is a default, not a fixture', () => {
    add('dataset.hemibrain')
    const card = graph().nodes.find((n) => n.type === 'dataset.description')!
    useGraphStore.getState().deleteNodes([card.id])
    // Any later edit re-infers the whole graph, which is where a "repair" would creep in.
    useGraphStore.getState().setGraphName('after')
    expect(typesIn()).toEqual(['dataset.hemibrain'])
  })
})

describe('starter graphs', () => {
  it('open with the card, since a starter is the first graph most people see', () => {
    const built = buildStarter({
      nodeType: 'dataset.hemibrain',
      label: 'Hemibrain',
      sourceId: 'neuprint',
    })
    expect(built.nodes.map((n) => n.type)).toContain('dataset.description')
    const card = built.nodes.find((n) => n.type === 'dataset.description')!
    expect(built.edges.some((e) => e.target === card.id && e.targetHandle === 'dataset')).toBe(
      true,
    )
  })

  it('opens a mock starter without one', () => {
    const built = buildStarter({
      nodeType: 'dataset.mock.opticlobe',
      label: 'Mini',
      sourceId: 'mock',
    })
    expect(built.nodes.map((n) => n.type)).not.toContain('dataset.description')
  })
})

describe('the Description node itself', () => {
  it('is a dead end, so nobody wires a pipeline through the credits', () => {
    const def = requireNodeDef('dataset.description')
    expect(def.outputs ?? []).toHaveLength(0)
    expect((def.inputs ?? []).map((p) => p.id)).toEqual(['dataset'])
  })

  it('is offered on its own, so deleting one is not final', () => {
    const def = requireNodeDef('dataset.description')
    expect(def.hidden).toBeUndefined()
    expect(def.category).toBe('dataset')
  })
})
