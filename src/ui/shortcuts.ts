/**
 * Every keyboard shortcut and canvas gesture, in one table.
 *
 * There were four copies of this before: the window listener in `Editor.tsx` (which is what is
 * actually *bound*), the palette's right-aligned badges, the status bar's hints, and the start
 * page's key box. Three of those four were prose typed by hand, so a rebound key changed one of
 * them and the other two went on advertising the old one — silently, because nothing renders a
 * shortcut and its binding side by side.
 *
 * This is not a keymap: `Editor.tsx` still owns the bindings, because a table that dispatched
 * would have to encode React Flow's own keys (`selectionKeyCode`, `multiSelectionKeyCode`,
 * `deleteKeyCode`) which the library reads off props and handles itself. What this owns is the
 * *description* — the glyphs, the labels and the grouping — so all four surfaces say one thing.
 * Adding a binding means adding it here too; the entry is what makes it discoverable.
 *
 * Headless on purpose (no React, no store), so `shortcuts.test.ts` can read it without jsdom.
 */

/**
 * A chord, stored by meaning rather than by glyph.
 *
 * `mod` is the key `Editor.tsx` reads as `event.metaKey || event.ctrlKey` — ⌘ on a Mac and
 * Ctrl everywhere else. Storing the glyph directly is what made the four copies wrong for
 * Windows: every one of them printed ⌘, for a key that machine does not have.
 */
export interface Chord {
  /** ⌘ on Apple platforms, Ctrl elsewhere. */
  mod?: boolean
  shift?: boolean
  /** The key itself: `'Z'`, `'Tab'`, `'⌫'`, `'§'`, or a gesture like `'drag'`. */
  key: string
}

export interface Shortcut {
  id: string
  /**
   * One or more chords, all of which do this.
   *
   * Two entries mean two keys for one action (`Tab` and `⇧A` both open the browser), not a
   * sequence — the dialog renders them side by side and the badge surfaces take the first.
   *
   * A non-empty tuple rather than an array, so `chords[0]` is a `Chord` under
   * `noUncheckedIndexedAccess` and `shortcutKeys` needs no guard for a case the type forbids.
   */
  chords: [Chord, ...Chord[]]
  /** What it does, as the dialog says it. */
  label: string
  /** One clause of detail, where the label alone leaves a real question. */
  hint?: string
  /**
   * The terse form for the status bar, which has room for two words.
   *
   * Separate from `label` rather than derived from it: "Run everything that is stale" shortens
   * to "run", and no rule gets there from the words.
   */
  short?: string
}

export interface ShortcutGroup {
  title: string
  /** Shown under the heading, for a group with something to say about itself. */
  note?: string
  items: Shortcut[]
}

/**
 * Whether to print ⌘ or Ctrl.
 *
 * Read at call time rather than cached in a module constant, so a test can install a platform
 * and the next render agrees. `userAgentData` first because `navigator.platform` is deprecated
 * and frozen to `"MacIntel"` on some builds; both are absent under jsdom, where the fallback of
 * "not Apple" is the honest answer — the tests that care set one explicitly.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData
  const platform = data?.platform ?? navigator.platform ?? ''
  if (platform) return /mac|iphone|ipad|ipod/i.test(platform)
  return /mac|iphone|ipad|ipod/i.test(navigator.userAgent ?? '')
}

/**
 * The keys whose glyph is Apple-only.
 *
 * ⌫ and ⏎ are read fluently on a Mac and are a small puzzle on a keyboard whose keys are
 * labelled in words. The glyphs stay in the source because that is what the rest of the app
 * already writes; the spelling-out happens here, once.
 */
const SPELLED_OUT: Record<string, string> = {
  '⌫': 'Backspace',
  '⏎': 'Enter',
  '⌥': 'Alt',
}

