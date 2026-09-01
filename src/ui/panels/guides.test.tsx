// @vitest-environment jsdom

/**
 * The first-run guides dialog.
 *
 * What is worth pinning here is the *sequence*, not the markup: a dialog that appears in front
 * of the welcome page, is shown once ever, takes itself off screen for a guide and comes back
 * when that guide ends. Every one of those is a two-surface arrangement — this dialog and the
 * start page, this dialog and `tour.ts` — and each fails silently in a different way. A guides
 * dialog that forgets to stand down leaves two modals stacked; one that forgets to come back
 * drops the reader on a canvas with nothing saying what just happened; a checkmark awarded for
 * *starting* a guide is a lie nobody would notice.
 *
 * `startTour` is stubbed for `startPage.test.tsx`'s reason: it is an `import()` of driver.js,
 * and the tours themselves are covered by `tour.test.tsx` without loading it. Everything else
 * is the real store, so the return trip is driven through `finishGuide` exactly as `tour.ts`
 * calls it.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { loadGuidesDone, loadGuidesSeen } from '../../store/persistence'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import type * as TourState from '../tour/tourState'
import { TOURS } from '../tour/tourState'

const tours = vi.hoisted(() => ({ started: [] as string[] }))
vi.mock('../tour/tourState', async (importOriginal) => ({
  ...(await importOriginal<typeof TourState>()),
  startTour: (id: string) => {
    tours.started.push(id)
    return Promise.resolve()
  },
}))

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  // Node 26 shadows jsdom's localStorage, so without this neither the seen flag nor the
  // completed list can be observed at all.
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  tours.started.length = 0
  act(() => {
    /*
     * The state a first visit is in. Set explicitly because the store is a module singleton
     * created at import — it made this decision once, from whatever storage looked like then,
     * and one case's ending would otherwise be the next one's beginning.
     */
    useGraphStore.setState({
      startPageOpen: true,
      guidesOpen: true,
      startPageDismissed: false,
      completedGuides: [],
      zooOpen: false,
    })
    useGraphStore.getState().newGraph()
  })
})

afterEach(cleanup)

const dialog = () => document.querySelector('.guides')
const welcome = () => document.querySelector('.start__panel')
const rows = () => [...document.querySelectorAll<HTMLElement>('.guides__row')]

/** One guide's row, found by the name it shows — the label `TOURS` carries. */
function row(label: string): HTMLElement {
  const found = rows().find((el) => el.querySelector('.guides__name')?.textContent?.includes(label))
  if (!found) throw new Error(`No row for "${label}"`)
  return found
}

describe('the guides dialog', () => {
  it('opens in front of the welcome page, listing every guide from the one table', () => {
    render(<App />)
    expect(dialog()).toBeTruthy()
    // The whole point of the ordering: the welcome page is not also on screen behind it.
    expect(welcome()).toBeNull()
    expect(rows()).toHaveLength(TOURS.length)
    for (const tour of TOURS) expect(row(tour.label).textContent).toContain(tour.blurb)
  })

  /*
   * The nudge is the reason this exists rather than being one more card on the welcome page's
   * doors rail — that rail offers all three flat, which is the choice a newcomer cannot make.
   */
  it('nudges the first guide, and only while it is unfinished', () => {
    render(<App />)
    expect(row(TOURS[0].label).textContent).toContain('Start here')
    for (const tour of TOURS.slice(1)) {
      expect(row(tour.label).textContent).not.toContain('Start here')
    }

    act(() => {
      useGraphStore.setState({ completedGuides: [TOURS[0].id] })
    })
    expect(row(TOURS[0].label).textContent).not.toContain('Start here')
  })

  /*
   * On *sight*, which is what makes it a first-run dialog rather than a dismissible one: the
   * store reads this key when it is created, so a visit after this one opens on the welcome
   * page whatever the reader did here.
   */
  it('records that it has been shown, before anything is clicked', () => {
    expect(loadGuidesSeen()).toBe(false)
    render(<App />)
    expect(loadGuidesSeen()).toBe(true)
  })

  it('hands over to the welcome page when skipped', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(dialog()).toBeNull()
    expect(welcome()).toBeTruthy()
  })

  it('does the same on Escape', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(dialog()).toBeNull()
    expect(welcome()).toBeTruthy()
  })
})

describe('taking a guide', () => {
  it('clears the whole launch sequence off the canvas the guide runs over', () => {
    render(<App />)
    fireEvent.click(row(TOURS[0].label))
    expect(tours.started).toEqual([TOURS[0].id])
    expect(dialog()).toBeNull()
    // Not "the guides dialog closed and the welcome page opened", which is what a second
    // independent boolean would have produced.
    expect(welcome()).toBeNull()
  })

  it('comes back when the guide ends, with the guide ticked off', () => {
    render(<App />)
    fireEvent.click(row(TOURS[0].label))
    act(() => {
      useGraphStore.getState().finishGuide(TOURS[0].id, true)
    })
    expect(dialog()).toBeTruthy()
    expect(row(TOURS[0].label).dataset.done).toBe('')
    expect(row(TOURS[1].label).dataset.done).toBeUndefined()
    // Kept, so a reload during the first visit does not un-earn it.
    expect(loadGuidesDone()).toEqual([TOURS[0].id])
  })

  /*
   * Abandoning is not finishing. It still comes back — the reader is where they were, and
   * offering the list again is the useful thing — but the row is unticked, because a checkmark
   * that means "opened once" is worth nothing on the visit it is meant to help.
   */
  it('comes back unticked when the guide was abandoned part-way', () => {
    render(<App />)
    fireEvent.click(row(TOURS[0].label))
    act(() => {
      useGraphStore.getState().finishGuide(TOURS[0].id, false)
    })
    expect(dialog()).toBeTruthy()
    expect(row(TOURS[0].label).dataset.done).toBeUndefined()
    expect(loadGuidesDone()).toEqual([])
  })

  /*
   * The other half of the return trip, and the one that would have been silent: `finishGuide`
   * runs at the end of *every* tour, including the three the `?` menu and the welcome page's
   * rail launch. Those end on the canvas the reader was working on.
   */
  it('does not open over a guide launched from anywhere else', () => {
    act(() => {
      useGraphStore.setState({ startPageOpen: false })
    })
    render(<App />)
    act(() => {
      useGraphStore.getState().finishGuide(TOURS[1].id, true)
    })
    expect(dialog()).toBeNull()
    expect(welcome()).toBeNull()
    // The checkmark is still earned, wherever the guide was taken from.
    expect(loadGuidesDone()).toEqual([TOURS[1].id])
  })

  it('finishes one guide once, however many times it is taken', () => {
    render(<App />)
    for (const round of [0, 1]) {
      void round
      fireEvent.click(row(TOURS[0].label))
      act(() => {
        useGraphStore.getState().finishGuide(TOURS[0].id, true)
      })
    }
    expect(useGraphStore.getState().completedGuides).toEqual([TOURS[0].id])
  })

  /*
   * The button is the dialog's own summary of where the reader has got to, and it is the only
   * thing that changes once every guide is done — a dialog whose last state still says "Skip"
   * reads as though something was left undone.
   */
  it('offers an ending rather than a skip once every guide is finished', () => {
    act(() => {
      useGraphStore.setState({ completedGuides: TOURS.map((tour) => tour.id) })
    })
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Coda' }))
    expect(welcome()).toBeTruthy()
  })
})
