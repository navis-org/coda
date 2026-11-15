/**
 * A long list that draws only the rows in view.
 *
 * For a scrolling list of **equal-height** rows: the caller draws `rows.start … rows.end` between
 * two spacers of `rows.before` and `rows.after` pixels, so the scrollbar is the whole list's and
 * only a screenful (plus a margin) is in the DOM. Written for Review Suggestions, whose queue is
 * hundreds of rows per tip and tens of thousands per candidate, each holding six buttons.
 *
 * **Spacer elements, not padding**, because `ResizeObserver` reports the content box — padding
 * standing in for the off-screen rows would be subtracted from the viewport it measures.
 *
 * **`offsetHeight`, not `getBoundingClientRect`**: a card on the canvas sits inside React Flow's
 * zoom transform, which scales a bounding rect but not the layout size `scrollTop` is counted in.
 *
 * The row height is read off the first drawn row (`[data-row]`) rather than declared here, so
 * the stylesheet's fixed height is the one number. jsdom has no layout and reads 0; the estimate
 * stands there, which is fine for a test that draws a handful of rows.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { UIEvent } from 'react'

/** The rows to draw, and the space standing in for the rest. */
export interface RowWindow {
  /** First row drawn, inclusive. */
  readonly start: number
  /** Last row drawn, exclusive. */
  readonly end: number
  /** Pixels of spacer above the first drawn row. */
  readonly before: number
  /** Pixels of spacer below the last drawn row. */
  readonly after: number
}

/** Rows drawn beyond each edge of the view, so a quick scroll does not show blank space. */
const OVERSCAN = 10

/** Used until a row has been measured: `.review-row`'s fixed height. Wrong is only slower. */
const ESTIMATED_ROW_PX = 47

/** Used until the list has been measured, and in jsdom. Generous rather than empty. */
const FALLBACK_VIEWPORT_PX = 800

/** Which rows a list of `count` rows, scrolled to `scrollTop`, should draw. */
export function rowWindow(
  count: number,
  rowHeight: number,
  scrollTop: number,
  viewport: number,
  overscan = OVERSCAN,
): RowWindow {
  const height = rowHeight > 0 ? rowHeight : ESTIMATED_ROW_PX
  const inView = Math.ceil(viewport / height)
  /*
   * Held to the last screenful: a list that just got shorter (a filter, a switch of neuron) can
   * still be scrolled past its new end until the browser clamps `scrollTop`, and an unheld first
   * row past the end draws nothing at all for that frame.
   */
  const first = Math.min(
    Math.floor(Math.max(0, scrollTop) / height),
    Math.max(0, count - inView),
  )
  const start = Math.max(0, first - overscan)
  const end = Math.min(count, first + inView + overscan)
  return {
    start,
    end: Math.max(start, end),
    before: start * height,
    after: Math.max(0, count - Math.max(start, end)) * height,
  }
}

export function useRowWindow(count: number) {
  const [list, setList] = useState<HTMLElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const [rowHeight, setRowHeight] = useState(ESTIMATED_ROW_PX)

  useEffect(() => {
    if (!list) return
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height
      if (height) setViewport(height)
    })
    observer.observe(list)
    return () => observer.disconnect()
  }, [list])

  // After every render, because a row is only there to measure once something is drawn.
  useLayoutEffect(() => {
    const row = list?.querySelector<HTMLElement>('[data-row]')
    const height = row?.offsetHeight
    if (height && Math.abs(height - rowHeight) > 0.5) setRowHeight(height)
  })

  const onScroll = useCallback((event: UIEvent<HTMLElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  /** Back to the first row — for when the list is replaced by a different one. */
  const toTop = useCallback(() => {
    if (list) list.scrollTop = 0
    setScrollTop(0)
  }, [list])

  return {
    ref: setList,
    onScroll,
    toTop,
    rows: rowWindow(count, rowHeight, scrollTop, viewport || FALLBACK_VIEWPORT_PX),
  }
}
