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
  const key = JSON.stringify(value)
  const held = useRef<{ key: string; value: T }>({ key, value })
  if (held.current.key !== key) held.current = { key, value }
  return held.current.value
}
