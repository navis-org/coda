/**
 * Remembers a network's layout for the rest of the session.
 *
 * A force layout at a few thousand nodes is *earned* — settled over seconds, skipped forward,
 * frozen where it looked right. Closing the viewer used to throw all of it away, because
 * positions lived in the renderer and the renderer dies with the component. Reopening then
 * started from a seed again, which makes the whole layout feel disposable.
 *
 * Deliberately session-scoped and module-level, not part of the saved document:
 *
 *  - **Not persisted.** Positions are not provenance and would bloat every `.coda.json` with
 *    two floats per node. `layout` remains presentational, and reopening a saved file lays out
 *    afresh — which is also what keeps a file portable between machines and window sizes.
 *  - **Module-level rather than a ref**, because a ref dies with the component and surviving
 *    unmount is the entire point. It also means the card, the inspector and the overlay share
 *    one layout for the same node instead of each settling their own.
 *
 * A memo is only reused when the node set *and* the layout signature both still match, so
 * changing the algorithm, the data, or pressing re-layout all recompute rather than restoring
 * something that no longer describes the graph.
 */

import type { CameraState } from 'sigma/types'

import type { Positioned } from './networkLayout'

export interface LayoutMemo {
  /** Insertion order of the node ids the positions belong to. */
  nodeIds: string[]
  /** Everything that decides the arrangement; a change means recompute. */
  signature: string
  positions: Map<string, Positioned>
  camera?: CameraState | undefined
  /**
   * Whether any of these positions were placed by hand.
   *
   * Carried so the viewer's caption can keep admitting it after a rebuild: a restored layout
   * somebody arranged is still an arrangement, and the note saying it will not survive the
   * *file* has to survive a remount.
   */
  moved?: boolean | undefined
}

/**
 * How many layouts to hold.
 *
 * One per network node on the canvas is the realistic ceiling and graphs do not have many, so
 * this is a leak guard rather than a budget. Oldest out first.
 */
const MAX_MEMOS = 8

const memos = new Map<string, LayoutMemo>()

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function rememberLayout(key: string, memo: LayoutMemo): void {
  // Re-inserting moves the entry to the end, so eviction tracks last *use* rather than
  // first creation and the layout you keep returning to is the one that survives.
  memos.delete(key)
  memos.set(key, memo)
  while (memos.size > MAX_MEMOS) {
    const oldest = memos.keys().next()
    if (oldest.done) break
    memos.delete(oldest.value)
  }
}

/** The stored layout, when it still describes this graph laid out this way. */
export function recallLayout(
  key: string,
  nodeIds: string[],
  signature: string,
): LayoutMemo | undefined {
  const memo = memos.get(key)
  if (!memo) return undefined
  if (memo.signature !== signature || !sameIds(memo.nodeIds, nodeIds)) return undefined
  memos.delete(key)
  memos.set(key, memo)
  return memo
}

/** Test seam, and the hook for a future "forget layouts" command. */
export function forgetLayouts(): void {
  memos.clear()
}
