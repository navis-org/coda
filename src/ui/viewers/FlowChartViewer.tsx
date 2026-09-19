import { memo, useCallback, useId, useMemo, useRef, useState } from 'react'

import type { NetworkValue } from '../../core/values'
import type { FlowEdgeKind } from '../../nodes/lib/flowChartOps'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import type {
  BoxSize,
  FlowArrow,
  FlowBox,
  FlowChartShape,
  RouteGeometry,
} from './flowChartLayout'
import type { FlowDirection, FlowRouting } from './flowChartLayout'
import { flowChartShape, routeGeometry } from './flowChartLayout'
import {
  FLOW_NODES_WARN,
  flowGraph,
  foldFlowGraph,
  showsEdgeLabels,
} from '../../nodes/lib/flowChartOps'
import { CHART_INK, chartSurface, currentMode, inkOn } from '../colors'
import type { ResolvedColor } from '../encoding'
import { resolveColor } from '../encoding'
import { exportBaseName as makeBaseName } from '../export'
import { formatNumber, truncateLabel } from '../format'
import { ChartTooltip, TooltipRow } from './ChartTooltip'
import { ColorKey } from './LegendKeys'
import { tooltipPoint } from './tooltipPoint'
import type { MarkSelection } from './useMarkSelection'
import { isAdditive, useMarkSelection } from './useMarkSelection'
import { useElementSize } from './useElementSize'
import { useStable } from './useStable'
import { usePanGesture } from './usePanGesture'
import { useWheelZoom } from './useWheelZoom'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { ViewerEmpty } from './ViewerEmpty'

