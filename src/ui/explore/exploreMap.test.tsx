// @vitest-environment jsdom

/**
 * Explore Dataset's screen map — the half jsdom can see.
 *
 * Where the labels land is `mapLayout.test.ts`' and the browser probe's. What is here is what a
 * node's map adds to the shell's: that every finder resolves **inside the surface**, which is the
 * failure specific to a body drawn twice (the card on the canvas carries the same markup), and
 * that the map is a layer *over* a dialog — so Escape and a press on the scrim shut the map and
 * leave the viewer under it alone.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { resetIndexLoads } from '../../data/neuronIndex'
import { resetCache } from '../../data/cache'
import { useGraphStore } from '../../store/graphStore'
import { buildWorkflow, DEMO_DATASET } from '../../wizard/build'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { resetNeuronIndexState } from '../useNeuronIndex'
import { encodeChip, encodeColumn } from './rowColumns'
import { EXPLORE_MAP_SPOTS } from './exploreMap'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

/** The browse workflow the wizard builds, on the synthetic dataset. */
function browseWorkflow() {
  const graph = buildWorkflow({
    datasets: [DEMO_DATASET],
    start: 'browse',
    analysis: 'partners',
    visualisations: ['table'],
    notes: false,
    dashboard: false,
  })
  const explore = graph.nodes.find((node) => node.type === 'neuron.explore')!
  /*
   * A chip placed by hand. The synthetic dataset's fields are all well filled, so the automatic
   * list draws none — and a spot with nothing to find is (correctly) left off the map, which
   * would make every assertion below one short for a reason that has nothing to do with the map.
   */
  explore.params.layout = [
    encodeColumn({ render: 'text', fields: ['type'] }),
    encodeColumn({ render: 'number', fields: ['post'] }),
    encodeChip('instance'),
  ]
  return { graph, explore: explore.id }
}

let exploreId = ''

beforeEach(() => {
  clearStorage()
  resetCache()
  resetIndexLoads()
  resetNeuronIndexState()
  const { graph, explore } = browseWorkflow()
  exploreId = explore
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(graph)
  })
})

afterEach(() => {
  act(() => useGraphStore.getState().expandNode(undefined))
  cleanup()
  vi.restoreAllMocks()
})

/** Mount the app, expand the Explore node, and wait for its rows. */
async function expanded() {
  const view = render(<App />)
  act(() => useGraphStore.getState().expandNode(exploreId))
  const overlay = await screen.findByRole('dialog', { name: /output$/ })
  await waitFor(() => expect(overlay.querySelector('.explore-row')).toBeTruthy())
  return { ...view, overlay }
}

const openMap = () =>
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: /^Screen map of/ }))
  })

describe('Explore Dataset’s screen map', () => {
  /*
   * The card on the canvas is mounted too — it is the same `ExploreBody` — so a finder that asked
   * the document would resolve, and pass a "finds something" test, while pointing at the card.
   */
  it('finds every spot, and only inside the surface', async () => {
    const { overlay } = await expanded()
    const body = overlay.querySelector('.overlay__body')!
    for (const spot of EXPLORE_MAP_SPOTS) {
      const found = spot.find(body).filter(Boolean) as Element[]
      expect(found.length, spot.id).toBeGreaterThan(0)
      expect(
        found.every((el) => overlay.contains(el)),
        spot.id,
      ).toBe(true)
    }
    // And the card really is there, or the second half proves nothing.
    expect(document.querySelector('.react-flow .explore__input')).toBeTruthy()
  })

  /*
   * The finders being right is not the whole of it: the stage has to be *handed* the scope. jsdom
   * reports one rect for every element, so the card and the overlay are told apart here by rect —
   * anything outside the overlay reports itself 4000px away, and a box that unioned one in would
   * be that wide.
   */
  it('boxes what is in the surface, not the card behind it', async () => {
    const { overlay } = await expanded()
    // `installJsdomStubs` defines the rect on `HTMLElement.prototype`, so that is where to spy.
    const real = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = real.call(this)
      if (overlay.contains(this) || this.closest('.smap')) return rect
      return { ...rect, x: rect.x + 4000, left: rect.left + 4000, right: rect.right + 4000 }
    })
    openMap()
    const boxes = [...document.querySelectorAll<HTMLElement>('.smap__box')]
    expect(boxes).toHaveLength(EXPLORE_MAP_SPOTS.length)
    for (const box of boxes)
      expect(parseFloat(box.style.width), box.dataset.spot).toBeLessThan(4000)
  })

  it('draws a box and its label for each', async () => {
    await expanded()
    openMap()
    const drawn = [...document.querySelectorAll('.smap__label')].map((label) => [
      label.querySelector('strong')?.textContent,
      label.querySelector('span')?.textContent,
    ])
    expect(drawn).toEqual(EXPLORE_MAP_SPOTS.map((spot) => [spot.label, spot.note]))
    expect(screen.getByRole('dialog', { name: 'Explore Dataset' })).toBeTruthy()
  })

  /*
   * Both listeners take Escape on the capture phase at `window`, where `stopPropagation` does not
   * stop a sibling — so the viewer has to stand aside while a map is up, or one press shuts both.
   */
  it('closes on Escape and leaves the viewer open', async () => {
    const { overlay } = await expanded()
    openMap()
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(document.querySelector('.smap')).toBeNull()
    expect(overlay.isConnected).toBe(true)
    expect(useGraphStore.getState().expandedNodeId).toBe(exploreId)
    // The next press is the viewer's again.
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(useGraphStore.getState().expandedNodeId).toBeUndefined()
  })

  /*
   * The stage is portalled out of the overlay (its `backdrop-filter` would otherwise be the
   * containing block for every fixed box), but React events still bubble through the tree — to
   * the overlay's backdrop, which closes on a press.
   */
  it('closes on a press outside its panel and leaves the viewer open', async () => {
    await expanded()
    openMap()
    act(() => {
      fireEvent.pointerDown(document.querySelector('.smap__scrim')!)
    })
    expect(document.querySelector('.smap')).toBeNull()
    expect(useGraphStore.getState().expandedNodeId).toBe(exploreId)
  })

  it('is offered only by a body that declares one', async () => {
    const table = useGraphStore.getState().graph.nodes.find((node) => node.type === 'out.table')
    render(<App />)
    act(() => useGraphStore.getState().expandNode(table!.id))
    await screen.findByRole('dialog', { name: /output$/ })
    expect(screen.queryByRole('button', { name: /^Screen map of/ })).toBeNull()
  })
})
