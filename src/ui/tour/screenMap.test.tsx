// @vitest-environment jsdom

/**
 * The Screen Map's half that jsdom can see.
 *
 * Not where anything lands — jsdom performs no layout, so every `getBoundingClientRect` is one
 * constant and the placement is `mapLayout.test.ts`' business, fed real numbers. What is here is
 * everything else, and the first of them is the one that actually rots:
 *
 * **Does every spot still find something?** A map is not a route. Rename `.statusbar`, drop the
 * `data-tour` off `Save`, move the view rail inside something else, and nothing in the app
 * fails — the map just quietly stops labelling a control, once, for whoever opens it next. Same
 * failure `tour.test.tsx` exists for, and the same fix: mount the real `App` with the real store
 * and assert against the markup the app renders.
 *
 * Then the lifecycle, which is the part with a way to be wrong that nobody would notice: the map
 * borrows the inspector and a selection, and a borrow that is not handed back is a persisted
 * preference silently rewritten by a guide.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { installMatchMedia, setViewport } from '../../test/matchMedia'
import { resetSmallScreenForTest } from '../smallScreen'
import { TOURS, startTour } from './tourState'
import { MAP_SPOTS } from './mapSpots'

beforeAll(() => {
  installJsdomStubs({ width: 360, height: 220 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    // The map ticks itself off on close, and the store outlives a `cleanup()` — so without this
    // the checkmark test reads the previous test's tick.
    useGraphStore.setState({ completedGuides: [] })
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
  })
})

afterEach(() => {
  act(() => useGraphStore.getState().closeScreenMap())
  cleanup()
})

/** Open the map the way every surface opens it. */
async function open(): Promise<void> {
  await act(async () => {
    await startTour('map')
  })
}

