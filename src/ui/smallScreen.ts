/**
 * "This is built for a bigger screen" — the one thing Coda says on a phone.
 *
 * Coda is a node-graph editor: a canvas of cards you place and wire, an inspector, a dock, a
 * status bar, and viewers that want every pixel they can get. None of that has a phone-sized
 * form, and the honest position is that it is not going to get one — a workflow you cannot see
 * the shape of is not a workflow you can reason about. So this is a *notice*, not the first step
 * of a responsive layout: it says what the app expects, offers the three pages that genuinely do
 * read on a phone, and gets out of the way if the reader wants in regardless.
 *
 * ## Two thresholds, one number
 *
 * There are two questions here, and they share the width. `SMALL_SCREEN_QUERY` decides whether
 * to put the notice up at all; `NARROW_QUERY` decides whether the shell folds its toolbar into
 * one row and lets an open panel take the screen — which is what the reader who presses
 * "Open it anyway" then gets. The second is **width only**, deliberately: a desktop window that
 * is short is not a window whose toolbar needs collapsing, and folding it there would take the
 * controls away from somebody with 1400px of room for them.
 *
 * ## Why a media query and not the user agent
 *
 * What makes the shell unusable is the viewport, and a phone is only the commonest way to have a
 * small one. A desktop window dragged to a third of the screen is the same problem, and a UA
 * string cannot see it — while a tablet, which we do mean to support, is a UA string away from
 * being called a phone. So the question asked is the one that matters, and it is asked in both
 * axes because a phone in landscape is *wide*:
 *
 *  - **`max-width: 720px`** — every phone in portrait is at most 440 CSS px; the narrowest
 *    tablet we mean to keep working is the iPad mini's 744. 720 sits under that with room.
 *  - **`max-height: 560px`** — the same separation the other way round: a phone in landscape is
 *    at most ~440 tall before browser chrome, a tablet in landscape at least 744. Height is the
 *    axis a browser's own chrome eats into, which is why the gap is left wide rather than split.
 *
 * Between the two, no tablet in either orientation matches and no phone in either escapes.
 *
 * ## The acknowledgement, and where it lives
 *
 * `localStorage`, through `persistence.ts` — see `loadSmallScreenAck` for why the answer is kept
 * for good rather than for the session. What is stored is *that the reader answered*, never the
 * size they answered at: a smaller screen later is not a new question.
 *
 * The store is `hints.ts`'s, for its reasons — nothing here is about the graph, and putting a
 * boolean about the viewport into `useGraphStore` would wake 1,204 call sites for a tap on a
 * button. Two surfaces read it: the notice itself, and `GuidesDialog`, which must not spend its
 * once-ever appearance behind a modal nobody has dismissed yet.
 */

import { useSyncExternalStore } from 'react'

import { channel } from '../data/channel'
import { loadSmallScreenAck, saveSmallScreenAck } from '../store/persistence'
import { mediaMatches, resetMediaForTest, subscribeMedia, useMediaQuery } from './mediaQuery'

/**
 * The shell is narrow: one toolbar row with the rest behind `⋯`, and an open panel takes the
 * screen rather than a column of it. Width only — see the module note.
 *
 * Read by `App`, which stamps `data-narrow` on `.app` for the CSS half. **The number lives
 * here and nowhere else**, which is why the CSS asks the attribute rather than repeating the
 * query: a stylesheet that disagreed with this by 40px would hide the toolbar's controls at a
 * width where nothing had put them in the menu.
 */
export const NARROW_QUERY = '(max-width: 720px)'

/** Exported so the test can drive it, and so there is one spelling of the threshold. */
export const SMALL_SCREEN_QUERY = `${NARROW_QUERY}, (max-height: 560px)`

const changed = channel()

/**
 * The stored answer, on first ask.
 *
 * Lazy for `hints.ts`'s reason: `localStorage` is undefined under Node + jsdom until a test
 * installs the stub, so a module that read it at import time would answer "not acknowledged"
 * forever for every suite that installs the stub afterwards.
 */
let acknowledged: boolean | undefined

/**
 * Both halves of the answer: the viewport, and whether anybody has waved it away. Two
 * subscriptions rather than one, because the notice goes down for either reason.
 */
function subscribe(listener: () => void): () => void {
  const stopMedia = subscribeMedia(SMALL_SCREEN_QUERY, listener)
  const stopAck = changed.subscribe(listener)
  return () => {
    stopMedia()
    stopAck()
  }
}

/**
 * Whether the notice belongs on screen: the viewport is too small **and** nobody has said to
 * carry on. A boolean, so `useSyncExternalStore`'s identity comparison is the right one
 * (invariant 7).
 *
 * Note the order — the stored answer is checked first, so an acknowledged reader pays no
 * media-query read, and rotating the phone afterwards asks nothing again.
 */
function snapshot(): boolean {
  if (acknowledged === undefined) acknowledged = loadSmallScreenAck()
  if (acknowledged) return false
  return mediaMatches(SMALL_SCREEN_QUERY)
}

/**
 * Is the small-screen notice showing?
 *
 * It stops showing on its own if the viewport grows — a desktop window pulled back out is a
 * reader who has fixed the thing the notice was about, and making them dismiss it as well would
 * be asking for an acknowledgement of a condition that no longer holds. Nothing is stored on
 * that path, so narrowing again brings it back.
 */
export function useSmallScreenNotice(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}

/** "Carry on anyway" — the only thing that writes. Idempotent. */
export function acknowledgeSmallScreen(): void {
  if (acknowledged) return
  acknowledged = true
  saveSmallScreenAck()
  changed.notify()
}

/**
 * Is the shell in its narrow arrangement? Unaffected by the acknowledgement — this is about the
 * window, not about what anybody was told.
 */
export function useNarrowShell(): boolean {
  return useMediaQuery(NARROW_QUERY)
}

/**
 * Forget the answer and re-read the environment. Tests only.
 *
 * The media registry goes with it, because a suite that swaps `matchMedia` leaves it holding a
 * `MediaQueryList` that belongs to the list it just replaced.
 */
export function resetSmallScreenForTest(): void {
  acknowledged = undefined
  resetMediaForTest()
  changed.notify()
}
