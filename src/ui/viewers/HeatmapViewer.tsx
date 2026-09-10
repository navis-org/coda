import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { MatrixValue } from '../../core/values'
import { decodeMatrixSelection, encodeMatrixSelection } from '../../nodes/lib/chartSelection'
import type { ColorLimits, HeatmapPalette } from '../../nodes/lib/heatmapParams'
import { CHART_INK, chartSurface, currentMode } from '../colors'
import { exportBaseName as makeBaseName, matrixToCsv } from '../export'
import { formatCompact, formatNumber, formatZoom } from '../format'
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
  linesInRect,
  matrixExtent,
  panWindow,
  pointToMatrix,
  rampColors,
  selectionBands,
  valueMarks,
  windowScale,
  zoomWindow,
} from './heatmapPlot'
import { prepareCanvas } from './canvas2d'
import { GestureMarquee } from './GestureMarquee'
import { CLICK_SLOP, tooltipPoint } from './tooltipPoint'
import { isAdditive } from './useMarkSelection'
import { useWheelZoom } from './useWheelZoom'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { useElementSize } from './useElementSize'
import { useStable } from './useStable'
import { ChartTooltip, TooltipRow } from './ChartTooltip'
import { ViewerEmpty } from './ViewerEmpty'

export interface HeatmapViewerProps {
  matrix: MatrixValue
  scale?: 'sequential' | 'diverging'
  /** A name from `heatmapParams.ts`; `coda` is the validated default. */
  palette?: HeatmapPalette
  /** Manual ends of the ramp, already parsed — see `readColorLimits`. */
  limits?: ColorLimits
  /** Map the colour through a log, leaving every number on screen as it is. */
  logColor?: boolean
  showValues?: boolean
  compact?: boolean
  /** Filename stem for CSV/SVG/PNG export. */
  baseName?: string
  /**
   * The node's `selection` param, verbatim — `r:`/`c:`-prefixed axis labels.
   *
   * Passed and returned encoded rather than as two arrays, because it is one param: a rectangle
   * is one gesture and has to be one commit. `chartSelection.ts` owns the grammar, so the label
   * this writes and the label `evaluate` matches are one string.
   */
  selection?: string[]
  onSelectionChange?: (ids: string[]) => void
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

/** Stable identity, so an absent `limits` prop does not re-run the domain memo every render. */
const EMPTY_LIMITS: ColorLimits = {}

/**
 * A gesture in progress, in box coordinates.
 *
 * The division is `ScatterViewer`'s, stated in its header and kept here deliberately: bare drag
 * pans, Shift- or ⌘/Ctrl-drag selects — the same assignment React Flow's `panOnDrag` and
 * `selectionKeyCode` give the canvas underneath, so the hand does not change modes when the
 * pointer crosses into a card. Bare drag is the frequent one and keeps the bare gesture.
 */
type Gesture =
  | { kind: 'pan'; lastX: number; lastY: number; moved: boolean }
  | {
      kind: 'box'
      x0: number
      y0: number
      x1: number
      y1: number
      moved: boolean
      /** Alt held at the press: add to the standing selection rather than replacing it. */
      additive: boolean
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
 *
 * ## Selecting rows and columns
 *
 * Shift- or ⌘/Ctrl-drag draws a rectangle and hands back the **positions** it covered, one list
 * per axis, which the node turns into its `Selected Rows` and `Selected Columns` ports. Alt held
 * at the press adds to the standing selection instead of replacing it — the scatter's modifier
 * for the same thing. Bare drag still pans, which is `ScatterViewer`'s division and React
 * Flow's: navigation is the frequent gesture and keeps the bare one.
 *
 * **Positions, not the labels under the box**, and `encodeMatrixSelection` carries the argument:
 * the Labels tab exists to put one name on many lines, so resolving by name selected every row
 * of a cell type when a box was drawn round one of them.
 *
 * Two things follow for the drawing. It is **bands rather than the box that was dragged**, since
 * an additive selection is several blocks and a folded axis puts many lines on one grid cell.
 * And they are **outlined, never tinted**, because colour is the data on this viewer.
 *
 * Clearing is the ⌫ button, or a modifier-click with no drag — but not while Alt is down, where
 * the gesture was "add" and adding nothing should take nothing away. A **bare click clears
 * nothing** either: it is the start of a pan, and reading a cell's tooltip is not a request to
 * lose a selection.
 */
export function HeatmapViewer({
  matrix,
  scale = 'sequential',
  palette = 'coda',
  limits: rawLimits = EMPTY_LIMITS,
  logColor = false,
  showValues = false,
  compact = false,
  baseName,
  selection = [],
  onSelectionChange,
  onExpand,
  onError,
}: HeatmapViewerProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<Hover | null>(null)
  const [view, setView] = useState<HeatmapWindow | undefined>(undefined)
  const [gesture, setGesture] = useState<Gesture | null>(null)
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
  /*
   * By value, not by identity: `readColorLimits` parses two params into a fresh object on every
   * render of the editor, and the domain is a dependency of the *fold* — so an unstable one
   * would re-fold a four-million-cell matrix every time anything on the canvas re-rendered.
   * `useStable` is the rule CLAUDE.md states for exactly this, and the network and scatter
   * viewers were both bitten by it first.
   */
  const limits = useStable(rawLimits)

  /*
   * By value, `limits`' rule one line down and for its reason: `idList` hands the card a fresh
   * array every render, and the bands below are drawn from this.
   */
  const stableSelection = useStable(selection)
  const picked = useMemo(() => decodeMatrixSelection(stableSelection), [stableSelection])
  const selectable = !compact && drawable && Boolean(onSelectionChange)

  const extent = useMemo(() => matrixExtent(matrix.values), [matrix])
  const domain = useMemo(
    () => colorDomain(extent, scale, { limits, log: logColor }),
    [extent, scale, limits, logColor],
  )
  // What the caption has to own up to: cells pushed onto an end, and a mapping that is not
  // linear. Both are invisible in the picture itself, which is exactly why they are said.
  const clipped = extent.min < domain.lo || extent.max > domain.hi

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

  const ramp = useMemo(
    () => rampColors(scale, mode, RAMP_STEPS, palette),
    [scale, mode, palette],
  )
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
   * Zoom about the pointer: the cell under it is the one that must not move. The non-passive
   * listener, the per-frame coalescing and the sensitivity are `useWheelZoom`'s — this was the
   * first of three copies, and the third is what retired them.
   *
   * `nowheel` on the box below is the other half where a card is on the canvas — moot here,
   * since the gesture is off under `compact`, but the class costs nothing.
   */
  useWheelZoom(ref, Boolean(spec) && zoomable, (factor, x, y) => {
    if (!spec) return
    const anchor = pointToMatrix(spec, x, y)
    const next = zoomWindow(spec.window, full, anchor, factor)
    setView(isFullWindow(next, full) ? undefined : next)
  })

  const fit = () => setView(undefined)

  // --- pointer -----------------------------------------------------------
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    const point = tooltipPoint(event, ref.current)
    // `isAdditive` is the canvas's own modifier chord, which is what it means here too — the
    // one gesture that is not a pan. Its name is the four other viewers' use of it.
    if (selectable && isAdditive(event)) {
      event.currentTarget.setPointerCapture(event.pointerId)
      setGesture({
        kind: 'box',
        x0: point.x,
        y0: point.y,
        x1: point.x,
        y1: point.y,
        moved: false,
        // Alt adds, which is `ScatterViewer`'s modifier for the same thing one gesture over.
        additive: event.altKey,
      })
      setHover(null)
      return
    }
    // A pan is only meaningful zoomed in, which is where it has always been gated.
    if (!zoomable || !view) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setGesture({ kind: 'pan', lastX: point.x, lastY: point.y, moved: false })
    setHover(null)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!spec) return
    // Container coordinates, not the viewport's — see `tooltipPoint`.
    const point = tooltipPoint(event, ref.current)
    if (gesture?.kind === 'box') {
      setGesture({
        ...gesture,
        x1: point.x,
        y1: point.y,
        moved:
          gesture.moved || Math.hypot(point.x - gesture.x0, point.y - gesture.y0) > CLICK_SLOP,
      })
      return
    }
    if (gesture) {
      const dx = point.x - gesture.lastX
      const dy = point.y - gesture.lastY
      setView(
        panWindow(
          spec.window,
          full,
          (-dy / Math.max(1, spec.plot.height)) * spec.window.rows,
          (-dx / Math.max(1, spec.plot.width)) * spec.window.cols,
        ),
      )
      setGesture({ kind: 'pan', lastX: point.x, lastY: point.y, moved: true })
      return
    }
    const hit = cellAt(spec, point.x, point.y)
    setHover(hit ? { ...hit, ...point } : null)
  }

