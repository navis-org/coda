/**
 * The morphology fetch nodes' `Warn above` guard rail.
 *
 * Worth pinning because the number and the reason have drifted apart twice. The mesh limit was
 * 25, picked before levels of detail existed and never re-derived: with detail selection doing
 * the real work, that refused thirty neurons that would have arrived as a few hundred
 * kilobytes. And the message blamed "this viewer", which has no cap of its own and was not what
 * refused.
 *
 * The second drift is the one these tests are now about. The number said "refuse", and a
 * refusal is a claim that there is no useful answer — which for a count is almost never true.
 * So the same threshold now says what the fetch will cost and then fetches: `ctx.warn`, and the
 * result underneath it. See `core/limits.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource, SourceCapabilities } from '../../data/source'
import { registerSource, requireSource } from '../../data/source'
import { T } from '../../core/types'
import { MAX_NEURONS } from './morphology'

import '../index'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

const MORPHOLOGY_NODES = ['neuron.skeletons', 'neuron.meshes', 'neuron.synapses'] as const

function limitParam(type: string) {
  const def = requireNodeDef(type)
  const param = (def.params ?? []).find((p) => p.id === 'limit')
  if (!param || param.kind !== 'int') throw new Error(`${type} has no int limit param`)
  return param
}

describe('Warn above', () => {
  it('shares one threshold across all three morphology nodes', () => {
    for (const type of MORPHOLOGY_NODES) {
      expect(limitParam(type).max, type).toBe(MAX_NEURONS)
      expect(defaultParams(requireNodeDef(type)).limit, type).toBe(MAX_NEURONS)
    }
  })

  it('is ten thousand, which is where every backend is into tens of minutes', () => {
    // Pinned as a literal in exactly one place. The three nodes above are pinned to *each
    // other*, so raising the shared number moves all of them and lands here.
    expect(MAX_NEURONS).toBe(10000)
  })

  it('is a threshold rather than a cap, and says so on the card', () => {
    // The label carried "Max" while the behaviour was a refusal, and kept it for a while
    // afterwards — which is the one way this control can lie about what it does.
    for (const type of MORPHOLOGY_NODES) {
      expect(limitParam(type).label, type).toBe('Warn above')
      expect(limitParam(type).help ?? '', type).toMatch(/threshold, not a cap/)
    }
  })

  it('keeps a Detail budget alongside it, since that is what bounds mesh weight', () => {
    // Raising the count without a weight control would just move the cliff.
    const def = requireNodeDef('neuron.meshes')
    expect((def.params ?? []).some((p) => p.id === 'detail')).toBe(true)
  })
})

/** dataset → find → geometry, with the geometry node's limit forced below the neuron count. */
function pipeline(geometryType: string, limit: number): CodaGraph {
  const node = (id: string, type: string, params: Record<string, unknown> = {}): GraphNode => ({
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  })

  let g = emptyGraph('limit-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('geo', geometryType))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'geo',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'geo',
    targetHandle: 'neurons',
  })
  return setNodeParam(g, 'geo', 'limit', limit)
}

describe('an oversized set', () => {
  it.each(MORPHOLOGY_NODES)('%s names the real constraint, not the viewer', async (type) => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(pipeline(type, 1), { mode: 'full' })

    const info = sched.info('geo')
    // The whole change: there is a result under the sentence. It used to be `error`, and
    // everything downstream was blocked by a wait somebody had not been asked about.
    expect(info.error ?? info.state).toBe('ok')
    expect(sched.warning('geo')).toMatch(/neurons is past this node's Warn above \(1\)/)
    expect(sched.warning('geo')).toMatch(/cancel and filter upstream/)
    // The message used to say this, and both halves of it were wrong.
    expect(sched.warning('geo')).not.toMatch(/this viewer can draw/)
  })

  it('explains the cost in terms specific to each node', async () => {
    const costs: Record<string, RegExp> = {
      'neuron.skeletons': /separate request/,
      'neuron.meshes': /full resolution/,
      'neuron.synapses': /row per synapse/,
    }
    for (const [type, pattern] of Object.entries(costs)) {
      const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
      await sched.run(pipeline(type, 1), { mode: 'full' })
      expect(sched.warning('geo'), type).toMatch(pattern)
    }
  })

  it('keeps the warning with the result, not with the run that produced it', async () => {
    // A second Run answers from the provenance cache without evaluating, and the caveat is
    // about the value rather than about the run — see `CacheEntry.warnings`.
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    const graph = pipeline('neuron.skeletons', 1)
    await sched.run(graph, { mode: 'full' })
    await sched.run(graph, { mode: 'full' })
    expect(sched.warning('geo')).toMatch(/Warn above/)
  })

  it('says nothing when the set fits', async () => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(pipeline('neuron.meshes', 500), { mode: 'full' })
    expect(sched.info('geo').state).toBe('ok')
    expect(sched.warning('geo')).toBeUndefined()
  })
})

/**
 * The per-dataset capability.
 *
 * `SourceCapabilities` is per **source**, and one source can serve datasets that genuinely
 * differ: a CAVE datastack's skeletons depend on whether its chunkedgraph has a level-2 cache,
 * which six of thirteen do. A flat answer is wrong for somebody whichever way it is set.
 */
describe('a capability that differs per dataset', () => {
  const def = requireNodeDef('neuron.skeletons')

  function withCapabilities(id: string, per: Record<string, Partial<SourceCapabilities>>) {
    const base = new MockSource({ latencyMs: 0 })
    registerSource(
      Object.assign(Object.create(base) as DataSource, {
        id,
        capabilities: { ...base.capabilities, skeletons: false },
        capabilitiesFor: (datasetId: string) => per[datasetId],
      }),
    )
  }

  const issues = (sourceId: string, datasetId: string) =>
    (
      def.validate?.(
        makeInferContext(def, defaultParams(def), { dataset: T.dataset(sourceId, datasetId) }),
      ) ?? []
    ).join(' ')

  it('lets a dataset answer for itself where the source cannot', () => {
    withCapabilities('per-dataset', { 'has:1': { skeletons: true } })
    // The source says no; this dataset says yes and wins.
    expect(issues('per-dataset', 'has:1')).toBe('')
  })

  it('falls back to the source for a dataset with nothing to say', () => {
    withCapabilities('per-dataset-2', { 'has:1': { skeletons: true } })
    // `undefined` is "same as the source", which is every dataset of every other backend — and
    // the safe answer while a peek has not landed.
    expect(issues('per-dataset-2', 'other:1')).toContain('no skeletons')
  })

  it('blames the dataset rather than the backend', () => {
    withCapabilities('per-dataset-3', {})
    // "This data source has no skeletons" told a FlyWire-production user something false about
    // a datastack that can perfectly well answer.
    expect(issues('per-dataset-3', 'other:1')).toContain('This dataset')
  })
})
