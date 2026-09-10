/**
 * The hover card a chart draws beside the pointer, and its rows.
 *
 * Written out in seven viewers first. What is easy to get wrong is not the markup but the
 * coordinates: `at` is what `tooltipPoint` hands back — relative to the tooltip's containing
 * block and divided by the canvas zoom — and `.chart-tooltip` is `position: absolute`, never
 * `fixed`, which `tooltipPoint.test.ts` holds the stylesheet to.
 */

import type { ReactNode } from 'react'

/** How far the card sits below and right of the pointer, in container px. */
const OFFSET = 12

export function ChartTooltip({
  at,
  children,
}: {
  /** The pointer, as `tooltipPoint` hands it back. */
  at: { x: number; y: number }
  children: ReactNode
}) {
  return (
    <div
      className="chart-tooltip"
      style={{ left: at.x + OFFSET, top: at.y + OFFSET }}
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
