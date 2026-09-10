/**
 * Keyboard navigation for a search-and-list modal.
 *
 * The three pieces — an active index that resets when the results change, `scrollIntoView` on
 * the active row, and a `step` that wraps — were written out in
 * `NodeBrowser`, again in `CommandPalette`, and a third time in `ZooBrowser`. Same shape as
 * `useDismiss`, whose own docstring records that a popover behaviour written five times meant a
 * fix reached exactly one popover at a time.
 *
 * Escape is the modal's (`useOverlayEscape`), not the list's: a list that took the key itself
 * was a surface off the stack, and closed the viewer under a browser opened over it.
 *
 * The `listRef` goes on the scrolling container: the hook finds the active row by
 * `[aria-selected="true"]` inside it, which is the attribute those lists already carry for
 * screen readers, so nothing has to be wired up twice.
 */

import { useEffect, useRef, useState } from 'react'

export interface ListNav {
  activeIndex: number
  setActiveIndex: (index: number) => void
  /** Move by one, wrapping. A no-op on an empty list rather than an index of -1. */
  step: (direction: 1 | -1) => void
  listRef: React.RefObject<HTMLDivElement | null>
  /** ArrowUp/ArrowDown wired to `step`; returns true when the key was handled. */
  onKeyDown: (event: React.KeyboardEvent) => boolean
}

export function useListNav(count: number, resetKey: unknown): ListNav {
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => setActiveIndex(0), [resetKey])

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const step = (direction: 1 | -1) => {
    setActiveIndex((current) => (count === 0 ? 0 : (current + direction + count) % count))
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
