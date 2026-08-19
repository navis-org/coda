import { useMemo, useRef, useState } from 'react'

import type { TableValue } from '../../core/values'
import {
  CHART_INK,
  MAX_BAR_THICKNESS,
  MAX_SERIES,
  OTHER_LABEL,
  SURFACE_GAP,
  chartSurface,
  currentMode,
  seriesColor,
} from '../colors'
import { exportBaseName as makeBaseName, tableToCsvParts } from '../export'
import { formatCompact, formatNumber, niceTicks, truncateLabel } from '../format'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { useElementSize } from './useElementSize'

export interface BarChartViewerProps {
  table: TableValue
  categoryColumn: string
  valueColumn: string
  seriesColumn?: string
  sortBars?: boolean
  compact?: boolean
  /** Filename stem for CSV/SVG/PNG export. */
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

interface Segment {
  series: string
  value: number
  colorIndex: number
}

interface Bar {
  category: string
  total: number
  segments: Segment[]
}

interface Hover {
  bar: number
  segment: number
  x: number
  y: number
}

/**
 * Horizontal bar chart, optionally stacked.
 *
 * Horizontal rather than vertical because the categories here are ROI and cell-type names
 * — long strings that would need rotated tick labels as columns.
 *
 * Mark specs applied: bars capped at 24px (the band's leftover is air), 4px rounded
 * data-end with a square baseline, a 2px surface gap between stacked segments, values at
 * the tip only when they fit, and a legend whenever there are two or more series.
 */
export function BarChartViewer({
  table,
  categoryColumn,
  valueColumn,
  seriesColumn,
  sortBars = true,
  compact = false,
  baseName,
  onExpand,
  onError,
}: BarChartViewerProps) {
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

  const { bars, series, max } = useMemo(
    () => aggregate(table, categoryColumn, valueColumn, seriesColumn, sortBars),
    [table, categoryColumn, valueColumn, seriesColumn, sortBars],
  )

  if (bars.length === 0) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Nothing to plot — no rows after aggregation</div>
      </div>
    )
  }

  const showLegend = series.length >= 2
  const labelWidth = compact
    ? Math.min(72, Math.max(28, longest(bars.map((b) => b.category)) * 5.6 + 6))
    : Math.min(120, Math.max(40, longest(bars.map((b) => b.category)) * 6 + 8))
  const axisHeight = compact ? 0 : 16
  const rightPad = 40

  const bandHeight = Math.max(14, Math.min(30, MAX_BAR_THICKNESS + 6))
  const contentHeight = bars.length * bandHeight + axisHeight + 6
  const height = Math.max(size.height, contentHeight)
  const plotWidth = Math.max(10, size.width - labelWidth - rightPad)
  const ticks = axisHeight > 0 ? niceTicks(max, plotWidth > 240 ? 4 : 2) : []
  const scaleMax = ticks.length > 1 ? ticks[ticks.length - 1]! : max || 1
  const barThickness = Math.min(MAX_BAR_THICKNESS, bandHeight - 6)

  const xOf = (value: number): number => labelWidth + (value / scaleMax) * plotWidth

  const hovered =
    hover && bars[hover.bar]
      ? {
          bar: bars[hover.bar]!,
          segment: bars[hover.bar]!.segments[hover.segment],
        }
      : null

  return (
    <div className="viewer">
      <div ref={ref} className="viewer__scroll nowheel" style={{ position: 'relative' }}>
        {size.width > 60 && (
          <svg ref={svgRef} className="chart" width={size.width} height={height} role="img">
            <title>{`${valueColumn} by ${categoryColumn}${seriesColumn ? `, stacked by ${seriesColumn}` : ''}`}</title>
            <rect width={size.width} height={height} fill={surface} />

            {/* Gridlines: hairline, solid, one step off surface, behind the data. */}
            {ticks.map((tick) => (
              <line
                key={`grid-${tick}`}
                x1={xOf(tick)}
                x2={xOf(tick)}
                y1={0}
                y2={height - axisHeight}
                stroke={ink.grid}
                strokeWidth={1}
              />
            ))}
            {/* Baseline the bars grow from. */}
            <line
              x1={labelWidth}
              x2={labelWidth}
              y1={0}
              y2={height - axisHeight}
              stroke={ink.axis}
              strokeWidth={1}
            />

            {bars.map((bar, barIndex) => {
              const bandTop = barIndex * bandHeight + 3
              const y = bandTop + (bandHeight - 6 - barThickness) / 2
              let cursor = 0
              const tipX = xOf(bar.total)
              const labelText = formatCompact(bar.total)
              // Only draw the tip value when there is room outside the bar end.
              const tipFits = tipX + 4 + labelText.length * 5.6 <= size.width - 2

              return (
                <g key={bar.category}>
                  {bar.segments.map((segment, segmentIndex) => {
                    const startX = xOf(cursor)
                    cursor += segment.value
                    const endX = xOf(cursor)
                    const isLast = segmentIndex === bar.segments.length - 1
                    // The 2px gap is surface showing through between segments.
                    const width = Math.max(0, endX - startX - (isLast ? 0 : SURFACE_GAP))
                    if (width <= 0) return null
                    const isHovered =
                      hover?.bar === barIndex && hover?.segment === segmentIndex
                    return (
                      <path
                        key={segment.series}
                        d={barPath(startX, y, width, barThickness, isLast ? 4 : 0)}
                        fill={seriesColor(segment.colorIndex, mode)}
                        opacity={hover && !isHovered ? 0.72 : 1}
                        onMouseMove={(e) =>
                          setHover({
                            bar: barIndex,
                            segment: segmentIndex,
                            x: e.clientX,
                            y: e.clientY,
                          })
                        }
                        onMouseLeave={() => setHover(null)}
                      />
                    )
                  })}

                  <text
                    x={labelWidth - 5}
                    y={y + barThickness / 2}
                    fill={ink.secondary}
                    fontSize={10}
                    textAnchor="end"
                    dominantBaseline="central"
                  >
                    {truncateLabel(bar.category, labelWidth - 8)}
                  </text>

                  {tipFits && (
                    <text
                      x={tipX + 4}
                      y={y + barThickness / 2}
                      fill={ink.secondary}
                      fontSize={10}
                      dominantBaseline="central"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {labelText}
                    </text>
                  )}
                </g>
              )
            })}

            {ticks.map((tick) => (
              <text
                key={`tick-${tick}`}
                x={xOf(tick)}
                y={height - 4}
                fill={ink.muted}
                fontSize={9.5}
                textAnchor="middle"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatCompact(tick)}
              </text>
            ))}
          </svg>
        )}

        {hovered?.segment && (
          <div className="chart-tooltip" style={{ left: hover!.x + 12, top: hover!.y + 12 }} role="status">
            <strong>{hovered.bar.category}</strong>
            <div className="chart-tooltip__row">
              <span
                className="chart-tooltip__swatch"
                style={{ background: seriesColor(hovered.segment.colorIndex, mode) }}
              />
              {seriesColumn ? `${hovered.segment.series}: ` : ''}
              {formatNumber(hovered.segment.value)}
            </div>
            {seriesColumn && (
              <div className="chart-tooltip__row">total {formatNumber(hovered.bar.total)}</div>
            )}
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
          {valueColumn} by {categoryColumn}
        </span>
        <span>{bars.length} bars</span>
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'bar-chart')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function longest(values: string[]): number {
  return values.reduce((m, v) => Math.max(m, v.length), 0)
}

/**
 * Horizontal bar path: square at the baseline (left), rounded at the data end (right).
 * A plain `rx` would round the baseline too, detaching the bar from the axis.
 */
function barPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, height / 2, width))
  if (r === 0) return `M${x},${y}h${width}v${height}h${-width}Z`
  return [
    `M${x},${y}`,
    `H${x + width - r}`,
    `A${r},${r} 0 0 1 ${x + width},${y + r}`,
    `V${y + height - r}`,
    `A${r},${r} 0 0 1 ${x + width - r},${y + height}`,
    `H${x}`,
    'Z',
  ].join(' ')
}

