import { useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import type { TableValue } from '../../core/values'
import { CHART_INK, chartSurface, currentMode, inkOn, seriesColor } from '../colors'
import { exportBaseName as makeBaseName, tableToCsvParts } from '../export'
import { formatCompact, formatNumber, plural } from '../format'
import { ClearSelection } from './LegendKeys'
import type { PieSlice } from './pieLayout'
import { arcPath, pieSlices, polar, tallyCategories } from './pieLayout'
import { isAdditive, useMarkSelection } from './useMarkSelection'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { tooltipPoint } from './tooltipPoint'
import { useElementSize } from './useElementSize'

export interface PieViewerProps {
  table: TableValue
  categoryColumn: string
  /** Summed per category; omitted counts rows instead. */
  valueColumn?: string
  shape?: 'pie' | 'donut'
  sortSlices?: boolean
  maxSlices?: number
  sliceLabels?: 'percent' | 'value' | 'none'
  /** Category labels — see `chartSelection.ts`. */
  selection?: string[]
  onSelectionChange?: (ids: string[]) => void
  compact?: boolean
  /** Filename stem for CSV/SVG/PNG export. */
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/**
 * What a slice stands for, as labels.
 *
 * The residual hands back everything folded into it rather than the word `Other`, because the
 * fold depends on `maxSlices` — which is `presentational`, so nothing would re-run if it
 * changed and a stored `"Other"` would quietly come to mean a different set of rows.
 */
function labelsOf(slice: PieSlice): string[] {
  return slice.folded ?? [slice.label]
}

interface Hover {
  slice: number
  x: number
  y: number
}

/** How much of the radius the hole takes. A ring thinner than this stops reading as an arc. */
const DONUT_INNER = 0.58
/** A slice narrower than this cannot hold a label, so it does not get one. */
const MIN_LABEL_SWEEP = 0.28

/**
 * Pie and donut, with clickable slices.
 *
 * The layout is in `pieLayout.ts` — headless, because jsdom has no layout and the angles are
 * the part worth testing. What is here is marks, the label-fits rule, and the tooltip.
 *
 * **A selected slice pulls out of the ring rather than changing colour.** Colour is already the
 * categorical channel and every slice is using it; a "selected" hue would either collide with a
 * category's or say two different things at once. Displacement is the free channel, and it is
 * the gesture people already expect from a pie.
 */
export function PieViewer({
  table,
  categoryColumn,
  valueColumn,
  shape = 'donut',
  sortSlices = true,
  maxSlices = 8,
  sliceLabels = 'percent',
  selection,
  onSelectionChange,
  compact = false,
  baseName,
  onExpand,
  onError,
}: PieViewerProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<Hover | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const mode = currentMode()
  const ink = CHART_INK[mode]
  const surface = chartSurface(mode)

  const exportSource: ExportSource = useMemo(
    () => ({ csv: () => tableToCsvParts(table), svg: () => svgRef.current }),
    [table],
  )

  // Two memos, not one: the tally is the only O(rows) half, and neither the slice cap nor the
  // sort changes it. `maxSlices` is a scrub field that fires per pointer-move.
  const tally = useMemo(
    () => tallyCategories(table, categoryColumn, valueColumn),
    [table, categoryColumn, valueColumn],
  )
  const layout = useMemo(
    () => pieSlices(tally.totals, { maxSlices, sort: sortSlices, dropped: tally.dropped }),
    [tally, maxSlices, sortSlices],
  )

  const marks = useMarkSelection(selection, onSelectionChange)
  /*
   * Resolved once per layout rather than per slice per render. The residual's `labelsOf` is
   * *every* folded category, which on a `type` column is thousands of strings — and the
   * predicate was being run twice over, in the ring and again in the legend, on every store
   * tick and every pan.
   */
  const isSelected = useMemo(() => {
    const flags = new Map(layout.slices.map((slice) => [slice.label, marks.has(labelsOf(slice))]))
    return (slice: PieSlice) => flags.get(slice.label) ?? false
  }, [layout, marks])

  const { slices, total, categoryCount, dropped } = layout

  if (slices.length === 0) {
    return (
      <div className="viewer">
        <div className="viewer__empty">
          {dropped > 0
            ? `Nothing to plot — every value in "${valueColumn}" was negative or unreadable`
            : 'Nothing to plot — no rows'}
        </div>
      </div>
    )
  }

  const width = size.width
  const height = Math.max(60, size.height)
  // The pull-out needs room outside the ring, so the radius leaves it rather than being
  // clipped by the box the moment somebody clicks.
  const pull = compact ? 3 : 5
  const radius = Math.max(8, Math.min(width, height) / 2 - pull - (compact ? 4 : 10))
  const cx = width / 2
  const cy = height / 2
  const inner = shape === 'donut' ? radius * DONUT_INNER : 0

  const hovered = hover ? slices[hover.slice] : undefined

  return (
    <div className="viewer">
      <div ref={ref} className="viewer__scroll nowheel" style={{ position: 'relative' }}>
        {width > 60 && (
          <svg ref={svgRef} className="chart" width={width} height={height} role="img">
            <title>{`${valueColumn ?? 'Rows'} by ${categoryColumn}`}</title>
            <rect width={width} height={height} fill={surface} />

            {slices.map((slice, index) => {
              const picked = isSelected(slice)
              const dim = marks.size > 0 && !picked
              // Displaced along the slice's own bisector, which is the direction a slice
              // "comes out" in. `polar` already answers in screen coordinates, so this is a
              // delta to add.
              const offset = picked
                ? polar(0, 0, pull, (slice.start + slice.end) / 2)
                : { x: 0, y: 0 }
              const mid = (slice.start + slice.end) / 2
              const sweep = slice.end - slice.start
              const labelText =
                sliceLabels === 'none' || sweep < MIN_LABEL_SWEEP
                  ? ''
                  : sliceLabels === 'value'
                    ? formatCompact(slice.value)
                    : `${Math.round(slice.fraction * 100)}%`
              const fill = seriesColor(slice.colorIndex, mode)
              // Labels sit on the band, so they take ink chosen against the fill rather than
              // against the surface — the one place text is drawn on a filled mark.
              const labelRadius = inner > 0 ? (radius + inner) / 2 : radius * 0.66
              const at = polar(cx + offset.x, cy + offset.y, labelRadius, mid)

              return (
                <g
                  key={slice.label}
                  {...(marks.writable
                    ? {
                        onClick: (event: ReactMouseEvent) =>
                          marks.toggle(labelsOf(slice), isAdditive(event)),
                        style: { cursor: 'pointer' },
                      }
                    : {})}
                  onMouseMove={(event) =>
                    setHover({ slice: index, ...tooltipPoint(event, ref.current) })
                  }
                  onMouseLeave={() => setHover(null)}
                >
                  <path
                    d={arcPath(
                      cx + offset.x,
                      cy + offset.y,
                      radius,
                      inner,
                      slice.start,
                      slice.end,
                    )}
                    fill={fill}
                    opacity={dim ? 0.35 : hover?.slice === index ? 0.85 : 1}
                    // Surface between neighbours rather than a stroke in some other colour:
                    // the 2px gap rule, drawn the only way an arc can carry it.
                    stroke={surface}
                    strokeWidth={1.5}
                  />
                  {labelText && (
                    <text
                      x={at.x}
                      y={at.y}
                      fill={inkOn(fill)}
                      fontSize={compact ? 9 : 10}
                      textAnchor="middle"
                      dominantBaseline="central"
                      style={{ fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}
                    >
                      {labelText}
                    </text>
                  )}
                </g>
              )
            })}

            {/* The hole is where the total goes — the one number a pie otherwise never states. */}
            {inner > 0 && radius > 46 && (
              <>
                <text
                  x={cx}
                  y={cy - 5}
                  fill={ink.primary}
                  fontSize={Math.min(18, inner * 0.5)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatCompact(total)}
                </text>
                <text
                  x={cx}
                  y={cy + 9}
                  fill={ink.muted}
                  fontSize={9.5}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {/*
                    * "total" rather than "rows" when nothing is summed: the number in the hole
                    * is the whole the slices are shares *of*, and naming the unit invites it to
                    * be read as one more count beside the per-slice ones.
                    */}
                  {valueColumn ? `${valueColumn} total` : 'total'}
                </text>
              </>
            )}
          </svg>
        )}

        {hovered && (
          <div
            className="chart-tooltip"
            style={{ left: hover!.x + 12, top: hover!.y + 12 }}
            role="status"
          >
            <strong>{hovered.label}</strong>
            <div className="chart-tooltip__row">
              <span
                className="chart-tooltip__swatch"
                style={{ background: seriesColor(hovered.colorIndex, mode) }}
              />
              {formatNumber(hovered.value)} · {(hovered.fraction * 100).toFixed(1)}%
            </div>
            {hovered.folded && (
              <div className="chart-tooltip__row">
                {plural(hovered.folded.length, 'category', 'categories')}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="legend">
        {slices.map((slice) => (
          <span
            key={slice.label}
            className="legend__item"
            data-selected={isSelected(slice) || undefined}
          >
            <span
              className="legend__swatch"
              style={{ background: seriesColor(slice.colorIndex, mode) }}
            />
            {marks.writable ? (
              <button
                type="button"
                className="legend__label nodrag"
                aria-pressed={isSelected(slice)}
                title={`Select every ${slice.label} row`}
                onClick={(event) => marks.toggle(labelsOf(slice), isAdditive(event))}
              >
                {slice.label}
              </button>
            ) : (
              slice.label
            )}
          </span>
        ))}
      </div>

      <div className="viewer__caption">
        <span>
          {valueColumn ?? 'rows'} by {categoryColumn}
        </span>
        <span>
          {categoryCount > slices.length
            ? `${slices.length - 1} of ${plural(categoryCount, 'category', 'categories')}`
            : plural(categoryCount, 'category', 'categories')}
          {dropped > 0 ? ` · ${dropped} unplottable` : ''}
        </span>
        {marks.size > 0 && (
          <ClearSelection
            label={`${plural(marks.size, 'category', 'categories')} selected`}
            onClear={marks.clear}
          />
        )}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'pie-chart')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}
