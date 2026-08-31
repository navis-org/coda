/**
 * The region-mesh fetch node, and the one thing about it that is easy to get wrong.
 *
 * `RoiMeshRequest.rois` distinguishes **omitted** from **empty**, and the two mean opposite
 * things: omitted asks for the set that tiles the volume, empty asks for no regions at all. The
 * picker's resting state is an empty array, so a node that forwarded it literally would answer
 * every fresh card with nothing and look like a broken endpoint. That seam is asserted here
 * against a spy rather than through the result, because a mock generous enough to return the
 * primary set for `[]` would hide exactly the bug.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { attributeSchema, columnNames } from '../../core/types'
import { isMeshesValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource, RoiMeshRequest } from '../../data/source'
import { registerSource } from '../../data/source'
import { REGIONS_WARN } from './roiMeshes'

import '../index'

const DATASET = 'optic-lobe-mini'

let source: DataSource
let requests: RoiMeshRequest[]

beforeEach(() => {
  const mock = new MockSource({ latencyMs: 0 })
  requests = []
  source = new Proxy(mock, {
    get(target, prop, receiver) {
      if (prop === 'fetchRoiMeshes') {
        return (req: RoiMeshRequest) => {
          requests.push(req)
          return mock.fetchRoiMeshes(req)
        }
      }
      return Reflect.get(target, prop, receiver) as unknown
    },
  }) as DataSource
  // The picker's options come through `getSource(...).peekDataset(...)`, which reads the
  // registry rather than the scheduler's resolver — so the node under test needs both.
  registerSource(source)
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

/** The node's own inference context, which is what `validate` and derived options both take. */
function contextFor(g: CodaGraph, def = requireNodeDef('neuron.roiMeshes')) {
  const roi = g.nodes.find((n) => n.id === 'roi')!
  return makeInferContext(def, roi.params, inferGraph(g).nodes['roi']!.inputs)
}

function graph(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('roi-mesh-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('roi', 'neuron.roiMeshes', params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'roi',
    targetHandle: 'dataset',
  })
  return g
}

describe('neuron.roiMeshes', () => {
  it('answers from a Dataset alone, with no neurons wired', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(graph(), { mode: 'full' })

    const out = scheduler.output('roi', 'meshes')
    if (!isMeshesValue(out)) throw new Error('expected meshes')
    expect(out.items.length).toBeGreaterThan(0)
    expect(columnNames(out.attributes.schema)).toEqual(['roi', 'primary'])
  })

  it('omits `rois` entirely when the picker is empty, rather than sending []', async () => {
    // The whole point of the node's default. `[]` at this seam means "no regions", and a
    // source obeying it would answer a freshly dropped card with an empty scene.
    const scheduler = makeScheduler()
    await scheduler.run(graph({ rois: [] }), { mode: 'full' })

    expect(requests).toHaveLength(1)
    expect('rois' in requests[0]!).toBe(false)
  })

  it('forwards exactly the regions that were picked', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(graph({ rois: ['ME(R)', 'LO(R)'] }), { mode: 'full' })

    expect(requests[0]?.rois).toEqual(['ME(R)', 'LO(R)'])
    const out = scheduler.output('roi', 'meshes')
    if (!isMeshesValue(out)) throw new Error('expected meshes')
    expect(out.items.map((item) => item.id)).toEqual(['ME(R)', 'LO(R)'])
  })

  it('advertises its schema before anything has run', () => {
    // Fixed rather than discovered, like `roiCompleteness`'s: every source that can answer at
    // all answers in the same two columns, so a colour picker populates on the wire.
    const out = inferGraph(graph()).nodes['roi']?.outputs['meshes']
    expect(columnNames(attributeSchema(out))).toEqual(['roi', 'primary'])
  })

  it('refuses a region this dataset does not publish, before a run rather than after one', () => {
    const def = requireNodeDef('neuron.roiMeshes')
    const g = graph({ rois: ['ME(R)', 'NOT_A_REGION'] })
    const issues = def.validate!(contextFor(g, def))
    expect(issues.join(' ')).toContain('NOT_A_REGION')
    // And says nothing about the one that is real.
    expect(issues.join(' ')).not.toContain('ME(R),')
  })

  it('says a long selection is a lot, and points at the picker that asks for the set', () => {
    // It refused at 60 until it was noticed that naming the primary set by hand was refused
    // while asking for the same set by leaving the picker empty was fine.
    const def = requireNodeDef('neuron.roiMeshes')
    const many = Array.from({ length: REGIONS_WARN + 1 }, (_, i) => `R${i}`)
    const g = graph({ rois: many })
    const issues = def.validate!(contextFor(g, def))
    expect(issues.join(' ')).toContain(String(REGIONS_WARN + 1))
    expect(issues.join(' ')).toContain('primary set')
  })

  it('is expensive, so a whole primary set never fetches on a keystroke', () => {
    // 29–62 MB for a dataset's regions. `cheap` here would issue that per edit, at a shared
    // production server — invariant 6, in the one node most able to demonstrate it.
    expect(requireNodeDef('neuron.roiMeshes').cost).toBe('expensive')
  })

  it('offers the dataset’s own region list as the picker’s options', () => {
    const def = requireNodeDef('neuron.roiMeshes')
    const param = (def.params ?? []).find((p) => p.id === 'rois')
    if (param?.kind !== 'multiEnum') throw new Error('expected a multiEnum')
    if (typeof param.options !== 'function') throw new Error('expected derived options')

    const options = param.options(contextFor(graph(), def))
    expect(options.length).toBeGreaterThan(0)
    expect(options.map((o) => o.value)).toContain('ME(R)')
  })

  it('says what empty means, because empty is its resting state', () => {
    // A picker whose most common value is a decision the node interprets has to name it, or
    // the control says nothing in the state everybody sees first.
    const param = (requireNodeDef('neuron.roiMeshes').params ?? []).find((p) => p.id === 'rois')
    if (param?.kind !== 'multiEnum') throw new Error('expected a multiEnum')
    expect(param.emptyLabel).toBeTruthy()
  })
})
