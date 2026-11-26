/**
 * The button a warning carries when its node knows the fix (`NodeIssue.fix`), drawn under the
 * warning's sentence on the card and in the inspector.
 *
 * Under the sentence rather than in the node's body, which is where the first version put it: a
 * card draws its issue line *after* the body, so the fix sat above the problem it answered.
 *
 * Hidden under the lock where the fix's action is refused there (`fixLiveUnderLock`), so a card
 * does not offer a button that does nothing. `tickAndRun` is a param and a run, both live under
 * the lock, so it stays. Pressing goes through the store's one dispatch, `applyFix`.
 */

import { fixLiveUnderLock, type IssueFix } from '../core/node'
import { useGraphStore } from '../store/graphStore'

export function IssueFixButton({ nodeId, fix }: { nodeId: string; fix: IssueFix }) {
  const locked = useGraphStore((s) => s.locked)
  if (locked && !fixLiveUnderLock(fix)) return null
  return (
    <button
      type="button"
      className="issue-fix nodrag"
      title={fix.title}
      onClick={(event) => {
        // A click on a card also selects it, and the selection is not what was asked for.
        event.stopPropagation()
        void useGraphStore.getState().applyFix(nodeId, fix)
      }}
    >
      {fix.label}
    </button>
  )
}
