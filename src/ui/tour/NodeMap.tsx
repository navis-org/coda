/**
 * A node's own screen map: the header button on a full-size surface, for a body that declares
 * `NodeBodyEntry.screenMap`.
 *
 * The shell's map, pointed at one body. Same stage, same placement, same hover and the same list
 * below `NARROW_QUERY` — `MapStage.tsx` — and none of the guide's lifecycle, because there is
 * nothing to borrow: the surface is already open and already showing the controls being labelled.
 * So it is not in `TOURS`, earns no checkmark, and is not counted by `isTourActive()`. That guard
 * exists for keys that move what a stage measured; with a surface up, the keys that do (`f`, `i`,
 * `d`) either leave the panel where it is or unmount it, and this with it — the map is a child of
 * the surface, so it cannot outlive what it points at.
 *
 * ## Portalled, and not for tidiness
 *
 * The stage is `position: fixed` in viewport coordinates, and `.overlay` has a `backdrop-filter`
 * — which makes it the containing block for every fixed descendant, so a stage rendered in place
 * would be offset by the overlay's own origin while every rect it drew had been measured against
 * the viewport. Into the fullscreen element when there is one, `useHoverPanel`'s rule: a panel
 * handed to the Fullscreen API is the only subtree the browser draws, and a map portalled to the
 * body behind it would be up, modal and invisible.
 *
 * The wrapper stops `pointerdown` from climbing to the frame through the React tree, which a portal
 * does not cut. The overlay's panel happens to stop it already on its way to the backdrop, which
 * closes on a press; the dock and a dashboard cell make no such promise, and a press on the scrim
 * has no business reaching a frame's gestures. The dismissal itself is `useDismissOnOutside`'s
 * window listener, which runs before any of this.
 */

import { createPortal } from 'react-dom'
import type { RefObject } from 'react'

import { useNarrowShell } from '../smallScreen'
import { MapList, MapStage } from './MapStage'
import type { MapSpot } from './mapSpots'

export function NodeMap({
  spots,
  scope,
  label,
  onClose,
}: {
  spots: readonly MapSpot[]
  /** The surface's body — the one place its finders may look. */
  scope: RefObject<HTMLElement | null>
  /** The node type's label, which names the dialog. */
  label: string
  onClose: () => void
}) {
  const narrow = useNarrowShell()
  return createPortal(
    <div onPointerDown={(event) => event.stopPropagation()}>
      {narrow ? (
        <MapList
          spots={spots}
          title={label}
          lede={`What each part of ${label} is for. On a wider screen this is drawn on the view itself, with a box round each one.`}
          onClose={onClose}
        />
      ) : (
        <MapStage
          spots={spots}
          scope={scope}
          title={label}
          text="Everything in this view, labelled. Hover a label to find what it names."
          onClose={onClose}
        />
      )}
    </div>,
    document.fullscreenElement ?? document.body,
  )
}
