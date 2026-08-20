import { useMemo, useRef, useState } from 'react'

import type { MatrixValue } from '../../core/values'
import {
  CHART_INK,
  chartSurface,
  currentMode,
  divergingColor,
  inkOn,
  sequentialColor,
} from '../colors'
import { exportBaseName as makeBaseName, matrixToCsv } from '../export'
import { formatCompact, formatNumber, truncateLabel } from '../format'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { useElementSize } from './useElementSize'

export interface HeatmapViewerProps {
  matrix: MatrixValue
  scale?: 'sequential' | 'diverging'
  showValues?: boolean
  compact?: boolean
  /** Filename stem for CSV/SVG/PNG export. */
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

interface Hover {
  row: number
  col: number
  x: number
  y: number
}

const MAX_CELLS = 20_000

/**
 * Matrix heatmap.
 *
 * Sequential = one hue, and its direction flips with the theme so "near zero" always
 * recedes toward the surface it is drawn on (see `sequentialColor`). Diverging uses the
 * blue↔red pair with a neutral gray midpoint, centred on zero — never a rainbow.
 *
 * Cell values are drawn only when the cell is genuinely big enough for the text, with the
 * ink picked from the fill's luminance. A label that would not fit is dropped rather than
 * clipped; the hover tooltip carries it instead.
 */
export function HeatmapViewer({
  matrix,
  scale = 'sequential',
  showValues = false,
  compact = false,
  baseName,
  onExpand,
  onError,
}: HeatmapViewerProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<Hover | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const mode = currentMode()
  const ink = CHART_INK[mode]
  const surface = chartSurface(mode)

  const rows = matrix.rowLabels.length
  const cols = matrix.colLabels.length

  const exportSource: ExportSource = useMemo(
    () => ({ csv: () => [matrixToCsv(matrix)], svg: () => svgRef.current }),
    [matrix],
  )

  const stats = useMemo(() => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const v of matrix.values) {
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
    if (!Number.isFinite(min)) return { min: 0, max: 0 }
    return { min, max }
  }, [matrix])

