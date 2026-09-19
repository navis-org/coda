import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { MatrixValue } from '../../core/values'
import { decodeMatrixSelection, encodeMatrixSelection } from '../../nodes/lib/chartSelection'
import type { ColorLimits, HeatmapPalette } from '../../nodes/lib/heatmapParams'
import { CHART_INK, chartSurface, currentMode } from '../colors'
import { exportBaseName as makeBaseName, matrixToCsv } from '../export'
import { formatCompact, formatNumber, formatZoom } from '../format'
import { RAMP_STEPS, rampColors, rampNotes } from '../encoding'
import { drawHeatmap, heatmapToSvg } from './heatmapDraw'
import { CRASH_FLOOR_CELLS } from '../../core/limits'
import type { HeatmapWindow } from './heatmapPlot'
import {
  HEATMAP_CELLS_WARN,
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
  /**
   * `square` fills each cell; `circle` draws a disc whose **area** is the value, so magnitude is
   * carried twice — by the colour and by the size.
   *
   * Asked for, not granted: a circle needs a cell several pixels across, and past one cell per
   * pixel the grid is folded and a block stands for many cells. `spec.circlesFit` is the other
   * half, and the caption says so when it is the one that wins.
   */
  cellShape?: 'square' | 'circle'
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
 *
 * A box with no drag in it is not nothing: on an adding chord it is the **one cell under the
 * press**, and on a bare selection chord it clears. See `onPointerUp`.
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
      /** An adding chord held at the press — see `addsToSelection`. */
      additive: boolean
    }

/**
 * Whether the press *adds* to the standing selection rather than replacing it.
 *
 * A second question from `isAdditive`, which asks whether the press is a selection at all
 * (Shift **or** ⌘/Ctrl, the canvas's own chord) — so the adding chord has to be something
 * neither of those alone already means. **Shift+⌘/Ctrl** is that, and it reads as the thing it
 * is: the selection chord, with more of it.
 *
 * **Alt is kept**, where retiring it would have been tidier. It is `ScatterViewer`'s modifier
 * for the same act one viewer over, and that vocabulary is shared on purpose — a heatmap that
 * answered a hand's Alt+Shift by *replacing* the selection it had just added to would be the
 * kind of silent wrong this codebase spends its comments on. Two chords for one act is the
 * price, and it is paid in the help text rather than in a gesture.
 */
