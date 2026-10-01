/**
 * A menu that belongs to the pointer: `position: fixed` at a point, kept inside the window, and
 * closed by Escape or — unless `dismissOnOutside` is off — a press anywhere else.
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
import { createPortal } from 'react-dom'

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
  /**
   * Render into the document rather than in place — for a menu opened from inside a stacking
   * context (a React Flow `<Panel>`) that would cap its `z-index`. The host is `Modal`'s.
   */
  portal?: boolean
  /**
   * Close on a press anywhere else — the default. `false` for a popover holding a draft, where
   * the press that lands outside is usually somebody checking what they are writing about.
   */
  dismissOnOutside?: boolean
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
  portal = false,
  dismissOnOutside = true,
  children,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useDismissOnOutside(ref, onClose, { onEscape: true, onOutside: dismissOnOutside })

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

  const menu = (
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
  return portal ? createPortal(menu, document.fullscreenElement ?? document.body) : menu
}

/**
 * A section of a context menu that opens in place: a row with a disclosure arrow, and below it,
 * once opened, a bounded scrolling list.
 *
 * In place rather than as a flyout, which is the group menu's argument: a flyout is a second panel
 * to place against a window edge, and a panel holding one has to switch its own scrolling off
 * (`Dropdown`'s `flyouts`). The children render **only while open**, so a section whose rows are
 * costly to work out — every member's params, every tab's cells — pays for it on the right-clicks
 * that ask, not on all of them; put that work in a component passed as a child.
 */
export function ContextMenuSection({
  label,
  title,
  disabled,
  children,
}: {
  label: ReactNode
  title?: string
  disabled?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="context-menu__item context-menu__item--parent"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((was) => !was)}
      >
        {label}
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && !disabled && <div className="context-menu__controls">{children}</div>}
    </>
  )
}
