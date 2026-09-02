/**
 * ⌘C / ⌘X / ⌘V on the canvas, and the two clipboards behind them.
 *
 * The gestures are bound to the **clipboard events** rather than to keydown, which is the whole
 * design and not an implementation detail. A `copy`/`cut`/`paste` event carries a `clipboardData`
 * a page may read and write freely inside the browser's own gesture; `navigator.clipboard.readText`
 * is the other route and it is gated — a permission prompt in Chrome, and refused outright in
 * Firefox, for a keystroke that has to work every time on every browser. Binding the events also
 * means the OS shortcut is whatever that OS calls it, including the ones this app never listed.
 *
 * So the system clipboard is the primary one: a fragment copied here pastes into another tab, a
 * second window, a colleague's chat, or a text editor, where it is a readable `.coda.json`
 * fragment. `store.clipboard` is the fallback for the one route that cannot read the system one —
 * a menu row or a palette command, where there is no paste event to carry the data.
 *
 * Two guards keep this out of the way of ordinary text. A field the user is typing in is exempt
 * (`isTypingTarget`, shared with both keydown listeners), and so is a **live text selection**:
 * with prose selected in a dialog, ⌘C is about that prose even though three cards are also
 * selected on the canvas behind it, and stealing it would be silent.
 */

import { useEffect } from 'react'

import type { Point } from '../core/clipboard'
import { readFragment } from '../core/clipboard'
import { useGraphStore } from '../store/graphStore'
import { isTypingTarget } from './appShortcuts'
import { copyText } from './export'

/**
 * True when the user has text selected on the page.
 *
 * `toString()` rather than `isCollapsed`, because a selection that spans a canvas card's markup
 * from a double-click can be non-collapsed and yet contain nothing worth copying — and because
 * "would the browser put anything on the clipboard" is exactly the question being asked.
 */
function hasTextSelection(): boolean {
  const selection = typeof document === 'undefined' ? null : document.getSelection()
  return !!selection && selection.toString().trim().length > 0
}

/**
 * Copy — or cut — the selection, and put it on the system clipboard too.
 *
 * One function per gesture rather than a `copyFragmentToSystem(text)` every caller pairs with a
 * store call of its own: there are four call sites across the node menu and the palette, and the
 * two-line pair was written out at each. What the store returns is what goes on the clipboard, so
 * there was never a decision at those sites to make.
 *
 * The system write is best-effort and silent when refused: the text is already in
 * `store.clipboard`, so pasting inside this app works either way and the only thing lost is the
 * copy that crosses to another tab. Reporting "this browser refused clipboard access" on a
 * Duplicate-shaped gesture that visibly worked would be noise.
 */
export function copySelectionToSystem(): void {
  publish(useGraphStore.getState().copySelection())
}

export function cutSelectionToSystem(): void {
  publish(useGraphStore.getState().cutSelection())
}

function publish(text: string | undefined): void {
  if (text) void copyText(text).catch(() => {})
}

/**
 * Paste from wherever a fragment can be found, for a menu row or a palette command.
 *
 * Tries the system clipboard first so that "copy in one tab, paste in the other" works from the
 * menu as well as from the keyboard, and falls back to this app's own memory when the read is
 * unavailable or refused — which is the ordinary case in Firefox, not an error.
 *
 * `at` comes from whichever surface called: the click, for a menu row, and the canvas's own
 * `pastePoint` for a palette command, which `CommandContext` carries beside `fitView` for exactly
 * this reason. Without one the fragment lands at its own absolute coordinates, offset — which is
 * only ever right when it came from this graph.
 */
export async function pasteFromClipboard(at?: Point): Promise<number> {
  const store = useGraphStore.getState()
  let text: string | undefined
  try {
    text = await navigator.clipboard?.readText()
  } catch {
    text = undefined
  }
  if (text && readFragment(text)) return store.pasteFragment(text, at)
  return store.pasteFragment(undefined, at)
}

export interface ClipboardHandlers {
  /**
   * Where a pasted fragment's top-left corner goes, in flow coordinates.
   *
   * Always a point, never undefined: a paste into a graph the fragment did not come from would
   * otherwise land at its original absolute coordinates, which can be an entire screen away from
   * anything — a paste that worked and looks exactly like a paste that did nothing. The canvas
   * answers with the pointer, or with the middle of what is on screen when the pointer is
   * somewhere else.
   */
  pastePoint(): Point
  /** The canvas's own lock refusal: true when the edit must not land, having said so. */
  refuseIfLocked(): boolean
}

export function useClipboardShortcuts({ pastePoint, refuseIfLocked }: ClipboardHandlers): void {
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target) || hasTextSelection()) return
      const text = useGraphStore.getState().copySelection()
      if (!text) return
      event.clipboardData?.setData('text/plain', text)
      event.preventDefault()
    }

    const onCut = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target) || hasTextSelection()) return
      // Nothing selected is not a refusal — it is the browser's cut, over whatever else is going
      // on — so the lock is only consulted once there is something this would have removed.
      if (useGraphStore.getState().selection.length === 0) return
      if (refuseIfLocked()) {
        event.preventDefault()
        return
      }
      const text = useGraphStore.getState().cutSelection()
      if (!text) return
      event.clipboardData?.setData('text/plain', text)
      event.preventDefault()
    }

    const onPaste = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target)) return
      const text = event.clipboardData?.getData('text/plain')
      /*
       * Read before anything else happens, because "not a graph" has to leave the event
       * untouched: most of what is on a clipboard is prose, a URL or a column of neuron ids, and
       * a canvas that swallowed those — or that answered one with a lock notice — would be
       * refusing a paste nobody aimed at it. The store parses it again; a few kilobytes on a
       * keystroke, against a `pasteFragment` that would have to report *why* it did nothing.
       */
      if (!text || !readFragment(text)) return
      event.preventDefault()
      if (refuseIfLocked()) return
      useGraphStore.getState().pasteFragment(text, pastePoint())
    }

    window.addEventListener('copy', onCopy)
    window.addEventListener('cut', onCut)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('cut', onCut)
      window.removeEventListener('paste', onPaste)
    }
  }, [pastePoint, refuseIfLocked])
}
