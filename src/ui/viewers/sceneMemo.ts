/**
 * Remembers the state a neuroglancer embed was showing, for the rest of the session.
 *
 * `cameraMemo`'s problem one seam further out. A 3D viewer's camera is six floats this app
 * holds; a neuroglancer embed's state lives inside a foreign document, so *everything* the user
 * did in it — the camera, the panel layout, a layer they hid, a layer they added, a segment they
 * picked in the viewer itself — dies with the iframe. And the iframe dies for the most ordinary
 * reason there is: expanding the card hands the node to the overlay, which is a second instance
 * of the same node, so the card stands down (see `showPreview` in `CodaNodeView`) and the overlay
 * mounts a frame of its own. Closing it hands the node back the same way. Two remounts, two
 * scenes reset to the published camera, for an action nobody thinks of as destructive.
 *
 * The memo carries the whole state rather than a camera, because it costs nothing more to and
 * because there is no smaller unit that helps: the frame is re-pointed with one URL either way.
 *
 * `base` and `identity` are what make a stored state safe to restore *into*. `identity` is
 * `sceneIdentity` of the **built** scene that was applied when the state was read, not of the
 * state itself — a live scene differs from the built one on exactly the keys the user moved, the
 * camera above all, so comparing the two would never match. Comparing what was *asked for* then
 * and what is asked for now is the same gate `NeuroglancerViewer` already uses to decide whether
 * an update may be merged, which is the right question here too: same place, same viewer.
 *
 * Session-scoped and module-level for `cameraMemo`'s two reasons, which hold harder here:
 *
 *  - **Not persisted.** A viewer state is not provenance. Male-CNS publishes 38 kB of scene
 *    before a single neuron is added, and the live copy is larger; putting that in every
 *    `.coda.json` would hand somebody else's panel layout to whoever opened the file.
 *  - **Module-level rather than a ref**, because surviving unmount is the entire point.
 *
 * Only reachable where the viewer is proxied same-origin — a cross-origin frame's
 * `location.hash` cannot be read, so nothing is ever stored and the embed behaves as it did.
 * The same condition `spliceSegments` runs under, and the same honest degrade.
 */

import type { NgScene } from '../../data/neuroglancer/scene'

export interface SceneMemo {
  /** Viewer instance the state was read out of. A state is meaningless against another one. */
  base: string
  /** `sceneIdentity` of the scene that had been *applied* when this was read. See above. */
  identity: string
  /** What the frame was actually showing. */
  scene: NgScene
}

/**
 * How many states to hold.
 *
 * Fewer than `cameraMemo`'s eight, because an entry is a whole scene — tens of kB for the larger
 * published states, and the live copy grows as somebody adds layers. One per neuroglancer node
 * being worked on at once is the realistic need, and a leak guard is what this is; oldest out
 * first, refreshed on write so the one being used stays.
 */
const MAX_MEMOS = 4

const memos = new Map<string, SceneMemo>()

export function rememberScene(key: string, memo: SceneMemo): void {
  memos.delete(key)
  memos.set(key, memo)
  while (memos.size > MAX_MEMOS) {
    const oldest = memos.keys().next()
    if (oldest.done) break
    memos.delete(oldest.value)
  }
}

/** The stored state for this viewer, if one was read before its frame went away. */
export function recallScene(key: string): SceneMemo | undefined {
  return memos.get(key)
}

/**
 * Drop one, so the next mount opens the published scene.
 *
 * What Reload does. A reload is how somebody gets out of a frame that has gone wrong, and
 * restoring the state it went wrong in would be the one thing that button must not do.
 */
export function forgetScene(key: string): void {
  memos.delete(key)
}

/** Test seam. */
export function resetSceneMemos(): void {
  memos.clear()
}
