/**
 * The hover card a chart draws beside the pointer, and its rows.
 *
 * Written out in seven viewers first. What is easy to get wrong is not the markup but the
 * coordinates: `at` is what `tooltipPoint` hands back — relative to the tooltip's containing
 * block and divided by the canvas zoom — and `.chart-tooltip` is `position: absolute`, never
 * `fixed`, which `tooltipPoint.test.ts` holds the stylesheet to.
 */

import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

import { TOOLTIP_OFFSET, tooltipPlacement } from './tooltipPoint'

export function ChartTooltip({
  at,
  children,
}: {
  /** The pointer, as `tooltipPoint` hands it back. */
  at: { x: number; y: number }
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  /*
   * The fit, corrected before paint.
   *
   * `useLayoutEffect` and a direct style write rather than state, because this runs on **every
   * pointer move**: a `setState` here would be a second render per move for a card that has
   * already been positioned, and the flash a two-pass placement causes is exactly what a layout
   * effect exists to avoid. React's own `left`/`top` below are the naive position, which is
   * where the card belongs whenever there is room and is what a zero measurement falls back to.
   *
   * `offsetParent` is the containing block by definition, which is the one thing that must not
   * be guessed at: `.chart-tooltip` is positioned against `.viewer` or `.viewer__scroll`
   * depending on the viewer, and measuring the wrong one flips the card at the wrong moment.
   */
  useLayoutEffect(() => {
    const node = ref.current
    const parent = node?.offsetParent
    if (!node || !(parent instanceof HTMLElement)) return
    const placed = tooltipPlacement({
      x: at.x,
      y: at.y,
      width: node.offsetWidth,
      height: node.offsetHeight,
      containerWidth: parent.clientWidth,
      containerHeight: parent.clientHeight,
    })
    node.style.left = `${placed.x}px`
    node.style.top = `${placed.y}px`
    // Keyed on the pointer, so a parent re-render that did not move it costs no forced layout —
    // and reading `offsetWidth` here is a synchronous layout of a document holding the whole
    // chart. The card's own size changes only with its content, which changes with the pointer.
  }, [at.x, at.y])

  return (
    <div
      ref={ref}
      className="chart-tooltip"
      style={{ left: at.x + TOOLTIP_OFFSET, top: at.y + TOOLTIP_OFFSET }}
      role="status"
    >
      {children}
    </div>
  )
}

/** One line of a tooltip, led by the mark's colour when it has one. */
export function TooltipRow({ swatch, children }: { swatch?: string; children?: ReactNode }) {
  return (
    <div className="chart-tooltip__row">
      {swatch !== undefined && (
        <span className="chart-tooltip__swatch" style={{ background: swatch }} />
      )}
      {children}
    </div>
  )
}
