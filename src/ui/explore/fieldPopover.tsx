/**
 * What Explore's two field popovers share — the column editor and the header's `+` menu.
 *
 * Written twice first, and the copies drifted within a day: the `+` menu clamped its position
 * against a 440px height while wearing the class whose `max-height` is 520, so a tall menu hung
 * past the bottom of the window. One position rule, one key rule, one filter.
 */

import type { ReactNode } from 'react'

import { ContextMenu } from '../menu/ContextMenu'

/** The gap below the anchor, and the margin kept from the window's edge. */
const MARGIN = 4

/**
 * A field popover: a `ContextMenu` hung under its anchor's left edge, holding fields rather than
 * commands. `ContextMenu` keeps it inside the window by measuring its own box, where this used to
 * clamp against a width and a `max-height` typed here to mirror the stylesheet — the copy of a
 * size that had already drifted once.
 *
 * Every key stops at it, as the search box's do: the canvas binds Space and Backspace, and a field
 * filter is somewhere people type both. Escape included — the popover's own Escape is
 * `useOverlayEscape`'s, on the window's capture phase, which has run before this sees the key.
 */
export function FieldPopover({
  anchor,
  label,
  className,
  onClose,
  children,
}: {
  anchor: { left: number; bottom: number }
  label: string
  className: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu
      at={{ x: anchor.left, y: anchor.bottom + MARGIN }}
      onClose={onClose}
      className={className}
      role="dialog"
      label={label}
      margin={MARGIN}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </ContextMenu>
  )
}

/** The items whose name contains the filter, case-insensitively; all of them for an empty one. */
export function matching<T>(
  items: readonly T[],
  filter: string,
  nameOf: (item: T) => string,
): readonly T[] {
  const needle = filter.trim().toLowerCase()
  return needle ? items.filter((item) => nameOf(item).toLowerCase().includes(needle)) : items
}

export function FilterInput({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <input
      className="explore-colmenu__filter"
      type="text"
      value={value}
      placeholder="Filter fields…"
      aria-label="Filter fields"
      spellCheck={false}
      autoComplete="off"
      autoFocus
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function NoMatch({ filter }: { filter: string }) {
  return <div className="explore-colmenu__none">No field matches “{filter}”</div>
}

/** A field's kind — `#` for a number, `Aa` for text — or, where given, its place in a merge. */
export function KindBadge({
  numeric,
  order,
}: {
  numeric: boolean
  order?: number | undefined
}) {
  return (
    <span className="explore-colmenu__kind" title={numeric ? 'A number' : 'Text'}>
      {order ?? (numeric ? '#' : 'Aa')}
    </span>
  )
}