function addsToSelection(event: {
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}): boolean {
  return event.altKey || (event.shiftKey && (event.metaKey || event.ctrlKey))
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
  cellShape = 'square',
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
  /*
   * **On the card as well as expanded**, which is the one gesture here that is not gated on
   * `compact`. It was, and the recorded reason was React Flow's: shift-drag belongs to the
   * pane's own selection box. That turned out to be a fact about *where the press lands* rather
   * than about cards — the pane claims a shift-press anywhere inside it, our canvas included,
   * takes the pointer capture and stops propagation before our handler runs. `nokey` on the
   * container below is React Flow's own way of saying "not this subtree", so the press reaches
   * the heatmap and the pane rubber band starts from empty canvas as it always did.
   *
   * Zoom and pan stay expanded-only: those are `zoomable`, and a preview React Flow already
   * zooms has no business having a second zoom inside it. Selecting is the opposite case — it
   * writes a param, and asking somebody to expand a card to do it was a step in the way.
   */
  const selectable = drawable && Boolean(onSelectionChange)

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

  /*
   * The param `&&` the size test — `Show values`' arrangement and its recorded reason: folding
   * the choice into `buildHeatmapSpec` would put it in the dependency list of a pass that walks
   * every cell, so toggling the mark would re-fold the matrix to change a drawing.
   */
  const circles = cellShape === 'circle' && spec !== null && spec.circlesFit
  // Asked for and refused, which is the only state worth a caption line.
  const circlesTooSmall = cellShape === 'circle' && spec !== null && !spec.circlesFit

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
      circles,
    })
  }, [spec, ramp, surface, size.width, size.height, circles])

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
        additive: addsToSelection(event),
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

  /**
   * One cell added, which is what a press with no drag in it means on an adding chord.
   *
   * **`cellAt`, not a zero-width `linesInRect`.** The degenerate rectangle is the obvious reuse
   * and it is wrong twice: `pointToMatrix` is a bare linear map with no bounds of its own, so a
   * press in a label gutter comes back clamped to line 0 and silently selects the first row or
   * column; and a press landing exactly on a line boundary spans `[k, k - 1]`, which is empty.
   * `cellAt` is the function the hover ring and the tooltip already ask, so what a click takes
   * is what the card was pointing at when it was clicked — including on a folded block, where
   * the cell named is the strongest one the block is drawn as rather than the hundred behind it.
   *
   * Always a union: the chord that gets here is the adding one, and its whole meaning is more.
   */
  const commitCell = (x: number, y: number) => {
    if (!spec || !onSelectionChange) return
    const hit = cellAt(spec, x, y)
    if (!hit) return
    const rows = new Set(picked.rows)
    const cols = new Set(picked.columns)
    rows.add(hit.row)
    cols.add(hit.col)
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
     * No drag. On an adding chord that is the cell under the press — a rectangle covering one
     * cell is a rectangle, and refusing it would make "select these two cells" a gesture nobody
     * can perform without dragging a box narrower than the slop.
     *
     * On a bare selection chord it clears, which is `ScatterViewer`'s rule and now the only way
     * the plot itself clears — the ⌫ button is gone. A *bare* click deliberately clears nothing:
     * it is the start of a pan, and reading a cell's tooltip is not asking to lose a selection.
     */
    if (current.additive) {
      commitCell(current.x0, current.y0)
      return
    }
    clear()
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
            ...(showValues
              ? valueMarks(spec, matrix.values, ramp, { circles, background: surface })
              : []),
            ...axisMarks(spec, ink.secondary),
          ]
        : [],
    [spec, matrix.values, ramp, ink.secondary, showValues, circles, surface],
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
   * **Two layers, a light core over a dark casing, and no hue at all** — the same rects drawn
   * twice, all the casings beneath all the cores so one band's casing cannot overdraw its
   * neighbour's core. This was a 1.5px `--accent` line, which is blue, on a heatmap whose
   * default palette is *Coda blue*; measured against all twelve palettes in both themes its
   * worst-case contrast against a cell was **1.00:1**, i.e. somewhere on every ramp it is
   * exactly invisible. And that is not a fact about blue: every single colour tried came back
   * between 1.00 and 1.96, yellow included — worst of all on viridis, inferno and magma, whose
   * top *is* yellow. A ramp spans the hue circle and every lightness, so no one colour can sit
   * on top of one. A light-and-dark pair can, because any cell is either lighter or darker than
   * mid grey and the other tone then reads: white over black measures **4.59:1** at its worst
   * cell of any palette, above the 4.5 floor for text. The core is **dashed**, which is the half
   * that number could not see — the band's other neighbour is the inter-cell separator, and that
   * is the *surface* showing through rather than a painted colour, so on each theme one of the
   * casing's two tones is already the grid. An interrupted line cannot be mistaken for a
   * continuous one whatever colour either is. See `docs/viewers.md`.
   *
   * `data-axis` because the two are indistinguishable by shape once a selection is wide: a
   * column band spans the plot's whole height, so every row tick's y falls inside one.
   * `pnpm probe:heatmap-select` reads it — off the **core** layer alone, or every band counts
   * twice — and read it wrongly first, the check passing against the column band.
   */
  const bandRects = useMemo(() => {
    if (!spec) return null
    const { plot } = spec
    const bands = {
      rows: selectionBands(spec.rowMap, picked.rows),
      columns: selectionBands(spec.colMap, picked.columns),
    }
    const shapes = [
      ...bands.rows.map((band) => ({
        key: `r${band.from}`,
        axis: 'rows',
        x: plot.x,
        y: band.from,
        width: plot.width,
        height: Math.max(1, band.to - band.from),
      })),
      ...bands.columns.map((band) => ({
        key: `c${band.from}`,
        axis: 'columns',
        x: band.from,
        y: plot.y,
        width: Math.max(1, band.to - band.from),
        height: plot.height,
      })),
    ]
    const layer = (className: string) => (
      <g className={className}>
        {shapes.map((shape) => (
          <rect
            key={shape.key}
            data-axis={shape.axis}
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
          />
        ))}
      </g>
    )
    return (
      // The clip id spelled out rather than through `clip()`, which is declared below the early
      // returns — a hook may not close over it.
      <g clipPath={`url(#${clipId}-plot)`} className="heatmap-band">
        {layer('heatmap-band__case')}
        {layer('heatmap-band__core')}
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
          circles,
          title,
          ...(matrix.valueLabel ? { valueLabel: matrix.valueLabel } : {}),
          barLow: formatCompact(spec.domain.lo),
          barHigh: formatCompact(spec.domain.hi),
        })
      },
    }),
    [
      spec,
      matrix,
      title,
      ramp,
      ink,
      surface,
      size.width,
      size.height,
      showValues,
      circles,
      ref,
    ],
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
        /*
         * `nokey` is React Flow's, and it is what makes selecting on a card possible at all:
         * with `selectionKeyCode="Shift"` held its pane starts a rubber band on a press
         * *anywhere* inside it, takes the pointer capture and stops propagation in the capture
         * phase — before this element's own handler. The class is the library's documented way
         * to say "leave this subtree alone", checked with `closest`, so it belongs on the
         * container rather than on the canvas. `nowheel` and `nodrag` are the same bargain for
         * the wheel and the node drag.
         */
        className={`heatmap-plot nowheel nodrag nokey${compact ? ' heatmap-plot--compact' : ''}`}
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
          /*
           * A modified click over the plot belongs to the heatmap, and must not *also* reach
           * React Flow's node handler underneath — which selects the card, and with Shift held
           * **adds** it to the canvas selection. Measured on a card: one shift+⌘-click took a
           * cell and left the node selected, so building a selection cell by cell quietly
           * accumulated cards that the next ⌫ or Delete would have removed.
           *
           * `nodrag` does not cover this: it filters the d3 *drag*, where the node's selection
           * rides on the `click`, which fires even after a drag whose press and release are on
           * the same element. `isAdditive` rather than a flag set at pointer-up, because it is
           * the same question the press already asked and a second source of truth is how the
           * two come to disagree. A **bare** click passes through on purpose: clicking a card to
           * select it is what a card does.
           */
          onClick={(event) => {
            if (selectable && isAdditive(event)) event.stopPropagation()
          }}
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
          /*
           * One button, and it is the zoom's. The ⌫ beside it was removed as a control with two
           * better spellings already on the card — a shift-click on the plot, and the Selection
           * tab's own field — and a third that could only be reached by expanding. What it cost
           * is that the *gestures* lived in its `title`, so they moved to this one, which is the
           * control that is always here whenever they apply.
           */
          <div className="network-strip network-strip--bottom nodrag">
            <button
              type="button"
              className="network-strip__btn"
              title="Show the whole matrix (or double-click). Scroll to zoom, drag to pan. Shift-drag selects a rectangle, shift+⌘-drag or shift+⌘-click adds to it, shift-click clears."
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
        {circlesTooSmall && (
          /*
           * Asked for circles and got squares. A guard rail warns rather than refusing
           * (`docs/limits.md`), and the alternative — greying the control out as a card is
           * resized — is the one recorded against the Meshes node's `Detail`. The fallback is
           * also not permanent: the fold is per *window*, so zooming in reaches a density where
           * the circles come back, which is what the title says to do.
           *
           * **The second note that is not stood down under `compact`**, and for a different
           * reason from the selection count's. Every other note is a remark about the picture
           * and is dropped for room; this one is about a *control* — somebody set `Cell shape`
           * to circles in the inspector and the card is drawing squares. And the card is where
           * it will nearly always happen: a preview plot is a couple of hundred pixels for
           * however many rows, so 34 of them are already under four pixels each. Silent, that
           * is a control that looks broken.
           */
          <span
            className="viewer__note"
            title="Circles are drawn where a cell is at least a few pixels across. Here the cells are smaller than that, so the matrix is drawn as squares — zoom in, enlarge the card, or aggregate upstream to see circles."
          >
            too dense for circles
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
        {!compact &&
          // The words every colour bar in the app uses — `rampNotes` — with the matrix's own
          // range, so `values clipped` can say how far past the ends the cells run.
          rampNotes({
            domain: [domain.lo, domain.hi],
            log: domain.log,
            clipped,
            problem: limits.problem,
            extent,
          }).map((note) => (
            <span key={note.kind} className="viewer__note" title={note.title}>
              {note.text}
            </span>
          ))}
        {(selectedCount.rows > 0 || selectedCount.columns > 0) && (
          /*
           * The count is the caption's, where the scatter puts its own: the inspector's field
           * says how many *lines* are stored, and only this knows how many of them the matrix
           * on screen still has.
           *
           * **The one note here that is not stood down under `compact`**, now that a card can be
           * selected on. Every other note is a thing worth saying about a picture and is dropped
           * for room; this one is the only acknowledgement a card gives that a gesture landed —
           * the bands say *where*, and on a preview that has folded a thousand lines onto two
           * hundred pixels they cannot say how much.
           */
          <span
            className="viewer__note"
            title="Shift-drag to select a rectangle; shift+⌘-drag or shift+⌘-click adds to it; shift-click clears. Rows and columns leave the node on their own ports."
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
