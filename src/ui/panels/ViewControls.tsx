/**
 * The four view buttons at the top of the canvas controls rail.
 *
 *   ＋  zoom in           disabled at max zoom
 *   －  zoom out          disabled at min zoom
 *   ⛶  fit view          the whole graph
 *   ⌖  fit selected      what is selected, and only enabled when something is
 *
 * **These are ours rather than React Flow's own**, which `<Controls>` is told not to draw
 * (`showZoom={false} showFitView={false}`). The reason is the lock: React Flow disables its zoom
 * buttons at the zoom limits and nowhere else, and a locked canvas whose rail still offers three
 * live buttons that move the viewport is a lock with a hole in it. Owning them also puts the
 * min/max rule and the lock rule in one place, and lets all four take the line-drawn icons the
 * rest of the rail uses instead of React Flow's solid glyphs.
 *
 * Disabled rather than hidden throughout, so the rail does not change height under the pointer
 * and every absence has a visible cause — the same call `LayoutControls` makes for the alignment
 * row in its bubble. Each tooltip says which of the two reasons applies.
 */

import { ControlButton, useReactFlow, useStore } from '@xyflow/react'

import { useGraphStore } from '../../store/graphStore'
import { FIT_DURATION, useFitAll, useFitSelected } from '../fitView'
import { lockedTitle } from '../lockCopy'

function ZoomInIcon() {
  return (
    <svg className="rail-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="6.8" cy="6.8" r="4.6" />
      <path d="M10.3 10.3 14.6 14.6M4.4 6.8h4.8M6.8 4.4v4.8" strokeLinecap="round" />
    </svg>
  )
}

function ZoomOutIcon() {
  return (
    <svg className="rail-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="6.8" cy="6.8" r="4.6" />
      <path d="M10.3 10.3 14.6 14.6M4.4 6.8h4.8" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The corner frame both fit icons close in with, drawn once.
 *
 * The two differ only in what is inside it — two outlined cards for the whole graph, one solid
 * card for the selected one — and that difference is the entire meaning of the pair. Copied, the
 * frame is what would drift and take the pairing with it.
 */
function FitFrame() {
  return (
    <path
      d="M1.5 5V1.5H5M11 1.5h3.5V5M14.5 11v3.5H11M5 14.5H1.5V11"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  )
}

/** The frame closing in on the whole graph — two cards, where Fit Selected has one. */
function FitViewIcon() {
  return (
    <svg className="rail-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <FitFrame />
      <rect x="4.5" y="6" width="3" height="4" rx="0.8" />
      <rect x="8.5" y="6" width="3" height="4" rx="0.8" />
    </svg>
  )
}

/** The same frame, closing in on one card — the selected one, so it is the solid one. */
function FitSelectedIcon() {
  return (
    <svg className="rail-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <FitFrame />
      <rect x="5" y="5" width="6" height="6" rx="1.2" data-fill="" />
    </svg>
  )
}

export function ViewControls() {
  const { zoomIn, zoomOut } = useReactFlow()
  const fitAll = useFitAll()
  const fitSelected = useFitSelected()
  // Primitives, not the transform — invariant 7, and the same two questions React Flow's own
  // buttons ask of its store.
  const atMaxZoom = useStore((s) => s.transform[2] >= s.maxZoom)
  const atMinZoom = useStore((s) => s.transform[2] <= s.minZoom)
  const locked = useGraphStore((s) => s.locked)
  const selected = useGraphStore((s) => s.selection.length)

  /*
   * Hoisted rather than inlined, because it is the one title with three things to say — the
   * lock, an empty selection, and how many cards are about to be framed — and a four-way ternary
   * sitting between `disabled` and `aria-label` is the attribute you stop reading.
   */
  const fitSelectedTitle = locked
    ? lockedTitle('Fit Selected')
    : selected === 0
      ? 'Fit Selected — select a node first'
      : selected === 1
        ? 'Fit the selected node (§)'
        : `Fit the ${selected} selected nodes (§)`

  return (
    <>
      <ControlButton
        onClick={() => void zoomIn({ duration: FIT_DURATION })}
        disabled={locked || atMaxZoom}
        title={locked ? lockedTitle('Zoom in') : 'Zoom in'}
        aria-label="Zoom in"
      >
        <ZoomInIcon />
      </ControlButton>

      <ControlButton
        onClick={() => void zoomOut({ duration: FIT_DURATION })}
        disabled={locked || atMinZoom}
        title={locked ? lockedTitle('Zoom out') : 'Zoom out'}
        aria-label="Zoom out"
      >
        <ZoomOutIcon />
      </ControlButton>

      <ControlButton
        onClick={fitAll}
        disabled={locked}
        title={locked ? lockedTitle('Fit View') : 'Fit the whole graph'}
        aria-label="Fit View"
      >
        <FitViewIcon />
      </ControlButton>

      <ControlButton
        // Wrapped rather than passed: `useFitSelected` takes an optional overrides object now,
        // and handed straight to `onClick` it would be called with a `MouseEvent` as its
        // options. The type checker refuses it, which is the point of the parameter being typed
        // rather than `any` — but the wrapper is what makes the refusal go away honestly.
        onClick={() => fitSelected()}
        disabled={locked || selected === 0}
        title={fitSelectedTitle}
        aria-label="Fit Selected"
      >
        <FitSelectedIcon />
      </ControlButton>
    </>
  )
}
