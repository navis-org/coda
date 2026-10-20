/**
 * The shortcuts that are about the *app* rather than about the canvas.
 *
 * `Editor.tsx` owns the bindings for everything that acts on the graph — mute, collapse, pin,
 * group, duplicate, delete, fit, run, undo — and it is the right place for them, because every
 * one needs the canvas, a selection or React Flow's own key handling.
 *
 * These four need none of that. Fullscreen is about the window; the inspector and the assistant
 * are panels `App` renders; the dashboard is which of the two views is up. Editor's own comments
 * already said as much ("unqualified, like `f` and `i`: it is about the view"), and they lived
 * there only because that is where the listener happened to be.
 *
 * Which stopped being harmless the moment the dashboard could replace the canvas: `Editor` is not
 * mounted while the grid is up, so `F` did nothing there, and so did `I` and `/`. The bug reported
 * was fullscreen; the other two were the same bug not yet noticed. `D` had already been split
 * across two components to work around it, one binding written twice — exactly the duplication
 * `shortcuts.ts` exists to prevent, and it is now one binding again.
 *
 * The rule this leaves behind: **a key that needs the canvas belongs to `Editor`; a key that
 * needs the app belongs here.** `shortcuts.ts` remains the single description of all of them.
 */

import { useEffect } from 'react'

import { dashboardOf, tabForDigit } from '../core/dashboard'
import { useGraphStore } from '../store/graphStore'
import { appElement, toggleFullscreen } from './fullscreen'
import { isTourActive } from './tour/tourState'

/**
 * The keys a guided tour cannot follow, declined while one is on screen.
 *
 * One set for both listeners, and it has to be: driver measures the spotlit element and has no
 * event to learn that the shell re-laid itself out underneath. Splitting the list in two when the
 * bindings split would have been the four-copies problem in miniature — `Editor.tsx` imports this
 * rather than keeping a second copy, so a key added to either listener is declined by name in one
 * place.
 *
 * `d` is on it for the strongest version of the reason: it does not move the spotlit card, it
 * unmounts the entire canvas the tour is pointing at.
 */
export const TOUR_DECLINES = new Set(['f', 'i', 'm', 'h', 'p', 'd', '/'])

/**
 * True when a keypress is somebody typing rather than somebody reaching for a shortcut.
 *
 * The same test `Editor.tsx` opens with. Exported so the two cannot drift on the next field kind
 * that has to be exempt — a `contenteditable` cell, a combobox.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  )
}

/**
 * ⌥1–⌥9: a dashboard tab by position, 9 being the last. Answers whether the key was taken.
 *
 * **Matched on `code`, not `key`.** On a Mac ⌥ is a character modifier, so ⌥2 arrives as `™`
 * and `key` names no digit at all — on every layout, not just some. `code` is the physical key,
 * which is what a positional shortcut means anyway.
 *
 * **The grid only.** On the canvas the keys stay free: the canvas's own digits are planned for
 * saved views, and a chord that silently swapped the whole surface out from under somebody
 * reaching for one would be the worse failure. A field keeps the key too — `isTypingTarget` has
 * already returned by the time this runs — since ⌥digit is how a Mac types `¡`, `™` and `£`.
 *
 * Declined while a tour is up, for `d`'s reason: a page switch unmounts the cells it points at.
 */
function dashboardTabKey(event: KeyboardEvent): boolean {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false
  const match = /^Digit([1-9])$/.exec(event.code)
  if (!match) return false
  const store = useGraphStore.getState()
  if (!store.dashboardOpen || isTourActive()) return false
  const tab = tabForDigit(dashboardOf(store.graph), Number(match[1]))
  // Taken even when there is no tab in that place, so ⌥7 on a three-tab dashboard does not
  // type `¶` into nothing or reach the browser's own Alt+digit.
  event.preventDefault()
  if (tab) store.setDashboardTab(tab.id)
  return true
}

export function useAppShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      if (dashboardTabKey(event)) return
      // Every other key here is unmodified. Leaving the modified ones alone matters: ⌘D is Duplicate
      // and ⌘I is the browser's inspector, and neither is ours to take.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (isTourActive() && TOUR_DECLINES.has(key)) return

      const store = useGraphStore.getState()
      switch (key) {
        case 'f':
          // The browser's own F11 does the same thing; this is the half discoverable from inside
          // the app, and it pairs with the toolbar's ⛶. Nothing to do with the selection, which
          // is why it works on a dashboard that has no selection at all.
          event.preventDefault()
          void toggleFullscreen(appElement())
          return
        case 'i':
          event.preventDefault()
          store.togglePanel('inspector')
          return
        case 'd':
          event.preventDefault()
          store.toggleDashboard()
          return
        case '/':
          /*
           * `/` rather than a letter. Every bare letter near the canvas is either taken or one
           * shift away from something else — `a` would sit beside `⇧A` for the node browser and
           * mean something entirely different. `/` is the universal "start typing at something".
           */
          event.preventDefault()
          store.togglePanel('assistant')
          return
        default:
          return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
