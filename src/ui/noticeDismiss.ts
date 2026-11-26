/**
 * A status notice of a feature's own: what the reader's × on it does, and — optionally — a small
 * choice drawn beside its text. Find path's clears its route on ×, and offers what its colour
 * encodes (`ui/seam/findPathSession.ts`). The notice keeps both with it: `showNotice` sets them,
 * the reader's × (`StatusNotice.tsx`, `dismissNotice`) runs the dismissal, and a notice that merely
 * replaces this one — any `setNotice`, a load or a new graph clearing it — drops them unrun and
 * undrawn, since by then the notice on show is not the one that brought them.
 */

import { channel } from '../data/channel'
import { useGraphStore } from '../store/graphStore'

/** A choice drawn beside a notice's text: a labelled select. */
export interface NoticeChoice {
  /** What is chosen, as the select is named: "Colour by". */
  readonly label: string
  readonly value: string
  readonly options: readonly {
    readonly value: string
    readonly label: string
    /** Offered but not choosable, with why on hover. */
    readonly disabled?: string | undefined
  }[]
  readonly onChange: (value: string) => void
}

let owned:
  | { readonly text: string; readonly onDismiss: () => void; readonly choice?: NoticeChoice }
  | undefined
const changed = channel()

/** Show `text` on the status bar, with what the reader's × on it does and a choice beside it. */
export function showNotice(text: string, onDismiss: () => void, choice?: NoticeChoice): void {
  owned = { text, onDismiss, ...(choice ? { choice } : {}) }
  useGraphStore.getState().setNotice(text)
  changed.notify()
}

/** The reader's ×: clear the notice, and run its dismissal where it is still the one on show. */
export function dismissNotice(): void {
  const store = useGraphStore.getState()
  const text = store.notice
  const mine = owned
  owned = undefined
  store.setNotice(undefined)
  changed.notify()
  if (mine && text === mine.text) mine.onDismiss()
}

/** The choice of the notice on show, where it brought one. */
export function noticeChoice(notice: string | undefined): NoticeChoice | undefined {
  return owned && notice === owned.text ? owned.choice : undefined
}

/** Whenever a feature's notice, or its choice, changes. Returns the unsubscribe. */
export const onOwnedNotice = changed.subscribe
