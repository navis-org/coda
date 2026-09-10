/**
 * A menu that belongs to the pointer: `position: fixed` at a point, kept inside the window, and
 * closed by Escape or a press anywhere else.
 *
 * **Measured, not estimated.** The seven menus that wear `.context-menu` each clamped against a
 * size typed beside them — 190×230, 210×110, 220×210 plus 67 when a chip row appeared, 264×520
 * for the Explore popovers — and a menu taller than its guess ran off the bottom of the window,
 * which is what every added row made more likely. The box is read in a `useLayoutEffect`, so the
 * correction lands before paint, and again whenever it changes size: a section toggled open
 * inside a child component grows the menu without this one rendering, so a re-read per render
 * would miss exactly the case a guess got wrong.
 *
 * **Escape is on `useOverlayEscape`'s stack**, like every surface that closes on it. A menu opened
 * inside a dialog is pushed after the dialog, so the menu answers first and the dialog stays up.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { useDismissOnOutside } from '../useDismiss'
import { menuPosition } from './placement'

export interface ContextMenuProps {
  /** Where it opens, in client coordinates: the pointer, or the corner of what it hangs from. */
  at: { x: number; y: number }
  onClose: () => void
  /** Classes beside `context-menu`. */
  className?: string
  /** `dialog` for a popover holding fields rather than commands. */
  role?: 'menu' | 'dialog'
  label?: string
  /** The margin kept from the window's edge. */
  margin?: number
  onKeyDown?: (event: KeyboardEvent) => void
  children: ReactNode
}

export function ContextMenu({
  at,
  onClose,
  className,
  role = 'menu',
  label,
  margin = 0,
  onKeyDown,
  children,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useDismissOnOutside(ref, onClose, { onEscape: true })

  const { x, y } = at
  const [place, setPlace] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const clamp = () => {
      const next = menuPosition({ x, y }, menu.getBoundingClientRect(), margin)
      setPlace((prev) => (prev.left === next.left && prev.top === next.top ? prev : next))
    }
    clamp()
    // Absent under jsdom unless a suite installs the stub; the clamp above has still run.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(clamp)
    observer.observe(menu)
    return () => observer.disconnect()
  }, [x, y, margin])

  return (
    <div
      ref={ref}
      className={className ? `context-menu ${className}` : 'context-menu'}
      style={place}
      role={role}
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
}
