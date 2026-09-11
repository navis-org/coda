/**
 * Keyboard navigation for a search-and-list modal.
 *
 * The three pieces — an active index that resets when the results change, `scrollIntoView` on
 * the active row, and a `step` that wraps — were written out in
 * `NodeBrowser`, again in `CommandPalette`, and a third time in `ZooBrowser`. Same shape as
 * `useDismiss`, whose own docstring records that a popover behaviour written five times meant a
 * fix reached exactly one popover at a time.
 *
 * The palette's rows can be disabled, which is `skip`: the active row lands on the first usable one
 * and the arrows step over the rest — the one difference that had kept it on its own copy.
 *
 * Escape is the modal's (`useOverlayEscape`), not the list's: a list that took the key itself
 * was a surface off the stack, and closed the viewer under a browser opened over it.
 *
 * The `listRef` goes on the scrolling container: the hook finds the active row by
 * `[aria-selected="true"]` inside it, which is the attribute those lists already carry for
 * screen readers, so nothing has to be wired up twice.
 */

import { useEffect, useRef, useState } from 'react'

import { useLatest } from './useLatest'

export interface ListNav {
  activeIndex: number
  setActiveIndex: (index: number) => void
  /** Move by one, wrapping, over any row `skip` refuses. A no-op on an empty list. */
  step: (direction: 1 | -1) => void
  listRef: React.RefObject<HTMLDivElement | null>
  /** ArrowUp/ArrowDown wired to `step`; returns true when the key was handled. */
  onKeyDown: (event: React.KeyboardEvent) => boolean
}

export function useListNav(
  count: number,
  resetKey: unknown,
  skip?: (index: number) => boolean,
): ListNav {
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  // Read at the reset rather than listed: a caller's `skip` is an inline arrow over this render's
  // rows, and the reset belongs to `resetKey` alone.
  const latest = useLatest({ count, skip })

  useEffect(() => {
    const { count, skip } = latest.current
    let first = 0
    while (skip && first < count && skip(first)) first += 1
    setActiveIndex(first < count ? first : 0)
  }, [resetKey, latest])

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const step = (direction: 1 | -1) => {
    setActiveIndex((current) => {
      for (let offset = 1; offset <= count; offset++) {
        const next = (((current + direction * offset) % count) + count) % count
        if (!skip?.(next)) return next
      }
      return current
    })
  }

  return {
    activeIndex,
    setActiveIndex,
    step,
    listRef,
    onKeyDown: (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        step(1)
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        step(-1)
        return true
      }
      return false
    },
  }
}
