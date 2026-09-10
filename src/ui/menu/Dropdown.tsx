/**
 * The toolbar's menus: a trigger with a panel under it (`Dropdown`), and a row inside one that
 * opens a panel of its own (`Submenu`). Where each panel goes is `placement.ts`.
 */

import { useCallback, useRef, useState } from 'react'

import type { TourAnchor } from '../tour/anchors'
import { useNarrowShell } from '../smallScreen'
import { useDismissOnOutside } from '../useDismiss'
import { menuShift, submenuPlacement, useMenuFit } from './placement'

export function Dropdown({
  label,
  title,
  onOpen,
  tour,
  flyouts,
  children,
}: {
  label: string
  /** Accessible name and tooltip, for a trigger whose label is a glyph rather than a word. */
  title?: string
  /** Fired on the transition to open — the seam for a menu whose contents have to be fetched. */
  onOpen?: () => void
  /** `data-tour` name, for a menu the Guided Tour points at. See `tour/steps.ts`. */
  tour?: TourAnchor
  /**
   * This menu contains a `Submenu`, so the panel must not clip.
   *
   * `.dropdown__panel` sets `overflow-y: auto` for the long menus (New, Open, Save), and
   * `overflow-y` on a box makes `overflow-x` compute to `auto` as well — so a flyout positioned
   * at `left: 100%` renders *inside a scrollbar*, or not at all. Opting out is safe only for a
   * menu short enough never to need the scroll, which is the same menu short enough to want
   * submenus. Not inferred from the children: the panel is a render prop, so nothing here can
   * see what is in it until it is too late to style.
   */
  flyouts?: boolean
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  /*
   * A top-level menu opens at its trigger's left edge and is nudged back inside the window when
   * that would hang it over an edge — `menuShift` holds the reasoning. It matters here at all
   * because the narrow shell puts four menus on a 412px row, and an absolutely-positioned box
   * past the window is scrollable overflow, which is the thing that makes a phone zoom out.
   */
  const shift = menuShift(useMenuFit(ref, open, '.dropdown__panel'))

  useDismissOnOutside(ref, close, { enabled: open })

  return (
    <div className="dropdown" ref={ref} data-tour={tour}>
      <button
        type="button"
        className="btn btn--ghost"
        title={title}
        aria-label={title}
        onClick={() => {
          // Not inside the state updater: React may call that twice under StrictMode, which
          // would fire the fetch twice for one click.
          const next = !open
          setOpen(next)
          if (next) onOpen?.()
        }}
      >
        {label} ▾
      </button>
      {open && (
        <div
          className={`dropdown__panel${flyouts ? ' dropdown__panel--flyouts' : ''}`}
          /* Inline because it is a measurement, not a state: there is no class for "60px to the
             left of where you would have been". Absent whenever the panel already fits. */
          style={shift === 0 ? undefined : { left: shift }}
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}

/**
 * One row of a `Dropdown` that opens a panel of its own beside it.
 *
 * **Hover opens it and click toggles it, and both are needed.** Hover alone is unreachable by
 * touch and by keyboard; click alone makes a pointer user press twice to read a menu that is
 * already under the cursor. The flyout is a *child* of the row's wrapper and butts against it
 * with no gap, so travelling from the row into it never leaves the wrapper and `pointerleave`
 * never fires mid-journey — a gap here is the classic submenu that closes as you reach for it.
 *
 * Focus opens it too, and `relatedTarget` distinguishes moving *between* children (stay open)
 * from leaving altogether (close), since `focusout` fires on every hop inside. **That path is
 * currently unreachable, and not because of anything here:** `Editor.tsx` binds Tab globally to
 * the node browser and exempts only text fields, so Tab inside any toolbar menu opens the
 * browser rather than moving through the rows — measured in a browser against the untouched
 * Examples menu (since replaced), so it is app-wide and predates submenus. The handling stays because it is
 * correct and becomes live the moment that guard learns about open menus.
 */
export function Submenu({
  label,
  blurb,
  children,
}: {
  label: string
  blurb: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  /*
   * Where the flyout opens — `submenuPlacement` holds the reasoning. Inline, it is an ordinary
   * block in the panel it is already inside, so it always fits, and the panel scrolls, having
   * nothing beside it left to clip (see `.dropdown__panel--flyouts`).
   */
  const narrow = useNarrowShell()
  const placement = submenuPlacement(useMenuFit(ref, open, '.dropdown__flyout'), narrow)
  const inline = placement === 'inline'

  /*
   * Hover is the other half of the same change. Opening on `pointerenter` is right for a flyout
   * you travel across to and wrong on a touchscreen, where there is no hover to leave and the
   * only gesture is the tap — so inline, the row is a plain toggle and nothing else opens it.
   *
   * That inverts the rule below deliberately. "Opens, and does not toggle" is true *because*
   * something has already opened the flyout by the time the click lands; with no pointer or
   * focus handler attached, nothing has, and a row that only ever opens is a row that cannot be
   * shut.
   */
  const hover = inline
    ? {}
    : {
        onPointerEnter: () => setOpen(true),
        onPointerLeave: () => setOpen(false),
        onFocus: () => setOpen(true),
        onBlur: (event: React.FocusEvent) => {
          if (!ref.current?.contains(event.relatedTarget)) setOpen(false)
        },
      }

  return (
    <div className="dropdown__sub" ref={ref} {...hover}>
      <button
        type="button"
        className="dropdown__item dropdown__item--parent"
        aria-haspopup="true"
        aria-expanded={open}
        /*
         * Opens, and deliberately does not toggle — beside its row. See `hover` above for why
         * inline is the other way round.
         *
         * A toggle looked right and was wrong in all three input paths, because in every one of
         * them something has *already* opened the flyout by the time the click lands: a pointer
         * hovered, a keyboard focused, a tap fired `pointerenter` first. So Enter on the row a
         * keyboard user had just opened closed it again, and a tap opened and shut it in one
         * gesture. Closing belongs to leaving — `pointerleave`, blur, or dismissing the menu —
         * and this stays as the fallback for the browsers that fire neither (Safari does not
         * focus a button on click).
         */
        onClick={() => setOpen(inline ? !open : true)}
      >
        <strong>{label}</strong>
        <span>{blurb}</span>
      </button>
      {open && (
        <div
          className={`dropdown__panel dropdown__panel--flyouts dropdown__flyout${
            placement === 'inline'
              ? ' dropdown__flyout--inline'
              : placement === 'left'
                ? ' dropdown__flyout--left'
                : ''
          }`}
        >
          {children}
        </div>
      )}
    </div>
  )
}
