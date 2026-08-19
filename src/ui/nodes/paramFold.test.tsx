// @vitest-environment jsdom

/**
 * Folding a viewer's param rows away.
 *
 * A widget is configured once and then looked at for the rest of the session, so the rows that
 * set it up spend the card's height on a decision already made. The fold gives that height back.
 *
 * Two things here fail silently rather than loudly, which is what this file is for. The button
 * lives in the *header* — folded, the band is not rendered at all, so a toggle inside it would
 * leave nothing to press — and the fold must cost no run: it is a card-layout decision, and a
 * graph going stale because somebody tidied a chart reads as a scheduler bug.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { allNodeDefs, requireNodeDef } from '../../core/registry'
import type { NodeDefinition } from '../../core/node'
import { isViewer } from '../../core/node'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 420, height: 300 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadExample('roi-summary')
  })
})

afterEach(cleanup)

function nodeIdOfType(type: string): string {
  const found = useGraphStore.getState().graph.nodes.find((n) => n.type === type)
  if (!found) throw new Error(`no ${type} in the example`)
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

  it('is offered on viewers only', async () => {
    // A transform node's rows *are* its card. Folding them would leave a header and a footer
    // with no visible way back, and `collapsed` already says "hide this node's middle".
    render(<App />)
    const group = nodeIdOfType('core.groupBy')
    const card = await cardFor(group)
    expect(card.querySelectorAll('.coda-node__params .param').length).toBeGreaterThan(0)
    expect(foldButton(card)).toBeNull()
  })
})

describe('what the store will and will not fold', () => {
  it('refuses a non-viewer, so the flag never lands where nothing can undo it', () => {
    const store = useGraphStore.getState()
    const group = nodeIdOfType('core.groupBy')
    act(() => store.toggleParamRows([group]))
    expect(
      useGraphStore.getState().graph.nodes.find((n) => n.id === group)?.paramsCollapsed,
    ).toBeUndefined()
    // A refused fold is not a commit either — it must not consume the undo stack.
    expect(useGraphStore.getState().past).toHaveLength(0)
  })

  it('folds the viewers out of a mixed selection and skips the rest', () => {
    const chart = nodeIdOfType('out.barChart')
    const group = nodeIdOfType('core.groupBy')
    act(() => useGraphStore.getState().toggleParamRows([chart, group]))
    const nodes = useGraphStore.getState().graph.nodes
    expect(nodes.find((n) => n.id === chart)?.paramsCollapsed).toBe(true)
    expect(nodes.find((n) => n.id === group)?.paramsCollapsed).toBeUndefined()
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

describe('which nodes the affordance reaches', () => {
  /*
   * The card's own rule, restated once: a viewer with at least one non-advanced param. Stated
   * here as a set rather than checked node by node, because the failure being guarded is a
   * *policy* drift — a viewer added tomorrow that quietly gets no button, or a param moved to
   * `advanced` that empties a band the header still offers to fold.
   */
  const offersFold = (def: NodeDefinition) =>
    isViewer(def) && (def.params ?? []).some((p) => !p.advanced)

  it('reaches every viewer that draws a band, and no others', () => {
    const folding = allNodeDefs()
      .filter(offersFold)
      .map((d) => d.type)
    // Every one of these draws rows above a picture, which is the case this exists for.
    expect(folding).toEqual(
      expect.arrayContaining(['out.barChart', 'out.heatmap', 'out.network', 'out.table']),
    )
    // Nothing outside the viewers, however many params it has.
    expect(allNodeDefs().filter(offersFold).every(isViewer)).toBe(true)
  })

  it('does not offer to fold a band that is not drawn', () => {
    // Every neuroglancer param is `advanced`, i.e. inspector-only: a row of pickers above a
    // 400px embed takes a tenth of the space someone opened the node for. So there is nothing
    // on the card to fold, and a button promising otherwise would be a dead press.
    const ng = requireNodeDef('out.neuroglancer')
    expect(isViewer(ng)).toBe(true)
    expect(offersFold(ng)).toBe(false)
  })
})
