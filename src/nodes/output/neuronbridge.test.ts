/**
 * The NeuronBridge node's contract, which is Neuron Profile's: a tap whose pass-through keeps the
 * edge's kind, whose browsing invalidates nothing and whose pinning does — and which never fetches
 * in `evaluate`, so `fetch` is made to fail throughout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, schemaOf } from '../../core/types'
import { getColumn } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import '../index'
import { searchFor } from '../../test/findNeurons'
import { node } from '../../test/graph'
import { mockScheduler } from '../../test/scheduler'
import type { NbPin } from '../lib/neuronbridgePins'
import { PINNED_SCHEMA, encodePin } from '../lib/neuronbridgePins'

const PIN: NbPin = {
  neuronId: '1734350788',
  line: 'SS02800',
  collection: 'FlyLight Split-GAL4 Omnibus Broad',
  method: 'cds',
  score: 50000,
  pppmRank: null,
  matchingPixels: 424,
  mirrored: true,
  area: 'Brain',
  slideCode: '20150415_32_J1',
  objective: '63x',
  lmImageId: '2711777482658283531',
  emLibrary: 'FlyEM_Hemibrain_v1.2.1',
  nbVersion: 'v3_10_0',
}

/** dataset → find → neuronbridge, on the mock connectome. */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('neuronbridge-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', searchFor({ type: 'LC.*' })))
  g = addNode(g, node('nb', 'out.neuronbridge', params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'nb',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'nb',
    targetHandle: 'neurons',
  })
  return g
}

const def = requireNodeDef('out.neuronbridge')

function validate(dataset: ReturnType<typeof T.dataset>) {
  return def.validate!(makeInferContext(def, {}, { dataset }))
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('out.neuronbridge must not fetch outside its widget')
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('out.neuronbridge', () => {
  it('passes a Neurons edge through as Neurons, and declares the Pinned schema before a run', () => {
    const inference = inferGraph(pipeline())
    expect(inference.nodes['nb']?.outputs['out']?.kind).toBe('neurons')
    expect(schemaOf(inference.nodes['nb']?.outputs['pinned'])).toEqual(PINNED_SCHEMA)
  })

  it('says a dataset NeuronBridge does not cover, and names the ones it does', () => {
    const messages = (inferGraph(pipeline()).nodes['nb']?.issues ?? []).map((i) => i.message)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/NeuronBridge has no matches for .*It covers hemibrain/)
    // Warnings, never errors: the table still passes through and the card still pages.
    expect(
      inferGraph(pipeline()).nodes['nb']?.issues.every((i) => i.severity === 'warning'),
    ).toBe(true)
  })

  it('says nothing about a covered dataset, whatever its version', () => {
    expect(validate(T.dataset('neuprint', 'hemibrain:v1.2.1'))).toEqual([])
    expect(validate(T.dataset('neuprint', 'male-cns:v1.0'))).toEqual([])
    expect(validate(T.dataset('cave', 'flywire_fafb_public:783'))).toEqual([])
  })

  it('passes the table through untouched and emits the pins, with no request', async () => {
    const scheduler = mockScheduler(new MockSource({ latencyMs: 0 }))
    await scheduler.run(pipeline({ pins: [encodePin(PIN), 'garbage'] }), { mode: 'full' })
    expect(scheduler.output('nb', 'out')).toBe(scheduler.output('find', 'neurons'))
    const pinned = scheduler.output('nb', 'pinned')
    expect(pinned && 'schema' in pinned ? pinned.schema : undefined).toEqual(PINNED_SCHEMA)
    expect(pinned && 'data' in pinned ? getColumn(pinned, 'line') : []).toEqual(['SS02800'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('browsing is free — paging, chips, method, step and version re-run nothing', async () => {
    const scheduler = mockScheduler(new MockSource({ latencyMs: 0 }))
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    let browsed = setNodeParam(graph, 'nb', 'page', 3)
    browsed = setNodeParam(browsed, 'nb', 'collections', ['split'])
    browsed = setNodeParam(browsed, 'nb', 'method', 'pppm')
    browsed = setNodeParam(browsed, 'nb', 'tiles', 48)
    browsed = setNodeParam(browsed, 'nb', 'version', 'v3_10_0')
    scheduler.refreshStates(browsed)
    expect(scheduler.info('nb').state).toBe('ok')
    expect((await scheduler.run(browsed, { mode: 'full' })).executed).toEqual([])
  })

  it('pinning is a decision — a pin marks the node stale', async () => {
    const scheduler = mockScheduler(new MockSource({ latencyMs: 0 }))
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })
    const pinned = setNodeParam(graph, 'nb', 'pins', [encodePin(PIN)])
    scheduler.refreshStates(pinned)
    expect(scheduler.info('nb').state).toBe('stale')
  })
})
