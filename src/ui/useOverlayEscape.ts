/**
 * Escape for anything over the page that closes on it — every `Modal` (the full-size viewer among
 * them), every `ContextMenu`, the command palette and a node's screen map.
 *
 * Fifteen modals each bound this themselves, five different ways, and the copies had drifted on
 * the three rules that matter; this is those rules, once:
 *
 * - **Capture phase, and stopped.** Ahead of the fields inside the surface — several stop every
 *   key at themselves to keep the canvas's Space and Backspace off them, and on the bubble phase
 *   they would swallow the surface's Escape too — and ahead of the canvas's own listeners.
 * - **Only the surface on top answers.** Every listener is on `window`, where `stopPropagation`
 *   does not stop a sibling — so Help opened from a full-size viewer, or the start page reopened
 *   over one, closed both on a single press. The open surfaces are kept in the order they
 *   opened, and the last one is on top.
 * - **A popover opened on a surface answers before it**, because it is on the same stack: a menu
 *   opened inside a dialog is pushed after the dialog. This replaced a class check (stand aside
 *   while a `.context-menu` or `.smap` is in the document), which answered "is something on top"
 *   a second way and silently skipped any popover that forgot the class.
 *
 * - **A field that cancels its own edit comes first.** A rename or a note reverts on Escape, and
 *   a surface taking the key on the capture phase would close over it instead — unmounting the
 *   field, whose blur then commits the very draft Escape was meant to throw away. Such a field
 *   says so with `data-owns-escape`; the press is left to it, and the surface closes on the next.
 *
 * The order is the order surfaces *opened*, not mounted: React runs a child's effects before its
 * parent's, so a surface mounted in the same commit as the dialog it sits in would register first.
 * Nothing here opens that way — a menu or a map opens on a later gesture.
 */

import { useEffect } from 'react'

import { useLatest } from './useLatest'

/** Marks a field whose own Escape — cancelling its edit — is asked before any surface's. */
const OWNS_ESCAPE = 'data-owns-escape'

/** The open surfaces, oldest first. Identity is the listener's own token. */
const open: symbol[] = []

export interface OverlayEscapeOptions {
  /**
   * Asked at the press: true means this Escape is not the surface's to take. The viewer's own
   * fullscreen, which the browser answers by leaving fullscreen with the overlay still up.
   */
  ignore?: () => boolean
}

/** `close` omitted binds nothing — a surface with no way out on Escape. */
export function useOverlayEscape(
  close: (() => void) | undefined,
  { ignore }: OverlayEscapeOptions = {},
): void {
  /*
   * Read through a ref rather than listed as dependencies: re-binding on a new `close` would
   * take the surface off the stack and put it back on *top*, so a parent re-rendering the one
   * underneath would promote it over the one somebody just opened.
   */
  const latest = useLatest({ close, ignore })
  const bound = close !== undefined

  useEffect(() => {
    if (!bound) return
    const self = Symbol('overlay')
    open.push(self)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || open[open.length - 1] !== self) return
      if ((event.target as Element | null)?.closest?.(`[${OWNS_ESCAPE}]`)) return
      if (latest.current.ignore?.()) return
      event.stopPropagation()
      latest.current.close?.()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      open.splice(open.indexOf(self), 1)
    }
  }, [bound, latest])
}
