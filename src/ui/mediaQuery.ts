/**
 * One `MediaQueryList` per query, read through `useSyncExternalStore`.
 *
 * Two features ask the viewport a question — the small-screen notice and the narrow shell — and
 * the plumbing either of them needs is the same: look `matchMedia` up lazily, remember that this
 * environment does not have one, and hand React a snapshot it can compare by identity. Written
 * twice it would drift on the part that is invisible when wrong: whether the listener is attached
 * at all.
 *
 * **Lazy, and the laziness is not an optimisation.** `matchMedia` is absent under Node + jsdom
 * until a suite installs a stub, so a module that resolved its query at import time would answer
 * `false` for the rest of the process — green for every test that installs the stub afterwards.
 * `null` in the registry records "asked, and this environment has none", so the lookup is not
 * retried on every render either.
 *
 * **`subscribe` and `matches` hang off the entry rather than being minted per call**, which is
 * what makes `useMediaQuery` a plain read. `useSyncExternalStore` keys its subscription effect on
 * the identity of `subscribe`: an inline arrow there tears the listener down and re-adds it on
 * every render of every caller, and the callers here are `App` and `Toolbar`.
 *
 * There is no channel in front of the `MediaQueryList` because it is already an event target
 * with add and remove of its own. Interposing one bought nothing and cost a listener that could
 * never be taken off.
 */

import { useSyncExternalStore } from 'react'

interface Watched {
  /** `null` means this environment has no `matchMedia`. */
  list: MediaQueryList | null
  /** Per-query and stable — see the module note. Returns its own removal. */
  subscribe: (listener: () => void) => () => void
  matches: () => boolean
}

const watched = new Map<string, Watched>()

function watch(query: string): Watched {
  const known = watched.get(query)
  if (known) return known
  const list =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : null
  const entry: Watched = {
    list,
    subscribe: (listener) => {
      list?.addEventListener('change', listener)
      return () => list?.removeEventListener('change', listener)
    },
    matches: () => list?.matches ?? false,
  }
  watched.set(query, entry)
  return entry
}

/** Does the viewport match, right now? `false` where there is no `matchMedia` to ask. */
export function mediaMatches(query: string): boolean {
  return watch(query).matches()
}

/** Subscribe to changes in one query. Returns the unsubscribe, for a React effect. */
export function subscribeMedia(query: string, listener: () => void): () => void {
  return watch(query).subscribe(listener)
}

/** The server snapshot: a page rendered without a window is not a narrow one. */
const noMatch = () => false

/**
 * A boolean, so `useSyncExternalStore`'s identity comparison is the right one (invariant 7).
 */
export function useMediaQuery(query: string): boolean {
  const entry = watch(query)
  return useSyncExternalStore(entry.subscribe, entry.matches, noMatch)
}

/**
 * Forget every query, so the next ask re-reads the environment. Tests only — a suite that swaps
 * `window.matchMedia` would otherwise keep answering from a `MediaQueryList` belonging to the one
 * it replaced. A component still mounted across a reset keeps its listener on that old list,
 * which no suite does and the app never can.
 */
export function resetMediaForTest(): void {
  watched.clear()
}
