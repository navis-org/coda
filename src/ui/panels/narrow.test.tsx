// @vitest-environment jsdom

/**
 * The narrow shell: the toolbar folded into `⋯`, and a panel that takes the screen.
 *
 * The bug behind all of it is one a test in this suite cannot see. The toolbar's controls come to
 * 973px of min-content width; below that it overflows, which makes the *document* wider than the
 * viewport, which a mobile browser answers by zooming out to fit — so the app renders at 42% in
 * the top corner of the screen with its status bar hanging in mid-air. jsdom performs no layout,
 * so the measurement lives in `pnpm probe:mobile`, which drives a real Chrome told it is a Pixel
 * 7 and fails if the document is ever wider than the viewport it was given.
 *
 * What *is* checkable here is everything about which control is drawn where, and three of those
 * are silent when wrong:
 *
 * **Nothing is lost on the way into the menu.** A phone has no keyboard and no command palette
 * reachable by touch, so a control that is neither on the row nor in `⋯` is a control that has
 * gone. This asserts the folded set by accessible *name* — the same names the wide row uses —
 * which is what makes a rename break here rather than quietly leaving the phone's copy behind.
 *
 * **`data-narrow` is the CSS's half of the arrangement.** The threshold is declared once in TS
 * and the stylesheet reads the attribute, so a shell that folded its toolbar without stamping
 * the attribute would leave the keyboard hints and a 320px inspector column on a 412px screen.
 * Nothing about the toolbar rendering says whether the attribute went on.
 *
 * **The threshold is width only.** `SMALL_SCREEN_QUERY` also matches a short window, because a
 * phone in landscape is wide; folding the toolbar on that rule would take the controls away from
 * a laptop in a short window, which has 1400px of room for them.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import type { Viewport } from '../../test/matchMedia'
import { evaluateQuery, installMatchMedia, setViewport } from '../../test/matchMedia'
import { NARROW_QUERY, resetSmallScreenForTest } from '../smallScreen'
import { submenuPlacement } from './Toolbar'

const PHONE = { width: 412, height: 915 }
const DESKTOP = { width: 1440, height: 900 }

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
  installMatchMedia()
})

beforeEach(() => {
  clearStorage()
  setViewport(DESKTOP)
  resetSmallScreenForTest()
  act(() => {
    // No first-run modals: the notice covers the shell this is about, and the guides dialog
    // stands in front of it. Both are `smallScreen.test.tsx`'s subject rather than this one's.
    useGraphStore.setState({
      startPageOpen: false,
      guidesOpen: false,
      startPageDismissed: true,
      panels: { ...useGraphStore.getState().panels, inspector: false, assistant: false },
    })
    useGraphStore.getState().newGraph()
  })
})

afterEach(cleanup)

const shell = () => document.querySelector('.app')
const more = () => screen.getByRole('button', { name: 'More toolbar controls' })
const menu = () => document.querySelector('.dropdown__panel')

/**
 * One row of the open `⋯` menu, found by its first line.
 *
 * By the `<strong>` rather than by the accessible name, because a `.dropdown__item` is named by
 * everything in it — label *and* blurb, which is the idiom every menu in this toolbar follows.
 * The first line is the half that has to match the button's name on the wide row, and matching
 * it here is what makes a rename on one side fail rather than quietly leave the other behind.
 */
function row(label: string): HTMLElement {
  const panel = menu()
  if (!panel) throw new Error('the ⋯ menu is not open')
  const line = within(panel as HTMLElement).getByText(label, { selector: 'strong' })
  const button = line.closest('button')
  if (!button) throw new Error(`"${label}" is in the menu but not as a row`)
  return button
}

/*
 * Every control that folds, by the name it answers to in both places. The bell is in here
 * too — it keeps its own component for its permission state, and that is exactly the one most
 * likely to be forgotten when the menu is next edited.
 */
const FOLDED = [
  'Undo',
  'Redo',
  'Share workflow',
  'Connections',
  'Assistant',
  'Inspector',
  'Dashboard',
  'Clear results',
  'Notify me when a run finishes',
  'Theme',
]

/*
 * Visible on the row at any width. The three document menus are named by their own text — a
 * `Dropdown` with no `title` takes its name from the label it draws — while `?` carries
 * `title="Help"` because a question mark is not a name, and Run is labelled explicitly since
 * "Run 5 ⇧R" is a poor one.
 */
const ALWAYS = ['New ▾', 'Open ▾', 'Save ▾', 'Help', 'Run all stale nodes']

// ---------------------------------------------------------------------------

describe('the narrow threshold', () => {
  /*
   * Three rows, not a device table — `smallScreen.test.tsx` runs one of those through the same
   * parser, and repeating it here would only re-check that 720 is compared against a width.
   * What is this module's own is the *second* row: a short desktop window matches
   * `SMALL_SCREEN_QUERY` and must not match this one, which is the whole of what "width only"
   * buys. The tablet is the other end of the same statement.
   */
  const cases: [string, Viewport, boolean][] = [
    ['a phone in portrait', PHONE, true],
    ['a short desktop window', { width: 1440, height: 500 }, false],
    ['iPad mini portrait', { width: 744, height: 1133 }, false],
  ]

  it.each(cases)('%s', (_label, view, narrow) => {
    expect(evaluateQuery(NARROW_QUERY, view)).toBe(narrow)
  })
})

