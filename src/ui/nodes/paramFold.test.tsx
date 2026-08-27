// @vitest-environment jsdom

/**
 * Folding a viewer's param rows away.
 *
 * A card is configured once and then read for the rest of the session, so the rows that set it
 * up spend its height on a decision already made. The fold gives that height back — to the
 * drawing on a viewer, and to the canvas on everything else.
 *
 * Two things here fail silently rather than loudly, which is what this file is for. The button
 * lives in the *header* — folded, the band is not rendered at all, so a toggle inside it would
 * leave nothing to press, and that placement is the whole reason the fold is safe on a card with
 * no drawing under it. And the fold must cost no run: it is a card-layout decision, and a graph
 * going stale because somebody tidied a card reads as a scheduler bug.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import { allNodeDefs, requireNodeDef } from '../../core/registry'
import type { NodeDefinition, ParamValues } from '../../core/node'
import { defaultParams } from '../../core/node'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { noteNode } from '../../examples/notes'
import { useGraphStore } from '../../store/graphStore'
import { nodeBody } from './nodeBodies'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

/**
 * A bar chart over grouped ROI counts, plus a note — built here rather than borrowed from the
 * bundled examples.
 *
 * The three cards this file needs are a viewer with several param rows above a drawing, a
 * transform whose card *is* its rows, and a note that has neither. No example ships all three
 * any more, and a test that quietly swapped to whichever one still nearly fits would be
 * asserting about a different card than the comments describe.
 */
function chartGraph(): CodaGraph {
  const place = (id: string, type: string, col: number, params?: Record<string, unknown>) =>
    ({
      id,
      type,
      position: { x: col * 320, y: 0 },
      params: { ...defaultParams(requireNodeDef(type)), ...params } as ParamValues,
    }) as GraphNode

  let g = emptyGraph('param fold')
  for (const node of [
    place('ds', 'dataset.mock.opticlobe', 0),
    place('find', 'neuron.findNeurons', 1, {
      filters: ['{"f":"type","op":"matches","v":["LC.*"]}'],
    }),
    place('roi', 'neuron.roiCounts', 2),
    place('group', 'core.groupBy', 3, { by: ['roi', 'type'], agg: 'sum', value: 'post' }),
    place('bar', 'out.barChart', 4, {
      category: 'roi',
      value: 'sum_post',
      series: 'type',
      useSeries: true,
      sortBars: true,
    }),
    noteNode({ id: 'why', x: 0, y: -260, width: 520, height: 120, text: 'A note.' }),
  ]) {
    g = addNode(g, node)
  }
  for (const [from, fromPort, to, toPort] of [
    ['ds', 'dataset', 'find', 'dataset'],
    ['ds', 'dataset', 'roi', 'dataset'],
    ['find', 'neurons', 'roi', 'neurons'],
    ['roi', 'counts', 'group', 'in'],
    ['group', 'out', 'bar', 'in'],
  ] as const) {
    g = addEdge(g, { source: from, sourceHandle: fromPort, target: to, targetHandle: toPort })
  }
  return g
}

beforeAll(() => {
  installJsdomStubs({ width: 420, height: 300 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(chartGraph())
  })
})

afterEach(cleanup)

function nodeIdOfType(type: string): string {
  const found = useGraphStore.getState().graph.nodes.find((n) => n.type === type)
  if (!found) throw new Error(`no ${type} in the fixture`)
  return found.id
}

async function cardFor(nodeId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const wrapper = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
    const card = wrapper?.querySelector('.coda-node')
    if (!card) throw new Error(`no card for ${nodeId}`)
    return card as HTMLElement
  })
}

function foldButton(card: HTMLElement): HTMLButtonElement | null {
  return card.querySelector('.coda-node__fold')
}

describe('the fold button', () => {
  it('folds a chart’s param rows away and brings them back', async () => {
    render(<App />)
    const chart = nodeIdOfType('out.barChart')
    const card = await cardFor(chart)

    // The bar chart is the case worth having this for: five rows above the drawing.
    expect(card.querySelectorAll('.coda-node__params .param').length).toBeGreaterThan(1)

    const button = foldButton(card)!
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)
    await waitFor(() => {
      expect(card.querySelector('.coda-node__params')).toBeNull()
    })
    expect(
      useGraphStore.getState().graph.nodes.find((n) => n.id === chart)?.paramsCollapsed,
    ).toBe(true)

    // The button is still there, in the same place, which is the whole reason it is in the
    // header: the band it controls has just stopped existing.
    const again = foldButton(card)!
    expect(again).not.toBeNull()
    expect(again.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(again)
    await waitFor(() => {
      expect(card.querySelector('.coda-node__params')).not.toBeNull()
    })
  })

  it('leaves the header’s other controls alone', async () => {
    // Collapse is the neighbouring control and means something else entirely: it hides the
    // drawing too. A fold that also collapsed, or a collapse that unfolded, would be one
    // control wearing two glyphs.
    render(<App />)
    const chart = nodeIdOfType('out.barChart')
    const card = await cardFor(chart)

    fireEvent.click(foldButton(card)!)
    await waitFor(() => expect(card.querySelector('.coda-node__params')).toBeNull())
    expect(
      useGraphStore.getState().graph.nodes.find((n) => n.id === chart)?.collapsed,
    ).toBeFalsy()
    expect(card.querySelector('.coda-node__footer')).not.toBeNull()
  })

  it('reaches a transform card too, and leaves it something to press', async () => {
    // The rows *are* a transform node's card, so this is the case where a toggle living on the
    // band would strand it. From the header it survives, and what is left behind still reads:
    // the ports keep their labels and the footer keeps its summary, which is what separates
    // this from Collapse.
    render(<App />)
    const group = nodeIdOfType('core.groupBy')
    const card = await cardFor(group)
    expect(card.querySelectorAll('.coda-node__params .param').length).toBeGreaterThan(0)

    fireEvent.click(foldButton(card)!)
    await waitFor(() => expect(card.querySelector('.coda-node__params')).toBeNull())
    expect(foldButton(card)).not.toBeNull()
    expect(card.querySelector('.coda-node__ports')).not.toBeNull()
    expect(card.querySelector('.coda-node__footer')).not.toBeNull()
  })
})

