/**
 * Put the graph store back to one blank workflow.
 *
 * The store is a module singleton and the open documents live in a closure beside it, so
 * `useGraphStore.setState(...)` — which is how most suites reset — reaches the *active*
 * document's fields and nothing else. `newGraph()` on its own is no longer a reset either: it
 * opens a workflow, and opening one beside a canvas that has work on it is the whole feature.
 * Left alone, a file's cases therefore accumulate a document each and the second one to count
 * tabs is answering for every case before it.
 *
 * Only the store's own public actions, deliberately: a reset with a private door into the
 * closure would be a second definition of what closing a workflow means, and the one thing worth
 * knowing about `closeDocument` — that the last one leaves a fresh blank in its place — is
 * exactly what makes this terminate.
 */

import { useGraphStore } from '../store/graphStore'

export function resetDocuments(): void {
  // A blank one first, so what survives the loop below is a document nothing has touched.
  useGraphStore.getState().newGraph()
  const { tabs, activeTabId, closeDocument } = useGraphStore.getState()
  for (const tab of tabs) if (tab.id !== activeTabId) closeDocument(tab.id)
}
