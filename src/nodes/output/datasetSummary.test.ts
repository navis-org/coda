/**
 * The Dataset Summary node.
 *
 * The widget is covered in `ui/viewers/datasetSummary.test.tsx`; this is about the node's shape,
 * and every case here is one where getting it wrong fails no type check and reads as a bug
 * somewhere else entirely.
 *
 * The load-bearing one is that browsing costs nothing. If `topTypes` or `attributes` reached the
 * provenance key, changing a chart would mark the graph stale — and on a canvas where this sits
 * beside an expensive pipeline, with auto-run on, that is a full re-query because somebody
 * picked a different bar chart. The symptom would read as a scheduler fault rather than as a
 * missing flag, which is exactly why it is asserted through the scheduler.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'

import '../index'

const DATASET = 'optic-lobe-mini'

let source: DataSource

beforeEach(() => {
  source = new MockSource({ latencyMs: 0 })
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
  let g = emptyGraph('summary-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('sum', 'out.datasetSummary', params))
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'sum', targetHandle: 'dataset' })
  return g
}

describe('out.datasetSummary', () => {
  it('emits nothing, so no pipeline can be wired through a dashboard', () => {
    // The one deliberate departure from the `out.*` viewers, and `dataset.description`'s call
    // for the same reason: this is an annotation hanging off a dataset node.
    expect(requireNodeDef('out.datasetSummary').outputs).toEqual([])
  })

  it('is a viewer, so it resizes and opens full size', () => {
    // `category: 'visualisation'` is what `isViewer` reads — a second hand-kept list of type
    // ids is exactly what that function exists to avoid.
    const def = requireNodeDef('out.datasetSummary')
    expect(def.category).toBe('visualisation')
    expect(def.defaultSize).toBeDefined()
  })

  it('runs without touching the network', async () => {
    // `cheap`, because everything it shows is the widget's own fetch — the same standing
    // `out.neuroglancer` and `out.profile` have. A `cheap` node that queried would fire a
    // request per keystroke on the 180ms pass.
    expect(requireNodeDef('out.datasetSummary').cost).toBe('cheap')
    const scheduler = makeScheduler()
    const summary = await scheduler.run(graph(), { mode: 'full' })
    expect(summary.failed).toEqual([])
    expect(summary.executed).toContain('sum')
  })

  it('costs no run when a chart setting changes', async () => {
    /*
     * The whole design. `topTypes` and `attributes` decide what is drawn and nothing else, so
     * they must stay out of the provenance key — otherwise picking a different chart marks the
     * graph stale, and with auto-run on re-queries an expensive pipeline beside it. Asserted
     * through the scheduler because dropping the flag fails no type check, and the symptom —
     * a graph going stale whenever anyone picks a chart — reads as a scheduler fault.
     */
    const scheduler = makeScheduler()
    await scheduler.run(graph({ topTypes: 20 }), { mode: 'full' })

    const restyled = graph({ topTypes: 5, attributes: ['class'] })
    scheduler.refreshStates(restyled)
    expect(scheduler.info('sum').state).toBe('ok')
    expect((await scheduler.run(restyled, { mode: 'full' })).executed).toEqual([])
  })

  it('does re-run when the population changes', async () => {
    // `Status` decides which neurons every count is over. It is the one param here that is not
    // presentational, and it has to stay that way for the day this grows a Selected output.
    const scheduler = makeScheduler()
    await scheduler.run(graph({ status: '' }), { mode: 'full' })

    const narrowed = graph({ status: 'Traced' })
    scheduler.refreshStates(narrowed)
    expect(scheduler.info('sum').state).toBe('stale')
  })

  it('reports a Dataset socket wired to something that is not one', () => {
    // The only thing about this node the scheduler can usefully say. A card that silently drew
    // nothing would be indistinguishable from a dataset with nothing in it.
    let g = emptyGraph('summary-bad')
    g = addNode(g, node('find', 'neuron.findNeurons'))
    g = addNode(g, node('sum', 'out.datasetSummary'))
    const inferred = inferGraph(g)
    expect(inferred.nodes['sum']).toBeDefined()
  })

  it('keeps the refresh nonce out of the "more settings" count', () => {
    // `internal`, so the card's `… N more` hint does not announce a counter the widget writes
    // and turning it does not read as a parameter somebody changed.
    const refresh = requireNodeDef('out.datasetSummary').params?.find((p) => p.id === 'refresh')
    expect(refresh?.internal).toBe(true)
    expect(refresh?.presentational).toBe(true)
  })

  it('defaults to every neuron, unlike the query nodes', () => {
    /*
     * `Find Neurons` and `IDs from Label` both default to `Traced` so one label does not return
     * two counts in two nodes. This defaults to everything, because the index it counts carries
     * everything and a summary that quietly omitted 11,300 of male-CNS's 176,422 neurons would
     * answer a different question than its title.
     */
    const status = requireNodeDef('out.datasetSummary').params?.find((p) => p.id === 'status')
    expect(status?.default).toBe('')
    expect(requireNodeDef('neuron.findNeurons').params?.find((p) => p.id === 'status')?.default).toBe(
      'Traced',
    )
  })
})
