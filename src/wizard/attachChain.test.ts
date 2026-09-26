/**
 * Attaching an annotation chain to a dataset node already on a canvas, and the stale-labels
 * warning that offers it. See `wizard/attachChain.ts` and `AnnotationChain.staleBuiltin`.
 *
 * The rule under test is that a bare FlyWire node, which looks as if it works, says where its
 * labels come from until something feeds its Annotations port, and that the fix it offers
 * leaves the graph as the wizard would have built it.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import type { CodaGraph } from '../core/graph'
import { addEdge, emptyGraph } from '../core/graph'
import { addNodeWithCompanion } from '../core/companion'
import { inferGraph } from '../core/inference'
import { T } from '../core/types'
import { registerBuiltinSources } from '../data/builtins'
import { shippedSpecFor } from '../data/cave/spec'
import { collapsedView } from '../layout/collapse'
import { CARD_GAP } from '../layout/columns'
import { resolveSize } from '../layout/elkGraph'
import { chainLinks } from '../nodes/lib/annotationChain'
import {
  ADD_CHAIN_LABEL,
  ATTACH_CHAIN_LABEL,
  datasetFamily,
  familyChainHint,
} from '../nodes/lib/datasetFamilies'
import '../nodes'
import { graphNode } from './assemble'
import { attachChain } from './attachChain'
import { buildWorkflow } from './build'

beforeAll(() => {
  registerBuiltinSources()
})

/** The folded box the canvas draws for the chain whose cards are `nodeIds`. */
function frameOf(graph: CodaGraph, nodeIds: readonly string[]) {
  const box = collapsedView(graph).boxes.find((b) => b.members.some((m) => m.id === nodeIds[0]))
  if (!box) throw new Error('the chain was not folded')
  return { ...box.position, ...resolveSize(box) }
}

const flywire = datasetFamily('flywire')!
const chain = flywire.annotationChain!

function loneDataset(): CodaGraph {
  return addNodeWithCompanion(
    emptyGraph('t'),
    graphNode('ds', 'dataset.flywire', { x: 800, y: 300 }),
  )
}

describe('familyChainHint', () => {
  it('names the table the backend reads, and the button that fixes it', () => {
    const table = shippedSpecFor(undefined, flywire.family)?.annotations?.table
    expect(table).toBe('hierarchical_neuron_annotations')
    const warning = familyChainHint(flywire, undefined)
    // Pinned whole: this is the wording that was asked for, assembled from three declarations.
    expect(warning?.message).toBe(
      'Cell types come from the hierarchical_neuron_annotations CAVE table, an outdated cut of ' +
        'the FlyWire annotations: later typing and corrections are missing, and it has no ' +
        'community tags. Click button below to wire in the recommended FlyWire annotations.',
    )
    expect(warning?.fix).toEqual(
      expect.objectContaining({ label: ATTACH_CHAIN_LABEL, action: 'attachAnnotationChain' }),
    )
  })

  it('stands down for any wire on the Annotations port, not only the chain', () => {
    expect(familyChainHint(flywire, T.table())).toBeUndefined()
  })

  it('offers the chain where a dataset has no labels of its own and its chain opts in', () => {
    const minnie = datasetFamily('minnie65')
    const hint = familyChainHint(minnie, undefined)
    expect(hint?.message).toBe(
      'No cell types without annotations: MICrONS types its cells in CAVE tables rather than on ' +
        'the neuron. Click button below to wire in the recommended MICrONS cell types.',
    )
    expect(hint?.fix).toEqual(
      expect.objectContaining({ label: ADD_CHAIN_LABEL, action: 'attachAnnotationChain' }),
    )
    expect(familyChainHint(minnie, T.table())).toBeUndefined()
  })

  it('is silent where a chain declares neither reason, or there is no chain', () => {
    // BANC is Minnie's case and has not opted in (`AnnotationChain.unlabelled`).
    for (const key of ['banc', 'hemibrain']) {
      expect(familyChainHint(datasetFamily(key), undefined), key).toBeUndefined()
    }
  })

  it('is silent on the graph the wizard builds', () => {
    const graph = buildWorkflow({
      datasets: ['flywire'],
      start: 'browse',
      analysis: 'neurons',
      visualisations: ['table'],
      notes: true,
      dashboard: false,
    })
    const ds = graph.nodes.find((node) => node.type === 'dataset.flywire')!
    const annotations = inferGraph(graph).nodes[ds.id]?.inputs.annotations
    expect(annotations).toBeDefined()
    expect(familyChainHint(flywire, annotations)).toBeUndefined()
  })
})

