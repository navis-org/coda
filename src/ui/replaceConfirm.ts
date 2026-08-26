/**
 * The one sentence asked before a graph is replaced, and the guard that decides to ask it.
 *
 * Three surfaces load somebody else's graph over whatever is on the canvas: the start page's
 * cards, the shared-link gate, and the Zoo browser. Each had written the question itself, and
 * the third copy had already lost the only fact the question exists to convey — that the undo
 * history goes with it. `docs/ui-shell.md` states the rule this broke: two routes to one dialog
 * is two places for the wording to drift.
 *
 * The *layout* stays with each caller, deliberately — inline on a card, inline in a detail
 * column, a modal for an incoming link — because that part genuinely differs. What is shared is
 * the guard and the words, which do not.
 */

import { useState } from 'react'

import { useGraphStore } from '../store/graphStore'

/**
 * Asked when there is work to lose. Ends with the consequence rather than the action, because
 * "this clears the undo history" is the half a reader cannot infer from the button.
 */
export const REPLACE_GRAPH_QUESTION = 'Replace the current graph? This clears the undo history.'

export interface ReplaceConfirm {
  /** The id currently being confirmed, so a caller can render the prompt on that row alone. */
  confirming: string | undefined
  /**
   * Run `commit`, or arm the confirmation and return.
   *
   * Keyed by id rather than by a bare boolean so that clicking a *second* row re-asks about that
   * row instead of silently inheriting the first one's armed state.
   */
  ask(id: string, commit: () => void): void
  cancel(): void
}

export function useReplaceConfirm(): ReplaceConfirm {
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  // A primitive, per invariant 7: the store is read through `useSyncExternalStore`, which
  // compares snapshots by identity.
  const hasWork = useGraphStore((s) => s.graph.nodes.length > 0)

  return {
    confirming,
    ask: (id, commit) => {
      if (hasWork && confirming !== id) {
        setConfirming(id)
        return
      }
      setConfirming(undefined)
      commit()
    },
    cancel: () => setConfirming(undefined),
  }
}
