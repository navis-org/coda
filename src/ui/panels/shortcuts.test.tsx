// @vitest-environment jsdom

/**
 * The keyboard shortcuts card, and the table under it.
 *
 * Two things are worth pinning, and neither is "the dialog renders".
 *
 * The first is that every glyph on the card is a key something actually binds. A shortcut sheet
 * is the one surface whose whole value is being *true*: a wrong row is worse than a missing one,
 * because the reader presses the key, nothing happens, and what they learn is that the keyboard
 * does not work. So the ids the four consuming surfaces ask for are checked against the table,
 * and the keys the table advertises are checked against the window listener in `Editor.tsx` —
 * by dispatching them and watching the store, which is the only check that cannot go stale.
 *
 * The second is the platform split. `formatChord` is the only place in the app that knows ⌘ from
 * Ctrl, and it is exercised directly rather than through a render, because the interesting cases
 * (a bare shift chord, a spelled-out glyph) are cheap to state and expensive to reach in the DOM.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { DEFAULT_PANELS } from '../../store/persistence'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import {
  SHORTCUT_GROUPS,
  STATUS_BAR_HINTS,
  formatChord,
  shortcutHint,
  shortcutKeys,
} from '../shortcuts'
import { buildCommandItems } from './paletteItems'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.setState({ panels: { ...DEFAULT_PANELS } })
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
    useGraphStore.getState().closeStartPage()
  })
})

afterEach(cleanup)

const ALL = SHORTCUT_GROUPS.flatMap((g) => g.items)

const dialog = () => screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })

/** Open it the way the toolbar does, without depending on the menu markup. */
function open() {
  act(() => useGraphStore.getState().requestShortcuts())
}

