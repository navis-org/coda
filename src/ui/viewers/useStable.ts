/**
 * Memoise by *value* rather than by identity.
 *
 * `readColorSpec` and `readSizeSpec` build a fresh object out of a node's params on every
 * render of the parent, so anything keyed on their identity — a memo, an effect's dependency
 * list — invalidates on every unrelated re-render of the editor. In the network viewer that
 * tore down the renderer and threw away the camera; in the scatter it rebuilt the whole point
 * set and repainted the canvas. The rule in CLAUDE.md is short for a reason: **memoise
 * encoding specs by value.**
 *
 * Extracted from `NetworkViewer` when the second viewer needed it. A copy would have been the
 * usual way for the two to drift on what "stable" means.
 */

import { useRef } from 'react'

export function useStable<T>(value: T): T {
  const held = useRef<{ key: string; value: T } | undefined>(undefined)
  /*
   * Identity first. `JSON.stringify` is O(size) and every caller here re-renders at pointer-poll
   * rate, so a caller that already holds its value steady — most of them, once the value is
   * memoised at its source — should pay one reference compare rather than a walk. What this is
   * *not* is a licence to hand the hook something unbounded: a selection that big is memoised
   * where it is built (`ValuePreview`), and this only stops the cost being paid twice.
   */
  if (held.current && held.current.value === value) return value
  const key = JSON.stringify(value)
  if (!held.current || held.current.key !== key) held.current = { key, value }
  return held.current.value
}
