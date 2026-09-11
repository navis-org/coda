/**
 * A modal: the backdrop, the panel, and the two ways out — Escape and a press on the backdrop.
 *
 * Fifteen surfaces built this by hand, and the copies had drifted on exactly the parts nobody
 * sees: Escape on the capture phase or the bubble, standing aside for a popover or not, the
 * backdrop closing through its own handler or through a window listener. What each dialog keeps
 * is what is genuinely its own — its content, its header, and one of two documented departures:
 *
 * - **No `onClose`**: nothing closes it but its own buttons. `SmallScreenGate`, where a key and a
 *   tap outside would both be accidents.
 * - **`backdrop={false}`**: Escape closes, a stray press does not. `SharedLinkGate`, where
 *   dismissing throws away a link somebody was sent.
 *
 * **The backdrop closes on its own pointer-down, and the panel stops the event** — not a window
 * listener testing containment, which half the copies used. React events from a portal bubble
 * through the React tree, so a child portalled out of the panel's DOM (a node's screen map)
 * still stops at the panel, where a containment test calls it outside and closes the dialog
 * from under it.
 *
 * Escape is `useOverlayEscape`, which is also what makes stacking work: only the surface opened
 * last answers it.
 *
 * **`portal`** is for a modal opened from inside a node card, which clips, and whose React Flow
 * transform would otherwise be the fixed-position containing block. It renders into the document
 * — the fullscreen element when there is one, as the hover panels do, or it opens invisibly under
 * a fullscreen viewer — and stops React events at its root: they still bubble through a portal to
 * the card, whose double-click expands it. Escape is left alone; `useOverlayEscape` takes it on the
 * window, in the capture phase.
 */

import type { CSSProperties, ReactNode, Ref, SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'

import { useOverlayEscape } from './useOverlayEscape'

export interface ModalProps {
  /** Every class on the panel, `overlay__panel` included — the variants are each dialog's own. */
  className: string
  /** The backdrop's classes: `overlay`, unless the surface draws a backdrop of its own. */
  rootClassName?: string
  label?: string
  labelledBy?: string
  /** Omitted for a dialog that only its own buttons may close. */
  onClose?: () => void
  backdrop?: boolean
  /** Asked at each Escape — see `useOverlayEscape`'s `ignore`. */
  ignoreEscape?: () => boolean
  panelRef?: Ref<HTMLDivElement>
  style?: CSSProperties
  /** `data-tour` name, for a dialog the Guided Tour spotlights. */
  tour?: string
  /** Opened from inside a node card — see the note above. */
  portal?: boolean
  children: ReactNode
}

function stopHere(event: SyntheticEvent) {
  if ('key' in event && event.key === 'Escape') return
  event.stopPropagation()
}

export function Modal({
  className,
  rootClassName = 'overlay',
  label,
  labelledBy,
  onClose,
  backdrop = true,
  ignoreEscape,
  panelRef,
  style,
  tour,
  portal = false,
  children,
}: ModalProps) {
  useOverlayEscape(onClose, { ignore: ignoreEscape })
  const close = backdrop && onClose ? onClose : undefined
  const modal = (
    <div
      className={rootClassName}
      role="presentation"
      onPointerDown={(event) => {
        if (portal) event.stopPropagation()
        close?.()
      }}
      onClick={portal ? stopHere : undefined}
      onDoubleClick={portal ? stopHere : undefined}
      onKeyDown={portal ? stopHere : undefined}
    >
      <div
        ref={panelRef}
        className={className}
        style={style}
        data-tour={tour}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
  return portal ? createPortal(modal, document.fullscreenElement ?? document.body) : modal
}

/** The header most dialogs wear: a title and a ✕. */
export function ModalHeader({
  titleId,
  onClose,
  children,
}: {
  titleId?: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <header className="modal__header">
      <h2 id={titleId}>{children}</h2>
      <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close">
        ✕
      </button>
    </header>
  )
}
