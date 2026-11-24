/**
 * A status notice that does something when the reader dismisses it — find path's clears its route
 * (`ui/seam/findPathSession.ts`). The notice keeps its dismissal with it: `showNotice` sets both,
 * the reader's × (`StatusNotice.tsx`, `dismissNotice`) runs it, and a notice that merely replaces
 * this one — any `setNotice`, a load or a new graph clearing it — drops it unrun, since by then the
 * notice on show is not the one that brought it.
 */

import { useGraphStore } from '../store/graphStore'

let owned: { readonly text: string; readonly onDismiss: () => void } | undefined

/** Show `text` on the status bar, with what the reader's × on it does. */
export function showNotice(text: string, onDismiss: () => void): void {
  owned = { text, onDismiss }
  useGraphStore.getState().setNotice(text)
}

/** The reader's ×: clear the notice, and run its dismissal where it is still the one on show. */
export function dismissNotice(): void {
  const store = useGraphStore.getState()
  const text = store.notice
  const mine = owned
  owned = undefined
  store.setNotice(undefined)
  if (mine && text === mine.text) mine.onDismiss()
}
