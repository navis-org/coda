import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { MatrixValue } from '../../core/values'
import type { HeatmapPalette } from '../../nodes/lib/heatmapParams'
import { CHART_INK, chartSurface, currentMode } from '../colors'
import { exportBaseName as makeBaseName, matrixToCsv } from '../export'
import { formatCompact, formatNumber } from '../format'
import { drawHeatmap, heatmapToSvg } from './heatmapDraw'
import { CRASH_FLOOR_CELLS } from '../../core/limits'
import type { HeatmapWindow } from './heatmapPlot'
import {
  HEATMAP_CELLS_WARN,
  RAMP_STEPS,
  axisMarks,
  clipZones,
  buildHeatmapSpec,
  cellAt,
  cellRect,
  colorDomain,
  fullWindow,
  isFullWindow,
  matrixExtent,
  panWindow,
  pointToMatrix,
  rampColors,
  valueMarks,
  windowScale,
  zoomWindow,
} from './heatmapPlot'
import { prepareCanvas } from './canvas2d'
import { tooltipPoint } from './tooltipPoint'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { useElementSize } from './useElementSize'

export interface HeatmapViewerProps {
  matrix: MatrixValue
  scale?: 'sequential' | 'diverging'
  /** A name from `heatmapParams.ts`; `coda` is the validated default. */
  palette?: HeatmapPalette
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

/** A pan in progress: where the pointer was last, in box coordinates. */
interface Pan {
  lastX: number
  lastY: number
  moved: boolean
}

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
 *
 * ## Zoom and pan, where the card is the surface
 *
 * Wheel zooms about the pointer, a drag pans, double-click or ⤢ fits — the scatter's gestures,
 * and off the canvas only (`compact` off), where the card is not a 150px preview that React Flow
 * already zooms. The state is a `HeatmapWindow` in matrix units, and it is the *fold's input*:
 * the spec is rebuilt for the visible lines, so zooming in shows real cells with their own labels
 * and printed values where the fit showed folded blocks. The labels never scale — the gutters
 * are fixed and the ticks are re-thinned for the pitch the zoom gives them, which is what "the
 * labels stay visible" means here. The colour domain is memoised apart from the window, so a
 * pan neither rescans the matrix nor changes what a colour means.
 */
export function HeatmapViewer({
  matrix,
  scale = 'sequential',
  palette = 'coda',
  showValues = false,
  compact = false,
  baseName,
  onExpand,
  onError,
}: HeatmapViewerProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<Hover | null>(null)
  const [view, setView] = useState<HeatmapWindow | undefined>(undefined)
  const [pan, setPan] = useState<Pan | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const clipId = useId()
  const mode = currentMode()
  const ink = CHART_INK[mode]
  const surface = chartSurface(mode)

  const title = chartTitle(matrix)
  const rows = matrix.rowLabels.length
  const cols = matrix.colLabels.length
  const cells = rows * cols
  const oversized = cells > CRASH_FLOOR_CELLS
  const drawable = rows > 0 && cols > 0 && !oversized && size.width > 40 && size.height > 40
  const zoomable = !compact && drawable

  // A new matrix gets a new frame; a resize does not, because the window is in matrix units.
  useEffect(() => {
    setView(undefined)
  }, [matrix])
  const full = useMemo(() => fullWindow(matrix), [matrix])

  /*
   * The extent scan apart from the fold: one walk of every cell, independent of the window, so
   * a pan does not repeat it — and so a zoom cannot change what a colour means.
   */
  const domain = useMemo(() => colorDomain(matrixExtent(matrix.values), scale), [matrix, scale])

  /*
   * The fold behind one memo, keyed on what genuinely changes it. Not on the theme: `buckets`
   * is mode-independent by construction, so a theme flip re-resolves the ramp's hex and
   * repaints rather than re-folding the matrix. On the window, necessarily — the window is what
   * is folded — and zoomed in that walk covers fewer cells than the fit did.
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
            domain,
            ...(view ? { window: view } : {}),
          })
        : null,
    [drawable, matrix, scale, size.width, size.height, compact, domain, view],
  )

  const ramp = useMemo(() => rampColors(scale, mode, RAMP_STEPS, palette), [scale, mode, palette])
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

  // --- zoom --------------------------------------------------------------
  /*
   * A native, non-passive listener, for `ScatterViewer`'s reason: React routes `onWheel`
   * through a passive root listener, so `preventDefault` there is ignored and the overlay
   * scrolls behind the chart. `nowheel` on the box is the other half where a card is on the
   * canvas — moot here, since the gesture is off under `compact`, but the class costs nothing.
   */
  useEffect(() => {
    const element = ref.current
    if (!element || !spec || !zoomable) return
    /*
     * Coalesced to one update per animation frame. A trackpad delivers wheel events faster
     * than frames, each one a React render and a canvas paint on its own; the factors multiply
     * while the frame is pending and the last pointer position is the anchor, which is what a
     * single larger step about the same point would have been.
     */
    let pending: { factor: number; x: number; y: number; frame: number } | undefined
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const factor = Math.exp(event.deltaY * 0.0015)
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      if (pending) {
        pending.factor *= factor
        pending.x = x
        pending.y = y
        return
      }
      pending = {
        factor,
        x,
        y,
        frame: requestAnimationFrame(() => {
          const step = pending!
          pending = undefined
          // Zoom about the pointer: the cell under it is the one that must not move.
          const anchor = pointToMatrix(spec, step.x, step.y)
          const next = zoomWindow(spec.window, full, anchor, step.factor)
          setView(isFullWindow(next, full) ? undefined : next)
        }),
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      if (pending) cancelAnimationFrame(pending.frame)
    }
  }, [ref, spec, full, zoomable])

  const fit = () => setView(undefined)

  // --- pointer -----------------------------------------------------------
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!zoomable || !view || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = tooltipPoint(event, ref.current)
    setPan({ lastX: point.x, lastY: point.y, moved: false })
    setHover(null)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!spec) return
    // Container coordinates, not the viewport's — see `tooltipPoint`.
    const point = tooltipPoint(event, ref.current)
    if (pan) {
      const dx = point.x - pan.lastX
      const dy = point.y - pan.lastY
      setView(
        panWindow(
          spec.window,
          full,
          (-dy / Math.max(1, spec.plot.height)) * spec.window.rows,
          (-dx / Math.max(1, spec.plot.width)) * spec.window.cols,
        ),
      )
      setPan({ lastX: point.x, lastY: point.y, moved: true })
      return
    }
    const hit = cellAt(spec, point.x, point.y)
    setHover(hit ? { ...hit, ...point } : null)
  }

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
    /*
     * The one shape with no picture on the other side of it — past `CRASH_FLOOR_CELLS`, which
     * nothing upstream can produce anyway. It used to say this at four million, where the
     * honest answer is a slower first layout and a caption; see `HEATMAP_CELLS_WARN`.
     */
    return (
      <div className="viewer">
        <div className="viewer__empty">
          {rows.toLocaleString()} × {cols.toLocaleString()} is {cells.toLocaleString()} cells,
          more than a browser can hold as one grid.
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
  const zoom = spec && view ? windowScale(spec.window, full) : 1
  const zones = spec ? clipZones(spec) : null
  const clip = (zone: keyof NonNullable<typeof zones>) => `url(#${clipId}-${zone})`

  return (
    <div className="viewer">
      <div
        className="heatmap-plot nowheel nodrag"
        ref={ref}
        style={{
          background: surface,
          cursor: pan ? 'grabbing' : view ? 'grab' : 'default',
          ...(zoomable ? { touchAction: 'none' } : {}),
        }}
        {...(zoomable
          ? {
              onDoubleClick: (event: React.MouseEvent) => {
                event.stopPropagation()
                fit()
              },
            }
          : {})}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => setPan(null)}
          onPointerCancel={() => setPan(null)}
          onPointerLeave={() => setHover(null)}
        />

        {spec && zones && (
          <svg
            className="heatmap-overlay"
            width={size.width}
            height={size.height}
            role="img"
            aria-label={title}
          >
            <title>{title}</title>
            {/* The three regions `heatmapToSvg` clips to as well: zoomed, a line half off the
                plot keeps its cells and its ring clipped, and a gutter's labels stay in it. */}
            <defs>
              {(Object.keys(zones) as Array<keyof typeof zones>).map((zone) => (
                <clipPath key={zone} id={`${clipId}-${zone}`}>
                  <rect {...zones[zone]} />
                </clipPath>
              ))}
            </defs>

            {/* The same placements `heatmapToSvg` appends, so the card and the file cannot
                disagree about a label's position or a printed value's ink. */}
            {(['plot', 'rows', 'cols'] as const).map((zone) => (
              <g key={zone} clipPath={clip(zone)}>
                {chrome
                  .filter((mark) => mark.zone === zone)
                  .map((mark) => (
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
              </g>
            ))}

            {hoverBox && (
              <g clipPath={clip('plot')}>
                <rect
                  x={hoverBox.x}
                  y={hoverBox.y}
                  width={hoverBox.width}
                  height={hoverBox.height}
                  fill="none"
                  stroke={ink.primary}
                  strokeWidth={1.5}
                />
              </g>
            )}
          </svg>
        )}

        {zoomable && (
          // Bottom right rather than the strip's usual top right, which here is the column
          // gutter: at ×15 the button sat on the last column's name. Seen in a browser.
          <div className="network-strip nodrag" style={{ top: 'auto', bottom: 6 }}>
            <button
              type="button"
              className="network-strip__btn"
              title="Show the whole matrix (or double-click). Scroll to zoom, drag to pan."
              aria-label="Fit to view"
              disabled={!view}
              onClick={fit}
            >
              ⤢
            </button>
          </div>
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
        {cells > HEATMAP_CELLS_WARN && !compact && (
          // A matrix this size lays out in a few hundred milliseconds and repaints in half
          // that, on a resize and never on a hover. Worth saying once, next to the shape.
          <span
            className="viewer__note"
            title={`${cells.toLocaleString()} cells — laying this out takes a moment on the first draw and on each resize. Nothing is dropped; the blocks each stand for many cells.`}
          >
            large matrix
          </span>
        )}
        {thinned > 0 && !compact && (
          <span
            className="viewer__note"
            title={
              view
                ? 'Too many labels to draw them all at this zoom — zoom in further to see the rest.'
                : 'Too many labels to draw them all — zoom in, enlarge the card, or aggregate upstream.'
            }
          >
            labels thinned
          </span>
        )}
        {view && spec && (
          <span
            className="viewer__note"
            title={`Zoomed in: rows ${Math.floor(spec.window.row0) + 1}–${Math.ceil(spec.window.row0 + spec.window.rows)} of ${rows.toLocaleString()}, columns ${Math.floor(spec.window.col0) + 1}–${Math.ceil(spec.window.col0 + spec.window.cols)} of ${cols.toLocaleString()}. Scroll to zoom, drag to pan, double-click or ⤢ to fit.`}
          >
            ×{zoom >= 10 ? Math.round(zoom) : zoom.toFixed(1)}
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
