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

import { useLatest } from './useLatest'
import { useOverlayEscape } from './useOverlayEscape'

export interface DismissOptions {
  /**
   * Also close on Escape — through `useOverlayEscape`, so the popover is on the one stack that
   * decides which surface answers, and one opened inside a dialog closes before the dialog.
   */
  onEscape?: boolean
  /** Skip binding entirely — for popovers that stay mounted while closed. */
  enabled?: boolean
}

export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  { onEscape = false, enabled = true }: DismissOptions = {},
): void {
  const latest = useLatest(onClose)
  useOverlayEscape(onEscape && enabled ? onClose : undefined)

  useEffect(() => {
    if (!enabled) return
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) latest.current()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [ref, enabled, latest])
}
