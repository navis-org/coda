/**
 * The button a warning carries when its node knows the fix (`NodeIssue.fix`), drawn under the
 * warning's sentence on the card and in the inspector.
 *
 * Under the sentence rather than in the node's body, which is where the first version put it: a
 * card draws its issue line *after* the body, so the fix sat above the problem it answered.
 *
 * Hidden under the lock, since every fix is an edit. The action refuses under the lock as well,
 * so this only keeps the card from offering a button that does nothing.
 */

import type { IssueFix } from '../core/node'
import { useGraphStore } from '../store/graphStore'

export function IssueFixButton({ nodeId, fix }: { nodeId: string; fix: IssueFix }) {
  const locked = useGraphStore((s) => s.locked)
  if (locked) return null
  return (
    <button
      type="button"
      className="issue-fix nodrag"
      title={fix.title}
      onClick={(event) => {
        // A click on a card also selects it, and the selection is not what was asked for.
        event.stopPropagation()
        useGraphStore.getState()[fix.action](nodeId)
      }}
    >
      {fix.label}
    </button>
  )
}
