/**
 * What's New: whether the editor has anything to announce, and to whom.
 *
 * The changelog itself is `src/changelog/entries.ts`, loaded here with a dynamic `import()` so its
 * prose is a chunk of its own rather than part of the editor's first paint. What this module owns
 * is the decision, which has three answers:
 *
 * - **A first visit announces nothing.** The whole history is not news to somebody who has never
 *   seen the old behaviour, so today's date is recorded as seen and the dot stays off.
 * - **A returning visit with a highlighted update newer than the last one seen** gets the card,
 *   once, in the corner. Dismissing it in any way records the newest date.
 * - **Anything newer that is not highlighted** waits on the page: the `?` menu carries a dot, and
 *   opening `changelog.html` (which writes the same key, `changelog/seen.ts`) clears it.
 *
 * "Returning" cannot be read off the changelog key, which did not exist before the changelog did:
 * everyone who used Coda before this shipped has no record and is not a first visitor. So it is
 * read off the flags earlier visits leave behind, **once, when this module loads** — before the
 * guides dialog records itself on a first visit, which happens in an effect a moment later and
 * would otherwise make every first visit look like a return. The first visit is recorded in the
 * same step, not when the entries arrive: a visit closed before then would otherwise leave the
 * guides flag set and no date, and the next visit would announce the entire history.
 *
 * A visit that arrives through a share or demo link is neither: it shows no card and records
 * nothing, so a returning reader who follows a link still hears about the update next time.
 */

import { useSyncExternalStore } from 'react'

import type { ChangelogEntry } from '../changelog/entries'
import { dayOf } from '../changelog/dates'
import { CHANGELOG_SEEN_KEY, loadChangelogSeen, saveChangelogSeen } from '../changelog/seen'
import { hasShareFragment } from '../data/share/fragment'
import {
  loadFeedbackNudgeAt,
  loadGuidesSeen,
  loadStartPageDismissed,
  watchLocalKey,
} from '../store/persistence'

export interface WhatsNewDecision {
  /** Highlighted updates to announce, newest first. Empty means no card. */
  announce: readonly ChangelogEntry[]
  /** Anything at all newer than what was seen — the `?` menu's dot. */
  unseen: boolean
}

const QUIET: WhatsNewDecision = { announce: [], unseen: false }

/**
 * The decision, as a pure function of what is stored.
 *
 * `seen` undefined with `returning` false is a first visit whose date could not be stored; with
 * `returning` true it is somebody from before the changelog existed, for whom every entry is news.
 */
export function decideWhatsNew(
  entries: readonly ChangelogEntry[],
  seen: string | undefined,
  returning: boolean,
): WhatsNewDecision {
  if (seen === undefined && !returning) return QUIET
  const fresh = entries.filter((e) => e.date > (seen ?? ''))
  return fresh.length ? { announce: fresh.filter((e) => e.highlight), unseen: true } : QUIET
}

// Read once, at module load — see the header. Guarded for the environment: `src/ui` is imported
// under plain Node by a few suites, where there is no `location`.
const RETURNING =
  loadGuidesSeen() || loadStartPageDismissed() || loadFeedbackNudgeAt() !== undefined
const ARRIVED_BY_LINK =
  typeof window !== 'undefined' && hasShareFragment(window.location?.hash ?? '')
const FIRST_VISIT = !RETURNING && loadChangelogSeen() === undefined
if (FIRST_VISIT && !ARRIVED_BY_LINK) saveChangelogSeen(dayOf(Date.now()))

// ---------------------------------------------------------------------------
// A small external store: the entries once loaded, the stored date, and the decision over both
// ---------------------------------------------------------------------------

interface State {
  entries: readonly ChangelogEntry[] | undefined
  seen: string | undefined
  decision: WhatsNewDecision
}

let state: State = { entries: undefined, seen: loadChangelogSeen(), decision: QUIET }
const listeners = new Set<() => void>()
let loading: Promise<boolean> | undefined

/** The decision is derived here, once per change, so no snapshot read recomputes it. */
function set(next: Partial<Omit<State, 'decision'>>): void {
  const merged = { ...state, ...next }
  const decision = merged.entries
    ? decideWhatsNew(merged.entries, merged.seen, RETURNING)
    : QUIET
  state = { ...merged, decision }
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Another tab — the changelog page above all — recording a visit clears the dot here too.
watchLocalKey(CHANGELOG_SEEN_KEY, () => set({ seen: loadChangelogSeen() }))

/**
 * Load the entries once; resolves to whether there is anything to show. The card closes itself on
 * `false`, so `whatsNewOpen` never outlives a load that failed — the nudge and Escape both read it
 * as "a card is on screen".
 */
export function loadWhatsNew(): Promise<boolean> {
  loading ??= import('../changelog/entries')
    .then(({ CHANGELOG }) => {
      set({ entries: CHANGELOG })
      return CHANGELOG.length > 0
    })
    .catch(() => false)
  return loading
}

/**
 * Load the entries if this session could have anything to learn from them. A first visit has just
 * recorded today as seen, so it fetches nothing until somebody opens the card by hand.
 */
export function prefetchWhatsNew(): void {
  if (!FIRST_VISIT) void loadWhatsNew()
}

/** Record every entry as seen: the card was dismissed, or its link followed. */
export function markWhatsNewSeen(): void {
  const newest = state.entries?.[0]?.date
  if (!newest) return
  saveChangelogSeen(newest)
  set({ seen: loadChangelogSeen() })
}

/** The whole state, for the card. Stable between changes, per invariant 7. */
export function useWhatsNew(): State {
  return useSyncExternalStore(subscribe, () => state)
}

/** Whether the `?` menu carries a dot. A primitive. */
export function useWhatsNewUnseen(): boolean {
  return useSyncExternalStore(subscribe, () => state.decision.unseen)
}

/** Whether this session should put the card up by itself: unseen highlights, no link. */
export const whatsNewDue = (s: State): boolean =>
  !ARRIVED_BY_LINK && s.decision.announce.length > 0

/**
 * What the card lists: the unseen highlights, or — opened by hand from the `?` menu with nothing
 * unseen — the highlights newest first, or every entry if none is one. The card decides how many
 * to show.
 */
export function whatsNewRows(s: State): { rows: readonly ChangelogEntry[]; unseen: boolean } {
  if (s.decision.announce.length > 0) return { rows: s.decision.announce, unseen: true }
  const entries = s.entries ?? []
  const highlights = entries.filter((e) => e.highlight)
  return { rows: highlights.length ? highlights : entries, unseen: false }
}
