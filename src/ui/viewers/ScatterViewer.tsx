/**
 * Scatter plot viewer.
 *
 * Canvas rather than SVG, and that is the load-bearing choice: the node this draws for is
 * meant to take an embedding of a whole dataset — male-CNS is 165,122 traced neurons — and
 * one `<circle>` per row would mount a hundred and sixty thousand DOM nodes. Export re-draws
 * the same spec as vector, so nothing is given up but the DOM (`scatterDraw.ts`).
 *
 * The gesture division matches the canvas underneath it: bare drag pans, Shift-drag lassos,
 * ⌘/Ctrl-drag draws a box — the same assignment `panOnDrag` and `selectionKeyCode="Shift"`
 * give the editor, so the hand does not have to change modes when the pointer crosses into a
 * card. Navigation is far more frequent than selection and gets the bare gesture.
 *
 * Everything geometric lives in `scatterPlot.ts`, headless, because jsdom has no canvas and
 * this file is therefore very nearly untestable. What remains here is React state, pointer
 * plumbing and the caption.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ColorSpec, SizeSpec } from '../../nodes/lib/encodingParams'
import { rowKeys } from '../../nodes/lib/rowIds'
import type { TableValue } from '../../core/values'
import { CHART_INK, chartSurface, currentMode } from '../colors'
import { resolveColor, resolveSize } from '../encoding'
import { exportBaseName as makeBaseName, tableToCsvParts } from '../export'
import { formatCell, formatCompact, formatNumber, plural } from '../format'
import { ColorKey, ShapeKey, SizeKey } from './LegendKeys'
import type { LegendItem } from './scatterDraw'
import { drawScatter, scatterToSvg } from './scatterDraw'
import type { Rect, ScaleKind, ScatterSpec, Viewport } from './scatterPlot'
import {
  buildHitIndex,
  buildScatter,
  cellNumber,
  equaliseAspect,
  rectPolygon,
  resolveShape,
  rowsInPolygon,
  unprojectX,
  unprojectY,
} from './scatterPlot'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { tooltipPoint } from './tooltipPoint'
import { useElementSize } from './useElementSize'
import { useStable } from './useStable'

export interface ScatterViewerProps {
  table: TableValue
  xColumn: string
  yColumn: string
  xScale: ScaleKind
  yScale: ScaleKind
  aspect: 'fit' | 'equal'
  color: ColorSpec
  size: SizeSpec
  shapeColumn?: string
  labelColumn?: string
  /** How a selected point is named downstream. Undefined means the row index. */
  idColumn?: string
  opacity: number
  maxPoints: number
  trend: 'none' | 'linear'
  trendPerGroup: boolean
  selection: string[]
  onSelectionChange?: (ids: string[]) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/** How close the pointer has to be to a mark for the tooltip to claim it. */
const HOVER_RADIUS = 12

/** Below this much pointer travel a drag is read as a click. */
const CLICK_SLOP = 3

/** Minimum pointer travel between recorded lasso vertices. */
const LASSO_STEP = 4

const MARGIN_FULL = { top: 10, right: 14, bottom: 40, left: 50 }
const MARGIN_COMPACT = { top: 5, right: 6, bottom: 6, left: 6 }

type Gesture =
  | { kind: 'pan'; lastX: number; lastY: number; view: Viewport; moved: boolean }
  | { kind: 'lasso'; points: number[]; moved: boolean; additive: boolean }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; moved: boolean }

