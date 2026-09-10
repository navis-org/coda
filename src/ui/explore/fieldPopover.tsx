/**
 * What Explore's two field popovers share — the column editor and the header's `+` menu.
 *
 * Written twice first, and the copies drifted within a day: the `+` menu clamped its position
 * against a 440px height while wearing the class whose `max-height` is 520, so a tall menu hung
 * past the bottom of the window. One position rule, one key rule, one filter.
 */

import type React from 'react'

/** Mirrors `.explore-colmenu`'s width and `max-height` — the box the position is clamped for. */
const WIDTH = 264
const MAX_HEIGHT = 520
const MARGIN = 4

/**
 * Hung below its anchor's left edge and kept inside the window.
 *
 * `documentElement.clientWidth`, never `window.innerWidth` — `RowContextMenu` records why.
 */
export function popoverStyle(anchor: { left: number; bottom: number }): React.CSSProperties {
  const width = document.documentElement.clientWidth
  const height = document.documentElement.clientHeight
  return {
    left: Math.max(MARGIN, Math.min(anchor.left, width - WIDTH - MARGIN)),
    top: Math.max(MARGIN, Math.min(anchor.bottom + MARGIN, height - MAX_HEIGHT)),
  }
}

/**
 * Every key but Escape stops at the popover, as the search box's do: the canvas binds Space and
 * Backspace, and a field filter is somewhere people type both. Escape is let through because it is
 * the dismissal's own key, heard at the window.
 */
export function stopCanvasKeys(event: React.KeyboardEvent): void {
  if (event.key !== 'Escape') event.stopPropagation()
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
