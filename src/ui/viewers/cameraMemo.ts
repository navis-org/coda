/**
 * Remembers where a 3D viewer's camera was, for the rest of the session.
 *
 * A framing is *earned* in the same way a force layout is — turned until the arbour reads,
 * pulled in until the branch you care about is on screen — and it used to be thrown away by
 * anything that remounted the component. Expanding the card to the overlay and closing it again
 * was enough, because those are two instances of the same node, and so was an upstream node
 * re-running under it.
 *
 * Deliberately session-scoped and module-level, exactly as `layoutMemo` is and for the same
 * reasons:
 *
 *  - **Not persisted.** A camera is not provenance. It would put six floats in every
 *    `.coda.json` and hand somebody else's window aspect to whoever opened the file.
 *  - **Module-level rather than a ref**, because surviving unmount is the entire point. It is
 *    also what makes the card and the overlay one continuous view of a scene rather than two.
 *
 * The scene is drawn recentred on the origin (see `Viewer3D.tsx`), which is what makes a stored
 * camera meaningful across a data change at all: swapping one neuron for a whole cell type
 * moves the *contents*, not the space they are drawn in, so a camera that was looking at the
 * origin still is. Only the clip planes follow the new extent.
 */

export interface CameraMemo {
  position: [number, number, number]
  up: [number, number, number]
  /** Orientation as a quaternion, so a rolled trackball view survives verbatim. */
  quaternion: [number, number, number, number]
}

/**
 * How many cameras to hold.
 *
 * One per 3D node on the canvas is the realistic ceiling. A leak guard rather than a budget —
 * an entry is three small arrays — and oldest out first, refreshed on write so the scene you
 * keep coming back to is the one that survives.
 */
const MAX_MEMOS = 8

const memos = new Map<string, CameraMemo>()

export function rememberCamera(key: string, memo: CameraMemo): void {
  memos.delete(key)
  memos.set(key, memo)
  while (memos.size > MAX_MEMOS) {
    const oldest = memos.keys().next()
    if (oldest.done) break
    memos.delete(oldest.value)
  }
}

/**
 * The stored camera for this viewer, if there is one.
 *
 * Its presence is also the answer to "has this scene ever been framed?", which is what stops
 * the automatic framing from firing a second time. A viewer that has a remembered camera has
 * been framed at least once, by definition — the first framing writes one.
 */
export function recallCamera(key: string): CameraMemo | undefined {
  return memos.get(key)
}

/** Drop one, so the next mount frames afresh. What the Reset view control does. */
export function forgetCamera(key: string): void {
  memos.delete(key)
}

/** Test seam. */
export function resetCameraMemos(): void {
  memos.clear()
}