export function ScatterViewer({
  table,
  xColumn,
  yColumn,
  xScale,
  yScale,
  aspect,
  color,
  size,
  shapeColumn,
  labelColumn,
  idColumn,
  opacity,
  maxPoints,
  trend,
  trendPerGroup,
  selection,
  onSelectionChange,
  compact = false,
  baseName,
  onExpand,
  onError,
}: ScatterViewerProps) {
  const [wrapRef, box] = useElementSize<HTMLDivElement>()
  /*
   * The tooltip is a child of `.viewer`, not of the plot box, so that is the element its
   * `left`/`top` resolve against. The two share an origin today — the canvas is the first flex
   * child — but naming the right one is what keeps that a coincidence rather than a dependency.
   */
  const viewerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState<Viewport | undefined>(undefined)
  const [hovered, setHovered] = useState<{ index: number; x: number; y: number } | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const mode = currentMode()
  const ink = CHART_INK[mode]
  const surface = chartSurface(mode)

  const margin = compact ? MARGIN_COMPACT : MARGIN_FULL
  const plot: Rect = useMemo(
    () => ({
      x: margin.left,
      y: margin.top,
      width: Math.max(10, box.width - margin.left - margin.right),
      height: Math.max(10, box.height - margin.top - margin.bottom),
    }),
    [box.width, box.height, margin],
  )

  const xValues = table.data[xColumn]
  const yValues = table.data[yColumn]

  // --- encodings ---------------------------------------------------------
  /*
   * By value, never by identity. `ValuePreview` calls `readColorSpec`/`readSizeSpec` inline,
   * so both props are a fresh object on every render of the editor — and both reach `spec`
   * below, which rebuilds the whole point set, the hit index and the canvas. Unstabilised, an
   * unrelated store tick repaints a fifty-thousand-mark plot. Same rule and same reason as the
   * network viewer's structure effect, and now literally the same hook.
   */
  const stableColor = useStable(color)
  const stableSize = useStable(size)
  const stableSelection = useStable(selection)
  const colors = useMemo(
    () => resolveColor(table, stableColor, mode),
    [table, stableColor, mode],
  )
  const sizes = useMemo(() => resolveSize(table, stableSize), [table, stableSize])
  const shapes = useMemo(
    () => resolveShape(shapeColumn ? table.data[shapeColumn] : undefined, shapeColumn),
    [table, shapeColumn],
  )

  // --- framing -----------------------------------------------------------
  /*
   * A new question gets a new frame. Anything that changes what is *being* plotted — the
   * table, either column, either scale — resets the viewport, because a zoom framed on one
   * pair of columns says nothing about the next. Resizing the card deliberately does not:
   * it changes how much of the picture fits, not which picture it is, and throwing away a
   * zoom because somebody dragged the corner is the failure the layout memo exists to avoid.
   */
  useEffect(() => {
    setView(undefined)
  }, [table, xColumn, yColumn, xScale, yScale, aspect])

  // Equal aspect has to be re-imposed after a resize, since the pixel box it was computed
  // against has changed. Idempotent when the view already satisfies it.
  const framed = useMemo(
    () => (view && aspect === 'equal' ? equaliseAspect(view, plot) : view),
    [view, aspect, plot],
  )

  const spec: ScatterSpec | undefined = useMemo(() => {
    if (!xValues || !yValues || plot.width < 10 || plot.height < 10) return undefined
    return buildScatter({
      xValues,
      yValues,
      length: table.length,
      xScale,
      yScale,
      plot,
      ...(framed ? { view: framed } : {}),
      aspect,
      maxPoints,
      trend,
      trendPerGroup,
      trendColor: ink.primary,
      style: {
        colorAt: colors.at,
        radiusAt: sizes.at,
        shapeAt: shapes ? shapes.shapeAt : () => 'circle',
      },
    })
  }, [
    xValues,
    yValues,
    table.length,
    xScale,
    yScale,
    plot,
    framed,
    aspect,
    maxPoints,
    trend,
    trendPerGroup,
    ink.primary,
    colors,
    sizes,
    shapes,
  ])

  const hitIndex = useMemo(() => (spec ? buildHitIndex(spec) : undefined), [spec])

  // --- selection ---------------------------------------------------------
  const keyAt = useMemo(() => rowKeys(table, idColumn), [table, idColumn])
  const selectedKeys = useMemo(() => new Set(stableSelection.map(String)), [stableSelection])
  const selectedIndices = useMemo(() => {
    const out = new Set<number>()
    if (!spec || selectedKeys.size === 0) return out
    for (let i = 0; i < spec.drawn; i++) {
      if (selectedKeys.has(keyAt(spec.rows[i]!))) out.add(i)
    }
    return out
  }, [spec, selectedKeys, keyAt])

  const commitRows = useCallback(
    (rows: number[], additive: boolean) => {
      const keys = additive ? new Set(selectedKeys) : new Set<string>()
      for (const row of rows) keys.add(keyAt(row))
      onSelectionChange?.([...keys])
    },
    [keyAt, onSelectionChange, selectedKeys],
  )

  // --- painting ----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !spec) return
    const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
    canvas.width = Math.max(1, Math.round(box.width * ratio))
    canvas.height = Math.max(1, Math.round(box.height * ratio))
    canvas.style.width = `${box.width}px`
    canvas.style.height = `${box.height}px`
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    drawScatter(context, {
      spec,
      ink,
      background: surface,
      opacity,
      width: box.width,
      height: box.height,
      xLabel: xColumn,
      yLabel: yColumn,
      selected: selectedIndices,
      ...(hovered ? { hovered: hovered.index } : {}),
      compact,
    })
  }, [spec, ink, surface, opacity, xColumn, yColumn, selectedIndices, hovered, compact, box])

  // --- zoom --------------------------------------------------------------
  /*
   * A native, non-passive listener: React routes `onWheel` through a passive root listener,
   * so `preventDefault` there is ignored and the page scrolls behind the chart. `nowheel` on
   * the wrapper is the other half — it stops React Flow zooming the canvas underneath.
   */
  useEffect(() => {
    const element = wrapRef.current
    if (!element || !spec) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      // Zoom about the pointer: the value under it is the one that must not move.
      const anchorX = unprojectX(px, spec.view, spec.plot)
      const anchorY = unprojectY(py, spec.view, spec.plot)
      const factor = Math.exp(event.deltaY * 0.0015)
      setView({
        x: {
          min: anchorX + (spec.view.x.min - anchorX) * factor,
          max: anchorX + (spec.view.x.max - anchorX) * factor,
        },
        y: {
          min: anchorY + (spec.view.y.min - anchorY) * factor,
          max: anchorY + (spec.view.y.max - anchorY) * factor,
        },
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [wrapRef, spec])

  // --- pointer -----------------------------------------------------------
  const localPoint = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!spec || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const { x, y } = localPoint(event)
    if (event.shiftKey) {
      setGesture({ kind: 'lasso', points: [x, y], moved: false, additive: event.altKey })
    } else if (event.metaKey || event.ctrlKey) {
      setGesture({ kind: 'box', x0: x, y0: y, x1: x, y1: y, moved: false })
    } else {
      setGesture({ kind: 'pan', lastX: x, lastY: y, view: spec.view, moved: false })
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!spec) return
    const { x, y } = localPoint(event)

    if (!gesture) {
      const index = hitIndex?.nearest(x, y, HOVER_RADIUS) ?? -1
      setHovered(index >= 0 ? { index, ...tooltipPoint(event, viewerRef.current) } : null)
      return
    }

    if (gesture.kind === 'pan') {
      const dx = x - gesture.lastX
      const dy = y - gesture.lastY
      const spanX = spec.view.x.max - spec.view.x.min
      const spanY = spec.view.y.max - spec.view.y.min
      const stepX = (dx / Math.max(1, spec.plot.width)) * spanX
      const stepY = (dy / Math.max(1, spec.plot.height)) * spanY
      setView({
        x: { min: spec.view.x.min - stepX, max: spec.view.x.max - stepX },
        // Screen y grows downwards; the axis does not.
        y: { min: spec.view.y.min + stepY, max: spec.view.y.max + stepY },
      })
      setGesture({ ...gesture, lastX: x, lastY: y, moved: true })
      return
    }

    if (gesture.kind === 'lasso') {
      const n = gesture.points.length
      const lastX = gesture.points[n - 2]!
      const lastY = gesture.points[n - 1]!
      if (Math.hypot(x - lastX, y - lastY) < LASSO_STEP) return
      setGesture({ ...gesture, points: [...gesture.points, x, y], moved: true })
      return
    }

    setGesture({
      ...gesture,
      x1: x,
      y1: y,
      moved: gesture.moved || Math.hypot(x - gesture.x0, y - gesture.y0) > CLICK_SLOP,
    })
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!spec || !gesture) return
    const current = gesture
    setGesture(null)
    const { x, y } = localPoint(event)

    const polygon =
      current.kind === 'lasso'
        ? current.points
        : current.kind === 'box'
          ? rectPolygon(current.x0, current.y0, current.x1, current.y1)
          : undefined

    if (!current.moved) {
      // A click, not a drag. Nothing under it clears; a modifier toggles rather than replaces,
      // which is the one place a selection is built up a point at a time.
      const index = hitIndex?.nearest(x, y, HOVER_RADIUS) ?? -1
      if (index < 0) {
        if (current.kind !== 'pan') onSelectionChange?.([])
        return
      }
      const key = keyAt(spec.rows[index]!)
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        const next = new Set(selectedKeys)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        onSelectionChange?.([...next])
      } else {
        onSelectionChange?.([key])
      }
      return
    }

    if (!polygon || !xValues || !yValues) return
    const rows = rowsInPolygon({
      xValues,
      yValues,
      // Every usable row, not the drawn sample: above the point budget a lasso still means
      // the region it enclosed. See `rowsInPolygon`.
      rows: spec.usableRows,
      xScale,
      yScale,
      view: spec.view,
      plot: spec.plot,
      polygon,
    })
    commitRows(rows, current.kind === 'lasso' && current.additive)
  }

  const fit = useCallback(() => setView(undefined), [])

  // --- export ------------------------------------------------------------
  const specRef = useRef<ScatterSpec | undefined>(undefined)
  specRef.current = spec
  const legendItems = useMemo<LegendItem[]>(() => {
    const items: LegendItem[] = []
    const legend = colors.legend
    if (legend?.kind === 'categorical') {
      for (const entry of legend.entries) items.push({ label: entry.label, color: entry.color })
    }
    if (shapes) {
      for (const entry of shapes.entries) items.push({ label: entry.label, shape: entry.shape })
    }
    return items
  }, [colors.legend, shapes])

  const exportSource: ExportSource = useMemo(
    () => ({
      csv: () => tableToCsvParts(table),
      svg: () => {
        const current = specRef.current
        if (!current) return null
        const ramp =
          colors.legend?.kind === 'sequential'
            ? {
                label: colors.legend.column,
                stops: colors.legend.stops,
                low: formatCompact(colors.legend.domain[0]),
                high: formatCompact(colors.legend.domain[1]),
              }
            : undefined
        return scatterToSvg({
          spec: current,
          width: box.width,
          height: box.height,
          background: surface,
          ink,
          font:
            typeof getComputedStyle === 'function' && wrapRef.current
              ? getComputedStyle(wrapRef.current).fontFamily || 'sans-serif'
              : 'sans-serif',
          opacity,
          xLabel: xColumn,
          yLabel: yColumn,
          title: `${yColumn} against ${xColumn}`,
          legend: legendItems,
          ...(ramp ? { ramp } : {}),
        })
      },
    }),
    [
      table,
      box.width,
      box.height,
      surface,
      ink,
      opacity,
      xColumn,
      yColumn,
      legendItems,
      colors.legend,
      wrapRef,
    ],
  )

  // --- empty states ------------------------------------------------------
  if (!xValues || !yValues) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Pick two numeric columns to plot.</div>
      </div>
    )
  }
  if (table.length === 0) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Nothing to plot — the table is empty.</div>
      </div>
    )
  }

  const usable = spec?.usableRows.length ?? 0
  const thinned = spec ? spec.drawn < usable : false
  const dropped = spec?.skipped ?? 0
  const singleTrend = spec?.trends.length === 1 ? spec.trends[0] : undefined
  const hoveredRow = hovered && spec ? spec.rows[hovered.index] : undefined

  return (
    <div className="viewer" ref={viewerRef}>
      <div
        ref={wrapRef}
        className="scatter-canvas nowheel nodrag"
        style={{
          background: surface,
          cursor: gesture?.kind === 'pan' ? 'grabbing' : 'crosshair',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setGesture(null)}
        onPointerLeave={() => setHovered(null)}
        /*
         * Only where the card is not the surface. `coda-node__preview` expands on
         * double-click, and that is the better meaning of the gesture in a 150px preview —
         * so in `compact` this lets the event through rather than firing two actions at once.
         */
        {...(compact
          ? {}
          : {
              onDoubleClick: (event: React.MouseEvent) => {
                event.stopPropagation()
                fit()
              },
            })}
      >
        <canvas ref={canvasRef} />

        {/* The marquee and the lasso trail, as an overlay rather than in the repaint: a
            gesture redrawing fifty thousand marks per pointer move is not a gesture. */}
        {gesture?.kind === 'box' && gesture.moved && (
          <svg className="scatter-gesture" width={box.width} height={box.height}>
            <rect
              x={Math.min(gesture.x0, gesture.x1)}
              y={Math.min(gesture.y0, gesture.y1)}
              width={Math.abs(gesture.x1 - gesture.x0)}
              height={Math.abs(gesture.y1 - gesture.y0)}
            />
          </svg>
        )}
        {gesture?.kind === 'lasso' && gesture.moved && (
          <svg className="scatter-gesture" width={box.width} height={box.height}>
            <polygon points={pairs(gesture.points)} />
          </svg>
        )}

        {!compact && (
          <div className="network-strip nodrag">
            <button
              type="button"
              className="network-strip__btn"
              title="Frame all the points (or double-click)"
              aria-label="Fit to view"
              onClick={fit}
            >
              ⤢
            </button>
            <button
              type="button"
              className="network-strip__btn"
              title="Clear the selection"
              aria-label="Clear selection"
              disabled={stableSelection.length === 0}
              onClick={() => onSelectionChange?.([])}
            >
              ⨯
            </button>
          </div>
        )}
      </div>

      {hovered && hoveredRow !== undefined && (
        <div
          className="chart-tooltip"
          style={{ left: hovered.x + 12, top: hovered.y + 12 }}
          role="status"
        >
          <strong>
            {labelColumn
              ? formatCell(table.data[labelColumn]?.[hoveredRow] ?? null, labelColumn)
              : keyAt(hoveredRow)}
          </strong>
          <div className="chart-tooltip__row">
            <span
              className="chart-tooltip__swatch"
              style={{ background: colors.at(hoveredRow) }}
            />
            {xColumn}: {formatNumber(cellNumber(xValues[hoveredRow]))}
          </div>
          <div className="chart-tooltip__row">
            {yColumn}: {formatNumber(cellNumber(yValues[hoveredRow]))}
          </div>
          {stableColor.column && (
            <div className="chart-tooltip__row">
              {stableColor.column}:{' '}
              {formatCell(table.data[stableColor.column]?.[hoveredRow] ?? null, stableColor.column)}
            </div>
          )}
          {shapeColumn && shapeColumn !== stableColor.column && (
            <div className="chart-tooltip__row">
              {shapeColumn}: {formatCell(table.data[shapeColumn]?.[hoveredRow] ?? null, shapeColumn)}
            </div>
          )}
        </div>
      )}

      {(colors.legend || shapes || (!compact && sizes.domain)) && (
        <div className="legend">
          <ColorKey colors={colors} />
          {!compact && <SizeKey channel={{ spec: stableSize, resolved: sizes }} name="size" />}
          {shapes && <ShapeKey column={shapes.column} entries={shapes.entries} />}
        </div>
      )}

      <div className="viewer__caption">
        <span>
          {yColumn} vs {xColumn} · {plural(usable, 'point')}
          {stableSelection.length > 0 && ` · ${formatNumber(stableSelection.length)} selected`}
        </span>
        {thinned && !compact && (
          <span
            className="viewer__note"
            title="Above Max points a stable stride is drawn. The table passes through whole, and a lasso still catches every row inside it."
          >
            showing {formatNumber(spec?.drawn ?? 0)} of {formatNumber(usable)}
          </span>
        )}
        {dropped > 0 && !compact && (
          <span
            className="viewer__note"
            title="Rows with a missing or non-numeric coordinate — and, under a log axis, values at or below zero, which have no logarithm."
          >
            {formatNumber(dropped)} unplottable
          </span>
        )}
        {singleTrend && !compact && (
          <span
            className="viewer__note"
            title="Pearson correlation, in the space the axes are drawn in."
          >
            r = {singleTrend.r.toFixed(2)}
          </span>
        )}
        {!idColumn && stableSelection.length > 0 && !compact && (
          <span
            className="viewer__note"
            title="This table carries no ID column, so the selection is by row position — it will re-point at different rows if anything upstream reorders or filters."
          >
            by row index
          </span>
        )}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'scatter')}
          source={exportSource}
          compact={compact}
          {...(onExpand ? { onExpand } : {})}
          {...(onError ? { onError } : {})}
        />
      </div>
    </div>
  )
}

/** Flat `[x, y, …]` to the `x,y x,y` an SVG polygon wants. */
function pairs(flat: number[]): string {
  const out: string[] = []
  for (let i = 0; i < flat.length; i += 2) out.push(`${flat[i]},${flat[i + 1]}`)
  return out.join(' ')
}
