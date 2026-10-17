/**
 * Line Chart viewer: lines against a numeric X, with a crosshair that reads every line at one X,
 * and a zoom along X.
 *
 * SVG, like the other charts here — a few lines of at most four samples per pixel column each
 * (`decimate`) is a small drawing however long the trace, and SVG is what the export clones. The
 * rules (which lines, in what order, what a pixel column keeps) are `lineSeries.ts`'; this is the
 * drawing and the gestures.
 *
 * **Zoom is along X only.** The wheel zooms about the pointer, a drag pans once zoomed, a double
 * click goes back to the whole extent, and Y refits to what the window holds — a 2 ms onset on a
 * 100 ms trace fills the height when it is looked at. Y is never zoomed on its own: a trace
 * zoomed in voltage alone is a trace cut off.
 */

import { useEffect, useId, useMemo, useState } from 'react'

import { lowerBound } from '../../core/stats'
import type { TableValue } from '../../core/values'
import type { PaletteName } from '../../nodes/lib/encodingParams'
import type { ResolvedColor } from '../../style/encoding'
import { categoricalLegend } from '../../style/encoding'
import { cycleColor, paletteColors } from '../../style/colors'
import { formatCompact, formatNumber, plural } from '../../style/format'
import { exportBaseName as makeBaseName } from '../export'
import { ChartTooltip, TooltipRow } from './ChartTooltip'
import { ColorKey } from './LegendKeys'
import type { Line, LineOrder } from './lineSeries'
import {
  buildLines,
  decimate,
  panWindow,
  valuesAt,
  xExtent,
  yExtentOf,
  zoomWindow,
} from './lineSeries'
import type { Affine, Domain, Rect, ScaleKind, Viewport } from './scatterPlot'
import {
  axisTicks,
  forward,
  inverse,
  padDomain,
  projectX,
  projectY,
  unprojectX,
  viewAffine,
  zeroDomain,
} from './scatterPlot'
import { tooltipPoint } from './tooltipPoint'
import { useChart } from './useChart'
import { usePanGesture } from './usePanGesture'
import { useStable } from './useStable'
import { useWheelZoom } from './useWheelZoom'
import { ViewerActions } from './ViewerActions'
import { ViewerEmpty } from './ViewerEmpty'

