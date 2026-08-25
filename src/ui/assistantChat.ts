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
  /** You pressed Stop. Nothing was applied, and nothing went wrong. */
  | { kind: 'stopped' }

let entries: ChatEntry[] = []
let busy = false
/**
 * When the wait started, so the panel can say how long it has been going.
 *
 * Here rather than in the drawer for the same reason the transcript is — the drawer unmounts
 * when it is closed, and a timer that restarted because you tidied the panel away would be
 * worse than no timer. Zero while nothing is running.
 *
 * It earns its place against a local model. A cloud provider answers in seconds and the wait
 * needs no narration; Ollama on a 27B model takes three to five minutes on Coda's prompt, and
 * an unchanging "Thinking…" is indistinguishable from a hang — which is exactly what it got
 * reported as.
 */
let busySince = 0
/**
 * The request in flight, so it can be called off.
 *
 * The alternative to a Stop button is not a shorter wait, it is a *closed* drawer: the only way
 * out of a five-minute question asked by mistake was to reload the page and lose the transcript.
 * `requestPlan` keeps an AbortError an AbortError all the way up, so this stays one cancel.
 */
let running: AbortController | undefined
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

/** When the current wait started, as a `Date.now()` stamp. 0 while nothing is running. */
export function chatBusySince(): number {
  return busySince
}

export function appendChat(entry: ChatEntry): void {
  entries = [...entries, entry]
  changed.notify()
}

export function setChatBusy(value: boolean, controller?: AbortController): void {
  if (busy === value) return
  busy = value
  busySince = value ? Date.now() : 0
  running = value ? controller : undefined
  changed.notify()
}

/**
 * Call off the request in flight.
 *
 * Says nothing itself: the abort surfaces where the turn was started, which is the one place
 * that knows whether anything had already been applied. A message written from here would be a
 * second account of the same event, racing the first.
 */
export function stopChat(): void {
  running?.abort()
}

export function clearChat(): void {
  if (entries.length === 0 && !busy) return
  entries = []
  busy = false
  busySince = 0
  // Aborted, not merely dropped. Clearing while a question is in flight otherwise leaves the
  // request running against a transcript that no longer exists, and its answer arrives into
  // a cleared panel.
  running?.abort()
  running = undefined
  changed.notify()
}

/** Test seam: module state outlives a test file otherwise. */
export const resetAssistantChat = clearChat
