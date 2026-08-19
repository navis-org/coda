/**
 * The dataset nodes.
 *
 * These are the entry point of every graph, so the things checked here are the ones whose
 * failure would be invisible: that the version a node resolves is the version it queries, that a
 * pinned version survives, and that the legacy generic node still loads.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { inferGraph } from '../../core/inference'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { EnumOption, ParamValues } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { getNodeDef, requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { datasetRef } from '../../core/types'
import { isDatasetValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource, requireSource } from '../../data/source'
import { NeuPrintSource } from '../../data/neuprint/NeuPrintSource'
import { DEFAULT_SERVER } from '../../data/neuprint/servers'
import '../index'

beforeAll(async () => {
  await registerSource(new MockSource({ latencyMs: 0 })).listDatasets()
  // Registered but never listed: constructing one does no I/O, which is exactly the state every
  // neuPrint dataset node is in until a token exists and the first listing lands.
  registerSource(new NeuPrintSource())
})

function ctxFor(type: string, params: ParamValues = {}) {
  const def = requireNodeDef(type)
  return makeInferContext(def, { ...defaultParams(def), ...params }, {})
}

function node(type: string, params: ParamValues = {}) {
  const def = requireNodeDef(type)
  return { id: 'ds', type, position: { x: 0, y: 0 }, params: { ...defaultParams(def), ...params } }
}

/** The `version` param's options, resolved against the live registry. */
function versionOptions(type: string): EnumOption[] {
  const param = (requireNodeDef(type).params ?? []).find((p) => p.id === 'version')
  if (!param || param.kind !== 'enum') throw new Error(`${type} has no version enum`)
  return typeof param.options === 'function' ? param.options(ctxFor(type)) : param.options
}

describe('per-dataset nodes', () => {
  it('arrives already pointed at its dataset, with no source to choose', () => {
    const def = requireNodeDef('dataset.mock.hemibrain')
    expect(def.category).toBe('dataset')
    // Version is the only question left; the old node also asked which backend and which dataset.
    expect((def.params ?? []).filter((p) => !p.advanced).map((p) => p.id)).toEqual(['version'])
  })

  it('infers the dataset id its evaluate will use', () => {
    const def = requireNodeDef('dataset.mock.hemibrain')
    const types = def.inferOutputs!(ctxFor('dataset.mock.hemibrain'))
    expect(datasetRef(types['dataset'])).toEqual({
      sourceId: 'mock',
      datasetId: 'hemibrain-mini',
    })
  })

  it('offers Latest plus each listed version, with no duplicate values', () => {
    const values = versionOptions('dataset.mock.hemibrain').map((o) => o.value)
    expect(values[0]).toBe('')
    // A select with two options sharing a value cannot express which one is chosen.
    expect(new Set(values).size).toBe(values.length)
  })

  it('names the version that Latest currently resolves to', () => {
    // "Latest" with no version beside it is a provenance question mark on a shared graph.
    expect(versionOptions('dataset.mock.hemibrain')[0]?.label).toMatch(/Latest \(.+\)/)
  })

  it('reports a version the server does not offer', () => {
    const def = requireNodeDef('dataset.mock.hemibrain')
    const issues = def.validate!(ctxFor('dataset.mock.hemibrain', { version: 'v9.9' }))
    expect(issues[0]).toContain('v9.9')
  })

  it('stays quiet while the listing has not arrived', () => {
    // Otherwise every dataset node in the graph reports a missing version before the connection
    // panel has had a chance to say the real problem — no token — even once.
    const def = requireNodeDef('dataset.malecns')
    expect(def.validate!(ctxFor('dataset.malecns', { version: 'v1.0' }))).toEqual([])
  })

  it('still resolves a pinned version with no listing, so types survive a reload', () => {
    const def = requireNodeDef('dataset.malecns')
    const types = def.inferOutputs!(ctxFor('dataset.malecns', { version: 'v0.9' }))
    expect(datasetRef(types['dataset'])?.datasetId).toBe('male-cns:v0.9')
  })

  it('runs and emits a dataset value', async () => {
    const graph = addNode(emptyGraph('t'), node('dataset.mock.hemibrain'))
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(graph, { mode: 'full' })
    const value = sched.output('ds', 'dataset')
    expect(isDatasetValue(value) && value.datasetId).toBe('hemibrain-mini')
    expect(isDatasetValue(value) && value.sourceId).toBe('mock')
  })

  it('feeds a downstream query node', () => {
    let graph = addNode(emptyGraph('t'), node('dataset.mock.hemibrain'))
    graph = addNode(graph, {
      id: 'find',
      type: 'neuron.findNeurons',
      position: { x: 300, y: 0 },
      params: defaultParams(requireNodeDef('neuron.findNeurons')),
    })
    graph = addEdge(graph, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'find',
      targetHandle: 'dataset',
    })
    const inference = inferGraph(graph)
    expect(inference.ok).toBe(true)
    // The refinement is what lets column pickers populate before anything runs.
    expect(datasetRef(inference.nodes['find']?.inputs['dataset'])?.datasetId).toBe('hemibrain-mini')
  })
})

describe('Custom neuPrint', () => {
  it('defaults to the Janelia deployment', () => {
    const def = requireNodeDef('dataset.neuprint')
    const server = (def.params ?? []).find((p) => p.id === 'server')
    expect(server?.default).toBe(DEFAULT_SERVER)
  })

  it('asks for a dataset instead of silently producing nothing', () => {
    const def = requireNodeDef('dataset.neuprint')
    expect(def.validate!(ctxFor('dataset.neuprint'))[0]).toContain('Name a dataset')
  })

  it('registers a source for a deployment it has not seen before', () => {
    const def = requireNodeDef('dataset.neuprint')
    const types = def.inferOutputs!(
      ctxFor('dataset.neuprint', { server: 'https://neuprint-pre.janelia.org', dataset: 'x:v1' }),
    )
    const ref = datasetRef(types['dataset'])
    expect(ref?.sourceId).toBe('neuprint:https://neuprint-pre.janelia.org')
    // Inference is what registers it, so evaluate can resolve it a moment later.
    expect(requireSource(ref!.sourceId!)).toBeDefined()
  })

  it('shares one source between two nodes naming the same deployment differently', () => {
    const def = requireNodeDef('dataset.neuprint')
    const a = def.inferOutputs!(ctxFor('dataset.neuprint', { server: 'neuprint.janelia.org/', dataset: 'x' }))
    const b = def.inferOutputs!(ctxFor('dataset.neuprint', { server: DEFAULT_SERVER, dataset: 'x' }))
    expect(datasetRef(a['dataset'])?.sourceId).toBe(datasetRef(b['dataset'])?.sourceId)
  })
})

describe('the superseded generic node', () => {
  it('is still registered, so a graph saved before the redesign still loads', () => {
    const def = getNodeDef('neuron.dataset')
    expect(def).toBeDefined()
    // An unregistered type renders as "Unknown node" and drops its params.
    expect(def?.hidden).toBe(true)
  })

  it('still evaluates', async () => {
    const graph = addNode(emptyGraph('t'), node('neuron.dataset', { source: 'mock', dataset: 'hemibrain-mini' }))
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(graph, { mode: 'full' })
    expect(isDatasetValue(sched.output('ds', 'dataset'))).toBe(true)
  })
})