/**
 * Collapse the table into bars.
 *
 * Series past slot 8 fold into a single "Other" bucket rather than cycling hues — a 9th
 * colour would repeat an earlier one and quietly imply two series are the same thing.
 */
function aggregate(
  table: TableValue,
  categoryColumn: string,
  valueColumn: string,
  seriesColumn: string | undefined,
  sortBars: boolean,
): { bars: Bar[]; series: string[]; max: number } {
  const categories = table.data[categoryColumn]
  const values = table.data[valueColumn]
  if (!categories || !values) return { bars: [], series: [], max: 0 }
  const seriesData = seriesColumn ? table.data[seriesColumn] : undefined

  const totals = new Map<string, Map<string, number>>()
  const seriesTotals = new Map<string, number>()

  for (let i = 0; i < table.length; i++) {
    const category = label(categories[i])
    const seriesName = seriesData ? label(seriesData[i]) : ''
    const raw = Number(values[i] ?? 0)
    const value = Number.isFinite(raw) ? raw : 0

    const byCategory = totals.get(category) ?? new Map<string, number>()
    byCategory.set(seriesName, (byCategory.get(seriesName) ?? 0) + value)
    totals.set(category, byCategory)
    seriesTotals.set(seriesName, (seriesTotals.get(seriesName) ?? 0) + value)
  }

  // Rank series by magnitude, then cap. Colour follows the entity (its rank in this
  // ordering), and stays with it as long as the data doesn't change.
  const ranked = [...seriesTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  const kept = ranked.slice(0, MAX_SERIES)
  const folded = ranked.length > MAX_SERIES
  const colorOf = new Map(kept.map((name, index) => [name, index]))
  const seriesOrder = folded ? [...kept, OTHER_LABEL] : kept

  const bars: Bar[] = [...totals.entries()].map(([category, byCategory]) => {
    const segments: Segment[] = []
    let otherTotal = 0
    for (const name of kept) {
      const value = byCategory.get(name)
      if (value === undefined || value === 0) continue
      segments.push({ series: name, value, colorIndex: colorOf.get(name)! })
    }
    if (folded) {
      for (const [name, value] of byCategory) {
        if (!colorOf.has(name)) otherTotal += value
      }
      if (otherTotal > 0) {
        segments.push({ series: OTHER_LABEL, value: otherTotal, colorIndex: MAX_SERIES })
      }
    }
    return {
      category,
      total: segments.reduce((sum, s) => sum + s.value, 0),
      segments,
    }
  })

  if (sortBars) bars.sort((a, b) => b.total - a.total || a.category.localeCompare(b.category))
  else bars.sort((a, b) => a.category.localeCompare(b.category, undefined, { numeric: true }))

  const max = bars.reduce((m, b) => Math.max(m, b.total), 0)
  return { bars, series: seriesColumn ? seriesOrder : [], max }
}

function label(cell: unknown): string {
  if (cell === null || cell === undefined) return '—'
  return String(cell)
}