/*
 * The geometry, handed in as numbers. This is the half of the fix a jsdom suite can reach — the
 * component only supplies rects, and jsdom measures nothing — and both failing cases below were
 * measured in a real browser before they were written down here.
 */
describe('where a submenu opens', () => {
  const PANEL = 260

  /** A row whose panel is `PANEL` wide, at `left` in a `viewport`-wide window. */
  const at = (left: number, viewport: number) => ({
    width: PANEL,
    rowLeft: left,
    rowRight: left + PANEL,
    viewport,
  })

  it('opens to the right when there is room, which is the desktop case', () => {
    expect(submenuPlacement(at(229, 1440), false)).toBe('right')
  })

  it('opens to the left when only that side fits', () => {
    // A menu near the right edge: 900 + 260 runs past 1000, 900 - 260 clears the gutter.
    expect(submenuPlacement(at(640, 1000), false)).toBe('left')
  })

  /*
   * The tablet case, and the reason this is not a phone rule. At 744 the New menu's panel sits
   * at 229, so the flyout misses on the right by 9px and on the left by 27 — a two-answer flip
   * had to pick one, and picked the 27.
   */
  it('goes inline when neither side fits, rather than picking the less bad one', () => {
    expect(submenuPlacement(at(229, 744), false)).toBe('inline')
  })

  /*
   * The reported case. Answered before any measurement, so the flyout is never painted beside
   * the row and then moved: no shell this narrow can seat a 260px panel next to a 260px one.
   */
  it('goes inline on the narrow shell without waiting to measure', () => {
    expect(submenuPlacement(undefined, true)).toBe('inline')
    expect(submenuPlacement(at(27, 412), true)).toBe('inline')
  })

  it('defaults to the right until it has been measured', () => {
    expect(submenuPlacement(undefined, false)).toBe('right')
  })
})

describe('the wide shell', () => {
  it('draws every control on the row, and offers no overflow menu', () => {
    render(<App />)
    for (const name of [...ALWAYS, ...FOLDED]) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: 'More toolbar controls' })).toBeNull()
    expect(shell()?.getAttribute('data-narrow')).toBeNull()
  })
})

describe('the narrow shell', () => {
  // Every case here is about the phone-sized window, so it is set once — a case that forgot it
  // would otherwise assert the wide shell's behaviour under this heading and pass.
  beforeEach(() => setViewport(PHONE))

  it('stamps the attributes the stylesheet reads', () => {
    render(<App />)
    expect(shell()?.getAttribute('data-narrow')).toBe('true')

    /*
     * The panel half of the same arrangement. An open inspector is a `data-` attribute rather
     * than something the stylesheet sniffs with `:has()`, which is what lets "both open, the
     * inspector wins" be a selector — and it is the only part of that rule a test with no
     * layout can reach.
     */
    expect(shell()?.getAttribute('data-inspector')).toBeNull()
    act(() => useGraphStore.getState().togglePanel('inspector'))
    expect(shell()?.getAttribute('data-inspector')).toBe('open')
  })

  it('keeps the document menus, Run and fullscreen on the row', () => {
    render(<App />)
    for (const name of ALWAYS) expect(screen.getByRole('button', { name })).toBeTruthy()
    // Fullscreen earns its place on a phone rather than despite being one: the browser's own
    // chrome is ~56px of the screen and this is the only way to get it.
    expect(screen.getByRole('button', { name: 'Enter fullscreen' })).toBeTruthy()
  })

  it('takes the rest off the row and puts every one of them in the menu', () => {
    render(<App />)

    for (const name of FOLDED) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }

    fireEvent.click(more())
    for (const name of FOLDED) expect(row(name)).toBeTruthy()
  })

  /*
   * The workflow name and Auto-run are the two that are not commands, so they are rendered as
   * themselves in a `.dropdown__row` rather than re-spelt as menu items — which is what lets
   * every *other* row close the menu on its click without needing an exception.
   */
  it('carries the two controls that are not commands, as controls', () => {
    render(<App />)
    fireEvent.click(more())

    const name = screen.getByTitle('Graph name — used as the filename when saving')
    expect((name as HTMLInputElement).value).toBe(
      useGraphStore.getState().graph.meta?.name ?? '',
    )
    expect(screen.getByRole('checkbox')).toBeTruthy()
  })

  it('acts on a row and closes behind it', () => {
    render(<App />)
    fireEvent.click(more())
    fireEvent.click(row('Inspector'))

    expect(useGraphStore.getState().panels.inspector).toBe(true)
    expect(menu()).toBeNull()
  })

  /*
   * A window pulled back out puts them back with no reload. The same property the notice has,
   * and for the same reason: nothing about this is stored.
   */
  it('unfolds again when the window grows', () => {
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Dashboard' })).toBeNull()

    act(() => setViewport(DESKTOP))
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeTruthy()
    expect(shell()?.getAttribute('data-narrow')).toBeNull()
  })
})
