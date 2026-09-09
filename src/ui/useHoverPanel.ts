/**
 * A transient panel that opens on a deliberate hover and goes away on its own.
 *
 * Two surfaces do this — Explore's thumbnail preview and an output port's value preview — and
 * this is the gesture they share. It was written twice first, which is what the extraction is
 * arguing from: about forty lines matched near token for token, *including* the reasoning in the
 * comments, and the subtle half is the dismissal. `useDismiss` records the same lesson one
 * gesture over ("written out five times before this — a fix to that reached exactly one popover
 * at a time"), and CLAUDE.md's rule about a second spelling is the general form of it.
 *
 * What each caller keeps is what is genuinely its own: what the panel *is*, where it goes, and
 * any work that has to start when it opens or stop when it closes. What is here is when it
 * opens, what it is anchored to, and the four ways it ends.
 *
 * **The anchor is not necessarily the hovered element.** The handlers go on whatever is a
 * comfortable target — a whole port row's side, a tile's slot — and `anchorRef` names the thing
 * the panel is placed against and whose movement dismisses it. On a port those differ: an 11px
 * socket is a fine target for a wire and a poor one for a pointer at rest.
 *
 * **The rect is measured when the panel opens, never when the pointer arrives**, because the
 * surface under the pointer moves during the delay — a list scrolls, a canvas pans.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

import type { Rect } from './hoverPlacement'

export interface HoverPanelOptions {
  /** What the panel is anchored to, and whose movement dismisses it. */
  anchorRef: RefObject<Element | null>
  /** How long the pointer rests before the panel opens. */
  delayMs: number
  /**
   * Asked when the delay elapses; `false` declines, leaving nothing on screen.
   *
   * At that moment rather than on arrival, so it can read state that the wait may have changed —
   * the port preview asks whether the node has run yet, and a run can land during the delay.
   */
  canOpen?: () => boolean
  /** Work that starts as the panel opens — the thumbnail's finer body. */
  onOpen?: () => void
  /** Work that stops as it closes — releasing what `onOpen` fetched. */
  onClose?: () => void
  /**
   * Whether a press dismisses the panel and keeps it dismissed until the pointer leaves.
   *
   * For an anchor where pressing starts a gesture of its own: on a socket that is a wire being
   * dragged, and a panel hanging over the canvas is covering the port being dragged *to*. The
   * "until the pointer leaves" half is the load-bearing one — a drag that ends back on this
   * anchor re-enters it with no intervening leave, so a plain dismissal comes straight back.
   */
  dismissOnPress?: boolean
}

export interface HoverPanel {
  /** The anchor's rect and the portal host, both read at the moment the panel opened. */
  open: { anchor: Rect; host: Element } | undefined
  hide: () => void
  handlers: {
    onPointerEnter: (event: ReactPointerEvent) => void
    onPointerLeave: () => void
    onPointerDown: () => void
  }
}

export function useHoverPanel(options: HoverPanelOptions): HoverPanel {
  const { anchorRef, delayMs, canOpen, onOpen, onClose, dismissOnPress } = options
  const timer = useRef<number | undefined>(undefined)
  const suppressed = useRef(false)
  const [open, setOpen] = useState<{ anchor: Rect; host: Element } | undefined>(undefined)

  /*
   * The callbacks live on a ref rather than in the dependency arrays below.
   *
   * A caller's `canOpen` closes over whatever it needs to ask about, so it is a fresh function
   * on most renders; threading it through `useCallback` deps would rebuild `hide` on each one,
   * and `hide` is a dependency of the watch effect — which would then tear down and restart a
   * `requestAnimationFrame` loop per render of the hovered card.
   */
  const latest = useRef({ canOpen, onOpen, onClose })
  latest.current = { canOpen, onOpen, onClose }

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    setOpen(undefined)
    latest.current.onClose?.()
  }, [])

  const show = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    if (latest.current.canOpen?.() === false) return
    latest.current.onOpen?.()
    const box = anchor.getBoundingClientRect()
    setOpen({
      anchor: { left: box.left, top: box.top, width: box.width, height: box.height },
      // Read off the document rather than off a ⛶ click: a fullscreen panel is the top layer and
      // shows that element's subtree only, so a portal to `body` would be positioned correctly
      // and invisible. Escape and F11 both leave fullscreen without passing through the app.
      host: document.fullscreenElement ?? document.body,
    })
  }, [anchorRef])

  const onPointerEnter = useCallback(
    (event: ReactPointerEvent) => {
      // Mouse only. A tap synthesises `pointerenter` too, and a panel opened by one has no
      // gesture that closes it — the pointer never leaves.
      if (event.pointerType !== 'mouse' || suppressed.current) return
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(show, delayMs)
    },
    [delayMs, show],
  )

  const onPointerLeave = useCallback(() => {
    suppressed.current = false
    hide()
  }, [hide])

  const onPointerDown = useCallback(() => {
    if (!dismissOnPress) return
    suppressed.current = true
    hide()
  }, [dismissOnPress, hide])

  // Unmounting mid-hover — a page turn, a search that drops this row, a card deleted — must not
  // leave a timer holding a reference to a dead component.
  useEffect(() => () => window.clearTimeout(timer.current), [])

  /*
   * **The anchor moving dismisses it, and that is a watch on the rect rather than a list of the
   * events that can move one.**
   *
   * This was `scroll` in the capture phase, which is right for a scrolling list and only there.
   * On a node card nothing scrolls: React Flow pans and zooms by writing a `transform` onto the
   * pane, so a canvas drag slides the anchor out from under a panel that fires no event at all —
   * and adding `wheel` and `pointerdown` beside `scroll` would cover those two while still
   * missing a keyboard fit-view, a resize, an auto-layout pass, a row re-flowed by a search.
   *
   * So the property is asked directly: the placement was measured against a rect and must not
   * outlive it. One `getBoundingClientRect` per frame while a panel is open, and there is at most
   * one open per anchor. A pixel of tolerance, because an element on a scaled pane lands on
   * fractional coordinates and the browser is free to round them differently between frames.
   *
   * Dismissing rather than repositioning: once the surface has moved, what is under the pointer
   * is a different row or a different port, and a panel following the pointer is the strobe the
   * delay exists to prevent.
   */
  useEffect(() => {
    const anchor = anchorRef.current
    if (!open || !anchor) return
    const from = open.anchor
    let handle = requestAnimationFrame(function check() {
      const now = anchor.getBoundingClientRect()
      if (Math.abs(now.left - from.left) > 1 || Math.abs(now.top - from.top) > 1) hide()
      else handle = requestAnimationFrame(check)
    })
    /*
     * A right-click closes it too, and that one is a stacking fact rather than a movement, which
     * is why it stays an event: a panel left up would sit *over* the menu it was opened from.
     * Dismissing rather than restacking — a right-click is a deliberate act that has finished
     * with the transient thing a hover put on screen, whether or not a menu follows.
     */
    window.addEventListener('contextmenu', hide, true)
    return () => {
      cancelAnimationFrame(handle)
      window.removeEventListener('contextmenu', hide, true)
    }
  }, [anchorRef, open, hide])

  return { open, hide, handlers: { onPointerEnter, onPointerLeave, onPointerDown } }
}