  if (rows === 0 || cols === 0) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Matrix is empty</div>
      </div>
    )
  }
  if (rows * cols > MAX_CELLS) {
    return (
      <div className="viewer">
        <div className="viewer__empty">
          {rows.toLocaleString()} × {cols.toLocaleString()} is too large to draw (
          {(rows * cols).toLocaleString()} cells).
          <br />
          Aggregate upstream — e.g. group by type before pivoting.
        </div>
      </div>
    )
  }

  // Label gutters sized to the content, capped so the plot keeps most of the space.
  const longestRowLabel = matrix.rowLabels.reduce((m, l) => Math.max(m, l.length), 0)
  const longestColLabel = matrix.colLabels.reduce((m, l) => Math.max(m, l.length), 0)
  const showLabels = !compact || size.width > 220
  const left = showLabels ? Math.min(96, Math.max(28, longestRowLabel * 6 + 8)) : 4
  const top = showLabels ? Math.min(72, Math.max(16, longestColLabel * 5.4 + 8)) : 4
  const right = 4
  const bottom = 4

  const plotWidth = Math.max(0, size.width - left - right)
  const plotHeight = Math.max(0, size.height - top - bottom)
  const cellWidth = plotWidth / cols
  const cellHeight = plotHeight / rows
  // The 1px inset is the surface showing between cells — the separator is negative
  // space, never a stroke around each cell.
  const gap = cellWidth > 6 && cellHeight > 6 ? 1 : 0

  const valueAt = (r: number, c: number): number => matrix.values[r * cols + c] ?? 0

  const colorAt = (value: number): string => {
    if (scale === 'diverging') {
      const extent = Math.max(Math.abs(stats.min), Math.abs(stats.max)) || 1
      return divergingColor(value / extent, mode)
    }
    const span = stats.max - Math.min(0, stats.min) || 1
    return sequentialColor((value - Math.min(0, stats.min)) / span, mode)
  }

  // Only label cells where the formatted text actually fits with padding.
  const labelsFit = showValues && cellHeight >= 14 && cellWidth >= 26 && rows * cols <= 400

  const hovered = hover
    ? {
        row: matrix.rowLabels[hover.row] ?? '',
        col: matrix.colLabels[hover.col] ?? '',
        value: valueAt(hover.row, hover.col),
      }
    : null

  return (
    <div className="viewer">
      <div
        ref={ref}
        className="viewer__scroll"
        style={{ overflow: 'hidden', position: 'relative' }}
      >
        {size.width > 40 && size.height > 40 && (
          <svg
            ref={svgRef}
            className="chart"
            width={size.width}
            height={size.height}
            role="img"
          >
            <title>
              {`Heatmap, ${rows} rows × ${cols} columns${matrix.valueLabel ? `, ${matrix.valueLabel}` : ''}`}
            </title>
            <rect width={size.width} height={size.height} fill={surface} />

            {matrix.rowLabels.map((_rowLabel, r) =>
              matrix.colLabels.map((_, c) => {
                const value = valueAt(r, c)
                const fill = colorAt(value)
                const x = left + c * cellWidth
                const y = top + r * cellHeight
                const w = Math.max(0, cellWidth - gap)
                const h = Math.max(0, cellHeight - gap)
                const isHovered = hover?.row === r && hover?.col === c
                return (
                  <g key={`${r}-${c}`}>
                    <rect
                      x={x}
                      y={y}
                      width={w}
                      height={h}
                      fill={fill}
                      onMouseMove={(e) =>
                        setHover({ row: r, col: c, x: e.clientX, y: e.clientY })
                      }
                      onMouseLeave={() => setHover(null)}
                    />
                    {isHovered && (
                      <rect
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        fill="none"
                        stroke={ink.primary}
                        strokeWidth={1.5}
                        pointerEvents="none"
                      />
                    )}
                    {labelsFit && value !== 0 && (
                      <text
                        x={x + w / 2}
                        y={y + h / 2}
                        fill={inkOn(fill)}
                        fontSize={9.5}
                        textAnchor="middle"
                        dominantBaseline="central"
                        pointerEvents="none"
                      >
                        {formatCompact(value)}
                      </text>
                    )}
                  </g>
                )
              }),
            )}

            {showLabels &&
              matrix.rowLabels.map((label, r) => (
                <text
                  key={`r-${label}-${r}`}
                  x={left - 5}
                  y={top + r * cellHeight + cellHeight / 2}
                  fill={ink.secondary}
                  fontSize={10}
                  textAnchor="end"
                  dominantBaseline="central"
                >
                  {truncateLabel(label, left - 8)}
                </text>
              ))}

            {showLabels &&
              matrix.colLabels.map((label, c) => {
                const x = left + c * cellWidth + cellWidth / 2
                return (
                  <text
                    key={`c-${label}-${c}`}
                    x={x}
                    y={top - 5}
                    fill={ink.secondary}
                    fontSize={10}
                    textAnchor="start"
                    // Rotated so long type names don't collide; -90 keeps reading order.
                    transform={`rotate(-90 ${x} ${top - 5})`}
                  >
                    {truncateLabel(label, top - 8, 5.4)}
                  </text>
                )
              })}
          </svg>
        )}
        {hovered && (
          <div
            className="chart-tooltip"
            style={{ left: hover!.x + 12, top: hover!.y + 12 }}
            role="status"
          >
            <strong>
              {hovered.row} → {hovered.col}
            </strong>
            <div className="chart-tooltip__row">
              {formatNumber(hovered.value)}
              {matrix.valueLabel ? ` ${matrix.valueLabel}` : ''}
            </div>
          </div>
        )}
      </div>
      <div className="viewer__caption">
        <span>
          {rows} × {cols}
          {matrix.valueLabel ? ` · ${matrix.valueLabel}` : ''}
        </span>
        <span className="colorbar">
          {formatCompact(
            scale === 'diverging'
              ? -Math.max(Math.abs(stats.min), Math.abs(stats.max))
              : Math.min(0, stats.min),
          )}
          <span
            className="colorbar__ramp"
            style={{
              background: `linear-gradient(to right, ${rampStops(scale, mode).join(', ')})`,
            }}
          />
          {formatCompact(
            scale === 'diverging'
              ? Math.max(Math.abs(stats.min), Math.abs(stats.max))
              : stats.max,
          )}
        </span>
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'heatmap')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}

/** Sample the active scale into CSS gradient stops for the colour bar. */
function rampStops(scale: 'sequential' | 'diverging', mode: 'light' | 'dark'): string[] {
  const steps = 9
  return Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1)
    return scale === 'diverging' ? divergingColor(t * 2 - 1, mode) : sequentialColor(t, mode)
  })
}
