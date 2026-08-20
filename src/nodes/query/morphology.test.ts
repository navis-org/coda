/**
 * The morphology fetch nodes' `Max neurons` guard rail.
 *
 * Worth pinning because the number and the reason drifted apart once. The mesh limit was 25,
 * picked before levels of detail existed and never re-derived: with detail selection doing the
 * real work, that refused thirty neurons that would have arrived as a few hundred kilobytes.
 * And the message blamed "this viewer", which has no cap of its own and is not what refuses.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource, requireSource } from '../../data/source'
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

describe('Max neurons', () => {
  it('shares one ceiling across all three morphology nodes', () => {
    for (const type of MORPHOLOGY_NODES) {
      expect(limitParam(type).max, type).toBe(500)
    }
  })

  it('lets Meshes fetch as many as the other two allow', () => {
    // The old 25 was the odd one out, and its own ceiling was 200 for no recorded reason.
    expect(defaultParams(requireNodeDef('neuron.meshes')).limit).toBe(500)
    expect(limitParam('neuron.meshes').max).toBe(500)
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

describe('refusing an oversized set', () => {
  it.each(MORPHOLOGY_NODES)('%s names the real constraint, not the viewer', async (type) => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(pipeline(type, 1), { mode: 'full' })

    const info = sched.info('geo')
    expect(info.state).toBe('error')
    expect(info.error).toMatch(/exceeds this node's Max neurons \(1\)/)
    expect(info.error).toMatch(/Raise the limit if you mean it, or filter upstream/)
    // The message used to say this, and both halves of it were wrong.
    expect(info.error).not.toMatch(/this viewer can draw/)
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
      expect(sched.info('geo').error, type).toMatch(pattern)
    }
  })

  it('says nothing when the set fits', async () => {
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    await sched.run(pipeline('neuron.meshes', 500), { mode: 'full' })
    expect(sched.info('geo').state).toBe('ok')
  })
})
