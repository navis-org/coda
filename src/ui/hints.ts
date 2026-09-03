/**
 * Which node hints this reader has put away.
 *
 * A hint is guidance docked to a card's border (`NodeHint` in `core/graph.ts`); dismissing one is
 * the reader saying "I have read that". Three properties decide where that fact can live, and
 * together they rule out every obvious home:
 *
 *  - **Not the document.** A `dismissed` flag on the node would be an undo step, would mark the
 *    file dirty, and would ride down a share link — so the colleague being shown the workflow
 *    would open it with the guidance already put away by somebody else.
 *  - **Not the graph store.** Nothing here is about the graph, and a set in that store would wake
 *    1,204 `useGraphStore` call sites for a click on a ×.
 *  - **Not session-scoped.** The hints that matter are onboarding copy, and a reader who is
 *    re-taught "search for and select neurons here" on every reload learns to ignore the boxes
 *    rather than to read them.
 *
 * So it is `localStorage`, behind the smallest external store that `useSyncExternalStore` will
 * accept: a module-level `Set` replaced on every write, so the snapshot is stable by identity
 * (invariant 7) and a subscriber re-renders exactly when the set actually changes.
 *
 * ## Keyed on the text, and what that trades
 *
 * The key is a digest of the hint's own prose, not a (document, node, hint) address. That is what
 * makes "once ever" mean what it says: the Workflow Wizard mints a *new* graph every time it is
 * used, with the same sentence docked to the same kind of card, and an address-keyed dismissal
 * would teach a returning reader the same thing again in every workflow they generate.
 *
 * What it trades is real and worth stating: two hints that say exactly the same words are one
 * hint as far as this is concerned, so dismissing a wizard's "Press Run" also silences a Zoo
 * entry that happens to have written the same sentence. That is the right way round — the reader
 * has in fact read it — but it means a hint's text is its identity, and reworded copy comes back
 * for everybody. Deliberate: a reworded hint is usually one that is now saying something else.
 *
 * Nothing is ever forgotten, so both escape hatches matter — the node menu's **Show hints** for
 * one card, and the `?` menu's **Show Hints Again** for the lot. A box dismissed for good with no
 * way back is the failure this file is one line away from at all times.
 */

import { useSyncExternalStore } from 'react'

import type { GraphNode, HintSide, NodeHint } from '../core/graph'
import { hashString } from '../core/hash'
import { channel } from '../data/channel'
import { loadDismissedHints, saveDismissedHints } from '../store/persistence'

/**
 * A hint's identity: a digest of its trimmed text.
 *
 * The *text* alone, not the tone or the side. Re-toning a warning to a note does not make it a
 * thing the reader has not read, and the side is where it is drawn.
 */
export function hintKey(hint: NodeHint): string {
  return hashString(hint.text.trim())
}

/**
 * The dismissed set, read from storage on first ask.
 *
 * Lazy because `localStorage` is undefined under Node + jsdom until a test installs the stub
 * (`test/jsdomStubs.ts`), and a module that read it at import time would answer empty forever for
 * every test file that installs the stub afterwards.
 */
let dismissed: ReadonlySet<string> | undefined

/** Stable empty snapshot, so a first render before any read still compares equal to itself. */
const EMPTY: ReadonlySet<string> = new Set()

/** The shared subscribe/notify shape, rather than a seventh hand-rolled `Set` of listeners. */
const changed = channel()

function current(): ReadonlySet<string> {
  if (!dismissed) dismissed = new Set(loadDismissedHints())
  return dismissed
}

function publish(next: ReadonlySet<string>): void {
  dismissed = next
  saveDismissedHints([...next])
  changed.notify()
}

/**
 * The dismissed set, as a snapshot that only changes when the set does.
 *
 * Returns the `Set` itself rather than a derived boolean, so one subscription serves a card
 * carrying several hints — the component asks `has` per hint, which allocates nothing.
 */
export function useDismissedHints(): ReadonlySet<string> {
  return useSyncExternalStore(changed.subscribe, current, () => EMPTY)
}

/** Put one hint away for good. Idempotent — dismissing a dismissed hint writes nothing. */
export function dismissHint(hint: NodeHint): void {
  const key = hintKey(hint)
  const set = current()
  if (set.has(key)) return
  publish(new Set(set).add(key))
}

/**
 * Bring hints back.
 *
 * With no argument, every hint this reader ever dismissed — the `?` menu's row. With a list, only
 * those — the node menu's row, which is about the card that was right-clicked and has no business
 * un-dismissing guidance on a card three columns over.
 */
export function restoreHints(hints?: readonly NodeHint[]): void {
  const set = current()
  const next = new Set(hints ? set : [])
  if (hints) for (const hint of hints) next.delete(hintKey(hint))
  // Removal only ever shrinks, so a size that did not move means nothing was dismissed.
  if (next.size === set.size) return
  publish(next)
}

/**
 * The hints on a node, split by whether this reader has read them.
 *
 * One function for every caller, so the card and the context menu cannot disagree about what is
 * left to show — the menu offers back exactly what the card is not drawing. `side` defaults to
 * `bottom` here exactly as `NodeHint` documents, which is the one place that default is spent.
 */
export function splitHints(
  node: GraphNode,
  seen: ReadonlySet<string>,
): { unread: Record<HintSide, NodeHint[]>; dismissed: NodeHint[] } {
  const unread: Record<HintSide, NodeHint[]> = { top: [], bottom: [] }
  const put: NodeHint[] = []
  for (const hint of node.hints ?? []) {
    if (seen.has(hintKey(hint))) put.push(hint)
    else unread[hint.side ?? 'bottom'].push(hint)
  }
  return { unread, dismissed: put }
}

/** Reset to the freshly-loaded state. Tests only — the app never forgets within a session. */
export function resetHintsForTest(): void {
  dismissed = undefined
  changed.notify()
}
