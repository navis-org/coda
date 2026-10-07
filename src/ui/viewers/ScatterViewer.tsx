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

import type {
  ColorSpec,
  MarkerShape,
  ShapeSpec,
  SizeSpec,
} from '../../nodes/lib/encodingParams'
import { writeOverrides } from '../../nodes/lib/encodingParams'
import { rowKeys } from '../../nodes/lib/rowIds'
import type { TableValue } from '../../core/values'
import { CHART_INK, chartSurface } from '../../style/colors'
import { currentMode } from '../useThemeMode'
import { rampLabel, resolveColor, resolveShape, resolveSize } from '../../style/encoding'
import { exportBaseName as makeBaseName, tableToCsvParts } from '../export'
import { formatCell, formatCompact, formatNumber, plural } from '../../style/format'
import { GestureMarquee } from './GestureMarquee'
import { ColorKey, ShapeKey, SizeKey } from './LegendKeys'
import type { LegendItem } from './scatterDraw'
import { drawScatter, measureLabel, scatterToSvg } from './scatterDraw'
import type { PlacedLabel } from './scatterLabels'
import { labelRequests, placePointLabels } from './scatterLabels'
import { DEFAULT_SEARCH, searchHits, searchMatcher } from './pointSearch'
import type { Rect, ScaleKind, ScatterMarks, ScatterSpec, Viewport } from './scatterPlot'
import {
  buildHitIndex,
  labelsApply,
  reachesPlot,
  buildMarks,
  buildScatter,
  cellNumber,
  equaliseAspect,
  rectPolygon,
  rowsInPolygon,
  unprojectX,
  unprojectY,
} from './scatterPlot'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { CLICK_SLOP, tooltipPoint } from './tooltipPoint'
import { prepareCanvas, uiFontFamily } from './canvas2d'
import { useDismissOnOutside } from '../useDismiss'
import { useElementSize } from './useElementSize'
import { useStable } from './useStable'
import { useWheelZoom } from './useWheelZoom'
import { ChartTooltip, TooltipRow } from './ChartTooltip'
import { ViewerEmpty } from './ViewerEmpty'

export interface ScatterViewerProps {
  table: TableValue
  xColumn: string
  yColumn: string
  xScale: ScaleKind
  yScale: ScaleKind
  aspect: 'fit' | 'equal'
  color: ColorSpec
  size: SizeSpec
  shape: ShapeSpec
  /**
   * Write a param back, which is how a legend pin survives a rerender.
   *
   * Only the shape key uses it — the colour key here is still inert, as it is on the network.
   */
  onParamChange?: ((paramId: string, value: string) => void) | undefined
  labelColumn?: string
  /** How a selected point is named downstream. Undefined means the row index. */
  idColumn?: string
  opacity: number
  /** Every exported mark a vector shape, even past `CIRCLES_MAX`. */
  vectorMarks?: boolean
  /** Listed in the tooltip after its own rows. */
  hoverColumns?: readonly string[]
  /** Labels beside the points, while at most `limit` are in view. Absent means none. */
  pointLabels?: { limit: number; lines: boolean; unplaced: 'hide' | 'dim' }
  trend: 'none' | 'linear'
  trendPerGroup: boolean
  selection: string[]
  onSelectionChange?: (ids: string[]) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

const NO_COLUMNS: readonly string[] = []
const NO_HITS: readonly number[] = []

/** How close the pointer has to be to a mark for the tooltip to claim it. */
const HOVER_RADIUS = 12

/** Minimum pointer travel between recorded lasso vertices. */
const LASSO_STEP = 4

const MARGIN_FULL = { top: 10, right: 14, bottom: 40, left: 50 }
/*
 * Room for tick labels, and none for axis titles.
 *
 * It was 6px on every side, which is a grid and an axis line with no numbers against them —
 * i.e. a box of dots, since an axis without a scale is decoration. The numbers are what say
 * whether the cloud spans ten synapses or ten thousand, and that is the first thing anybody
 * asks of a scatter on a card.
 *
 * The titles stay behind `compact`: they need another ~22px below the ticks, and the caption
 * under the card already reads `post vs pre`, so on this surface they would be the one label
 * that is genuinely redundant.
 */
const MARGIN_COMPACT = { top: 5, right: 8, bottom: 20, left: 30 }

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
  shape,
  onParamChange,
  labelColumn,
  idColumn,
  opacity,
  vectorMarks = false,
  hoverColumns = NO_COLUMNS,
  pointLabels,
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
  const stableShape = useStable(shape)
  const shapes = useMemo(() => resolveShape(table, stableShape), [table, stableShape])

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