describe('what the store will and will not fold', () => {
  it('refuses a text note, so the flag never lands where nothing can undo it', () => {
    // A note draws its own card — no header, no ports, no param band — so the flag would be
    // state nothing can see and nothing can clear. Same filter mute and collapse use.
    const store = useGraphStore.getState()
    const note = store.graph.nodes.find((n) => n.type === 'note.text')!
    expect(note).toBeDefined()
    act(() => store.toggleParamRows([note.id]))
    expect(
      useGraphStore.getState().graph.nodes.find((n) => n.id === note.id)?.paramsCollapsed,
    ).toBeUndefined()
    // A refused fold is not a commit either — it must not consume the undo stack.
    expect(useGraphStore.getState().past).toHaveLength(0)
  })

  it('folds a whole selection uniformly, notes excepted', () => {
    // One action for the selection, like mute and collapse: if anything in it is showing its
    // rows, the whole lot folds. Otherwise a mixed selection toggles into a different mixture.
    const chart = nodeIdOfType('out.barChart')
    const group = nodeIdOfType('core.groupBy')
    const note = useGraphStore.getState().graph.nodes.find((n) => n.type === 'note.text')!
    act(() => useGraphStore.getState().toggleParamRows([chart, group, note.id]))
    const nodes = useGraphStore.getState().graph.nodes
    expect(nodes.find((n) => n.id === chart)?.paramsCollapsed).toBe(true)
    expect(nodes.find((n) => n.id === group)?.paramsCollapsed).toBe(true)
    expect(nodes.find((n) => n.id === note.id)?.paramsCollapsed).toBeUndefined()
  })

  it('undoes in one step', () => {
    const chart = nodeIdOfType('out.barChart')
    act(() => useGraphStore.getState().toggleParamRows([chart]))
    act(() => useGraphStore.getState().undo())
    expect(
      useGraphStore.getState().graph.nodes.find((n) => n.id === chart)?.paramsCollapsed,
    ).toBeFalsy()
  })

  it('costs no run: the result survives and the node does not go stale', async () => {
    const chart = nodeIdOfType('out.barChart')
    await act(async () => {
      await useGraphStore.getState().runAll()
    })
    const before = useGraphStore.getState().nodeOutput(chart, 'out')
    expect(before).toBeDefined()
    expect(useGraphStore.getState().needsRun(chart)).toBe(false)

    act(() => useGraphStore.getState().toggleParamRows([chart]))

    // Identity, not equality: the cache entry must be the same object, i.e. untouched. A fold
    // is not in the provenance key because it is not a param at all.
    expect(useGraphStore.getState().nodeOutput(chart, 'out')).toBe(before)
    expect(useGraphStore.getState().needsRun(chart)).toBe(false)
  })
})

describe('which cards the affordance reaches', () => {
  /*
   * The card's own rule, restated once: any node that draws the generic param band, i.e. has a
   * non-advanced param and no body of its own. Stated as a set rather than checked node by
   * node, because the failure being guarded is a *policy* drift — a param moved to `advanced`
   * that empties a band the header still offers to fold.
   */
  const drawsBand = (def: NodeDefinition) =>
    (def.params ?? []).some((p) => !p.advanced) && !nodeBody(def.type) && !def.annotation

  it('reaches viewers and workhorses alike', () => {
    const folding = allNodeDefs()
      .filter(drawsBand)
      .map((d) => d.type)
    expect(folding).toEqual(
      expect.arrayContaining([
        // Rows above a picture, which is the case this was built for...
        'out.barChart',
        'out.heatmap',
        'out.network',
        'out.table',
        // ...and rows that are the whole card, which is the case that was added after.
        'core.filter',
        'core.groupBy',
        'neuron.connectivity',
      ]),
    )
  })

  it('does not offer to fold a band that is not drawn', () => {
    // Every neuroglancer param is `advanced`, i.e. inspector-only: a row of pickers above a
    // 400px embed takes a tenth of the space someone opened the node for. So there is nothing
    // on the card to fold, and a button promising otherwise would be a dead press.
    expect(drawsBand(requireNodeDef('out.neuroglancer'))).toBe(false)
    // Explore draws a search bar and a list of neurons instead of the generic rows; its params
    // are real, and reachable in the inspector, but there is no band here either.
    expect(drawsBand(requireNodeDef('neuron.explore'))).toBe(false)
  })
})
