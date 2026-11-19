/**
 * The menu behind a review row's split button — `VerdictButtons`' ▾ and `ExtendButtons`'.
 *
 * The menu is portalled (`ContextMenu`): the row sits in a scrolling list on a card inside React
 * Flow's transformed pane, which would clip a panel hung under it and scale it with the zoom.
 */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'

import { ContextMenu } from '../menu/ContextMenu'
import { anchorBelow } from '../menu/placement'

export function useSplitMenu(
  /** The menu's class, which marks a press inside it as not outside. */
  menuClass: string,
) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>()
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => {
    setMenuAt(undefined)
    trigger.current?.focus()
  }
  /*
   * **Closed by a press outside, but not by a press on ▾**, which toggles it. `ContextMenu`'s own
   * outside-dismiss cannot tell the two apart — the menu is portalled, ▾ is not in it — so it
   * closed on the press and the click reopened it at once.
   */
  useEffect(() => {
    if (!menuAt) return
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (trigger.current?.contains(target) || target?.closest?.(`.${menuClass}`)) return
      setMenuAt(undefined)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [menuAt, menuClass])
  // Focus into the menu as it opens, once, so a keyboard can reach it.
  const open = menuAt !== undefined
  useEffect(() => {
    if (open) {
      document
        .querySelector<HTMLButtonElement>(`.${menuClass} [role="menuitemradio"]:enabled`)
        ?.focus()
    }
  }, [open, menuClass])
  const toggle = (event: MouseEvent<HTMLButtonElement>) =>
    setMenuAt(menuAt ? undefined : anchorBelow(event.currentTarget))
  return { menuAt, trigger, close, toggle }
}

/** One row of a split button's menu. */
export interface SplitMenuItem<T extends string> {
  readonly value: T
  readonly label: string
  readonly title: string
  readonly disabled: boolean
}

/**
 * The menu itself: radio rows, the checked one ticked, a press closing it and then picking. Drawn
 * where `useSplitMenu` says it is open.
 */
export function SplitMenu<T extends string>({
  at,
  close,
  label,
  className,
  items,
  checked,
  onPick,
}: {
  at: { x: number; y: number }
  close: () => void
  label: string
  /** `useSplitMenu`'s class, which marks a press inside the menu as not outside. */
  className: string
  items: readonly SplitMenuItem<T>[]
  checked: T | undefined
  onPick: (value: T) => void
}) {
  return (
    <ContextMenu
      at={at}
      onClose={close}
      portal
      label={label}
      className={className}
      dismissOnOutside={false}
      onKeyDown={moveFocus}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="menuitemradio"
          aria-checked={checked === item.value}
          className="context-menu__item"
          data-value={item.value}
          disabled={item.disabled}
          title={item.title}
          onClick={() => {
            close()
            onPick(item.value)
          }}
        >
          {item.label}
          <span aria-hidden="true">{checked === item.value ? '✓' : ''}</span>
        </button>
      ))}
    </ContextMenu>
  )
}

/** Up and down move between the menu's rows, as in any menu. */
function moveFocus(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]:enabled',
    ),
  ]
  if (rows.length === 0) return
  const at = rows.indexOf(document.activeElement as HTMLButtonElement)
  const step = event.key === 'ArrowDown' ? 1 : -1
  rows[(at + step + rows.length) % rows.length]!.focus()
}
