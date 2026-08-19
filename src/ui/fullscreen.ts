/**
 * The browser's own fullscreen, for the whole app and for one viewer panel.
 *
 * Two callers ask the same two questions — "is this element the one being shown fullscreen?"
 * and "put it there" — so they ask them here rather than each keeping their own answer. A
 * second copy is how the toolbar's ⛶ and the overlay's ⛶ end up disagreeing about what the
 * button they both draw is currently doing.
 *
 * **`document.fullscreenElement` is the only honest source of truth.** Escape, F11 and the
 * browser's own window chrome all leave fullscreen without passing through anything in this
 * app, so a boolean written where `toggleFullscreen` is called is wrong the first time
 * somebody uses one of them — and a ⛶ button stuck in its pressed state reads as the app
 * having lost track of the window, which is exactly what it has done.
 *
 * Fullscreen is not persisted and cannot be: entering it requires a user gesture, so a
 * preference restored at load would be refused and there is no way to ask in advance.
 */

import { useSyncExternalStore } from 'react'

/**
 * What the *app* goes fullscreen on.
 *
 * The root element rather than a wrapper div, which is what makes this identical to F11: the
 * fullscreen UA stylesheet's `position: fixed` rule is `:fullscreen:not(:root)`, so the root
 * is exempt and nothing about the layout changes — the page simply stops having a browser
 * around it. A wrapper would be pulled out of flow and have to be sized back by hand.
 */
export function appElement(): Element {
  return document.documentElement
}

function subscribe(onChange: () => void): () => void {
  document.addEventListener('fullscreenchange', onChange)
  return () => document.removeEventListener('fullscreenchange', onChange)
}

/**
 * Whether `target` is the element the browser is currently showing fullscreen.
 *
 * A boolean rather than the element, so the snapshot is a primitive and cannot change identity
 * on an unrelated tick — invariant 7, same reason `Scheduler.info()` shares one frozen `IDLE`.
 */
export function useIsFullscreen(target: Element | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => target !== null && document.fullscreenElement === target,
    () => false,
  )
}

/**
 * Enter fullscreen on `target`, or leave if it is already the one being shown.
 *
 * Resolves to whether we ended up fullscreen — so a caller that wanted to *enter* can tell a
 * refusal from an ordinary exit by checking `useIsFullscreen` first. Browsers refuse outside a
 * user gesture and refuse again under some kiosk and iframe policies, with no way to ask in
 * advance, which is why the refusal is a return value rather than an exception.
 *
 * Compared against `target` rather than against "is anything fullscreen", and that matters
 * once the app itself can be fullscreen: the overlay's ⛶ pressed inside an already-fullscreen
 * window should show the *panel* full size, not drop the window out. The Fullscreen API keeps
 * a stack, so leaving the panel afterwards lands back on the fullscreen app rather than on the
 * browser.
 */
export async function toggleFullscreen(target: Element): Promise<boolean> {
  if (document.fullscreenElement === target) {
    exitFullscreen()
    return false
  }
  try {
    // Awaited inside the try so a rejection and a browser with no Fullscreen API at all — a
    // missing method throws synchronously — are refused the same way.
    await target.requestFullscreen()
    return true
  } catch {
    return false
  }
}

/** Leave fullscreen if anything is in it. Safe to call unconditionally. */
export function exitFullscreen(): void {
  if (!document.fullscreenElement) return
  void document.exitFullscreen().catch(() => {})
}
