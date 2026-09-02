/**
 * Minimap — a toggle in the canvas controls rail.
 *
 * It sits with the view buttons rather than with layout, because what it governs is what you can
 * see rather than where anything is. The map itself still opens in the bottom-right corner; the
 * button used to live down there with it, which meant a single icon alone in a corner opposite a
 * rail that already held every other canvas control.
 *
 * **Not disabled under the lock**, which makes it the one button in the rail that stays live —
 * `LockControl` says the rest dim together. Opening a map moves nothing and restructures nothing,
 * and the map it opens is itself `pannable`/`zoomable` only while the canvas is unlocked, so the
 * lock is honoured where it means something. Same call `styleGroup` and the overlay's Style
 * toggle make: a locked canvas is about geometry and structure, not about how things look.
 *
 * A mode, not a verb, so it says so the way the lock and auto-layout do — `aria-pressed` and an
 * accent tint. The glyph does not change with the state: a frame with two cards in it is what a
 * minimap looks like whether or not one is showing, and the tint carries the rest.
 */

import { ControlButton } from '@xyflow/react'

import { useGraphStore } from '../../store/graphStore'

/** A framed pane with two cards in it — the map, not a verb about it. */
function MinimapIcon() {
  return (
    <svg className="rail-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="1.5" y="2.75" width="13" height="10.5" rx="1.4" />
      <rect x="3.75" y="5" width="4" height="3" rx="0.5" data-fill="" />
      <rect x="8.75" y="8" width="4" height="3" rx="0.5" data-fill="" />
    </svg>
  )
}

export function MinimapControl() {
  // A primitive — invariant 7. `togglePanel` mints a fresh `panels` object every time.
  const open = useGraphStore((s) => s.panels.minimap)
  const togglePanel = useGraphStore((s) => s.togglePanel)

  return (
    <ControlButton
      onClick={() => togglePanel('minimap')}
      className={open ? 'rail-toggle--on' : undefined}
      aria-pressed={open}
      title={open ? 'Hide the minimap' : 'Show the minimap'}
      aria-label={open ? 'Hide minimap' : 'Show minimap'}
    >
      <MinimapIcon />
    </ControlButton>
  )
}