describe('attachChain', () => {
  it("wires the chain in by the declaration's own wires, folded and captioned", () => {
    const { graph, nodeIds } = attachChain(loneDataset(), 'ds', chain)
    expect(nodeIds).toHaveLength(chain.nodes.length)

    // Every card by type, and every wire `chainLinks` names, under the ids minted here.
    const byLocal = new Map(
      chain.nodes.map((card, i) => [card.id, graph.nodes.find((n) => n.id === nodeIds[i])!]),
    )
    for (const card of chain.nodes) expect(byLocal.get(card.id)?.type).toBe(card.type)
    const id = (local: string) => (local === 'ds' ? 'ds' : byLocal.get(local)!.id)
    for (const [from, fromPort, to, toPort] of chainLinks(chain, 'ds')) {
      const wire = graph.edges.find(
        (e) =>
          e.source === id(from) &&
          e.sourceHandle === fromPort &&
          e.target === id(to) &&
          e.targetHandle === toPort,
      )
      expect(wire, `${from}:${fromPort} → ${to}:${toPort}`).toBeDefined()
    }

    const group = graph.groups?.find((g) => g.title === chain.title)
    expect(group?.collapsed).toBe(true)
    expect([...(group?.nodeIds ?? [])].sort()).toEqual([...nodeIds].sort())
    expect(graph.nodes.some((n) => n.captionOf === id(chain.output.id))).toBe(true)

    // And the warning it was pressed for is gone.
    const annotations = inferGraph(graph).nodes['ds']?.inputs.annotations
    expect(familyChainHint(flywire, annotations)).toBeUndefined()
  })

  /*
   * The folded box is what the canvas draws, and it is drawn at its members' top-left. The
   * first version placed the members so that unfolding covered nothing, which put the box four
   * columns out from the dataset it feeds.
   */
  it('draws the folded frame one card gap left of the dataset, level with it', () => {
    const before = loneDataset()
    const { graph, nodeIds } = attachChain(before, 'ds', chain)
    const ds = graph.nodes.find((n) => n.id === 'ds')!
    const box = frameOf(graph, nodeIds)
    expect(box.x + box.width + CARD_GAP).toBe(ds.position.x)
    expect(box.y).toBe(ds.position.y)
    // Its caption hangs under it rather than somewhere the members used to be.
    const caption = graph.nodes.find((n) => n.captionOf && nodeIds.includes(n.captionOf))!
    expect(caption.position.x).toBe(box.x)
    expect(caption.position.y).toBeGreaterThan(box.y + box.height)
    // Nothing that was there moved.
    for (const node of before.nodes) {
      expect(graph.nodes.find((n) => n.id === node.id)?.position).toEqual(node.position)
    }
  })

  it('moves down past a card already where the frame would go', () => {
    const first = attachChain(loneDataset(), 'ds', chain)
    const spot = frameOf(first.graph, first.nodeIds)
    const crowded = loneDataset()
    crowded.nodes.push(graphNode('other', 'core.filterTable', { x: spot.x, y: spot.y }))
    const { graph, nodeIds } = attachChain(crowded, 'ds', chain)
    const other = graph.nodes.find((n) => n.id === 'other')!
    const obstacle = { ...other.position, ...resolveSize(other) }
    const box = frameOf(graph, nodeIds)
    expect(box.x).toBe(spot.x)
    expect(box.y).toBeGreaterThanOrEqual(obstacle.y + obstacle.height)
  })

  it('refuses to replace a wire somebody already made', () => {
    let graph = loneDataset()
    graph = {
      ...graph,
      nodes: [...graph.nodes, graphNode('mine', 'core.tableFromUrl', { x: 0, y: 0 })],
    }
    graph = addEdge(graph, {
      source: 'mine',
      sourceHandle: 'out',
      target: 'ds',
      targetHandle: 'annotations',
    })
    const attached = attachChain(graph, 'ds', chain)
    expect(attached.graph).toBe(graph)
    expect(attached.nodeIds).toEqual([])
  })

  it('mints fresh ids, so a canvas holding the chain already can take a second one', () => {
    const once = attachChain(loneDataset(), 'ds', chain).graph
    const withSecond = addNodeWithCompanion(
      once,
      graphNode('ds2', 'dataset.flywire', { x: 800, y: 1600 }),
    )
    const twice = attachChain(withSecond, 'ds2', chain)
    const ids = twice.graph.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(collapsedView(twice.graph).boxes).toHaveLength(2)
  })
})
