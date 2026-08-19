/**
 * The ROIs node.
 *
 * The geometry is covered in `ui/viewers/roiProjection.test.ts` and the widget will have its
 * own; this is about the node's shape, and every case is one where getting it wrong fails no
 * type check and reads as a bug somewhere else.
 *
 * The load-bearing one is that looking costs nothing. Every param here decides what is *drawn*
 * — `evaluate` returns nothing at all — so if any of them reached the provenance key, spinning
 * the 3D view or nudging the explode would mark the graph stale, and with auto-run on that
 * re-queries whatever expensive pipeline is sitting beside it. The symptom reads as a scheduler
 * fault rather than as a missing flag, which is why it is asserted through the scheduler.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import type { DataSource } from '../../data/source'

import '../index'

const DATASET = 'hemibrain-mini'

let source: DataSource

beforeEach(() => {
  source = new MockSource({ latencyMs: 0 })
  // `sourceSupports` reads the *registry*, not the scheduler's resolver, because inference is
  // synchronous and has no scheduler. Re-registering under the same id is how a test swaps one.
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

function graph(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('rois-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('rois', 'out.rois', params))
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'rois', targetHandle: 'dataset' })
  return g
}

describe('out.rois', () => {
  it('emits nothing, so no pipeline can be wired through a map', () => {
    // `dataset.description`'s call and `out.datasetSummary`'s: this is an annotation hanging off
    // a dataset node. A `Selected regions` output later would move no existing socket — but it
    // would have to take `selection` out of the presentational set the same day.
    expect(requireNodeDef('out.rois').outputs).toEqual([])
  })

  it('takes a Dataset and nothing else', () => {
    // The whole premise. A Skeletons or Meshes input would make this the context for a result
    // rather than an atlas, which is a different node.
    const inputs = requireNodeDef('out.rois').inputs ?? []
    expect(inputs.map((i) => i.id)).toEqual(['dataset'])
  })

  it('is a viewer, so it resizes and opens full size', () => {
    const def = requireNodeDef('out.rois')
    expect(def.category).toBe('visualisation')
    expect(def.defaultSize).toBeDefined()
    // Landscape: a fly brain is wider than it is tall in all three planes, so a portrait card
    // would spend its height on nothing.
    expect(def.defaultSize!.width).toBeGreaterThan(def.defaultSize!.height)
  })

  it('runs without touching the network', async () => {
    /*
     * `cheap`, despite the widget downloading tens of megabytes of neuropil mesh: `evaluate`
     * touches no network, and what a viewer fetches for itself is not what the scheduler has to
     * reason about. The same standing `out.profile` and `out.neuroglancer` have.
     */
    expect(requireNodeDef('out.rois').cost).toBe('cheap')
    const scheduler = makeScheduler()
    const summary = await scheduler.run(graph(), { mode: 'full' })
    expect(summary.failed).toEqual([])
    expect(summary.executed).toContain('rois')
  })

  it('costs no run when any control moves', async () => {
    /*
     * Every param, not a chosen few — there is no `Status`-shaped exception here, because
     * nothing this node draws is a count over a population. Changing the plane, exploding the
     * arrangement and recolouring are all drawing decisions over a value that is always empty.
     */
    const scheduler = makeScheduler()
    await scheduler.run(graph(), { mode: 'full' })

    const restyled = graph({
      view: 'lateral',
      explode: 80,
      colorBy: 'side',
      labels: 'all',
      opacity: 0.4,
      hemisphere: 'left',
      primaryOnly: false,
    })
    scheduler.refreshStates(restyled)
    expect(scheduler.info('rois').state).toBe('ok')
    expect((await scheduler.run(restyled, { mode: 'full' })).executed).toEqual([])
  })

  it('draws no param band, because the map carries its own controls', () => {
    /*
     * `out.neuroglancer`'s call. Every param is inspector-only, so the card is the map and its
     * caption — a stack of generic rows above a picture would be the same four controls twice,
     * and on a 460px card that is a fifth of the height.
     *
     * They are still `presentational`, so the expanded view's styling rail keeps offering them.
     */
    const params = requireNodeDef('out.rois').params ?? []
    expect(params.length).toBeGreaterThan(0)
    expect(params.filter((p) => !p.advanced).map((p) => p.id)).toEqual([])
    expect(params.filter((p) => !p.presentational).map((p) => p.id)).toEqual([])
  })

  it('advertises no ports at all, in or out of inference', () => {
    // A node with no outputs still has to survive inference, which runs on every graph edit.
    const inferred = inferGraph(graph())
    expect(inferred.nodes['rois']?.outputs).toEqual({})
    expect(inferred.nodes['rois']?.issues ?? []).toEqual([])
  })

  it('reports a Dataset socket wired to something that is not one', async () => {
    /*
     * The only thing about this node the scheduler can usefully say. A card that silently drew
     * an empty brain would be indistinguishable from a dataset with no regions in it.
     *
     * `addEdge` takes the handle it is given — the editor refuses an incompatible drag, but a
     * graph loaded from a file has already been assembled. Two things then catch it, and the
     * first is the better one: inference types the port and reports the mismatch *by name*
     * before anything runs, so `evaluate`'s own guard is the backstop for a value that types
     * correctly and is not one.
     */
    let g = emptyGraph('rois-bad')
    g = addNode(g, node('find', 'neuron.findNeurons'))
    g = addNode(g, node('rois', 'out.rois'))
    g = addEdge(g, {
      source: 'find',
      sourceHandle: 'neurons',
      target: 'rois',
      targetHandle: 'dataset',
    })
    expect(g.edges).toHaveLength(1)

    const scheduler = makeScheduler()
    const summary = await scheduler.run(g, { mode: 'full' })
    expect(summary.failed).toContain('rois')
    expect(scheduler.info('rois').error ?? '').toMatch(/Dataset/)
  })

  it('says so at edit time when the source publishes no region meshes', () => {
    /*
     * Not an edge case: four of the thirteen datasets neuPrint serves — banc, fib19,
     * mushroombody and wasp3 — answer the region-mesh endpoint with a 400. A card that just
     * drew nothing would be indistinguishable from one still loading.
     */
    const withoutMeshes: DataSource = Object.create(
      Object.getPrototypeOf(source) as object,
      Object.getOwnPropertyDescriptors(source),
    ) as DataSource
    Object.defineProperty(withoutMeshes, 'capabilities', {
      value: { ...source.capabilities, roiMeshes: false },
    })
    registerSource(withoutMeshes)

    const issues = inferGraph(graph()).nodes['rois']?.issues ?? []
    expect(issues.map((i) => i.message).join(' ')).toMatch(/region meshes/i)
  })
})