/**
 * A chord as text.
 *
 * Apple gets the tight glyph form the rest of the app already uses (`⇧⌘Z`, `⌘D`, `⇧R`) with no
 * separator, which is the platform convention. Everywhere else the parts are joined with `+`,
 * because `ShiftCtrlZ` is not a spelling anybody uses.
 */
export function formatChord(chord: Chord, apple = isApplePlatform()): string {
  if (apple) {
    return `${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${chord.key}`
  }
  const parts: string[] = []
  if (chord.mod) parts.push('Ctrl')
  if (chord.shift) parts.push('Shift')
  parts.push(SPELLED_OUT[chord.key] ?? chord.key)
  return parts.join('+')
}

/**
 * The whole table, in the order the dialog shows it.
 *
 * Grouped by what you are doing, not by which modifier is held: somebody looking for "how do I
 * frame the selection" is thinking about the view, and has no idea yet that the key is `§`.
 */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Adding & finding',
    items: [
      {
        id: 'palette',
        chords: [{ key: 'Space' }],
        label: 'Command palette',
        hint: 'Every command and every node, searchable',
        short: 'commands',
      },
      {
        id: 'browse-nodes',
        chords: [{ key: 'Tab' }, { shift: true, key: 'A' }],
        label: 'Node browser',
        hint: 'Previews and category filters, for when you do not know the name yet',
        short: 'add a node',
      },
      {
        id: 'assistant',
        chords: [{ key: '/' }],
        label: 'Assistant panel',
        short: 'assistant',
      },
      {
        id: 'inspector',
        chords: [{ key: 'I' }],
        label: 'Inspector panel',
        hint: 'Works with nothing selected — that is when you are about to select something',
      },
    ],
  },
  {
    title: 'Running',
    items: [
      {
        id: 'run-all',
        chords: [{ shift: true, key: 'R' }, { mod: true, key: '⏎' }],
        label: 'Run everything stale',
        hint: 'Only what an edit actually invalidated',
        short: 'run',
      },
    ],
  },
  {
    title: 'Editing',
    note: 'These are the ones the canvas lock refuses; the rest carry on while it is on.',
    items: [
      { id: 'undo', chords: [{ mod: true, key: 'Z' }], label: 'Undo', short: 'undo' },
      { id: 'redo', chords: [{ mod: true, shift: true, key: 'Z' }], label: 'Redo' },
      {
        id: 'duplicate',
        chords: [{ mod: true, key: 'D' }],
        label: 'Duplicate the selection',
      },
      {
        id: 'delete',
        chords: [{ key: '⌫' }],
        label: 'Delete the selection',
      },
      {
        id: 'group',
        chords: [{ mod: true, key: 'G' }],
        label: 'Frame the selection as a group',
        hint: 'One box around the cards; dragging it moves all of them',
      },
      {
        id: 'ungroup',
        chords: [{ mod: true, shift: true, key: 'G' }],
        label: 'Ungroup',
        hint: 'The frame goes; the cards stay where they are',
      },
      {
        id: 'mute',
        chords: [{ key: 'M' }],
        label: 'Mute or unmute the selection',
        hint: 'A muted node produces nothing and stops its downstream chain',
        short: 'mute',
      },
      {
        id: 'collapse',
        chords: [{ key: 'H' }],
        label: 'Collapse or expand the selection',
      },
    ],
  },
  {
    title: 'View',
    items: [
      {
        id: 'fit',
        chords: [{ key: '§' }],
        /*
         * One key, two fits, and the label says both because the key really does both — see the
         * long note at the binding in `Editor.tsx`. A row that said only "Fit selection" would
         * be describing what the key does half the time.
         */
        label: 'Frame the selection, or the whole graph',
        hint: 'The key at the top left of the keyboard — ` on a US layout, ^ on a German one',
      },
      {
        id: 'pin',
        chords: [{ key: 'P' }],
        label: 'Pin or unpin the selected result',
        hint: 'Docked down the right of the canvas, where it stays while you work on the graph',
        short: 'pin',
      },
      {
        id: 'fullscreen',
        chords: [{ key: 'F' }],
        label: 'Fullscreen',
        hint: "The browser's own tabs and address bar gone",
      },
      {
        id: 'escape',
        chords: [{ key: 'Esc' }],
        label: 'Close the menu, dialog or expanded result',
      },
    ],
  },
  {
    title: 'Canvas gestures',
    note: 'No keys of their own — this is what the mouse does on empty canvas.',
    items: [
      { id: 'pan', chords: [{ key: 'drag' }], label: 'Pan the canvas', short: 'pan' },
      { id: 'zoom', chords: [{ key: 'scroll' }], label: 'Zoom in and out' },
      {
        id: 'box-select',
        chords: [{ shift: true, key: 'drag' }],
        label: 'Draw a selection box',
        short: 'select',
      },
      {
        id: 'multi-select',
        chords: [{ mod: true, key: 'click' }],
        label: 'Add to or remove from the selection',
      },
      {
        id: 'double-click',
        chords: [{ key: 'double-click' }],
        label: 'Add a node here',
        hint: 'The palette, prefilled to node insertions, at the pointer',
      },
      {
        id: 'right-click',
        chords: [{ key: 'right-click' }],
        label: 'The menu for whatever is under the pointer',
        hint: 'A node, a link, or empty canvas — which offers to add a node here',
      },
    ],
  },
  {
    /*
     * Gestures named in words rather than glyphs, and the wording is load-bearing: a phrase in
     * the key column has to fit it, so the noun each one acts on ("a link", "a node") lives in
     * the *label* instead. Written out in full — "drag a link into space" — they overflowed the
     * column and printed on top of the label they were meant to sit beside. jsdom performs no
     * layout, so the suite was green while the card was unreadable.
     */
    title: 'Wiring',
    items: [
      {
        id: 'drag-to-empty',
        chords: [{ key: 'drag into space' }],
        label: 'Add a node wired to the link you dragged',
        hint: 'The palette, filtered to the nodes that accept it',
      },
      {
        id: 'rewire',
        chords: [{ key: 'drag an end off' }],
        label: 'Re-route a link',
        hint: 'Drop it on empty canvas to unplug it instead',
      },
      {
        id: 'splice',
        chords: [{ key: 'drop on a link' }],
        label: 'Splice a node into the chain',
      },
    ],
  },
]