  /*
   * Two memos, and the split is the performance. `marks` is everything a pan cannot change — the
   * cells read, the encodings resolved, the stacking order, the trend fit — and `spec` is one
   * frame of it under a view. A pan or a resize rebuilds only the second, and the GPU pass keeps
   * the first uploaded (`scatterGl.ts`); see `ScatterMarks`.
   */
  const marks: ScatterMarks | undefined = useMemo(() => {
    if (!xValues || !yValues) return undefined
    return buildMarks({
      xValues,
      yValues,
      length: table.length,
      xScale,
      yScale,
      trend,
      trendPerGroup,
      style: {
        colorAt: colors.at,
        radiusAt: sizes.at,
        shapeAt: shapes.at,
      },
    })
  }, [
    xValues,
    yValues,
    table.length,
    xScale,
    yScale,
    trend,
    trendPerGroup,
    colors,
    sizes,
    shapes,
  ])

  const spec: ScatterSpec | undefined = useMemo(() => {
    if (!marks || plot.width < 10 || plot.height < 10) return undefined
    return buildScatter({
      marks,
      plot,
      ...(framed ? { view: framed } : {}),
      aspect,
      trendColor: ink.primary,
    })
  }, [marks, plot, framed, aspect, ink.primary])

  const hitIndex = useMemo(() => (spec ? buildHitIndex(spec) : undefined), [spec])

  // --- selection ---------------------------------------------------------
  const keyAt = useMemo(() => rowKeys(table, idColumn), [table, idColumn])
  const selectedKeys = useMemo(() => new Set(stableSelection.map(String)), [stableSelection])
  // Positions in `marks`, which a pan does not move — so this is not redone per frame, where a
  // key per row was 129,325 strings built on every pointer move.
  const selectedIndices = useMemo(() => {
    const out = new Set<number>()
    if (!marks || selectedKeys.size === 0) return out
    for (let i = 0; i < marks.rows.length; i++) {
      if (selectedKeys.has(keyAt(marks.rows[i]!))) out.add(i)
    }
    return out
  }, [marks, selectedKeys, keyAt])

  const commitRows = useCallback(
    (rows: number[], additive: boolean) => {
      const keys = additive ? new Set(selectedKeys) : new Set<string>()
      for (const row of rows) keys.add(keyAt(row))
      onSelectionChange?.([...keys])
    },
    [keyAt, onSelectionChange, selectedKeys],
  )

  // --- point labels --------------------------------------------------------
  // Placed per frame while few enough marks are in view. The last frame's labels are kept (by the
  // painting effect, not in here) so their slots are tried first: a pan does not flip a label from
  // one side of its point to the other. The export draws the same labels from that ref.
  const stableLabels = useStable(pointLabels)
  const lastLabels = useRef<readonly PlacedLabel[] | undefined>(undefined)
  // `withheld` while more than the limit are in view, which the caption says; undefined while
  // labels are off.
  const labelling = useMemo(():
    | { withheld: true }
    | { withheld: false; labels: readonly PlacedLabel[]; omitted: number }
    | undefined => {
    if (!stableLabels || !spec) return undefined
    if (!labelsApply(spec, stableLabels.limit)) return { withheld: true }
    const { requests, obstacles } = labelRequests(
      spec,
      (mark) => {
        const row = spec.marks.rows[mark]!
        return labelColumn
          ? formatCell(table.data[labelColumn]?.[row] ?? null, labelColumn)
          : keyAt(row)
      },
      measureLabel,
      (mark) => (selectedIndices.has(mark) ? 0 : 1),
    )
    const labels = placePointLabels(requests, {
      bounds: spec.plot,
      obstacles,
      leaders: stableLabels.lines,
      unplaced: stableLabels.unplaced,
      previous: lastLabels.current,
    })
    // Said on the caption: a label left out is otherwise indistinguishable from an empty cell.
    return { withheld: false, labels, omitted: requests.length - labels.length }
  }, [stableLabels, spec, table, labelColumn, keyAt, selectedIndices])
  const placedLabels = labelling?.withheld === false ? labelling.labels : undefined

  // The picked columns after the tooltip's own rows, leaving out any it already shows.
  const extraTipColumns = useMemo(() => {
    const shown = new Set([
      labelColumn,
      xColumn,
      yColumn,
      stableColor.column,
      shapes.legend?.column,
    ])
    return hoverColumns.filter((name) => !shown.has(name) && name in table.data)
  }, [hoverColumns, labelColumn, xColumn, yColumn, stableColor.column, shapes.legend, table])

