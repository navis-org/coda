import { useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import type { TableValue } from '../../core/values'
import { encodeRange } from '../../nodes/lib/chartSelection'
import {
  CHART_INK,
  SURFACE_GAP,
  chartSurface,
  currentMode,
  seriesColor,
} from '../colors'
import { exportBaseName as makeBaseName, tableToCsvParts } from '../export'
import { formatCompact, formatNumber, labelStep, niceTicks, plural } from '../format'
import type { HistogramBar, Normalize } from './histogramBins'
import { binScan, normalizeLabel, scanValues } from './histogramBins'
import { isAdditive, useMarkSelection } from './useMarkSelection'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { tooltipPoint } from './tooltipPoint'
import { useElementSize } from './useElementSize'

export interface HistogramViewerProps {
  table: TableValue
  valueColumn: string
  seriesColumn?: string
  binMode?: 'auto' | 'fixed'
  bins?: number
  log?: boolean
  normalize?: Normalize
  cumulative?: boolean
  /** Encoded value ranges — see `chartSelection.ts`. */
  selection?: string[]
  onSelectionChange?: (ids: string[]) => void
  compact?: boolean
  /** Filename stem for CSV/SVG/PNG export. */
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

interface Hover {
  bar: number
  segment: number
  x: number
  y: number
}

/**
 * Vertical histogram, optionally stacked and clickable.
 *
 * **Vertical, where the Bar Chart beside it is horizontal, and the difference is not taste.**
 * A bar chart's categories are ROI and cell-type names, which need rotated labels as columns;
 * a histogram's axis is a *number line*, and a number line that runs downwards is not a thing
 * anybody reads. The value axis has to be the x axis or the picture stops being a histogram.
 *
 * All the arithmetic is in `histogramBins.ts` — jsdom has no layout, so anything left here is
 * covered by nothing. What is left here is marks, hit areas and the tooltip.
 */
export function HistogramViewer({
  table,
  valueColumn,
  seriesColumn,
  binMode = 'auto',
  bins = 30,
  log = false,
  normalize = 'count',
  cumulative = false,
  selection,
  onSelectionChange,
  compact = false,
  baseName,
  onExpand,
  onError,
}: HistogramViewerProps) {
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

  // Two memos, not one: nothing about a bin count or a scaling changes which rows are
  // plottable, and `bins` is a scrub field that fires per pointer-move. See `scanValues`.
  const scan = useMemo(
    () => scanValues(table, valueColumn, seriesColumn, log),
    [table, valueColumn, seriesColumn, log],
  )
  const histogram = useMemo(
    () => binScan(scan, { binMode, bins, normalize, cumulative }),
    [scan, binMode, bins, normalize, cumulative],
  )

  /*
   * Membership is tested against the exact string a bar encodes to, so a bar's selected state
   * survives a change to the bin count as a plain miss rather than as a wrong hit.
   */
  const marks = useMarkSelection(selection, onSelectionChange)

  const { bars, series, max, dropped, used } = histogram

  if (bars.length === 0) {
    return (
      <div className="viewer">
        <div className="viewer__empty">
          {dropped > 0
            ? `Nothing to plot — no usable ${log ? 'positive ' : ''}numbers in "${valueColumn}"`
            : 'Nothing to plot — no rows'}
        </div>
      </div>
    )
  }

  const showLegend = series.length >= 2
  const axisHeight = compact ? 12 : 20
  const labelWidth = compact ? 26 : 40
  const topPad = 6
  const rightPad = 6

  const height = Math.max(60, size.height)
  const plotWidth = Math.max(10, size.width - labelWidth - rightPad)
  const plotHeight = Math.max(10, height - axisHeight - topPad)
  const ticks = niceTicks(max, plotHeight > 160 ? 4 : 2)
  const scaleMax = ticks.length > 1 ? ticks[ticks.length - 1]! : max || 1

  const yOf = (value: number): number => topPad + plotHeight - (value / scaleMax) * plotHeight
  const barWidth = plotWidth / bars.length
  const xOf = (index: number): number => labelWidth + index * barWidth
  // A hairline between neighbours, but never at the cost of the bar itself: below about 3px a
  // gap is most of the mark, and the picture becomes a comb rather than a distribution.
  const gap = barWidth > 6 ? 1 : 0

  const hovered = hover && bars[hover.bar] ? bars[hover.bar]! : null
  const hoveredSegment = hovered?.segments[hover!.segment]
  /*
   * Room per edge label, measured rather than estimated: `formatCompact(126.4)` is five glyphs
   * at ~5.6px, so 34px let two labels touch on a card. Seen in a browser — jsdom performs no
   * layout and cannot measure a text node.
   */
  const edgeStep = labelStep(bars.length + 1, plotWidth, compact ? 46 : 58)

  return (
    <div className="viewer">
      <div ref={ref} className="viewer__scroll nowheel" style={{ position: 'relative' }}>
        {size.width > 60 && (
          <svg ref={svgRef} className="chart" width={size.width} height={height} role="img">
            <title>{`Distribution of ${valueColumn}${seriesColumn ? `, split by ${seriesColumn}` : ''}`}</title>
            <rect width={size.width} height={height} fill={surface} />

            {/* Gridlines: hairline, solid, one step off surface, behind the data. */}
            {ticks.map((tick) => (
              <line
                key={`grid-${tick}`}
                x1={labelWidth}
                x2={labelWidth + plotWidth}
                y1={yOf(tick)}
                y2={yOf(tick)}
                stroke={ink.grid}
                strokeWidth={1}
              />
            ))}

            {bars.map((bar, index) => {
              const x = xOf(index)
              const width = Math.max(0.5, barWidth - gap)
              const key = encodeRange(bar)
              const isSelected = marks.has([key])
              // Dimming is the *unselected* state rather than a highlight on the selected one:
              // with nothing selected every bar is full strength, which is the common case.
              const dim = marks.size > 0 && !isSelected
              let cursor = 0

              return (
                <g
                  key={key}
                  {...(marks.writable
                    ? {
                        onClick: (event: ReactMouseEvent) => marks.toggle([key], isAdditive(event)),
                        style: { cursor: 'pointer' },
                      }
                    : {})}
                  onMouseMove={(event) =>
                    setHover({
                      bar: index,
                      segment: segmentAt(bar, event, yOf, ref.current),
                      // Container coordinates — see `tooltipPoint`.
                      ...tooltipPoint(event, ref.current),
                    })
                  }
                  onMouseLeave={() => setHover(null)}
                >
                  {/*
                    * A full-height hit area under each bar, so a short bar in a long tail is
                    * still clickable. Without it the tail — which is what somebody clicking a
                    * histogram is nearly always after — is a two-pixel target.
                    */}
                  <rect
                    x={x}
                    y={topPad}
                    width={Math.max(1, barWidth)}
                    height={plotHeight}
                    fill="transparent"
                  />
                  {bar.segments.map((segment, segmentIndex) => {
                    const base = cursor
                    cursor += segment.value
                    const isTop = segmentIndex === bar.segments.length - 1
                    const top = yOf(cursor)
                    // The 2px gap is surface showing through, taken off the top of every
                    // segment that has another one above it. Never a stroke.
                    const inset = isTop ? 0 : SURFACE_GAP
                    const segmentHeight = Math.max(0, yOf(base) - top - inset)
                    if (segmentHeight <= 0) return null
                    return (
                      <rect
                        key={segment.series}
                        x={x}
                        y={top + inset}
                        width={width}
                        height={segmentHeight}
                        fill={seriesColor(segment.colorIndex, mode)}
                        opacity={dim ? 0.35 : hover?.bar === index ? 0.85 : 1}
                      />
                    )
                  })}
                  {isSelected && (
                    <rect
                      x={x}
                      y={yOf(bar.total)}
                      width={width}
                      height={Math.max(0, yOf(0) - yOf(bar.total))}
                      fill="none"
                      stroke={ink.primary}
                      strokeWidth={1}
                    />
                  )}
                </g>
              )
            })}

            {/* The baseline the bars stand on. */}
            <line
              x1={labelWidth}
              x2={labelWidth + plotWidth}
              y1={yOf(0)}
              y2={yOf(0)}
              stroke={ink.axis}
              strokeWidth={1}
            />

            {ticks.map((tick) => (
              <text
                key={`tick-${tick}`}
                x={labelWidth - 4}
                y={yOf(tick)}
                fill={ink.muted}
                fontSize={9.5}
                textAnchor="end"
                dominantBaseline="central"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatCompact(tick)}
              </text>
            ))}

            {/*
              * Edge labels rather than one per bar: the ticks of a histogram are the *edges*,
              * and a label under the middle of a bar names a value the bar does not start at.
              */}
            {bars.map((bar, index) =>
              index % edgeStep === 0 ? (
                <text
                  key={`edge-${index}`}
                  x={xOf(index)}
                  y={height - 4}
                  fill={ink.muted}
                  fontSize={9.5}
                  textAnchor="middle"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatCompact(bar.lo)}
                </text>
              ) : null,
            )}
            <text
              x={labelWidth + plotWidth}
              y={height - 4}
              fill={ink.muted}
              fontSize={9.5}
              textAnchor="end"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatCompact(bars[bars.length - 1]!.hi)}
            </text>
          </svg>
        )}

        {hovered && (
          <div
            className="chart-tooltip"
            style={{ left: hover!.x + 12, top: hover!.y + 12 }}
            role="status"
          >
            <strong>
              {formatNumber(hovered.lo)} – {formatNumber(hovered.hi)}
            </strong>
            {hoveredSegment && seriesColumn && (
              <div className="chart-tooltip__row">
                <span
                  className="chart-tooltip__swatch"
                  style={{ background: seriesColor(hoveredSegment.colorIndex, mode) }}
                />
                {hoveredSegment.series}: {plural(hoveredSegment.count, 'row')}
              </div>
            )}
            <div className="chart-tooltip__row">
              {plural(hovered.count, 'row')}
              {used > 0 ? ` · ${((hovered.count / used) * 100).toFixed(1)}%` : ''}
            </div>
          </div>
        )}
      </div>

      {showLegend && (
        <div className="legend">
          {series.map((name, index) => (
            <span key={name} className="legend__item">
              <span className="legend__swatch" style={{ background: seriesColor(index, mode) }} />
              {name}
            </span>
          ))}
        </div>
      )}

      <div className="viewer__caption">
        <span>
          {valueColumn} · {normalizeLabel(normalize, cumulative)}
          {log ? ' · log' : ''}
        </span>
        <span>
          {plural(bars.length, 'bin')}
          {dropped > 0 ? ` · ${dropped} unplottable` : ''}
        </span>
        {marks.size > 0 && (
          <button
            type="button"
            className="legend__label nodrag"
            title="Clear the selection"
            onClick={marks.clear}
          >
            {plural(marks.size, 'bin')} selected ⨯
          </button>
        )}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'histogram')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}

/**
 * Which stacked segment the pointer is over.
 *
 * The segments share one hit area — a full-height rectangle, so a two-pixel bar in the tail is
 * still clickable — so the tooltip has to work out for itself which band the pointer is in.
 * Falls back to the topmost segment above the stack, which is what a pointer in the air over a
 * bar is nearest to.
 */
function segmentAt(
  bar: HistogramBar,
  event: ReactMouseEvent,
  yOf: (value: number) => number,
  container: HTMLElement | null,
): number {
  const y = tooltipPoint(event, container).y
  let cursor = 0
  for (let i = 0; i < bar.segments.length; i++) {
    cursor += bar.segments[i]!.value
    if (y >= yOf(cursor)) return i
  }
  return Math.max(0, bar.segments.length - 1)
}