describe('the table', () => {
  it('has no duplicate ids, so a badge cannot silently resolve to the wrong row', () => {
    const ids = ALL.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  /*
   * The status bar maps over these ids and `shortcutHint` throws on a miss, so a renamed entry
   * would take the whole bar down at runtime. Stating it here turns that into a red test.
   */
  it('answers every id the status bar asks for', () => {
    for (const id of STATUS_BAR_HINTS) expect(() => shortcutHint(id)).not.toThrow()
  })

  it('answers every id the palette asks for', () => {
    // Building the list is what calls `shortcutKeys`; a bad id throws before this returns.
    const build = () =>
      buildCommandItems({
        store: useGraphStore.getState(),
        fitView: () => {},
        fitSelected: () => {},
      })
    expect(build).not.toThrow()
    // And the badges really came from the table rather than from a literal left behind.
    const run = build().find((item) => item.id === 'cmd:run-all')
    expect(run?.shortcut).toBe(shortcutKeys('run-all'))
  })

  it('refuses an unknown id rather than rendering nothing', () => {
    expect(() => shortcutKeys('no-such-shortcut')).toThrow(/Unknown shortcut/)
  })
})

describe('formatChord', () => {
  it('writes the Apple glyph form with no separators', () => {
    expect(formatChord({ mod: true, shift: true, key: 'Z' }, true)).toBe('⇧⌘Z')
    expect(formatChord({ mod: true, key: 'D' }, true)).toBe('⌘D')
    expect(formatChord({ shift: true, key: 'R' }, true)).toBe('⇧R')
    expect(formatChord({ key: '⌫' }, true)).toBe('⌫')
  })

  it('writes Ctrl and spells the Apple-only glyphs out everywhere else', () => {
    expect(formatChord({ mod: true, shift: true, key: 'Z' }, false)).toBe('Ctrl+Shift+Z')
    expect(formatChord({ mod: true, key: 'D' }, false)).toBe('Ctrl+D')
    expect(formatChord({ shift: true, key: 'R' }, false)).toBe('Shift+R')
    expect(formatChord({ key: '⌫' }, false)).toBe('Backspace')
    expect(formatChord({ mod: true, key: '⏎' }, false)).toBe('Ctrl+Enter')
  })

  it('leaves a gesture alone on both platforms', () => {
    expect(formatChord({ shift: true, key: 'drag' }, true)).toBe('⇧drag')
    expect(formatChord({ shift: true, key: 'drag' }, false)).toBe('Shift+drag')
  })
})

describe('the dialog', () => {
  it('is absent until asked for, and mounting does not re-fire the last request', () => {
    render(<App />)
    expect(dialog()).toBeNull()

    open()
    expect(dialog()).not.toBeNull()

    // A remount must not reopen it: the store outlives the component and keeps the counter.
    cleanup()
    render(<App />)
    expect(dialog()).toBeNull()
  })

  it('shows every group and every row', () => {
    render(<App />)
    open()
    const panel = dialog()!
    for (const group of SHORTCUT_GROUPS) {
      expect(within(panel).getByRole('heading', { name: group.title })).toBeTruthy()
    }
    for (const item of ALL) {
      expect(within(panel).getByText(item.label)).toBeTruthy()
      // Both chords of a two-key row, not just the first — the card has room for both, and
      // ⇧A is exactly the one a badge surface had to drop.
      for (const chord of item.chords) {
        expect(within(panel).getAllByText(formatChord(chord)).length).toBeGreaterThan(0)
      }
    }
  })

  it('closes on Escape and on the ✕', () => {
    render(<App />)
    open()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(dialog()).toBeNull()

    open()
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Close' }))
    expect(dialog()).toBeNull()
  })

  /* Top level of the `?` menu, not inside either submenu — it is neither a walkthrough nor a
     document, and burying it would cost the one row somebody hunting for a key would find. */
  it('is reachable from the ? menu without opening a submenu', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Help' }))
    fireEvent.click(screen.getByRole('button', { name: /Keyboard Shortcuts/ }))
    expect(dialog()).not.toBeNull()
  })
})

/**
 * What the card claims, against what `Editor.tsx` actually binds.
 *
 * Only the keys the window listener owns are checkable this way — React Flow reads
 * `selectionKeyCode`, `multiSelectionKeyCode` and `deleteKeyCode` off props and handles them
 * itself, and the gestures need a real pointer over a real layout, which jsdom does not have.
 * So this covers the letters and chords, which are also the ones most likely to be rebound.
 */
describe('the keys the card advertises', () => {
  const key = (id: string) => {
    const item = ALL.find((s) => s.id === id)!
    return item.chords[0]
  }

  const press = (id: string) => {
    const chord = key(id)
    fireEvent.keyDown(window, {
      key: chord.key,
      shiftKey: chord.shift ?? false,
      metaKey: chord.mod ?? false,
    })
  }

  it('opens the assistant and the inspector', () => {
    render(<App />)
    expect(useGraphStore.getState().panels.assistant).toBe(false)
    act(() => press('assistant'))
    expect(useGraphStore.getState().panels.assistant).toBe(true)

    act(() => press('inspector'))
    expect(useGraphStore.getState().panels.inspector).toBe(true)
  })

  it('mutes and collapses the selection', () => {
    render(<App />)
    const first = useGraphStore.getState().graph.nodes[0]!.id
    act(() => useGraphStore.getState().setSelection([first]))

    act(() => press('mute'))
    expect(useGraphStore.getState().graph.nodes.find((n) => n.id === first)?.disabled).toBe(true)

    act(() => press('collapse'))
    expect(useGraphStore.getState().graph.nodes.find((n) => n.id === first)?.collapsed).toBe(true)
  })

  it('duplicates, and undoes', () => {
    render(<App />)
    const before = useGraphStore.getState().graph.nodes.length
    act(() => useGraphStore.getState().setSelection([useGraphStore.getState().graph.nodes[0]!.id]))

    act(() => press('duplicate'))
    expect(useGraphStore.getState().graph.nodes.length).toBe(before + 1)

    act(() => press('undo'))
    expect(useGraphStore.getState().graph.nodes.length).toBe(before)
  })
})