  // --- search --------------------------------------------------------------
  // In a strip of its own, on the expanded card only. Matches the label and id by default, or one
  // picked column (`pointSearch.ts`); ‹ › pan to each hit at the current zoom and ring it, and the
  // selection is written only when somebody presses for it. The box and its menu close together;
  // the column and options are kept while the card is open.
  const [search, setSearch] = useState<{ term: string; menu: boolean } | null>(null)
  const [prefs, setPrefs] = useState({ column: '', options: DEFAULT_SEARCH })
  const searching = search !== null
  // Keyed on the term, not the search object: opening the menu must not make a new list of hits,
  // which would start the cursor over.
  const term = search?.term
  const matcher = useMemo(
    () => (term === undefined ? undefined : searchMatcher(term, prefs.options)),
    [term, prefs.options],
  )
  // The texts a point is known by, built once rather than per keystroke: formatting a number
  // column of 129,325 rows through `toLocaleString` was 1.5 s a keystroke, matching it 4 ms.
  const searchTexts = useMemo(() => {
    if (!searching || !marks) return undefined
    const column = prefs.column && prefs.column in table.data ? prefs.column : labelColumn
    const text = (row: number) =>
      column ? formatCell(table.data[column]?.[row] ?? null, column) : ''
    return {
      names: Array.from(marks.rows, text),
      // The id alongside the label, unless one column was picked to search instead.
      ids: prefs.column ? undefined : Array.from(marks.rows, (row) => keyAt(row)),
    }
  }, [searching, marks, prefs.column, table, labelColumn, keyAt])
  const hits = useMemo(() => {
    if (!searchTexts || !matcher) return NO_HITS
    const { names, ids } = searchTexts
    return searchHits(
      names.length,
      (mark) => (ids ? [names[mark]!, ids[mark]!] : [names[mark]!]),
      matcher,
    )
  }, [searchTexts, matcher])
  // Which hit the search is on, kept with the list it indexes, so a new list starts before its first.
  const [cursor, setCursor] = useState({ of: NO_HITS, at: -1 })
  const hitAt = cursor.of === hits ? cursor.at : -1
  const currentHit = hitAt >= 0 ? hits[hitAt] : undefined
  const searchError = matcher && 'error' in matcher ? matcher.error : undefined
  const hitCount = searchError
    ? 'bad pattern'
    : !search?.term.trim()
      ? ''
      : hitAt >= 0
        ? `${formatNumber(hitAt + 1)} / ${formatNumber(hits.length)}`
        : formatNumber(hits.length)

  const stepHit = (direction: 1 | -1) => {
    if (!spec || hits.length === 0) return
    const next =
      hitAt < 0 && direction < 0
        ? hits.length - 1
        : (hitAt + direction + hits.length) % hits.length
    setCursor({ of: hits, at: next })
    // Centred at the zoom somebody chose: finding a point is not a reason to change the scale.
    const mark = hits[next]!
    const halfX = (spec.view.x.max - spec.view.x.min) / 2
    const halfY = (spec.view.y.max - spec.view.y.min) / 2
    const x = spec.marks.xt[mark]!
    const y = spec.marks.yt[mark]!
    setView({ x: { min: x - halfX, max: x + halfX }, y: { min: y - halfY, max: y + halfY } })
  }
  const selectHits = (additive: boolean) => {
    if (!marks || hits.length === 0) return
    commitRows(
      hits.map((mark) => marks.rows[mark]!),
      additive,
    )
  }
  const searchBar = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(
    () => setSearch((open) => (open ? { ...open, menu: false } : open)),
    [],
  )
  // Over the whole bar, so a press on ⋯ toggles rather than closing and reopening the menu.
  useDismissOnOutside(searchBar, closeMenu, { onEscape: true, enabled: search?.menu === true })
  /** Where the tooltip for a hit goes: over its mark, in the viewer's own coordinates. */
  const searchTipAt = (mark: number | undefined) => {
    const plotBox = wrapRef.current
    if (mark === undefined || !spec || !plotBox) return null
    const x = spec.px[mark]!
    const y = spec.py[mark]!
    if (!reachesPlot(spec.plot, x, y, 0)) return null
    const box = plotBox.getBoundingClientRect()
    // The plot's pixels to the client's, through the zoom `tooltipPoint` then takes back out.
    const zoom = plotBox.offsetWidth > 0 ? box.width / plotBox.offsetWidth : 1
    const point = tooltipPoint(
      { clientX: box.left + x * zoom, clientY: box.top + y * zoom },
      viewerRef.current,
    )
    return { index: mark, ...point }
  }