  /**
   * The rectangle committed, as positions.
   *
   * **Positions, and every line the box touched** — the two rules this feature rests on, and
   * both live in modules a test can reach: `linesInRect` walks the window rather than the drawn
   * grid, so a box over a folded block means the block, and `encodeMatrixSelection` owns the
   * grammar `evaluate` decodes.
   *
   * Additive is a union rather than a toggle. A second box that overlaps the first is somebody
   * extending a selection, not asking for the overlap back — and a toggle over a folded block,
   * where one grid cell stands for a hundred lines, is a gesture whose result nobody could
   * predict. Clearing is the ⌫ button and a modifier-click.
   */
  const commitBox = (box: Extract<Gesture, { kind: 'box' }>) => {
    if (!spec || !onSelectionChange) return
    const covered = linesInRect(spec, box.x0, box.y0, box.x1, box.y1)
    const rows = box.additive ? new Set(picked.rows) : new Set<number>()
    const cols = box.additive ? new Set(picked.columns) : new Set<number>()
    for (let i = covered.rows[0]; i <= covered.rows[1]; i++) rows.add(i)
    for (let i = covered.cols[0]; i <= covered.cols[1]; i++) cols.add(i)
    onSelectionChange(encodeMatrixSelection(rows, cols))
  }

  const clear = () => onSelectionChange?.([])

