/**
 * How big each card is, read off the DOM.
 *
 * One function, two callers — `useArrange`, which wrote it, and the align/distribute tools,
 * which need the same answer from a context menu that is nowhere near React Flow's provider.
 * Extracted rather than copied for `fetchText`'s reason: two functions of one name a couple of
 * directories apart is a grep hazard, and this one is subtle enough that the copy would drift.
 *
 * **`offsetWidth`/`offsetHeight`, and both plausible alternatives are wrong.** The long version
 * is on `useArrange.measure`, which still owns the second half of the job (React Flow's own
 * `measured`, for a card with no element to read). In short: `getNodes()` hands back the array
 * *this app* built, whose `measured` is whatever we put there; a bounding rect is in screen
 * pixels and shrinks with the camera; the offset pair is layout-space, ignores CSS transforms,
 * and so reads the card's size in flow units at any zoom.
 *
 * Getting it wrong throws nothing and fails no type check — every card silently falls back to
 * `FALLBACK_NODE_SIZE` and a canvas of 520-wide Explore cards is arranged, or aligned, as a row
 * of identical 232×120 boxes.
 */

import type { MeasuredSizes, NodeSize } from '../layout/elkGraph'

export function measureCardSizes(): MeasuredSizes {
  const sizes = new Map<string, NodeSize>()
  /*
   * One query rather than a lookup per id: it avoids escaping ids into a selector, and a loaded
   * file may carry any id at all.
   *
   * **Scoped to the canvas, and that scope is load-bearing.** The group peek mounts a second
   * React Flow inside a modal, holding *the same cards* — so their `data-id`s appear twice in
   * the document, and while the group is folded the modal's copies are the only ones. Unscoped,
   * ELK would size the graph from cards drawn in a dialog and `structureKey` would change the
   * moment a peek opened, re-arranging the canvas behind it under auto-layout.
   */
  for (const el of document.querySelectorAll<HTMLElement>(
    '.canvas-area .react-flow__node[data-id]',
  )) {
    const id = el.dataset.id
    if (id && el.offsetWidth > 0 && el.offsetHeight > 0) {
      sizes.set(id, { width: el.offsetWidth, height: el.offsetHeight })
    }
  }
  return sizes
}
