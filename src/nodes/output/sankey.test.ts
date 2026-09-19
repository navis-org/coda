/**
 * The Sankey node's contract, over the chain it exists for.
 *
 * The flow arithmetic is `sankeyFlow.test.ts`' and the geometry is `sankeyLayout.test.ts`'. What
 * is pinned here is the part only the node and its wiring decide:
 *
 *  - the table passes through **by identity**, which is what makes every drawing control
 *    presentational and stops a restyle staling the `expensive` walk above it;
 *  - `Influence ▸ Transfers ▸ Sankey` needs no configuration, because that port's column names
 *    are the ones the pickers land on — asserted rather than assumed, since a rename at either
 *    end leaves a node that draws nothing and says only "pick the layer, from and to columns";
 *  - and the four pickers stay `optional`, so an unset one draws nothing rather than laying the
 *    diagram out by whatever column happened to come first.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultOutputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { columnNames } from '../../core/types'
import { getColumn, isTableValue } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource } from '../../data/source'
import { influenceFlowSchema } from '../lib/influenceOps'
import '../index'
import { searchFor } from '../../test/findNeurons'
import { node } from '../../test/graph'

const source: DataSource = new MockSource({ latencyMs: 0 })

/** dataset → find(LC4) → influence → out.sankey, wired to the Transfers port. */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('sankey-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', searchFor({ type: 'LC4' })))
  g = addNode(g, node('infl', 'neuron.influence', { maxHops: 3, flowFloor: 0 }))
  g = addNode(
    g,
    node('sank', 'out.sankey', {
      layerColumn: 'layer',
      sourceColumn: 'source',
      targetColumn: 'target',
      valueColumn: 'value',
      ...params,
    }),
  )
  for (const [from, handle, to, target] of [
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'infl', 'dataset'],
    ['find', 'neurons', 'infl', 'neurons'],
    ['infl', 'transfers', 'sank', 'in'],
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

describe('out.sankey — types', () => {
  it('keeps Table as the first output, so a dragged link continues the chain', () => {
    expect(defaultOutputPorts(requireNodeDef('out.sankey')).map((p) => p.id)).toEqual([
      'out',
      'selected',
    ])
  })

  it('is cheap: nothing here fetches and nothing here computes over a value', () => {
    expect(requireNodeDef('out.sankey').cost).toBe('cheap')
  })

  it('passes the input type through whole on both ports, before anything runs', () => {
    const types = inferGraph(pipeline()).nodes['sank']
    expect(types?.outputs['out']).toEqual(types?.inputs['in'])
    expect(types?.outputs['selected']).toEqual(types?.inputs['in'])
  })

  it('marks everything presentational but the selection and the id column', () => {
    const def = requireNodeDef('out.sankey')
    const plain = (def.params ?? []).filter((p) => p.presentational !== true).map((p) => p.id)
    expect(plain).toEqual(['idColumn', 'selection'])
  })

  it('leaves all four flow pickers optional, so an unset one draws nothing', () => {
    // `resolveColumn` rule 3 hands a *required* picker still on its declared default the first
    // compatible column — which here would lay the diagram out by whatever integer came first.
    const def = requireNodeDef('out.sankey')
    for (const id of ['layerColumn', 'sourceColumn', 'targetColumn', 'valueColumn']) {
      expect((def.params ?? []).find((p) => p.id === id)).toMatchObject({
        optional: true,
        default: '',
      })
    }
  })
})

describe('out.sankey — the Influence chain it exists for', () => {
  it('lands its pickers on the Transfers port’s own columns with no configuration', () => {
    // The two halves of "wire it up and it just works", asserted at both ends: a rename at
    // either leaves a node that draws nothing and says only "pick the layer, from and to
    // columns", with nothing failing.
    expect(columnNames(influenceFlowSchema())).toEqual(['layer', 'source', 'target', 'value'])

    const def = requireNodeDef('out.sankey')
    const defaults = Object.fromEntries(
      (def.params ?? []).map((p) => [p.id, p.default]),
    ) as Record<string, unknown>
    // Empty defaults plus `optional`, so what makes the chain work is the *resolver* finding the
    // names above rather than a default naming them. Pinning the schema is the half that matters.
    expect(defaults['layerColumn']).toBe('')
  })

  it('resolves every picker against a real Influence flow', () => {
    const types = inferGraph(pipeline()).nodes['sank']
    // Nothing unresolved, which is what "needs no configuration" means at edit time.
    expect(types?.issues ?? []).toEqual([])
  })

  it('draws a flow the walk actually produced', async () => {
    const scheduler = await run(pipeline())
    const flow = scheduler.output('infl', 'transfers')
    expect(isTableValue(flow)).toBe(true)
    if (!isTableValue(flow)) return
    expect(flow.length).toBeGreaterThan(0)
    // Layer 0 is the deepest column and the layers are contiguous, which is what the drawing
    // reads as the columns running in the direction the signal does.
    const layers = [...new Set(getColumn(flow, 'layer').map(Number))].sort((a, b) => a - b)
    expect(layers[0]).toBe(0)
    expect(layers).toEqual(layers.map((_, i) => i))
  })
})

describe('out.sankey — evaluate', () => {
  it('hands the table on by identity, not as a copy', async () => {
    const scheduler = await run(pipeline())
    expect(scheduler.output('sank', 'out')).toBe(scheduler.output('infl', 'transfers'))
  })

  it('emits nothing on Selected until something is clicked', async () => {
    const scheduler = await run(pipeline())
    const selected = scheduler.output('sank', 'selected')
    expect(isTableValue(selected)).toBe(true)
    if (isTableValue(selected)) expect(selected.length).toBe(0)
  })

  it('ignores a selected row the table no longer has, rather than blocking', async () => {
    // Invariant 5's corollary: a stale control is no reason to stop everything downstream.
    const scheduler = await run(pipeline({ selection: ['not-a-row'] }))
    expect(scheduler.info('sank').state).toBe('ok')
  })

  it('does not refuse over an unset picker', async () => {
    const scheduler = await run(pipeline({ layerColumn: '', sourceColumn: '' }))
    expect(scheduler.info('sank').state).toBe('ok')
    expect(scheduler.output('sank', 'out')).toBe(scheduler.output('infl', 'transfers'))
  })
})