describe('the Screen Map', () => {
  it('is one of the guides, and the first of them', () => {
    expect(TOURS[0]?.id).toBe('map')
  })

  it('finds every spot it means to label', async () => {
    render(<App />)
    await open()
    const missing = MAP_SPOTS.filter(
      (spot) => spot.find(document).filter(Boolean).length === 0,
    ).map((spot) => spot.id)
    expect(missing).toEqual([])
  })

  it('draws a box and a label for each', async () => {
    const { container } = render(<App />)
    await open()
    expect(container.querySelectorAll('.smap__box')).toHaveLength(MAP_SPOTS.length)
    // Read off the map rather than off the document: "Run" and "Share" are on the toolbar too,
    // and a `getByText` that found the button instead would pass with no label drawn at all.
    const drawn = [...container.querySelectorAll('.smap__label')].map((label) => [
      label.querySelector('strong')?.textContent,
      label.querySelector('span')?.textContent,
    ])
    expect(drawn).toEqual(MAP_SPOTS.map((spot) => [spot.label, spot.note]))
  })

  /*
   * The inspector is a persisted preference (`coda.panels.v1`) and a guide is not a reason to
   * have changed it — `tour.ts`'s note argues this at length for the tours, and the map borrows
   * the same two things for the same one screen.
   */
  it('hands back the inspector and the selection it borrowed', async () => {
    act(() => {
      const state = useGraphStore.getState()
      if (state.panels.inspector) state.togglePanel('inspector')
      state.setSelection([])
    })
    render(<App />)
    await open()
    expect(useGraphStore.getState().panels.inspector).toBe(true)
    expect(useGraphStore.getState().selection.length).toBe(1)
    act(() => useGraphStore.getState().closeScreenMap())
    expect(useGraphStore.getState().panels.inspector).toBe(false)
    expect(useGraphStore.getState().selection).toEqual([])
  })

  /*
   * An inspector the reader had open stays open afterwards, which is the other half of the same
   * rule and the half a "close it on the way out" implementation gets wrong.
   */
  it('leaves an inspector that was already open alone', async () => {
    act(() => {
      const state = useGraphStore.getState()
      if (!state.panels.inspector) state.togglePanel('inspector')
    })
    render(<App />)
    await open()
    act(() => useGraphStore.getState().closeScreenMap())
    expect(useGraphStore.getState().panels.inspector).toBe(true)
  })

  /*
   * A checkmark however it was closed. It has no steps, so there is no half-way through to
   * abandon — see `GuidesDialog`'s note, which this is the exception clause of.
   */
  it('is completed by being closed', async () => {
    render(<App />)
    await open()
    expect(useGraphStore.getState().completedGuides).not.toContain('map')
    act(() => useGraphStore.getState().closeScreenMap())
    expect(useGraphStore.getState().completedGuides).toContain('map')
  })

  it('opens a workflow on an empty canvas, and says so', async () => {
    act(() => useGraphStore.getState().newGraph())
    render(<App />)
    await open()
    expect(useGraphStore.getState().graph.nodes.length).toBeGreaterThan(0)
    expect(screen.getByText(/canvas was empty/)).toBeTruthy()
  })

  it('leaves the graph alone when there is one', async () => {
    render(<App />)
    const before = useGraphStore.getState().graph.nodes.length
    await open()
    expect(useGraphStore.getState().graph.nodes.length).toBe(before)
    expect(screen.queryByText(/canvas was empty/)).toBeNull()
  })

  /*
   * What the leaders are for. A figure with sixteen labels is one a reader has to trace, and the
   * question at any moment is which label goes with which box — so hovering either end lights the
   * box, the leader and the label together.
   *
   * Asserted through `data-spot`, which is the only thing that says the three parts are *the
   * same* spot: a version that lit the right number of elements while pairing them wrongly would
   * look correct in a screenshot. The leader is included by id for that reason.
   *
   * What jsdom cannot see is whether the hover can happen at all — that is `pointer-events`,
   * which it computes no styles for, and the cascade collision it invites is real (see
   * `screenMap.css`). `pnpm probe:screen-map` drives a real pointer.
   */
  it('lights the box, the leader and the label of one spot together', async () => {
    const { container } = render(<App />)
    await open()
    const spot = 'run'
    const box = container.querySelector(`.smap__box[data-spot="${spot}"]`)!
    expect(container.querySelector('.smap[data-hover]')).toBeNull()

    fireEvent.pointerEnter(box)
    expect(container.querySelector('.smap[data-hover]')).toBeTruthy()
    expect(
      [...container.querySelectorAll('[data-hot]')].map((el) => el.getAttribute('data-spot')),
    ).toEqual([spot, spot, spot])

    fireEvent.pointerLeave(box)
    expect(container.querySelectorAll('[data-hot]')).toHaveLength(0)
    expect(container.querySelector('.smap[data-hover]')).toBeNull()
  })

  /*
   * The label is the other end of the same leader, and for a region it is the *only* end: the
   * canvas's box is most of the window and the inspector's a whole column, so neither takes the
   * pointer — a box that big means the pointer is always on something and every other spot spends
   * its life dimmed.
   */
  it('lights a region from its label, which is the only way in', async () => {
    const { container } = render(<App />)
    await open()
    const label = container.querySelector('.smap__label[data-spot="canvas"]')!
    fireEvent.pointerEnter(label)
    const lit = [...container.querySelectorAll('[data-hot]')]
    // A region label has no leader, so the pair is the box and the label — never three.
    expect(lit.map((el) => el.className)).toEqual(['smap__box', 'smap__label'])
    expect(lit.every((el) => el.getAttribute('data-spot') === 'canvas')).toBe(true)
  })

  /*
   * The narrow shell gets the same words as a list, and the reason is not that a 176px label is
   * awkward at 412px: below `NARROW_QUERY` the toolbar has folded most of what this names into
   * `⋯`, so over half the boxes would simply be missing — and a map with holes in it is worse
   * than a list, because the holes are invisible. The list carries every spot including the ones
   * not on screen, which is the one thing it can do that the map cannot.
   *
   * jsdom's own `matchMedia` answers `false` to everything, so this needs the parser that really
   * evaluates a query — the same harness `narrow.test.tsx` uses.
   */
  it('stands down to a list on the narrow shell, carrying every spot', async () => {
    installMatchMedia()
    setViewport({ width: 412, height: 915 })
    resetSmallScreenForTest()
    try {
      const { container } = render(<App />)
      await open()
      expect(container.querySelector('.smap__label')).toBeNull()
      const rows = [...container.querySelectorAll('.smap__rows li')].map(
        (row) => row.querySelector('strong')?.textContent,
      )
      expect(rows).toEqual(MAP_SPOTS.map((spot) => spot.label))
    } finally {
      setViewport({ width: 1440, height: 900 })
      resetSmallScreenForTest()
    }
  })

  /*
   * `f`, `i` and `d` each move or unmount half of what the map is pointing at, and the map has no
   * event to learn that they did — so the same guard the tours use has to see it.
   */
  it('counts as a guide for the shortcut guard', async () => {
    const { isTourActive } = await import('./tourState')
    render(<App />)
    expect(isTourActive()).toBe(false)
    await open()
    expect(isTourActive()).toBe(true)
    act(() => useGraphStore.getState().closeScreenMap())
    expect(isTourActive()).toBe(false)
  })
})