export interface FlowChartViewerProps {
  network: NetworkValue
  direction?: FlowDirection
  routing?: FlowRouting
  /** Node attribute column naming each box. Empty falls back to the node id. */
  labelColumn?: string | undefined
  /** Node attribute column the layer is read from. Empty means longest path. */
  layerColumn?: string | undefined
  /** Edge attribute column printed on the arrows. Empty falls back to the weight. */
  edgeLabelColumn?: string | undefined
  edgeLabels?: 'auto' | 'on' | 'off'
  /** Boxes kept per layer before the rest fold into one. 0 folds nothing. */
  foldPerLayer?: number
  /** Arrow thickness follows the weight where this is on. */
  weightedArrows?: boolean
  nodeColor: ColorSpec
  selection: string[]
  onSelectionChange?: (ids: string[]) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/** Breathing room between the card's edge and the drawing. */
const PAD = 10

/** Text the boxes are drawn at, and what a box adds around it. */
const FONT = 12
const BOX_PAD = { x: 10, y: 7 }
const MIN_BOX = { width: 34, height: 22 }

/** Loop-invariant: a box is as tall as one line of text plus its padding, whatever it says. */
const BOX_HEIGHT = Math.max(MIN_BOX.height, FONT + BOX_PAD.y * 2)

/** Longest label a box will hold before it is cut. */
const MAX_LABEL = 22

/** Arrow thickness, and the range the weight encoding spends. */
const STROKE = { min: 1, max: 5 }

const HEAD = 6

/**
 * What a hovered arrow gains, on top of its own width.
 *
 * Added rather than a multiplier: a weighted chart spans `STROKE.min`..`STROKE.max`, and a factor
 * makes the emphasis on the thinnest arrow invisible and the one on the thickest a slab. A
 * constant is the same amount of "this one" wherever it lands.
 */
const HOVER_WIDTH = 2

/**
 * How far the fit will magnify a drawing smaller than its surface.
 *
 * It was 1 — never magnified — on the grounds that a two-box chart blown up to fill a card reads
 * as a different node from a twenty-box one, and that the text grows with it. Seen in a browser
 * that is plainly the wrong trade: an eighteen-box chart expanded to a 1250 x 850 panel drew
 * about 340px across and left three quarters of the surface empty, which is the one thing
 * expanding a card is for. **`pnpm probe:flowchart-draw` cannot report this** — every property it
 * asks (the boxes hold their text, nothing overlaps, no arrow crosses a box, it all fits) is
 * *more* comfortably true the smaller the drawing is, so it took looking at the screenshot.
 *
 * Capped rather than uncapped, which keeps the original argument's useful half: a chain of three
 * boxes filling a wide panel is 40px text beside a 12px interface. Two is where a small chart
 * becomes worth looking at without becoming a poster.
 */
const MAX_FIT = 2

/**
 * Above this many boxes the drawing is not built at all.
 *
 * Two numbers, as `DendrogramViewer` has: `FLOW_NODES_WARN` says "you will not enjoy reading
 * this" and this one says "there is no picture here". A flow chart of two thousand boxes is
 * several thousand SVG elements arranged into a grey field, and unlike a dendrogram — whose
 * shape is still legible when its leaves are not — a layered drawing at that size carries no
 * information a force layout would not carry better. So this one *declines and says where to
 * go*, which the empty state does by naming the Network Viewer.
 */
const MAX_BOXES_DRAWN = 600

/** What `shape` is above the cap: nothing is laid out, and nothing below the guard reads it. */
const EMPTY_SHAPE: FlowChartShape = { boxes: [], arrows: [], width: 0, height: 0 }

/** The view when nothing is zoomed or panned — `undefined` state spelled once. */
const FIT_VIEW = { zoom: 1, x: 0, y: 0 } as const

/** How far a wheel may magnify past the fit. */
const MAX_ZOOM = 8

/**
 * A network drawn as a feed-forward circuit diagram.
 *
 * **SVG rather than WebGL**, which is the opposite of `NetworkViewer`'s call and for the
 * opposite reason. That viewer is fed whole connectomes and draws discs with the label beside
 * them; here the label *is* the box, so the layout cannot run until the text is measured, and
 * the picture is bounded at a few dozen boxes. What SVG buys: real text metrics, the export
 * path for free — `ViewerActions` clones the live `<svg>` rather than synthesising one from a
 * display list, so what lands in a paper is what was on screen — hit testing on every box with
 * no quadtree, and selectable, findable, screen-readable labels.
 *
 * **The layout is synchronous and is part of the render.** Every other layout in the app is
 * async, and each one pays for it in a settle effect and a frame of the wrong picture. See
 * `flowChartLayout.ts` for why this one is neither ELK nor a worker.
 *
 * ## What the four edge kinds are drawn as
 *
 * The classification is `flowChartOps`'; what is here is the ink. A `forward` arrow is a solid
 * line. A `back` arrow is **dashed**, because a recurrent connection drawn like a feed-forward
 * one reads as a data error — an arrow pointing left through the boxes between its ends — and
 * because "there is feedback here" is a fact about the circuit rather than about the drawing.
 * A `within` arrow bulges off the flow axis so it cannot be mistaken for a connection to the
 * next layer, and a `self` arrow is a loop on the box. All four are the same colour: the kinds
 * differ in *shape*, because colour is already spent on the data.
 */
export function FlowChartViewer({
  network,
  direction = 'lr',
  routing = 'orthogonal',
  labelColumn,
  layerColumn,
  edgeLabelColumn,
  edgeLabels = 'auto',
  foldPerLayer = 0,
  weightedArrows = true,
  nodeColor,
  selection,
  onSelectionChange,
  compact = false,
  baseName,
  onExpand,
  onError,
}: FlowChartViewerProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<
    | { kind: 'box'; box: FlowBox; x: number; y: number }
    | { kind: 'arrow'; arrow: FlowArrow; x: number; y: number }
    | null
  >(null)
  /** Scale and offset over the fitted drawing. Absent means fitted. */
  const [view, setView] = useState<{ zoom: number; x: number; y: number } | undefined>(
    undefined,
  )
  const svgRef = useRef<SVGSVGElement>(null)
  const clipId = useId()
  const mode = currentMode()
  const ink = CHART_INK[mode]
  const surface = chartSurface(mode)

  /*
   * The selection, through the shared hook rather than a Set and a hand-written toggle: the
   * "replace, unless the click was the whole current selection, in which case clear" rule and the
   * additive chord are `useMarkSelection`'s, and a folded box standing for several ids is exactly
   * the multi-name mark `PieViewer` already passes it.
   */
  const marks = useMarkSelection(selection, onSelectionChange)

  /*
   * The layering, then the fold. Both memoised on the value's identity: `network` is a fresh
   * object per store tick but its tables are not, so the tables are the honest key — `shape`'s
   * reasoning in `DendrogramViewer`, one step cheaper than `useStable`.
   *
   * Above every early return, because a hook after one is a hook that does not run every render.
   */
  const graph = useMemo(
    () =>
      flowGraph(network, {
        ...(labelColumn ? { labelColumn } : {}),
        ...(layerColumn ? { layerColumn } : {}),
      }),
    /*
     * The two tables, not `network` — which the comment above is about and which the linter
     * cannot see is exhaustive: a `NetworkValue` is a fresh wrapper on every store tick and its
     * tables are not, so keying on the wrapper re-runs this, the fold, the text measurement and
     * the whole Sugiyama pass for an identical picture. `useStable` is not the tool here either:
     * it compares by `JSON.stringify`, which on a network is the tables themselves.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [network.nodes, network.edges, labelColumn, layerColumn],
  )
  const folded = useMemo(() => foldFlowGraph(graph, foldPerLayer), [graph, foldPerLayer])

  /*
   * Box sizes, measured rather than estimated.
   *
   * A shared offscreen canvas rather than a DOM measurement pass: `measureText` is synchronous
   * and needs no layout, which is what lets the whole arrangement stay inside the render. jsdom's
   * stub answers `text.length * 6`, the same estimate `truncateLabel` uses, so the layout runs
   * under test rather than being skipped — and a wrong answer there is a wrong *size*, never a
   * crash, which is the failure mode worth having.
   */
  /*
   * Above the draw cap none of this is built, which is what `MAX_BOXES_DRAWN` says it does.
   * Measuring text is the one genuinely slow step here — one canvas call per box — and the
   * Sugiyama pass behind it is a dummy slot per skipped layer per edge; on the graphs that trip
   * the cap (thousands of nodes) that was hundreds of milliseconds computed and then discarded
   * by the early return below. The layering above *does* have to run: its node count is what
   * decides the cap.
   */
  const boxCount = folded.nodes.length
  const tooBig = boxCount > MAX_BOXES_DRAWN

  // The truncated label is stored beside the size it was measured for. Two independent
  // truncations — one to size the box, one to draw it — is how a box comes to clip its label.
  const sizes = useMemo(() => {
    const out = new Map<string, BoxSize & { label: string }>()
    if (tooBig) return out
    const measure = textMeasurer()
    for (const node of folded.nodes) {
      const label = truncateLabel(node.label, MAX_LABEL, 1)
      out.set(node.id, {
        label,
        width: Math.max(MIN_BOX.width, measure(label) + BOX_PAD.x * 2),
        height: BOX_HEIGHT,
      })
    }
    return out
    // `tooBig` is derivable from `folded`, but it is *read* in the body and the linter cannot see
    // the derivation — a boolean in the list costs nothing next to two suppression comments.
  }, [folded, tooBig])

  const shape = useMemo(
    () => (tooBig ? EMPTY_SHAPE : flowChartShape(folded, { direction, sizes })),
    [folded, direction, sizes, tooBig],
  )

  /*
   * Colour resolves against the network's **own** node table, by the row each box remembers —
   * never against the folded graph, which has boxes that are not rows. `resolveColor` owns the
   * palette, the eight slots, the cycling, the null grey and the overrides; re-deriving any of
   * that here is what `ui/encoding.ts` exists to prevent.
   */
  // `useStable`, because `readColorSpec` mints a fresh object on every `ValuePreview` render —
  // the hazard `networkRebuild.test.tsx` records, and without it this memo never bites.
  const stableColor = useStable(nodeColor)
  const colors = useMemo(
    () => resolveColor(network.nodes, stableColor, mode),
    [network.nodes, stableColor, mode],
  )

  const arrowText = useMemo(() => {
    if (!showsEdgeLabels(edgeLabels, folded.nodes.length)) return undefined
    const column = edgeLabelColumn ? network.edges.data[edgeLabelColumn] : undefined
    return (arrow: FlowArrow): string => {
      // A merged edge has no row of its own, so a column label cannot be read for it — the
      // summed weight is the only thing that is still true about it. See `FlowEdge.row`.
      if (column && arrow.row >= 0) {
        const cell = column[arrow.row]
        return cell === null || cell === undefined ? '' : String(cell)
      }
      return arrow.weight === null ? '' : formatNumber(arrow.weight)
    }
  }, [edgeLabels, folded.nodes.length, edgeLabelColumn, network.edges.data])

  const weightRange = useMemo(() => {
    let low = Infinity
    let high = -Infinity
    for (const edge of folded.edges) {
      if (edge.weight === null) continue
      const value = Math.abs(edge.weight)
      if (value < low) low = value
      if (value > high) high = value
    }
    return Number.isFinite(low) && high > low ? { low, high } : undefined
  }, [folded])

  const exportSource: ExportSource = useMemo(() => ({ svg: () => svgRef.current }), [])

  const hoverBox = useCallback(
    (box: FlowBox, event: React.MouseEvent): void => {
      setHover({ kind: 'box', box, ...tooltipPoint(event, ref.current) })
    },
    [ref],
  )
  const hoverArrow = useCallback(
    (arrow: FlowArrow, event: React.MouseEvent): void => {
      setHover({ kind: 'arrow', arrow, ...tooltipPoint(event, ref.current) })
    },
    [ref],
  )
  const clearHover = useCallback(() => setHover(null), [])

  // Fit the whole drawing into the box, then let the view scale on top of it. One factor, which
  // is what `flowChartShape` shifting to the origin buys.
  const box = {
    width: Math.max(0, size.width - PAD * 2),
    height: Math.max(0, size.height - PAD * 2),
  }
  const fitScale =
    shape.width > 0 && shape.height > 0 && box.width > 0 && box.height > 0
      ? Math.min(MAX_FIT, box.width / shape.width, box.height / shape.height)
      : 1
  /*
   * Where the drawing sits, as one function of the view — used to place it and, below, to find
   * the point under the pointer when zooming. Written twice the anchor drifts from the picture
   * the moment `MAX_FIT` or the centring rule changes, and silently.
   */
  const placeAt = (at: { zoom: number; x: number; y: number }) => {
    const scale = fitScale * at.zoom
    // Centred, which is what makes a small chart sit in the middle of its card.
    return {
      scale,
      x: (box.width - shape.width * scale) / 2 + at.x,
      y: (box.height - shape.height * scale) / 2 + at.y,
    }
  }
  const { scale, x: offsetX, y: offsetY } = placeAt(view ?? FIT_VIEW)

  const zoomable = !compact && boxCount > 0 && !tooBig

  useWheelZoom(ref, zoomable && box.width > 0, (factor, x, y) => {
    setView((current) => {
      const at = current ?? FIT_VIEW
      // **Divided, not multiplied**: the hook's `factor` is above 1 for a wheel *away* from the
      // reader, which is zoom out — `zoomRoiWindow` reads it the same way. Multiplied, the
      // gesture ran backwards.
      const next = Math.min(MAX_ZOOM, Math.max(1, at.zoom / factor))
      if (next === 1) return undefined

      /*
       * Zoom about the pointer: the drawing point under it must not move.
       *
       * The pan is stored as an offset *on top of* the centring term, and that term is a
       * function of the zoom — so the new pan has to be measured against `placeAt` at the
       * **new** zoom. Measured against the old one, as this did, the anchor is off by half the
       * change in the centring term, which reads as the drawing sliding away from the cursor.
       */
      const before = placeAt(at)
      const centred = placeAt({ zoom: next, x: 0, y: 0 })
      const ratio = next / at.zoom
      const px = x - PAD
      const py = y - PAD
      return {
        zoom: next,
        x: px - (px - before.x) * ratio - centred.x,
        y: py - (py - before.y) * ratio - centred.y,
      }
    })
  })

  const { panning, handlers } = usePanGesture(zoomable && view !== undefined, (dx, dy) => {
    setView((current) =>
      current ? { ...current, x: current.x + dx, y: current.y + dy } : current,
    )
    setHover(null)
  })

  const fit = useCallback(() => setView(undefined), [])

  if (boxCount === 0) {
    return <ViewerEmpty>Network is empty</ViewerEmpty>
  }
  if (tooBig) {
    return (
      <ViewerEmpty>
        {boxCount.toLocaleString()} boxes is more than a flow chart can arrange.
        <br />
        Filter or group upstream, fold the layers, or use the Network Viewer for a graph this
        size.
      </ViewerEmpty>
    )
  }

  const labelsDrawn = arrowText !== undefined

  return (
    <div className="viewer">
      <div
        ref={ref}
        // `nowheel`/`nodrag` keep React Flow's pane out of a gesture aimed at the card.
        className="viewer__scroll nowheel nodrag"
        style={{
          overflow: 'hidden',
          position: 'relative',
          cursor: panning ? 'grabbing' : view ? 'grab' : 'default',
          ...(zoomable ? { touchAction: 'none' } : {}),
          // A pan drags across the box labels, and the browser's default for that is to select
          // them. Suppressed only while a pan is live, so a label stays selectable otherwise —
          // which is half of why this viewer is SVG. `DendrogramViewer` carries the same note.
          ...(panning ? { userSelect: 'none' as const } : {}),
        }}
        {...(zoomable
          ? {
              ...handlers,
              onDoubleClick: (event: React.MouseEvent) => {
                // Stopped, or the canvas underneath takes it as a zoom-to-fit of its own.
                event.stopPropagation()
                fit()
              },
            }
          : {})}
      >
        {size.width > 40 && size.height > 40 && (
          <svg
            ref={svgRef}
            // `flow-chart` beside the shared `chart`: every viewer's SVG carries the latter, so
            // it cannot address this one. `pnpm probe:flowchart-draw` needs to, and so would any
            // rule that wanted to style a box.
            className="chart flow-chart"
            width={size.width}
            height={size.height}
            role="img"
            aria-label={`Flow chart of ${boxCount} nodes in ${folded.layerCount} layers, ${folded.edges.length} connections`}
            onClick={(event) => {
              if (event.target === event.currentTarget) marks.clear()
            }}
          >
            <rect width={size.width} height={size.height} fill={surface} />
            <defs>
              <clipPath id={`${clipId}-plot`}>
                <rect width={box.width} height={box.height} />
              </clipPath>
            </defs>
            <g transform={`translate(${PAD} ${PAD})`} clipPath={`url(#${clipId}-plot)`}>
              <g transform={`translate(${offsetX} ${offsetY}) scale(${scale})`}>
                <FlowArrows
                  arrows={shape.arrows}
                  routing={routing}
                  flow={direction}
                  weighted={weightedArrows}
                  {...(weightRange ? { weightRange } : {})}
                  {...(arrowText ? { label: arrowText } : {})}
                  ink={ink}
                  surface={surface}
                  interactive={!compact}
                  onHover={hoverArrow}
                  onLeave={clearHover}
                />
                {/*
                 * The hovered arrow, traced again on top.
                 *
                 * One extra path rather than a colour inside the map above — `DendrogramLinks`'
                 * arrangement and its measured reason: hovering writes to state, so a stroke that
                 * read `hover` would put every *other* arrow's props back through reconciliation
                 * on each pointer move, which is exactly what memoising `FlowArrows` bought.
                 * Passing `hover` in as a prop would defeat that memo outright.
                 *
                 * Drawn here, so it is over the other arrows and under the boxes — where the
                 * arrows themselves are, and an emphasis that jumped in front of a box would read
                 * as the arrow ending somewhere it does not.
                 */}
                {hover?.kind === 'arrow' && (
                  <g pointerEvents="none">
                    {arrowMark(
                      hover.arrow.kind,
                      routeGeometry(hover.arrow.points, routing, direction),
                      arrowWidth(hover.arrow, weightedArrows, weightRange) + HOVER_WIDTH,
                      ink.primary,
                    )}
                  </g>
                )}
                <FlowBoxes
                  boxes={shape.boxes}
                  labels={sizes}
                  colors={colors}
                  marks={marks}
                  ink={ink}
                  surface={surface}
                  interactive={!compact}
                  onHover={hoverBox}
                  onLeave={clearHover}
                />
              </g>
            </g>
          </svg>
        )}

        {zoomable && (
          // `.network-strip--bottom`, which four viewers share and whose rule carries the
          // absolute placement — `.viewer__overlay-actions` is defined in no stylesheet, so this
          // button was laid out in flow inside an `overflow: hidden` box rather than over the
          // drawing, and without `nodrag` a press on it panned the canvas underneath.
          <div className="network-strip network-strip--bottom nodrag">
            <button
              type="button"
              className="network-strip__btn"
              title="Show the whole chart (or double-click). Scroll to zoom, drag to pan."
              aria-label="Fit to view"
              disabled={view === undefined}
              onClick={fit}
            >
              ⤢
            </button>
          </div>
        )}

        {hover && !panning && (
          <ChartTooltip at={hover}>
            {hover.kind === 'box' ? (
              <>
                <strong>{hover.box.label}</strong>
                <TooltipRow>layer {hover.box.layer + 1}</TooltipRow>
                {hover.box.folded.length > 0 && (
                  <TooltipRow>{hover.box.folded.length} folded</TooltipRow>
                )}
              </>
            ) : (
              <>
                <strong>
                  {boxLabel(shape.boxes, hover.arrow.source)} →{' '}
                  {boxLabel(shape.boxes, hover.arrow.target)}
                </strong>
                {hover.arrow.weight !== null && (
                  <TooltipRow>{formatNumber(hover.arrow.weight)}</TooltipRow>
                )}
                {hover.arrow.kind === 'back' && <TooltipRow>feedback</TooltipRow>}
                {hover.arrow.kind === 'self' && <TooltipRow>autapse</TooltipRow>}
                {hover.arrow.merged > 1 && (
                  <TooltipRow>{hover.arrow.merged} connections</TooltipRow>
                )}
              </>
            )}
          </ChartTooltip>
        )}
      </div>
      <div className="viewer__caption">
        <span>
          {boxCount} nodes · {folded.layerCount} layers · {folded.edges.length} links
          {/*
           * Which rule laid it out. A layering by column and a layering by longest path are
           * different pictures of one network — see `flowChartOps`' header — and the caption is
           * the only place that can say which one is on screen.
           */}
          {folded.layerSource === 'column' ? ` · by ${layerColumn}` : ''}
          {marks.size > 0 ? ` · ${marks.size} selected` : ''}
        </span>
        <ColorKey colors={colors} />
        {edgeLabels === 'auto' && !labelsDrawn && (
          // The other half of "on below a node count, off above": a control that silently
          // stopped doing anything is worse than one that is visibly overridden.
          <span
            className="viewer__note"
            title={`Too many nodes to print a number on every arrow. Set Arrow labels to "always" to draw them anyway.`}
          >
            labels off
          </span>
        )}
        {folded.dangling > 0 && (
          <span
            className="viewer__note"
            title="These links name a node the network does not have — usually a filter upstream that removed nodes and left their links behind."
          >
            {folded.dangling} dangling
          </span>
        )}
        {boxCount > FLOW_NODES_WARN && (
          <span
            className="viewer__note"
            title="More boxes than a flow chart separates well. Fold the layers, filter upstream, or use the Network Viewer."
          >
            crowded
          </span>
        )}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'flowchart')}
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
 * The ids a box stands for.
 *
 * A folded box stands for its members, and those are what the `Selected` port carries —
 * `+7 others` is not a neuron. See `FlowNode.folded`. Module scope rather than a `useCallback`:
 * it closes over nothing, and a plain function is stable for a memoised child for free.
 */
function idsOf(box: FlowBox): string[] {
  return box.folded.length > 0 ? [...box.folded] : [box.id]
}

/** A box's drawn label, for the arrow tooltip. Falls back to the id it could not find. */
function boxLabel(boxes: readonly FlowBox[], id: string): string {
  return boxes.find((box) => box.id === id)?.label ?? id
}

/**
 * One shared canvas for text measurement.
 *
 * Module-level rather than per render: a `<canvas>` per measurement pass allocates a backing
 * store to answer a question about a string. Returns an estimate where there is no context at
 * all, which is what keeps this from being a hard dependency on the DOM.
 *
 * **The font string is read off `--font-ui` rather than written out**, because the box is sized
 * by this measurement and drawn by `.chart text`, which takes that variable — and two spellings
 * of one font is a box that fits its label on the author's machine and clips it elsewhere. The
 * two agree wherever `system-ui` resolves, which is why a literal here would survive every check
 * anybody would think to run: they part company exactly where `system-ui` is unavailable and
 * `-apple-system` or `Segoe UI` answers instead, leaving the canvas on generic sans-serif and
 * the drawing on neither.
 *
 * Read once. A theme flip does not move it — `--font-ui` is declared outside both palettes — and
 * asking the DOM for a computed style per measurement pass would be paying for a value that
 * cannot change.
 */
const FALLBACK_FONT = 'system-ui, sans-serif'

let measureContext: CanvasRenderingContext2D | null | undefined
function textMeasurer(): (text: string) => number {
  if (measureContext === undefined) {
    measureContext =
      typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    if (measureContext) {
      const family =
        getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() ||
        FALLBACK_FONT
      measureContext.font = `${FONT}px ${family}`
    }
  }
  const context = measureContext
  // `truncateLabel`'s own estimate, so the two agree where there is no canvas to ask.
  if (!context) return (text) => text.length * 6
  return (text) => context.measureText(text).width
}

/**
 * How thick one arrow is drawn.
 *
 * Module scope because the hover emphasis traces the same stroke and has to be at least as wide
 * as what it is emphasising — computed twice, a weighted arrow and its highlight disagree and the
 * highlight reads as a second, thinner line beside the first.
 */
function arrowWidth(
  arrow: FlowArrow,
  weighted: boolean,
  weightRange: { low: number; high: number } | undefined,
): number {
  if (!weighted || !weightRange || arrow.weight === null) return STROKE.min + 0.4
  const share =
    (Math.abs(arrow.weight) - weightRange.low) / (weightRange.high - weightRange.low)
  return STROKE.min + share * (STROKE.max - STROKE.min)
}

/**
 * One arrow's stroke and its head, in a given colour and width.
 *
 * A plain function rather than a component: it holds no state and would otherwise cost a fiber
 * per arrow inside the very component that is memoised to stop reconciling them. It takes the
 * geometry rather than the `FlowArrow` so the route is walked once — see `routeGeometry`, which
 * four readers share.
 *
 * **The dash survives the emphasis.** A highlighted feedback arrow is still a feedback arrow, and
 * the kinds are told apart by shape rather than by colour — see `FlowArrows`.
 */
function arrowMark(kind: FlowEdgeKind, geometry: RouteGeometry, width: number, colour: string) {
  return (
    <>
      <path
        d={geometry.d}
        fill="none"
        stroke={colour}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...(kind === 'back' ? { strokeDasharray: '5 3' } : {})}
      />
      {geometry.head && (
        <path
          d={`M0 0L${-HEAD} ${-HEAD / 2.2}L${-HEAD} ${HEAD / 2.2}Z`}
          transform={`translate(${geometry.head.at.x} ${geometry.head.at.y}) rotate(${(geometry.head.angle * 180) / Math.PI})`}
          fill={colour}
        />
      )}
    </>
  )
}

/**
 * The boxes, memoised away from the tooltip — `FlowArrows`' arrangement and its reason.
 *
 * `setHover` fires on every pointer move over a box or an arrow's hit area, which re-runs this
 * component's parent. Left inline, each of those moves rebuilt up to `MAX_BOXES_DRAWN` groups:
 * a `folded.some`, an `inkOn` (a hex parse per box) and three React elements apiece, all to draw
 * the picture that is already on screen. Every prop here is a primitive or a memoised value, so
 * `memo` bites: `boxes` and `labels` come from `useMemo`s, `marks` from `useMarkSelection` (whose
 * members are `useCallback`s over a `useStable`d selection), and `onHover`/`onLeave` are
 * `useCallback`s in the parent.
 */
const FlowBoxes = memo(function FlowBoxes({
  boxes,
  labels,
  colors,
  marks,
  ink,
  surface,
  interactive,
  onHover,
  onLeave,
}: {
  boxes: readonly FlowBox[]
  labels: ReadonlyMap<string, { label: string }>
  colors: ResolvedColor
  marks: MarkSelection
  ink: { primary: string; secondary: string; muted: string }
  surface: string
  interactive: boolean
  onHover: (box: FlowBox, event: React.MouseEvent) => void
  onLeave: () => void
}) {
  return (
    <g>
      {boxes.map((item) => {
        // `hasAny`, not `has`: `has` is `every`, where a folded box standing for seven neurons
        // is worth lighting when *one* of them is selected — the box being those seven's only
        // mark. `item.folded` is already a `readonly string[]`, so this allocates nothing.
        const isSelected = marks.hasAny(item.folded.length > 0 ? item.folded : [item.id])
        const fill = item.row >= 0 ? colors.at(item.row) : surface
        return (
          <g
            key={item.id}
            // Both read by the browser probe, which has to ask a rendered box what it stands for
            // — a `<text>` is the drawn label and never the identity, and `+N others` names no
            // node at all.
            data-box={item.id}
            data-folded={item.folded.length || undefined}
            transform={`translate(${item.x - item.width / 2} ${item.y - item.height / 2})`}
            {...(interactive
              ? {
                  onClick: (event: React.MouseEvent) => {
                    event.stopPropagation()
                    marks.toggle(idsOf(item), isAdditive(event))
                  },
                  onMouseMove: (event: React.MouseEvent) => onHover(item, event),
                  onMouseLeave: onLeave,
                  style: { cursor: marks.writable ? 'pointer' : 'default' },
                }
              : {})}
          >
            <rect
              width={item.width}
              height={item.height}
              rx={4}
              // A folded box is the user's own summary rather than a thing in the data, so it
              // takes the achromatic ink and never a palette slot — `resolveColor`'s null rule.
              fill={fill}
              stroke={isSelected ? ink.primary : ink.muted}
              strokeWidth={isSelected ? 2 : 1}
              // A dashed outline is a selection the user made, which is the mark `glyphs.ts`
              // already reserves for exactly that.
              {...(item.row < 0 ? { strokeDasharray: '3 2' } : {})}
            />
            <text
              x={item.width / 2}
              y={item.height / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={FONT}
              fill={item.row >= 0 ? inkOn(fill) : ink.secondary}
            >
              {labels.get(item.id)?.label ?? item.label}
            </text>
          </g>
        )
      })}
    </g>
  )
})

/**
 * The arrows, memoised away from the tooltip.
 *
 * `DendrogramLinks`' arrangement and its measured reason: hovering writes to state, so without
 * this every pointer move over an arrow puts every other arrow's props back through
 * reconciliation.
 *
 * **The weight labels are drawn here rather than as a sibling group**, which is what stops them
 * being the one layer still rebuilt on every hover — they iterate the same arrows and each needs
 * a `routeMidpoint` over its polyline, so drawn outside they undid half of what this exists for. Every prop is a primitive or a memoised value, which is what makes `memo`
 * bite — the weight range is passed as an object from a `useMemo` and the callbacks from
 * `useCallback`s in the parent.
 */
const FlowArrows = memo(function FlowArrows({
  arrows,
  routing,
  flow,
  weighted,
  weightRange,
  label,
  ink,
  surface,
  interactive,
  onHover,
  onLeave,
}: {
  arrows: readonly FlowArrow[]
  routing: FlowRouting
  flow: FlowDirection
  weighted: boolean
  weightRange?: { low: number; high: number }
  /** Absent where the arrows carry no number — see `showsEdgeLabels`. */
  label?: (arrow: FlowArrow) => string
  ink: { secondary: string; muted: string }
  surface: string
  interactive: boolean
  onHover: (arrow: FlowArrow, event: React.MouseEvent) => void
  onLeave: () => void
}) {
  /*
   * The geometry, once per arrow.
   *
   * Memoised apart from the ink: the stroke, the arrowhead, the hit area and the weight label
   * all read one route, and asked separately each rebuilt it — an orthogonal arrow ran
   * `orthogonalCorners` three times and a labelled one four. It is also the half that does not
   * move when the theme flips or a callback's identity changes, both of which re-render this
   * component; the render below is then element construction and nothing else.
   *
   * The arrow count is **not** bounded by `MAX_BOXES_DRAWN`, which caps boxes: a 600-box
   * connectivity subgraph routinely carries tens of thousands of edges.
   */
  const marks = useMemo(
    () =>
      arrows.map((arrow) => ({
        arrow,
        geometry: routeGeometry(arrow.points, routing, flow),
        width: arrowWidth(arrow, weighted, weightRange),
      })),
    [arrows, routing, flow, weighted, weightRange],
  )

  return (
    <g>
      {marks.map(({ arrow, geometry, width }) => {
        const text = label ? label(arrow) : ''
        const at = text === '' ? undefined : geometry.mid
        return (
          <g key={arrow.edge} data-arrow={arrow.kind}>
            {arrowMark(arrow.kind, geometry, width, ink.muted)}
            {text !== '' && at && (
              <text
                x={at.x}
                y={at.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={FONT - 2}
                fill={ink.secondary}
                pointerEvents="none"
                // Painted behind itself, so a number over an arrow stays readable without a
                // background rect per label.
                stroke={surface}
                strokeWidth={3}
                paintOrder="stroke"
              >
                {text}
              </text>
            )}
            {interactive && (
              /*
               * A transparent fat copy of the route, purely as a hit area.
               *
               * A one-pixel line is not something a pointer can reliably find, and widening the
               * visible stroke to catch it would spend the one channel the weight encoding uses.
               * `pointerEvents="stroke"` rather than the default, or the *interior* of a bent
               * route is clickable too and an arrow that loops round a box swallows the canvas
               * inside it.
               */
              <path
                d={geometry.d}
                fill="none"
                stroke="transparent"
                strokeWidth={Math.max(10, width + 8)}
                pointerEvents="stroke"
                onMouseMove={(event) => onHover(arrow, event)}
                onMouseLeave={onLeave}
              />
            )}
          </g>
        )
      })}
    </g>
  )
})