const BY_ID = new Map(SHORTCUT_GROUPS.flatMap((g) => g.items).map((item) => [item.id, item]))

/**
 * One shortcut's keys, as the single string the badge surfaces want.
 *
 * The *first* chord, so `Tab` reaches the palette badge and `⇧A` does not — a badge has room
 * for one, and the first is the one the app teaches everywhere else.
 *
 * Throws on an unknown id rather than returning `undefined`: every caller here is a literal in
 * the source, so a miss is a typo the build should not survive, and an absent badge is exactly
 * the kind of nothing nobody notices.
 */
export function shortcutKeys(id: string, apple = isApplePlatform()): string {
  const item = BY_ID.get(id)
  if (!item) throw new Error(`Unknown shortcut: ${id}`)
  return formatChord(item.chords[0], apple)
}

/** `"⇧R run"` — the status bar's form, and the start page's, from one source. */
export function shortcutHint(id: string, apple = isApplePlatform()): string {
  const item = BY_ID.get(id)
  if (!item) throw new Error(`Unknown shortcut: ${id}`)
  return `${formatChord(item.chords[0], apple)} ${item.short ?? item.label.toLowerCase()}`
}

/**
 * What the status bar shows, left to right.
 *
 * Six, and the choice is what somebody who has never opened the dialog most needs: how to reach
 * everything (`Space`), the two gestures that have no key at all, and the three edits that are
 * hardest to guess. The full list is one `?` menu away.
 */
export const STATUS_BAR_HINTS = ['palette', 'pan', 'box-select', 'run-all', 'mute', 'undo']