export interface LineChartViewerProps {
  table: TableValue
  x: string
  /** Resolved: the picked Y columns, or every numeric one (`yColumnsOf`). */
  ys: readonly string[]
  series?: string | undefined
  order?: LineOrder
  xLog?: boolean
  yLog?: boolean
  palette?: PaletteName
  /** An X to mark with a solid line — a player's current time, say. Untransformed, as in the table. */
  cursor?: number
  /**
   * Xs to mark with a short tick at the foot of the plot — when inputs arrive, say. Untransformed;
   * `xMarksLabel` says what they are, on hover and in the exported SVG.
   */
  xMarks?: readonly number[]
  xMarksLabel?: string
  /**
   * A short panel under the plot on the same X — a stimulus, say — with a Y of its own, its unit
   * not being the lines'. Untransformed, as in the table; `x` ascending. For a caller drawing
   * beside its own lines (Simulate's Playback); not reachable from the Line Chart node's params.
   */
  strip?: ChartStrip | undefined
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

export interface ChartStrip {
  readonly label: string
  readonly unit: string
  readonly x: ArrayLike<number>
  readonly y: ArrayLike<number>
}

const PAD = { left: 54, right: 16, top: 14, bottom: 26 }
/** The strip's height and its gap below the plot, px. */
const STRIP_HEIGHT = 40
const STRIP_GAP = 10
const LINE_WIDTH = 1.5
/** How tall an `xMarks` tick is, px. */
const MARK_HEIGHT = 7
/** How many lines the crosshair's tooltip lists before it says how many more. */
const TOOLTIP_LINES = 12

interface Hover {
  /** The pointer, in the container's pixels, for the tooltip. */
  readonly x: number
  readonly y: number
  /** The transformed X the crosshair is at. */
  readonly at: number
}

export function LineChartViewer({
  table,
  x,
  ys,
  series,
  order = 'x',
  xLog = false,
  yLog = false,
  palette = 'coda',
  cursor,
  xMarks,
  xMarksLabel,
  strip,
  compact = false,
  baseName,
  onExpand,
  onError,
}: LineChartViewerProps) {
  const { ref, size, hover, setHover, svgRef, mode, ink, surface, exportSource } =
    useChart<Hover>(table)
  const clipId = useId()
  const xScale: ScaleKind = xLog ? 'log' : 'linear'
  const yScale: ScaleKind = yLog ? 'log' : 'linear'

  // Held by content: the entry resolves the Y list afresh on every render, and a new array here
  // would rebuild every line on every store tick.
  const yList = useStable(ys)
  const built = useMemo(
    () => buildLines(table, { x, ys: yList, series, order, xScale, yScale }),
    [table, x, yList, series, order, xScale, yScale],
  )
  const { lines } = built
  const dropped = built.missing + built.nonPositive
  // The whole extent, padded only when it is a single X, which has no width to draw across.
  const full = useMemo(() => {
    const extent = xExtent(lines)
    return extent && extent.max > extent.min ? extent : extent && padDomain(extent)
  }, [lines])

  // The X window; undefined is the whole extent. Another table or axis starts unzoomed.
  const [zoom, setZoom] = useState<Domain | undefined>()
  useEffect(() => setZoom(undefined), [table, x, xScale])
  const view = zoom ?? full

  const colors = useMemo((): ResolvedColor => {
    const colorOf = (i: number) => cycleColor(i, mode, palette)
    const legend = categoricalLegend(
      'line',
      lines.map((line) => line.label),
      (_, i) => colorOf(i),
      paletteColors(palette, mode).length,
    )
    return { at: colorOf, legend: lines.length > 1 ? legend : undefined }
  }, [lines, mode, palette])

  // A strip takes its height from the plot's, below it and above the X labels.
  const stripSpace = strip ? STRIP_HEIGHT + STRIP_GAP : 0
  const plot = useMemo(
    (): Rect => ({
      x: PAD.left,
      y: PAD.top,
      width: Math.max(1, size.width - PAD.left - PAD.right),
      height: Math.max(1, size.height - PAD.top - PAD.bottom - stripSpace),
    }),
    [size.width, size.height, stripSpace],
  )
  const stripTop = plot.y + plot.height + STRIP_GAP
  const stripRect: Rect = { x: plot.x, y: stripTop, width: plot.width, height: STRIP_HEIGHT }
  // The strip as a line of the chart's own, X through the axis's scale, so it is windowed and
  // decimated as the lines are; its Y its own, zero always in it so a sign reads off the line.
  const stripLine = useMemo((): Line | undefined => {
    if (!strip) return undefined
    const keep: number[] = []
    for (let i = 0; i < strip.x.length; i++) {
      if (Number.isFinite(forward(xScale, strip.x[i]!)) && Number.isFinite(strip.y[i]!))
        keep.push(i)
    }
    return {
      label: strip.label,
      x: Float64Array.from(keep, (i) => forward(xScale, strip.x[i]!)),
      y: Float64Array.from(keep, (i) => strip.y[i]!),
      sorted: true,
    }
  }, [strip, xScale])
  const stripY = useMemo(() => stripLine && zeroDomain(stripLine.y), [stripLine])

  // What each line draws in the window, decimated — and, since a pixel column keeps its extremes,
  // the Y extent over it is the window's, without a second pass over every sample.
  const kept = useMemo(
    () => (view ? lines.map((line) => decimate(line, view, Math.ceil(plot.width))) : []),
    [lines, view, plot.width],
  )
  const yDomain = useMemo(() => {
    let extent: Domain | undefined
    lines.forEach((line, i) => (extent = yExtentOf(line, kept[i] ?? [], extent)))
    return extent && padDomain(extent, 0.05)
  }, [lines, kept])

  /** The window and the plot as `scatterPlot`'s projection takes them; undefined with nothing to draw. */
  const frame = useMemo((): { view: Viewport; affine: Affine } | undefined => {
    if (!view || !yDomain) return undefined
    const window = { x: view, y: yDomain }
    return { view: window, affine: viewAffine(window, plot) }
  }, [view, yDomain, plot])

  const paths = useMemo(() => {
    if (!frame) return []
    const { sx, ox, sy, oy } = frame.affine
    return lines.map((line, l) => {
      let d = ''
      for (const i of kept[l] ?? []) {
        d += `${d === '' ? 'M' : 'L'}${(line.x[i]! * sx + ox).toFixed(2)} ${(line.y[i]! * sy + oy).toFixed(2)}`
      }
      return d
    })
  }, [lines, kept, frame])

  useWheelZoom(ref, frame !== undefined, (factor, px) => {
    if (!frame || !full) return
    const at = unprojectX(Math.min(Math.max(px, plot.x), plot.x + plot.width), frame.view, plot)
    setZoom(zoomWindow(frame.view.x, full, factor, at))
  })
  const { panning, handlers } = usePanGesture(zoom !== undefined, (dx) => {
    if (!frame || !full) return
    setZoom(panWindow(frame.view.x, full, -dx / frame.affine.sx))
  })

  // Every mark one short stroke up from the plot's foot, in one path — memoised, a moving cursor
  // re-rendering the chart every frame of a playback.
  const marksPath = useMemo(() => {
    if (!xMarks || !frame) return undefined
    return xMarks
      .map((x) => forward(xScale, x))
      .filter((x) => Number.isFinite(x) && x >= frame.view.x.min && x <= frame.view.x.max)
      .map((x) => `M${projectX(x, frame.view, plot)} ${plot.y + plot.height}v${-MARK_HEIGHT}`)
      .join('')
  }, [xMarks, xScale, frame, plot])

  // The strip's path over the window, a pixel column's extremes each — memoised on the window
  // and the plot, which a moving cursor leaves alone.
  const stripPath = useMemo(() => {
    if (!stripLine || !stripY || !view) return undefined
    const window = { x: view, y: stripY }
    const yOf = (y: number) =>
      stripTop + STRIP_HEIGHT * (1 - (y - stripY.min) / (stripY.max - stripY.min))
    let d = ''
    for (const i of decimate(stripLine, view, Math.ceil(plot.width))) {
      d += `${d === '' ? 'M' : 'L'}${projectX(stripLine.x[i]!, window, plot).toFixed(2)} ${yOf(stripLine.y[i]!).toFixed(2)}`
    }
    return { d, zero: yOf(0) }
  }, [stripLine, stripY, view, plot, stripTop])

  if (!frame) {
    return (
      <ViewerEmpty>
        {ys.length === 0
          ? 'No numeric column to draw against X.'
          : `Nothing to draw${dropped > 0 ? `: ${plural(dropped, 'value')} could not be plotted` : ''}.`}
      </ViewerEmpty>
    )
  }

  const xOf = (t: number) => projectX(t, frame.view, plot)
  // The cursor's X, transformed; NaN for none, or for one a log axis has no room for.
  const cursorX = cursor === undefined ? Number.NaN : forward(xScale, cursor)
  const yOf = (t: number) => projectY(t, frame.view, plot)
  const xTicks = axisTicks(frame.view.x, xScale, plot.width > 360 ? 6 : 4)
  const yTicks = axisTicks(frame.view.y, yScale, Math.max(3, Math.floor(plot.height / 50)))
  const readings = hover && !panning ? valuesAt(lines, hover.at, frame.view.x) : []
  const points = lines.reduce((sum, line) => sum + line.x.length, 0)

  return (
    <div className="viewer">
      <div
        ref={ref}
        className="viewer__scroll nowheel nodrag"
        style={{
          position: 'relative',
          overflow: 'hidden',
          touchAction: 'none',
          cursor: panning ? 'grabbing' : zoom ? 'grab' : 'crosshair',
        }}
        {...handlers}
        onDoubleClick={() => setZoom(undefined)}
      >
        {size.width > 60 && size.height > 60 && (
          <svg
            ref={svgRef}
            className="chart line-chart"
            width={size.width}
            height={size.height}
            role="img"
            aria-label={`${plural(lines.length, 'line')} against ${x}`}
            onMouseMove={(event) => {
              const point = tooltipPoint(event, ref.current)
              if (point.x < plot.x || point.x > plot.x + plot.width) return setHover(null)
              setHover({ ...point, at: unprojectX(point.x, frame.view, plot) })
            }}
            onMouseLeave={() => setHover(null)}
          >
            <rect width={size.width} height={size.height} fill={surface} />
            <defs>
              <clipPath id={`${clipId}-plot`}>
                <rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} />
              </clipPath>
            </defs>

            {yTicks.map((t) => (
              <g key={`y${t}`}>
                <line
                  x1={plot.x}
                  y1={yOf(t)}
                  x2={plot.x + plot.width}
                  y2={yOf(t)}
                  stroke={ink.grid}
                  strokeWidth={1}
                />
                <text
                  x={plot.x - 8}
                  y={yOf(t)}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize={10}
                  fill={ink.muted}
                >
                  {formatCompact(inverse(yScale, t))}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <g key={`x${t}`}>
                <line
                  x1={xOf(t)}
                  y1={plot.y}
                  x2={xOf(t)}
                  y2={plot.y + plot.height}
                  stroke={ink.grid}
                  strokeWidth={1}
                />
                <text
                  x={xOf(t)}
                  y={plot.y + plot.height + stripSpace + 14}
                  textAnchor="middle"
                  fontSize={10}
                  fill={ink.muted}
                >
                  {formatCompact(inverse(xScale, t))}
                </text>
              </g>
            ))}
            <line
              x1={plot.x}
              y1={plot.y}
              x2={plot.x}
              y2={plot.y + plot.height}
              stroke={ink.axis}
              strokeWidth={1}
            />
            <line
              x1={plot.x}
              y1={plot.y + plot.height}
              x2={plot.x + plot.width}
              y2={plot.y + plot.height}
              stroke={ink.axis}
              strokeWidth={1}
            />

            {strip && stripY && stripPath && (
              <g>
                <clipPath id={`${clipId}-strip`}>
                  <rect
                    x={stripRect.x}
                    y={stripRect.y - 1}
                    width={stripRect.width}
                    height={stripRect.height + 2}
                  />
                </clipPath>
                <line
                  x1={stripRect.x}
                  y1={stripPath.zero}
                  x2={stripRect.x + stripRect.width}
                  y2={stripPath.zero}
                  stroke={ink.grid}
                  strokeWidth={1}
                />
                <line
                  x1={stripRect.x}
                  y1={stripRect.y}
                  x2={stripRect.x}
                  y2={stripRect.y + stripRect.height}
                  stroke={ink.axis}
                  strokeWidth={1}
                />
                {[stripY.max, stripY.min].map((v, i) => (
                  <text
                    key={i}
                    x={plot.x - 8}
                    y={i === 0 ? stripRect.y : stripRect.y + stripRect.height}
                    textAnchor="end"
                    dominantBaseline="central"
                    fontSize={10}
                    fill={ink.muted}
                  >
                    {formatCompact(v)}
                  </text>
                ))}
                <text
                  x={stripRect.x + 4}
                  y={stripRect.y + 1}
                  dominantBaseline="hanging"
                  fontSize={10}
                  fill={ink.muted}
                >
                  {strip.label} ({strip.unit})
                </text>
                <path
                  d={stripPath.d}
                  fill="none"
                  stroke={ink.secondary}
                  strokeWidth={LINE_WIDTH}
                  strokeLinejoin="round"
                  clipPath={`url(#${clipId}-strip)`}
                />
                {Number.isFinite(cursorX) && (
                  <line
                    x1={xOf(cursorX)}
                    y1={stripRect.y}
                    x2={xOf(cursorX)}
                    y2={stripRect.y + stripRect.height}
                    stroke={ink.primary}
                    strokeWidth={1.5}
                    pointerEvents="none"
                  />
                )}
              </g>
            )}

            <g clipPath={`url(#${clipId}-plot)`}>
              {paths.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke={colors.at(i)}
                  strokeWidth={LINE_WIDTH}
                  strokeLinejoin="round"
                />
              ))}
              {marksPath && (
                <path
                  d={marksPath}
                  stroke={ink.secondary}
                  strokeWidth={1.5}
                  pointerEvents="stroke"
                >
                  {xMarksLabel && <title>{xMarksLabel}</title>}
                </path>
              )}
              {Number.isFinite(cursorX) && (
                <line
                  x1={xOf(cursorX)}
                  y1={plot.y}
                  x2={xOf(cursorX)}
                  y2={plot.y + plot.height}
                  stroke={ink.primary}
                  strokeWidth={1.5}
                  pointerEvents="none"
                />
              )}
            </g>

            {hover && !panning && (
              <g pointerEvents="none">
                <line
                  x1={hover.x}
                  y1={plot.y}
                  x2={hover.x}
                  y2={plot.y + plot.height}
                  stroke={ink.secondary}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                {readings.map((reading, i) =>
                  reading && reading.y >= frame.view.y.min && reading.y <= frame.view.y.max ? (
                    <circle
                      key={i}
                      cx={xOf(reading.x)}
                      cy={yOf(reading.y)}
                      r={3}
                      fill={colors.at(i)}
                      stroke={surface}
                      strokeWidth={1.5}
                    />
                  ) : null,
                )}
              </g>
            )}
          </svg>
        )}

        {hover && !panning && (
          <ChartTooltip at={hover}>
            <strong>
              {x} {formatNumber(inverse(xScale, hover.at))}
            </strong>
            {readings.slice(0, TOOLTIP_LINES).map((reading, i) =>
              reading ? (
                <TooltipRow key={i} swatch={colors.at(i)}>
                  {lines[i]!.label} {formatNumber(inverse(yScale, reading.y))}
                </TooltipRow>
              ) : null,
            )}
            {lines.length > TOOLTIP_LINES && (
              <TooltipRow>{plural(lines.length - TOOLTIP_LINES, 'more line')}</TooltipRow>
            )}
            {strip && stripLine && (
              <TooltipRow>
                {strip.label} {formatNumber(stripAt(stripLine, hover.at))} {strip.unit}
              </TooltipRow>
            )}
          </ChartTooltip>
        )}
      </div>

      <div className="viewer__caption">
        <span>
          {plural(lines.length, 'line')} · {plural(points, 'point')}
        </span>
        <ColorKey colors={colors} />
        {colors.legend?.kind === 'categorical' && colors.legend.cycled && !compact && (
          <span
            className="viewer__note"
            title="There are more lines than the palette has colours, so some share one. A palette with more colours, or fewer lines, separates them."
          >
            colours repeat
          </span>
        )}
        {dropped > 0 && (
          <span className="viewer__note" title={dropTitle(built.missing, built.nonPositive)}>
            {dropped.toLocaleString()} not plotted
          </span>
        )}
        {zoom && (
          <span
            className="viewer__note"
            title="Zoomed along X. Double-click to see the whole extent."
          >
            zoomed
          </span>
        )}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'line-chart')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}

function dropTitle(missing: number, nonPositive: number): string {
  const parts: string[] = []
  if (missing > 0) parts.push(`${plural(missing, 'value')} with no number in X or Y`)
  if (nonPositive > 0) {
    parts.push(
      `${plural(nonPositive, 'value')} at or below zero, which a log axis has no room for`,
    )
  }
  return `Not drawn: ${parts.join('; ')}.`
}

/**
 * The strip's value at `x` (through the axis's scale): its last point at or before it, a stimulus
 * holding until it changes.
 */
function stripAt(line: Line, x: number): number {
  const i = lowerBound(line.x, x)
  const at = line.x[i] === x ? i : i - 1
  return at < 0 ? Number.NaN : line.y[at]!
}
