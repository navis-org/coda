import { useEffect, useMemo, useRef, useState } from 'react'

import type { MatrixValue } from '../../core/values'
import { CHART_INK, chartSurface, currentMode } from '../colors'
import { exportBaseName as makeBaseName, matrixToCsv } from '../export'
import { formatCompact, formatNumber } from '../format'
import { drawHeatmap, heatmapToSvg } from './heatmapDraw'
import {
  MAX_HEATMAP_CELLS,
  axisMarks,
  buildHeatmapSpec,
  cellAt,
  cellRect,
  rampColors,
  valueMarks,
} from './heatmapPlot'
import { prepareCanvas } from './canvas2d'
import { tooltipPoint } from './tooltipPoint'
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
  index: number
  x: number
  y: number
}

/** Steps in the caption's colour bar — a coarse sampling of the same ramp the cells use. */
const BAR_STEPS = 9

/**
 * Matrix heatmap.
 *
 * Sequential = one hue, and its direction flips with the theme so "near zero" always
 * recedes toward the surface it is drawn on (see `sequentialColor`). Diverging uses the
 * blue↔red pair with a neutral gray midpoint, centred on zero — never a rainbow.
 *
 * ## Canvas for the cells, SVG for everything else
 *
 * The cells were one `<rect>` each, with their own hover handlers, and the viewer refused above
 * 20,000 cells because that is 40,000 DOM nodes and as many listeners on one card. Cells are
 * now painted to a canvas from a grid `heatmapPlot` has already folded to at most one cell per
 * pixel, so the cost of a repaint is bounded by the plot rather than by the matrix.
 *
 * The **labels, the printed values and the hover outline stay in an SVG overlay**, which is the
 * one place this departs from `ScatterViewer`'s all-canvas call — and it is a departure the
 * arithmetic licenses rather than a preference. A scatter's tick labels are a handful either
 * way; a heatmap's axis labels are bounded by *pixels*, since only so many 10px names fit down
 * an edge whatever the matrix is, so keeping them as real text costs nothing and buys text that
 * can be selected, found and read aloud. It is also what makes a hover free: the ring is one
 * element in the overlay, so moving the pointer never repaints four million cells.
 *
 * Cell values are drawn only when the cell is genuinely big enough for the text, with the ink
 * picked from the fill's luminance. A label that would not fit is dropped rather than clipped;
 * the hover tooltip carries it instead.
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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mode = currentMode()
  const ink = CHART_INK[mode]
  const surface = chartSurface(mode)

  const title = chartTitle(matrix)
  const rows = matrix.rowLabels.length
  const cols = matrix.colLabels.length
  const cells = rows * cols
  const oversized = cells > MAX_HEATMAP_CELLS
  const drawable = rows > 0 && cols > 0 && !oversized && size.width > 40 && size.height > 40

  /*
   * The two expensive passes — the extent scan and the fold — behind one memo, keyed on what
   * genuinely changes them. Not on the theme: `buckets` is mode-independent by construction, so
   * a theme flip re-resolves the ramp's hex and repaints rather than re-folding the matrix.
   */
  const spec = useMemo(
    () =>
      drawable
        ? buildHeatmapSpec({
            matrix,
            scale,
            width: size.width,
            height: size.height,
            showLabels: !compact || size.width > 220,
          })
        : null,
    [drawable, matrix, scale, size.width, size.height, compact],
  )

  const ramp = useMemo(() => rampColors(scale, mode), [scale, mode])
  // Sampled out of the cells' own ramp rather than resolved a second time, so the bar cannot
  // come to describe a scale the cells are not drawn in.
  const barRamp = useMemo(
    () =>
      Array.from(
        { length: BAR_STEPS },
        (_, i) => ramp[Math.round((i / (BAR_STEPS - 1)) * (ramp.length - 1))]!,
      ),
    [ramp],
  )

  // --- painting ----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !spec) return
    const context = prepareCanvas(canvas, size.width, size.height)
    if (!context) return
    drawHeatmap(context, {
      spec,
      ramp,
      background: surface,
      width: size.width,
      height: size.height,
    })
  }, [spec, ramp, surface, size.width, size.height])

  /*
   * Memoised apart from the hover, which re-renders at pointer-poll rate: without this every
   * mouse move rebuilt up to 400 value nodes — each one a `formatCompact`, i.e. an `Intl` call —
   * plus every axis label, for React to diff against an identical tree.
   */
  const chrome = useMemo(
    () =>
      spec
        ? [
            ...(showValues ? valueMarks(spec, matrix.values, ramp) : []),
            ...axisMarks(spec, ink.secondary),
          ]
        : [],
    [spec, matrix.values, ramp, ink.secondary, showValues],
  )

  const exportSource: ExportSource = useMemo(
    () => ({
      csv: () => [matrixToCsv(matrix)],
      svg: () => {
        if (!spec) return null
        return heatmapToSvg({
          spec,
          ramp,
          ink,
          background: surface,
          width: size.width,
          height: size.height,
          font:
            typeof getComputedStyle === 'function' && ref.current
              ? getComputedStyle(ref.current).fontFamily || 'sans-serif'
              : 'sans-serif',
          values: matrix.values,
          showValues,
          title,
          ...(matrix.valueLabel ? { valueLabel: matrix.valueLabel } : {}),
          barLow: formatCompact(spec.domain.lo),
          barHigh: formatCompact(spec.domain.hi),
        })
      },
    }),
    [spec, matrix, title, ramp, ink, surface, size.width, size.height, showValues, ref],
  )

  if (rows === 0 || cols === 0) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Matrix is empty</div>
      </div>
    )
  }
  if (oversized) {
    return (
      <div className="viewer">
        <div className="viewer__empty">
          {rows.toLocaleString()} × {cols.toLocaleString()} is too large to draw (
          {cells.toLocaleString()} cells).
          <br />
          Aggregate upstream — e.g. group by type before pivoting.
        </div>
      </div>
    )
  }

  const hovered =
    hover && matrix.values[hover.index] !== undefined
      ? {
          row: matrix.rowLabels[hover.row] ?? '',
          col: matrix.colLabels[hover.col] ?? '',
          value: matrix.values[hover.index]!,
        }
      : null
  const hoverBox = hover && spec ? cellRect(spec, hover.row, hover.col) : null
  const thinned = spec ? spec.rowLabelsThinned + spec.colLabelsThinned : 0

  return (
    <div className="viewer">
      <div className="heatmap-plot" ref={ref} style={{ background: surface }}>
        <canvas
          ref={canvasRef}
          onMouseMove={(event) => {
            if (!spec) return
            // Container coordinates, not the viewport's — see `tooltipPoint`.
            const point = tooltipPoint(event, ref.current)
            const hit = cellAt(spec, point.x, point.y)
            setHover(hit ? { ...hit, ...point } : null)
          }}
          onMouseLeave={() => setHover(null)}
        />

        {spec && (
          <svg
            className="heatmap-overlay"
            width={size.width}
            height={size.height}
            role="img"
            aria-label={title}
          >
            <title>{title}</title>

            {/* The same placements `heatmapToSvg` appends, so the card and the file cannot
                disagree about a label's position or a printed value's ink. */}
            {chrome.map((mark) => (
              <text
                key={mark.key}
                x={mark.x}
                y={mark.y}
                fill={mark.fill}
                fontSize={mark.size}
                textAnchor={mark.anchor}
                {...(mark.baseline ? { dominantBaseline: mark.baseline } : {})}
                {...(mark.transform ? { transform: mark.transform } : {})}
              >
                {mark.text}
              </text>
            ))}

            {hoverBox && (
              <rect
                x={hoverBox.x}
                y={hoverBox.y}
                width={hoverBox.width}
                height={hoverBox.height}
                fill="none"
                stroke={ink.primary}
                strokeWidth={1.5}
              />
            )}

          </svg>
        )}

        {hovered && hover && (
          <div
            className="chart-tooltip"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
            role="status"
          >
            <strong>
              {hovered.row} → {hovered.col}
            </strong>
            <div className="chart-tooltip__row">
              {formatNumber(hovered.value)}
              {matrix.valueLabel ? ` ${matrix.valueLabel}` : ''}
            </div>
            {spec?.folded && (
              // The block under the pointer stands for many cells and is drawn as the
              // strongest of them, so say which one is being named.
              <div className="chart-tooltip__row">
                strongest of ~{spec.foldFactor.toLocaleString()} cells
              </div>
            )}
          </div>
        )}
      </div>

      <div className="viewer__caption">
        <span>
          {rows.toLocaleString()} × {cols.toLocaleString()}
          {matrix.valueLabel ? ` · ${matrix.valueLabel}` : ''}
        </span>
        {spec?.folded && !compact && (
          <span
            className="viewer__note"
            title={`More cells than pixels: each block is drawn as the strongest of about ${spec.foldFactor.toLocaleString()} cells. Enlarge the card to see more of them.`}
          >
            cells merged
          </span>
        )}
        {thinned > 0 && !compact && (
          <span
            className="viewer__note"
            title="Too many labels to draw them all — enlarge the card, or aggregate upstream."
          >
            labels thinned
          </span>
        )}
        <span className="colorbar">
          {formatCompact(spec ? spec.domain.lo : 0)}
          <span
            className="colorbar__ramp"
            style={{ background: `linear-gradient(to right, ${barRamp.join(', ')})` }}
          />
          {formatCompact(spec ? spec.domain.hi : 0)}
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

function chartTitle(matrix: MatrixValue): string {
  return `Heatmap, ${matrix.rowLabels.length} rows × ${matrix.colLabels.length} columns${
    matrix.valueLabel ? `, ${matrix.valueLabel}` : ''
  }`
}
