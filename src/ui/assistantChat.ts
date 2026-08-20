/**
 * The assistant conversation, for as long as the tab is open.
 *
 * Module-level rather than component state, and module-level rather than in the graph store,
 * for two different reasons.
 *
 * Not component state, because the drawer unmounts when it is closed — a transcript that
 * vanished because you tidied the panel away is not a transcript. Same idiom as
 * `useNeuronIndex` and `viewers/layoutMemo`: state that outlives a component without being
 * part of the document.
 *
 * Not the graph store, because it is **not the document**. It is never serialised, never
 * autosaved, and never travels with a `.coda.json` — a graph you send a colleague must not
 * carry your conversation, and the autosave lives in a ~5MB origin budget that a transcript
 * has no business competing for. Keeping it out of the store is also what stops the panel's
 * heavy half reaching the main chunk: `converse.ts` pulls the catalogue and the API client, and
 * the store is imported by everything.
 *
 * A reload clears it. The graph is the artefact; the chat is the scaffolding that built it.
 */

import type { ApplyWarning } from '../assistant/apply'
import type { CodaGraph } from '../core/graph'
import { channel } from '../data/channel'

/** One line of the transcript. */
export type ChatEntry =
  | { kind: 'you'; text: string }
  /** A plan that landed. `graph` is the object it produced — see `undoable` below. */
  | {
      kind: 'done'
      summary: string
      added: number
      wired: number
      settings: number
      removed: number
      warnings: ApplyWarning[]
      /**
       * The graph this edit produced, held by identity so the panel can tell whether its Undo
       * is still the thing that would come off the stack. Anything the user does afterwards
       * replaces the object, and the button stands down rather than undoing someone else's
       * edit — a global undo offered against a stale message is a trap.
       */
      graph: CodaGraph
    }
  /** The plan was refused, or the request never produced one. Nothing was applied. */
  | { kind: 'failed'; text: string; detail?: string[] }

let entries: ChatEntry[] = []
let busy = false
const changed = channel()

export const subscribeChat = changed.subscribe

/*
 * `useSyncExternalStore` compares snapshots by identity, so both of these must return a
 * stable reference between changes — a fresh array per call is the infinite-loop warning
 * invariant 7 exists for.
 */
export function chatEntries(): ChatEntry[] {
  return entries
}

export function chatBusy(): boolean {
  return busy
}

export function appendChat(entry: ChatEntry): void {
  entries = [...entries, entry]
  changed.notify()
}

export function setChatBusy(value: boolean): void {
  if (busy === value) return
  busy = value
  changed.notify()
}

export function clearChat(): void {
  if (entries.length === 0 && !busy) return
  entries = []
  busy = false
  changed.notify()
}

/** Test seam: module state outlives a test file otherwise. */
export const resetAssistantChat = clearChat
