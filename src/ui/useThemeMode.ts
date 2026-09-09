/**
 * Which theme the document is rendering in, and whether the reader wants less motion.
 *
 * Lifted out of `NeuronThumbnail` when the row marks became the second consumer. Not only
 * tidiness: `currentMode()` read per mark is four calls a row and a hundred a page. Read once and
 * handed down, it is one. It also fixes the marks going stale on a theme flip, which is the same
 * failure this hook exists for on the tiles.
 *
 * **The subscription is one; the *snapshot* was not, and that is worth separating.** This file
 * used to claim the whole problem was solved here, while `currentMode()` — the `getSnapshot` React
 * calls several times per subscriber per render — still built a fresh `MediaQueryList` on every
 * call under the default `system` preference. That belonged in `currentMode` rather than in a
 * hook, since every other caller reads it too; `colors.ts` has the measurement.
 */

import { useSyncExternalStore } from 'react'

import type { Mode } from './colors'
import { DARK_SCHEME, currentMode } from './colors'
import { subscribeMedia, useMediaQuery } from './mediaQuery'

/** Asked through the shared registry, so every caller on a page shares one `MediaQueryList`. */
export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/**
 * The reader's motion preference.
 *
 * `useMediaQuery`'s registry rather than a `matchMedia` of its own — `ui/mediaQuery.ts` records
 * why the lookup is lazy and what `resetMediaForTest` is for.
 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION)
}

/**
 * The mode the document is actually rendering in, re-read when it changes.
 *
 * A thumbnail is the one surface where a stale theme does not heal. The mask carries no colour
 * (see `thumbnail.ts`), so a theme flip changes only which ink is painted through it — but the
 * paint is an effect keyed on the mask, and nothing re-renders a row: Explore fetches for itself
 * and its rows subscribe to no graph state. The chart viewers have the same read-during-render
 * of `currentMode()` and go stale on a flip too, and there the next edit repaints them
 * (docs/viewers.md records that as pre-existing); here there is no next edit, so a list rendered
 * in dark mode kept `#c3c2b7` on a light card for as long as it stayed open. Light grey on
 * white — which is the "too faint" this fixes, rather than anything about the ramp.
 *
 * Both halves are load-bearing, because the preference has three values and only two of them are
 * stamped: `data-theme` carries an explicit light or dark, and is *absent* for `system`, where
 * the OS media query is the whole answer. `currentMode()` already knows that rule; this only has
 * to notice when either input moves.
 *
 * Lifted here when the row marks became the second consumer, which is the rule its own note used
 * to state. The viewers all want it too, and that is one change rather than eleven — which is
 * also why the subscription below is shared rather than per component.
 */
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null
let unwatchMedia: (() => void) | null = null

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * One subscription for the document, however many components ask.
 *
 * Per component it was a `MutationObserver` on `<html>` *and* a `MediaQueryList` each — an
 * expanded Explore page is 25 tiles plus the list, so 26 of both, every one waking on any
 * `data-theme` write, and all 26 torn down and rebuilt whenever a search re-keys the rows. The
 * module header claimed the opposite of that, which is the half worth fixing.
 *
 * `mediaQuery.ts`'s shape, and its registry for the media half: lazy, so a suite that installs a
 * `matchMedia` stub after import is still answered correctly, and reachable from
 * `resetMediaForTest`.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!observer && typeof document !== 'undefined') {
    observer = new MutationObserver(notify)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
  }
  unwatchMedia ??= subscribeMedia(DARK_SCHEME, notify)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    observer?.disconnect()
    observer = null
    unwatchMedia?.()
    unwatchMedia = null
  }
}

/** A page rendered without a document is not a dark one. */
const lightSnapshot = (): Mode => 'light'

export function useThemeMode(): Mode {
  /*
   * `currentMode()` is the snapshot, and it returns a string — so `useSyncExternalStore` compares
   * it by value and a `data-theme` write that does not change the answer re-renders nothing.
   * That is invariant 7's rule, and it is what lets one shared subscription serve every caller.
   */
  return useSyncExternalStore(subscribe, currentMode, lightSnapshot)
}
