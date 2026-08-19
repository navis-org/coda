/**
 * Close-when-the-pointer-lands-elsewhere, for the popovers.
 *
 * Written out five times before this — both context menus, the palette, the toolbar dropdowns
 * and the viewer export menu — and the subtle part is the capture-phase `true`, which is what
 * makes the dismissal beat a click handler inside the thing being clicked. A fix to that (a
 * portal-aware containment test, touch handling) reached exactly one popover at a time.
 */

import { useEffect } from 'react'
import type { RefObject } from 'react'

export interface DismissOptions {
  /** Also close on Escape. The context menus want it; the dropdowns leave it to their button. */
  onEscape?: boolean
  /** Skip binding entirely — for popovers that stay mounted while closed. */
  enabled?: boolean
}

export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  { onEscape = false, enabled = true }: DismissOptions = {},
): void {
  useEffect(() => {
    if (!enabled) return
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    if (onEscape) window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      if (onEscape) window.removeEventListener('keydown', onKey)
    }
  }, [ref, onClose, onEscape, enabled])
}