  const onPointerUp = () => {
    const current = gesture
    setGesture(null)
    if (current?.kind !== 'box') return
    if (current.moved) {
      commitBox(current)
      return
    }
    /*
     * A modifier-click with no drag clears, which is `ScatterViewer`'s rule — except while Alt
     * is held, where the gesture in progress was "add", and adding nothing is nothing rather
     * than a request to lose what is there. A *bare* click deliberately clears nothing either:
     * it is the start of a pan, and reading a cell's tooltip is not asking to lose a selection.
     */
    if (!current.additive) clear()
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

  /*
   * The caption's two numbers, apart from the bands: they depend on the selection and the axis
   * lengths and not on the spec, so a pan or a zoom — which mints a new spec every frame — must
   * not re-walk both picked sets to recompute a caption that cannot have changed.
   *
   * Counted over the whole axis rather than over the window, because the caption is about what
   * leaves the node: scrolling a selected row off screen does not deselect it. And counted
   * against the axis's *length* rather than as `picked.size`, because an index the matrix no
   * longer has carries no row — the node drops those for the same reason.
   */
  const selectedCount = useMemo(() => {
    const count = (length: number, set: ReadonlySet<number>) => {
      let n = 0
      for (const i of set) if (i < length) n++
      return n
    }
    return {
      rows: count(matrix.rowLabels.length, picked.rows),
      columns: count(matrix.colLabels.length, picked.columns),
    }
  }, [matrix.rowLabels.length, matrix.colLabels.length, picked])

  /*
   * The bands, measured and built as elements in one memo — this component re-renders at
   * pointer-poll rate on hover and on every frame of a box drag, and an unmemoised group
   * rebuilds one `<rect>` per run on each axis for React to diff against an identical tree.
   * `spec` does not depend on the hover or the gesture, so neither does this.
   *
   * A band per run of selected lines, outlined rather than tinted: colour *is* the data here, so
   * a translucent wash over the cells would change what every cell in the selection appears to
   * say. Rows span the plot's width and columns its height, which draws a cross rather than the
   * rectangle that was dragged — and that is the honest picture, since the two axes leave this
   * node as two independent lists.
   *
   * `data-axis` because the two are indistinguishable by shape once a selection is wide: a
   * column band spans the plot's whole height, so every row tick's y falls inside one.
   * `pnpm probe:heatmap-select` reads it, and read it wrongly first — the check passed against
   * the column band.
   */
  const bandRects = useMemo(() => {
    if (!spec) return null
    const { plot } = spec
    const bands = {
      rows: selectionBands(spec.rowMap, picked.rows),
      columns: selectionBands(spec.colMap, picked.columns),
    }
    return (
      // The clip id spelled out rather than through `clip()`, which is declared below the early
      // returns — a hook may not close over it.
      <g clipPath={`url(#${clipId}-plot)`} className="heatmap-band">
        {bands.rows.map((band) => (
          <rect
            key={`r${band.from}`}
            data-axis="rows"
            x={plot.x}
            y={band.from}
            width={plot.width}
            height={Math.max(1, band.to - band.from)}
          />
        ))}
        {bands.columns.map((band) => (
          <rect
            key={`c${band.from}`}
            data-axis="columns"
            x={band.from}
            y={plot.y}
            width={Math.max(1, band.to - band.from)}
            height={plot.height}
          />
        ))}
      </g>
    )
  }, [spec, picked, clipId])

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
    return <ViewerEmpty>Matrix is empty</ViewerEmpty>
  }
  if (oversized) {
    /*
     * The one shape with no picture on the other side of it — past `CRASH_FLOOR_CELLS`, which
     * nothing upstream can produce anyway. It used to say this at four million, where the
     * honest answer is a slower first layout and a caption; see `HEATMAP_CELLS_WARN`.
     */
    return (
      <ViewerEmpty>
        {rows.toLocaleString()} × {cols.toLocaleString()} is {cells.toLocaleString()} cells,
        more than a browser can hold as one grid.
        <br />
        Aggregate upstream — e.g. group by type before pivoting.
      </ViewerEmpty>
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
          cursor:
            gesture?.kind === 'pan'
              ? 'grabbing'
              : gesture
                ? 'crosshair'
                : view
                  ? 'grab'
                  : 'default',
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
          onPointerUp={onPointerUp}
          onPointerCancel={() => setGesture(null)}
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

            {bandRects}

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

        {/* The marquee, outside the overlay's clip and out of the canvas repaint: a gesture
            that re-folded the matrix per pointer move is not a gesture. */}
        {gesture?.kind === 'box' && gesture.moved && (
          <GestureMarquee {...gesture} width={size.width} height={size.height} />
        )}

        {zoomable && (
          // Bottom right rather than the strip's usual top right, which here is the column
          // gutter: at ×15 the button sat on the last column's name. Seen in a browser.
          <div className="network-strip network-strip--bottom nodrag">
            {/*
              Only where a selection can be made at all, which is `selectable` and not
              `zoomable`: on a surface with no `onSelectionChange` — a dashboard cell reading a
              node it cannot write to — a clear button would be a control that does nothing.
              `disabled` says the rest, so the button does not appear and vanish under the
              pointer as a selection comes and goes. `ScatterViewer`'s button, one viewer over.
            */}
            {selectable && (
              <button
                type="button"
                className="network-strip__btn"
                title="Clear the selection (or shift-click the plot)"
                aria-label="Clear selection"
                disabled={picked.rows.size === 0 && picked.columns.size === 0}
                onClick={clear}
              >
                ⌫
              </button>
            )}
            <button
              type="button"
              className="network-strip__btn"
              title="Show the whole matrix (or double-click). Scroll to zoom, drag to pan; shift-drag to select, alt-shift-drag to add."
              aria-label="Fit to view"
              disabled={!view}
              onClick={fit}
            >
              ⤢
            </button>
          </div>
        )}

        {hovered && hover && (
          <ChartTooltip at={hover}>
            <strong>
              {hovered.row} → {hovered.col}
            </strong>
            <TooltipRow>
              {formatNumber(hovered.value)}
              {matrix.valueLabel ? ` ${matrix.valueLabel}` : ''}
            </TooltipRow>
            {spec?.folded && (
              // The block under the pointer stands for many cells and is drawn as the
              // strongest of them, so say which one is being named.
              <TooltipRow>strongest of ~{spec.foldFactor.toLocaleString()} cells</TooltipRow>
            )}
          </ChartTooltip>
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
        {clipped && !compact && (
          <span
            className="viewer__note"
            title={`The colour scale stops at ${formatCompact(domain.lo)} and ${formatCompact(
              domain.hi,
            )}, and this matrix runs ${formatCompact(extent.min)} to ${formatCompact(
              extent.max,
            )}. Cells outside are drawn in the end colour they passed, not dropped.`}
          >
            values clipped
          </span>
        )}
        {domain.log && !compact && (
          <span
            className="viewer__note"
            title="The colour runs on a log scale, so equal steps of colour are not equal steps of value. The numbers — the printed cells, the tooltip and the two ends of the bar — are the values themselves."
          >
            log colour
          </span>
        )}
        {limits.problem && !compact && (
          <span
            className="viewer__note"
            title={`The colour limits are being ignored because ${limits.problem}. The scale is the one the data gives.`}
          >
            limits ignored
          </span>
        )}
        {(selectedCount.rows > 0 || selectedCount.columns > 0) && !compact && (
          // The count is the caption's, where the scatter puts its own: the inspector's field
          // says how many *lines* are stored, and only this knows how many of them the matrix
          // on screen still has.
          <span
            className="viewer__note"
            title="Shift-drag to select a rectangle, alt-shift-drag to add another; ⌫ or shift-click to clear. Rows and columns leave the node on their own ports."
          >
            {formatNumber(selectedCount.rows)} × {formatNumber(selectedCount.columns)} selected
          </span>
        )}
        {view && spec && (
          <span
            className="viewer__note"
            title={`Zoomed in: rows ${Math.floor(spec.window.row0) + 1}–${Math.ceil(spec.window.row0 + spec.window.rows)} of ${rows.toLocaleString()}, columns ${Math.floor(spec.window.col0) + 1}–${Math.ceil(spec.window.col0 + spec.window.cols)} of ${cols.toLocaleString()}. Scroll to zoom, drag to pan, double-click or ⤢ to fit.`}
          >
            ×{formatZoom(zoom)}
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