  // --- painting ----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !spec) return
    const context = prepareCanvas(canvas, box.width, box.height)
    if (!context) return
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
      ...(placedLabels ? { labels: placedLabels } : {}),
      ...(hits.length ? { hits } : {}),
      ...(currentHit !== undefined ? { current: currentHit } : {}),
      compact,
    })
    lastLabels.current = placedLabels
  }, [
    spec,
    ink,
    surface,
    opacity,
    xColumn,
    yColumn,
    selectedIndices,
    hovered,
    placedLabels,
    hits,
    currentHit,
    compact,
    box,
  ])

  // --- zoom --------------------------------------------------------------
  // The shared hook: a native non-passive listener, and one update per animation frame.
  useWheelZoom(wrapRef, spec !== undefined, (factor, px, py) => {
    if (!spec) return
    // Zoom about the pointer: the value under it is the one that must not move.
    const anchorX = unprojectX(px, spec.view, spec.plot)
    const anchorY = unprojectY(py, spec.view, spec.plot)
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
  })

  // --- pointer -----------------------------------------------------------
  /*
   * In the element's own pixels, which is what the plot is laid out in. Through `tooltipPoint`,
   * which divides out React Flow's zoom: the gestures are live on the card too, at whatever scale
   * the canvas is at, and a raw client offset put the hover and the lasso that factor away.
   */
  const localPoint = (event: React.PointerEvent<HTMLDivElement>): { x: number; y: number } =>
    tooltipPoint(event, event.currentTarget)

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
      const key = keyAt(spec.marks.rows[index]!)
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

    if (!polygon) return
    commitRows(rowsInPolygon(spec, polygon), current.kind === 'lasso' && current.additive)
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
    if (shapes.legend) {
      for (const entry of shapes.legend.entries) {
        items.push({ label: entry.label, shape: entry.shape })
      }
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
                label: rampLabel(colors.legend),
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
          // The face the labels and ticks were measured and painted in, not whatever the wrapper
          // happens to inherit.
          font: uiFontFamily(),
          opacity,
          xLabel: xColumn,
          yLabel: yColumn,
          title: `${yColumn} against ${xColumn}`,
          legend: legendItems,
          ...(ramp ? { ramp } : {}),
          vectorMarks,
          ...(lastLabels.current ? { labels: lastLabels.current } : {}),
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
      vectorMarks,
    ],
  )

  // --- empty states ------------------------------------------------------
  if (!xValues || !yValues) {
    return <ViewerEmpty>Pick two numeric columns to plot.</ViewerEmpty>
  }
  if (table.length === 0) {
    return <ViewerEmpty>Nothing to plot — the table is empty.</ViewerEmpty>
  }

  const usable = marks?.rows.length ?? 0
  const dropped = marks?.skipped ?? 0
  const singleTrend = spec?.trends.length === 1 ? spec.trends[0] : undefined
  // The tooltip is the pointer's, or else the current search hit's, placed over its mark.
  const tipped = hovered ?? searchTipAt(currentHit)
  const hoveredRow = tipped && spec ? spec.marks.rows[tipped.index] : undefined

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
            gesture redrawing a hundred thousand marks per pointer move is not a gesture. */}
        {gesture?.kind === 'box' && gesture.moved && (
          <GestureMarquee {...gesture} width={box.width} height={box.height} />
        )}
        {gesture?.kind === 'lasso' && gesture.moved && (
          <svg className="chart-gesture" width={box.width} height={box.height}>
            <polygon points={pairs(gesture.points)} />
          </svg>
        )}
      </div>

      {/* Siblings of the plot rather than children of it: the plot takes pointer capture on every
          press to start a pan, which would send a button's release — and its click — to the plot. */}
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
          <button
            type="button"
            className="network-strip__btn"
            title="Find points by name"
            aria-label="Search"
            aria-pressed={searching}
            onClick={() => setSearch(searching ? null : { term: '', menu: false })}
          >
            ⌕
          </button>
        </div>
      )}

      {!compact && search && (
        <div
          ref={searchBar}
          className="network-strip network-strip--below nodrag"
          role="search"
        >
          <input
            className="network-strip__find"
            type="search"
            value={search.term}
            placeholder="Find…"
            aria-label="Find points"
            aria-invalid={searchError !== undefined}
            // Opened by a press, so typing is what comes next.
            autoFocus
            onChange={(event) => setSearch({ ...search, term: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') stepHit(event.shiftKey ? -1 : 1)
              if (event.key === 'Escape') setSearch(null)
            }}
          />
          <span
            className="network-strip__count"
            {...(searchError ? { title: searchError } : {})}
          >
            {hitCount}
          </span>
          <button
            type="button"
            className="network-strip__btn"
            title="Previous hit (Shift+Enter)"
            aria-label="Previous hit"
            disabled={hits.length === 0}
            onClick={() => stepHit(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="network-strip__btn"
            title="Next hit (Enter)"
            aria-label="Next hit"
            disabled={hits.length === 0}
            onClick={() => stepHit(1)}
          >
            ›
          </button>
          <button
            type="button"
            className="network-strip__btn"
            title="Select every hit (Shift adds them to the selection)"
            aria-label="Select hits"
            disabled={hits.length === 0 || !onSelectionChange}
            onClick={(event) => selectHits(event.shiftKey)}
          >
            ◎
          </button>
          <button
            type="button"
            className="network-strip__btn"
            title="Search options"
            aria-label="Search options"
            aria-expanded={search.menu}
            onClick={() => setSearch({ ...search, menu: !search.menu })}
          >
            ⋯
          </button>
          {search.menu && (
            <div className="network-strip__menu">
              <label>
                Search in{' '}
                <select
                  value={prefs.column}
                  onChange={(event) => setPrefs({ ...prefs, column: event.target.value })}
                >
                  <option value="">Label and id</option>
                  {table.schema.columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {(
                [
                  ['exact', 'Whole value only'],
                  ['caseSensitive', 'Match case'],
                  ['regex', 'Regular expression'],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={prefs.options[key]}
                    onChange={(event) =>
                      setPrefs({
                        ...prefs,
                        options: { ...prefs.options, [key]: event.target.checked },
                      })
                    }
                  />{' '}
                  {label}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {tipped && hoveredRow !== undefined && (
        <ChartTooltip at={tipped}>
          <strong>
            {labelColumn
              ? formatCell(table.data[labelColumn]?.[hoveredRow] ?? null, labelColumn)
              : keyAt(hoveredRow)}
          </strong>
          <TooltipRow swatch={colors.at(hoveredRow)}>
            {xColumn}: {formatNumber(cellNumber(xValues[hoveredRow]))}
          </TooltipRow>
          <TooltipRow>
            {yColumn}: {formatNumber(cellNumber(yValues[hoveredRow]))}
          </TooltipRow>
          {stableColor.column && (
            <TooltipRow>
              {stableColor.column}:{' '}
              {formatCell(
                table.data[stableColor.column]?.[hoveredRow] ?? null,
                stableColor.column,
              )}
            </TooltipRow>
          )}
          {shapes.legend && shapes.legend.column !== stableColor.column && (
            <TooltipRow>
              {shapes.legend.column}:{' '}
              {formatCell(
                table.data[shapes.legend.column]?.[hoveredRow] ?? null,
                shapes.legend.column,
              )}
            </TooltipRow>
          )}
          {extraTipColumns.map((name) => (
            <TooltipRow key={name}>
              {name}: {formatCell(table.data[name]?.[hoveredRow] ?? null, name)}
            </TooltipRow>
          ))}
        </ChartTooltip>
      )}

      {(colors.legend || shapes.legend || (!compact && sizes.domain)) && (
        <div className="legend">
          <ColorKey colors={colors} />
          {!compact && <SizeKey channel={{ spec: stableSize, resolved: sizes }} name="size" />}
          {shapes.legend && (
            <ShapeKey
              column={shapes.legend.column}
              entries={shapes.legend.entries}
              {...(onParamChange && !compact
                ? {
                    onReshape: (label: string, mark: MarkerShape) =>
                      onParamChange(
                        'pointShapeOverrides',
                        writeOverrides({ ...(stableShape.overrides ?? {}), [label]: mark }),
                      ),
                  }
                : {})}
            />
          )}
        </div>
      )}

      <div className="viewer__caption">
        <span>
          {yColumn} vs {xColumn} · {plural(usable, 'point')}
          {stableSelection.length > 0 && ` · ${formatNumber(stableSelection.length)} selected`}
        </span>
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
        {labelling?.withheld && stableLabels && spec && !compact && (
          <span
            className="viewer__note"
            title={`Labels are drawn once at most ${formatNumber(stableLabels.limit)} points are in view (Label up to); there are ${formatNumber(spec.visible.length)}.`}
          >
            zoom in for labels
          </span>
        )}
        {labelling?.withheld === false && labelling.omitted > 0 && !compact && (
          <span
            className="viewer__note"
            title="Labels with no free space around their point, left out rather than drawn over each other or over other points. Zoom in, or draw them faintly (Labels that do not fit)."
          >
            {plural(labelling.omitted, 'label')} left out
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
