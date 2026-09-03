// @vitest-environment jsdom

/**
 * The small-screen notice.
 *
 * Three things are worth pinning, and each is invisible in the place it breaks.
 *
 * **The thresholds.** They are the whole design decision — a tablet must get the app and a phone
 * must get the notice, in both orientations — and jsdom evaluates no media query, so nothing else
 * in the suite can see them. `evaluate` below is a parser for exactly this query's shape and
 * refuses anything else, so the table of real device viewports is checking the *numbers* rather
 * than checking itself.
 *
 * **The guides dialog standing down.** `coda.guidesSeen.v1` is written the moment that dialog
 * mounts, so a first visit on a phone would spend it behind an opaque backdrop and the reader
 * would never be offered the guides at all. It is the kind of thing that works perfectly in
 * every test and is wrong for exactly the visitor it was meant for.
 *
 * **Growing the viewport writes nothing.** Coming back from a narrowed desktop window is not an
 * acknowledgement, and storing it there would silence the notice on the phone that reader picks
 * up later.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { loadSmallScreenAck } from '../../store/persistence'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import { SMALL_SCREEN_QUERY, resetSmallScreenForTest } from '../smallScreen'

// ---------------------------------------------------------------------------
// A matchMedia that actually answers
// ---------------------------------------------------------------------------

interface Viewport {
  width: number
  height: number
}

/**
 * Evaluate the notice's query against a viewport.
 *
 * Understands one shape — comma-separated `(max-width: Npx)` / `(max-height: Npx)` terms, OR-ed,
 * which is what a comma means in a media query list — and throws on anything else. That refusal
 * is deliberate: a query rewritten into a form this cannot read should fail loudly here rather
 * than quietly answering `false` and turning every case below green.
 */
function evaluate(query: string, view: Viewport): boolean {
  return query.split(',').some((raw) => {
    const term = /^\s*\(max-(width|height):\s*(\d+)px\)\s*$/.exec(raw)
    if (!term) throw new Error(`smallScreen.test cannot read the term "${raw.trim()}"`)
    const size = term[1] === 'width' ? view.width : view.height
    return size <= Number(term[2])
  })
}

let viewport: Viewport = { width: 1440, height: 900 }
const listeners = new Set<() => void>()

function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return evaluate(query, viewport)
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

/** Resize, and tell whoever is watching — the browser fires `change` on the list itself. */
function setViewport(next: Viewport): void {
  viewport = next
  act(() => {
    for (const fn of [...listeners]) fn()
  })
}

const PHONE_PORTRAIT = { width: 390, height: 844 }
const PHONE_LANDSCAPE = { width: 844, height: 390 }
const DESKTOP = { width: 1440, height: 900 }

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
  installMatchMedia()
})

beforeEach(() => {
  clearStorage()
  listeners.clear()
  viewport = DESKTOP
  resetSmallScreenForTest()
  act(() => {
    // The state a first visit is in — the guides dialog's turn, which is what this has to get
    // in front of without spending.
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

const notice = () => document.querySelector('.small-screen')
const guides = () => document.querySelector('.guides')
const proceed = () => screen.getByRole('button', { name: 'Open it anyway' })

// ---------------------------------------------------------------------------

describe('the small-screen thresholds', () => {
  /*
   * Real CSS-pixel viewports. The tablets are the reason the numbers are where they are: the
   * iPad mini's 744 portrait width is the tightest constraint in the table, and a threshold
   * raised to a round 768 or 800 would take every tablet with it.
   */
  const devices: [string, Viewport, boolean][] = [
    ['iPhone SE portrait', { width: 375, height: 667 }, true],
    ['iPhone 16 Pro Max portrait', { width: 440, height: 956 }, true],
    ['iPhone 16 Pro Max landscape', { width: 956, height: 440 }, true],
    ['a narrowed desktop window', { width: 520, height: 900 }, true],
    ['iPad mini portrait', { width: 744, height: 1133 }, false],
    ['iPad mini landscape', { width: 1133, height: 744 }, false],
    ['iPad Pro portrait', { width: 1024, height: 1366 }, false],
    ['a laptop', { width: 1440, height: 900 }, false],
  ]

  it.each(devices)('%s', (_label, view, warned) => {
    expect(evaluate(SMALL_SCREEN_QUERY, view)).toBe(warned)
  })
})

describe('the small-screen notice', () => {
  it('stays out of the way at any ordinary size', () => {
    render(<App />)
    expect(notice()).toBeNull()
    // The property the other three dozen App suites are relying on without knowing it.
    expect(guides()).toBeTruthy()
  })

  it('covers the app on a phone, in either orientation', () => {
    viewport = PHONE_PORTRAIT
    render(<App />)
    expect(notice()).toBeTruthy()

    cleanup()
    resetSmallScreenForTest()
    viewport = PHONE_LANDSCAPE
    render(<App />)
    expect(notice()).toBeTruthy()
  })

  /*
   * The silent one. `saveGuidesSeen` runs on mount, so a guides dialog rendered behind this
   * would burn the single visit it gets on a modal nobody saw.
   */
  it('holds back the first-run guides dialog, without spending it', () => {
    viewport = PHONE_PORTRAIT
    render(<App />)
    expect(guides()).toBeNull()

    fireEvent.click(proceed())
    expect(notice()).toBeNull()
    expect(guides()).toBeTruthy()
  })

  it('stays away once, and stays away next visit', () => {
    viewport = PHONE_PORTRAIT
    render(<App />)
    fireEvent.click(proceed())
    expect(loadSmallScreenAck()).toBe(true)

    cleanup()
    resetSmallScreenForTest()
    render(<App />)
    expect(notice()).toBeNull()
  })

  /*
   * A window pulled back out is somebody fixing the condition rather than accepting it, so the
   * notice goes and nothing is written — narrowing again brings it back, and so does the phone
   * they pick up later.
   */
  it('gets out of the way when the viewport grows, and remembers nothing', () => {
    viewport = PHONE_PORTRAIT
    render(<App />)
    expect(notice()).toBeTruthy()

    setViewport(DESKTOP)
    expect(notice()).toBeNull()
    expect(loadSmallScreenAck()).toBe(false)

    setViewport(PHONE_PORTRAIT)
    expect(notice()).toBeTruthy()
  })
})
