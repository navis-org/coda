/**
 * Lock — the last button in the canvas controls rail.
 *
 * A mode, not a verb, so it says so the way auto-layout does: `aria-pressed`, an accent tint,
 * and a drawing that changes with the state rather than only the colour. A padlock is one of the
 * few glyphs where open and shut are legible at 14px, which is what makes the two-drawing rule
 * affordable here — see `RoutingIcon`, which makes the same call for the same reason.
 *
 * Last in the rail, below the layout buttons, because it governs them: while it is on, every
 * other button in the rail is disabled, which is the strongest signal on screen that the canvas
 * is frozen — the whole rail dims except this one and `MinimapControl`, which shows a panel
 * rather than touching the graph and so stays live for the reason `styleGroup` does.
 *
 * What the lock covers is written up on `GraphState.locked`, and the copy every refusing surface
 * shows is in `ui/lockCopy.ts`.
 */

import { ControlButton } from '@xyflow/react'

import { useGraphStore } from '../../store/graphStore'

/** Shackle up and body open, or shackle down and body shut. */
function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg className="rail-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7.5" rx="1.4" />
      {locked ? (
        <path d="M5.4 7V4.9a2.6 2.6 0 0 1 5.2 0V7" strokeLinecap="round" />
      ) : (
        <path d="M5.4 7V4.9a2.6 2.6 0 0 1 5.2 0" strokeLinecap="round" />
      )}
      <circle cx="8" cy="10.6" r="1.1" data-fill="" />
    </svg>
  )
}

export function LockControl() {
  // A primitive — invariant 7.
  const locked = useGraphStore((s) => s.locked)
  const toggleLocked = useGraphStore((s) => s.toggleLocked)

  return (
    <ControlButton
      onClick={toggleLocked}
      className={locked ? 'rail-toggle--on' : undefined}
      aria-pressed={locked}
      title={
        locked
          ? 'Canvas locked — no panning, zooming, dragging, resizing or editing. Click to unlock.'
          : 'Lock the canvas — freeze the view, the cards and the wiring'
      }
      aria-label="Lock canvas"
    >
      <LockIcon locked={locked} />
    </ControlButton>
  )
}
