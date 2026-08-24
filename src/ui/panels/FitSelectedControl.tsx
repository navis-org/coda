/**
 * Fit Selected — the fourth view button in the canvas controls rail.
 *
 * It sits directly under React Flow's own Zoom In / Zoom Out / Fit View (children of
 * `<Controls>` render after the built-ins) because it is the same kind of thing they are: a verb
 * that moves the *view* and holds no state. The layout buttons follow it.
 *
 * Disabled rather than hidden with nothing selected, so the rail does not change height under
 * the pointer and the control's absence has a visible cause — the same call `LayoutControls`
 * makes for the alignment row in its bubble. The tooltip says what is missing.
 */

import { ControlButton } from '@xyflow/react'

import { useGraphStore } from '../../store/graphStore'
import { useFitSelected } from '../fitView'

/** A frame closing in on one card — what the button does, drawn small. */
function FitSelectedIcon() {
  return (
    <svg className="rail-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M1.5 5V1.5H5M11 1.5h3.5V5M14.5 11v3.5H11M5 14.5H1.5V11"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="5" y="5" width="6" height="6" rx="1.2" data-fill="" />
    </svg>
  )
}

export function FitSelectedControl() {
  const fitSelected = useFitSelected()
  // A primitive, not the selection array — invariant 7. This only asks whether anything is
  // selected, and how many says it in the tooltip.
  const count = useGraphStore((s) => s.selection.length)

  const label =
    count === 0
      ? 'Fit Selected — select a node first'
      : count === 1
        ? 'Fit the selected node (§)'
        : `Fit the ${count} selected nodes (§)`

  return (
    <ControlButton
      onClick={fitSelected}
      disabled={count === 0}
      title={label}
      aria-label="Fit Selected"
    >
      <FitSelectedIcon />
    </ControlButton>
  )
}
