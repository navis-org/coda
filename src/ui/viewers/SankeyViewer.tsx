/**
 * Layered flow, drawn as bands whose width is the quantity.
 *
 * SVG, for `FlowChartViewer`'s reasons: the drawing is bounded at a few hundred marks, the labels
 * want real text metrics and want to be selectable, and `ViewerActions` exports by cloning the
 * live `<svg>` so what lands in a paper is what was on screen.
 *
 * Everything about the numbers is in `sankeyFlow.ts` and everything about the positions is in
 * `sankeyLayout.ts`, both headless. What is here is ink, pointer plumbing and the caption.
 *
 * ## What the marks mean, and the one that is easy to get wrong
 *
 * A **box** is a (layer, label) pair, as tall as the larger of what it takes in and what it sends
 * on. A **band** is drive crossing between two of them, filled rather than stroked so its width
 * is the quantity rather than a line weight. The **dimmed tail** of a box is drive that arrived
 * and went no further, and it is drawn *on the box* rather than beside it — a node already
 * absorbs its own shortfall, so a second mark at the column's foot counts the same quantity
 * twice. The **feathered edge** on the first column is not that: it is where the diagram was cut
 * off, and calling it a loss would be as wrong as calling a sink one.
 *
 * ## The caption measures the claim the mark makes
 *
 * Inflow equals outflow at every node is the Sankey's whole grammar, and a flow of synapse counts
 * satisfies it nowhere. Rather than refuse such a table — flow between categories is a legitimate
 * thing to draw — the caption says how far off it is, so the claim is one a reader can check.
 */

import { useCallback, useMemo } from 'react'

import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { rowKeys } from '../../nodes/lib/rowIds'
import type { TableValue } from '../../core/values'
import { resolveColor } from '../encoding'
import { exportBaseName as makeBaseName } from '../export'
import { formatNumber, formatShare, plural, truncateLabel } from '../format'
import { ChartTooltip, TooltipRow } from './ChartTooltip'
import { ColorKey } from './LegendKeys'
import type { SankeyBand, SankeyBox, SankeyDirection } from './sankeyLayout'
import { sankeyShape, shareOf } from './sankeyLayout'
import { foldSankey, sankeyFlow } from './sankeyFlow'
import type { ViewerPoint } from './tooltipPoint'
import { tooltipPoint } from './tooltipPoint'
import { isAdditive, useMarkSelection } from './useMarkSelection'
import { useChart } from './useChart'
import { useStable } from './useStable'
import { ViewerActions } from './ViewerActions'
import { ViewerEmpty } from './ViewerEmpty'

export interface SankeyViewerProps {
  table: TableValue
  layerColumn: string | undefined
  sourceColumn: string | undefined
  targetColumn: string | undefined
  valueColumn?: string | undefined
  idColumn?: string | undefined
  direction?: SankeyDirection
  foldPerLayer?: number
  labelValues?: boolean
  bandColor: ColorSpec
  selection: string[]
  onSelectionChange?: (ids: string[]) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/**
 * Breathing room.
 *
 * No gutter reserved for the labels, which is a correction rather than an omission: the last
 * column's labels are drawn *before* its bar rather than after it — it has nowhere further to go
 * — so a gutter past it is dead space, and at 96px it was squeezing the drawing by a tenth of
 * its width for nothing. Every label rides a surface halo instead.
 */
const PAD = { near: 12, far: 12, start: 10, end: 14 }

const FONT = 11
const MAX_LABEL = 18

/** Smallest box that gets a label at all; below this the text is taller than the mark. */
const LABEL_MIN = 9

/**
 * Above this many boxes the drawing is not built.
 *
 * `DendrogramViewer`'s two-number arrangement. Unlike a flow chart, a Sankey degrades gracefully
 * for a while — the bands stay readable long after the labels stop — so there is only a ceiling
 * here and no crowding warning below it: the widths are the information and they survive.
 */
const MAX_BOXES = 400

/** One empty list, shared: a fresh `[]` per box per render is a fresh identity for nothing. */
const EMPTY_ROWS: string[] = []

/**
 * Discriminated, so a box hover cannot be read as a band one — and so neither call site has to
 * pass placeholder coordinates that `hoverAt` immediately overwrites. `RankViewer` does the same
 * job the same way.
 */
type Hover = ({ kind: 'box'; box: SankeyBox } | { kind: 'band'; band: SankeyBand }) &
  ViewerPoint

export function SankeyViewer({
  table,
  layerColumn,
  sourceColumn,
  targetColumn,
  valueColumn,
  idColumn,
  direction = 'lr',
  foldPerLayer = 0,
  labelValues = true,
  bandColor,
  selection,
  onSelectionChange,
  compact = false,
  baseName,
  onExpand,
  onError,
}: SankeyViewerProps) {
  const { ref, size, hover, setHover, svgRef, mode, ink, surface, exportSource } =
    useChart<Hover>(table)
  const marks = useMarkSelection(selection, onSelectionChange)

  /*
   * The flow, then the fold. Keyed on the table rather than on the wrapper, which is
   * `FlowChartViewer`'s note: a value is a fresh object per store tick and its columns are not.
   */
  const flow = useMemo(
    () => sankeyFlow(table, { layerColumn, sourceColumn, targetColumn, valueColumn }),
    [table, layerColumn, sourceColumn, targetColumn, valueColumn],
  )
  const folded = useMemo(() => foldSankey(flow, foldPerLayer), [flow, foldPerLayer])

  const names = useMemo(() => rowKeys(table, idColumn), [table, idColumn])

  // `useStable`, because `readColorSpec` mints a fresh object on every `ValuePreview` render.
  const stableColor = useStable(bandColor)
  const colors = useMemo(
    () => resolveColor(table, stableColor, mode),
    [table, stableColor, mode],
  )

  const tooBig = folded.nodes.length > MAX_BOXES

  const along = direction === 'lr' ? size.width : size.height
  const across = direction === 'lr' ? size.height : size.width
  const shape = useMemo(
    () =>
      tooBig
        ? undefined
        : sankeyShape(folded, {
            direction,
            along: Math.max(10, along - PAD.start - PAD.end),
            across: Math.max(10, across - PAD.near - PAD.far),
          }),
    [folded, direction, along, across, tooBig],
  )

  /**
   * The rows each box stands for, built in **one** pass over the ribbons.
   *
   * This was a scan of every ribbon per box, called from inside the render loop — so the render
   * was O(boxes × ribbons), and because hovering writes state it ran again on every pointer move
   * over the diagram. A ribbon contributes its row to exactly two boxes, so one walk fills the
   * whole map; the arrays then survive across renders instead of being rebuilt per mark.
   */
  const rowsOfBox = useMemo(() => {
    /*
     * A `Set` while filling, an array once. Deduping with `includes` on a growing array is
     * quadratic in a box's degree, and a hub in an unfolded flow reaches tens of thousands of
     * ribbons — `sankeyFlow` emits one per table row and `Fold past` is 0 by default.
     */
    const building = new Map<string, Set<string>>()
    const push = (id: string, name: string) => {
      const held = building.get(id)
      if (held) held.add(name)
      else building.set(id, new Set([name]))
    }
    for (const ribbon of folded.ribbons) {
      if (ribbon.row < 0) continue
      const name = names(ribbon.row)
      push(ribbon.source, name)
      push(ribbon.target, name)
    }
    const out = new Map<string, string[]>()
    for (const [id, rows] of building) out.set(id, [...rows])
    return out
  }, [folded.ribbons, names])

  /** Boxes by id, for the band tooltip — a `find` per hovered band is a scan per render. */
  const boxLabels = useMemo(() => {
    const out = new Map<string, string>()
    for (const box of shape?.boxes ?? []) out.set(box.id, box.label)
    return out
  }, [shape])

  const hoverAt = useCallback(
    (
      next: { kind: 'box'; box: SankeyBox } | { kind: 'band'; band: SankeyBand },
      event: React.MouseEvent,
    ) => {
      setHover({ ...next, ...tooltipPoint(event, ref.current) })
    },
    [ref, setHover],
  )
  const clearHover = useCallback(() => setHover(null), [setHover])

  if (!layerColumn || !sourceColumn || !targetColumn) {
    return <ViewerEmpty>Pick the layer, from and to columns</ViewerEmpty>
  }
  if (folded.nodes.length === 0) {
    return (
      <ViewerEmpty>
        Nothing to draw
        {folded.dropped > 0 ? (
          <>
            <br />
            {plural(folded.dropped, 'row')} name no connection, or carry no value
          </>
        ) : null}
      </ViewerEmpty>
    )
  }
  if (tooBig) {
    return (
      <ViewerEmpty>
        {folded.nodes.length.toLocaleString()} boxes is more than a flow diagram separates.
        <br />
        Raise Fold past to group each layer’s tail, or aggregate upstream.
      </ViewerEmpty>
    )
  }

  // Which box the pointer is on, read off the hover rather than tracked beside it: a second
  // piece of state saying what the discriminated union already says is one more thing to keep in
  // lockstep on every pointer move.
  const lit = hover?.kind === 'box' ? hover.box.id : null

  const originX = direction === 'lr' ? PAD.start : PAD.near
  const originY = direction === 'lr' ? PAD.near : PAD.start

  /*
   * Asked of the shortfall itself, never of a rounded percentage.
   *
   * This read `Math.round(folded.leak * 100) === 0`, so a diagram leaking anything under half a
   * percent captioned itself `conserves` — the one claim this viewer exists to keep honest.
   * `finish` already drops a per-node shortfall below 1e-12, so an empty map is exactly "nothing
   * stopped anywhere", and `formatShare` is the app's one percent formatter and keeps a decimal
   * below 10% rather than printing a present quantity as zero.
   */
  const conserves = folded.shortfall.size === 0

  return (
    <div className="viewer">
      <div
        ref={ref}
        className="viewer__scroll nowheel nodrag"
        style={{ position: 'relative', overflow: 'hidden' }}
      >
        {size.width > 60 && size.height > 60 && shape && (
          <svg
            ref={svgRef}
            className="chart sankey-chart"
            width={size.width}
            height={size.height}
            role="img"
            aria-label={`Flow diagram of ${folded.nodes.length} boxes in ${folded.layerCount} layers, ${folded.ribbons.length} bands`}
            onClick={(event) => {
              if (event.target === event.currentTarget) marks.clear()
            }}
          >
            <rect width={size.width} height={size.height} fill={surface} />

            <g transform={`translate(${originX} ${originY})`}>
              {/*
               * The feathered edge: drive entering from outside the diagram. Drawn first, under
               * everything, because it is the edge of the picture rather than a mark in it.
               */}
              {shape.inlet && (
                <g pointerEvents="none">
                  {Array.from({ length: 18 }, (_, i) => {
                    const t = i / 17
                    const span = direction === 'lr' ? shape.inlet!.height : shape.inlet!.width
                    const at = t * span
                    const from = direction === 'lr' ? { x: -10, y: at } : { x: at, y: -10 }
                    const to = direction === 'lr' ? { x: 0, y: at } : { x: at, y: 0 }
                    return (
                      <line
                        key={i}
                        x1={from.x}
                        y1={from.y}
                        x2={to.x}
                        y2={to.y}
                        stroke={ink.muted}
                        strokeWidth={1.2}
                        strokeOpacity={0.1 + 0.28 * (1 - Math.abs(t - 0.5) * 2)}
                      />
                    )
                  })}
                </g>
              )}

              {shape.bands.map((band) => {
                // `band.row` is the ribbon's own row, copied on by `sankeyLayout` — looking the
                // ribbon up again is one value with two spellings in one component.
                const fill = band.row >= 0 ? colors.at(band.row) : ink.muted
                const touched = lit === band.source || lit === band.target
                const picked = band.row >= 0 && marks.hasAny([names(band.row)])
                return (
                  <path
                    key={band.ribbon}
                    d={band.path}
                    fill={fill}
                    /*
                     * Measured on the dark surface rather than chosen. At 0.38 a muted band over
                     * `#1a1a19` lands about two and a half steps off the ground, which reads as a
                     * slightly uneven background rather than as a mark; 0.55 is where the bands
                     * separate from the surface while still sitting under the node bars, which
                     * are drawn opaque so the two never read as the same thing.
                     */
                    fillOpacity={touched || picked ? 0.82 : 0.55}
                    /*
                     * A surface hairline round every band, which is the stacked-fill rule the
                     * bar chart already follows: several bands meeting one node face are stacked
                     * segments, and without a gap between them a node's whole inflow reads as one
                     * mass. Seen on the synthetic dataset, where two bands into `LC4` drew as a
                     * single block.
                     */
                    stroke={picked ? ink.primary : surface}
                    strokeWidth={picked ? 1.5 : 0.75}
                    {...(compact
                      ? {}
                      : {
                          style: { cursor: marks.writable ? 'pointer' : 'default' },
                          onMouseMove: (event: React.MouseEvent) =>
                            hoverAt({ kind: 'band', band }, event),
                          onMouseLeave: clearHover,
                          onClick: (event: React.MouseEvent) => {
                            event.stopPropagation()
                            if (band.row >= 0)
                              marks.toggle([names(band.row)], isAdditive(event))
                          },
                        })}
                  />
                )
              })}

              {shape.boxes.map((box) => {
                const rows = rowsOfBox.get(box.id) ?? EMPTY_ROWS
                const picked = rows.length > 0 && marks.hasAny(rows)
                const label = truncateLabel(box.label, MAX_LABEL, 1)
                const extent = direction === 'lr' ? box.height : box.width
                // The last column's labels go before the bar; every other column's after it, so
                // nothing runs off the far edge.
                const trailing = box.layer + 1 < folded.layerCount
                return (
                  <g key={box.id}>
                    <rect
                      x={box.x}
                      y={box.y}
                      width={box.width}
                      height={box.height}
                      fill={box.row >= 0 ? colors.at(box.row) : ink.muted}
                      // Opaque, so a bar is always distinct from the bands meeting it even when
                      // the whole diagram is one colour — which is the default.
                      fillOpacity={box.row >= 0 ? 1 : 0.7}
                      stroke={picked ? ink.primary : 'none'}
                      strokeWidth={picked ? 2 : 0}
                      data-box={box.id}
                      {...(compact
                        ? {}
                        : {
                            style: { cursor: marks.writable ? 'pointer' : 'default' },
                            onMouseMove: (event: React.MouseEvent) =>
                              hoverAt({ kind: 'box', box }, event),
                            onMouseLeave: clearHover,
                            onClick: (event: React.MouseEvent) => {
                              event.stopPropagation()
                              if (rows.length > 0) marks.toggle(rows, isAdditive(event))
                            },
                          })}
                    />
                    {/*
                     * What arrived and went no further, on the box's own far end. Hatched rather
                     * than a second colour, because it is an absence and colour is spent on the
                     * data — `out.flowChart`'s rule, one viewer over.
                     */}
                    {box.stopped > 0.5 && (
                      <rect
                        x={direction === 'lr' ? box.x : box.x + box.width - box.stopped}
                        y={direction === 'lr' ? box.y + box.height - box.stopped : box.y}
                        width={direction === 'lr' ? box.width : box.stopped}
                        height={direction === 'lr' ? box.stopped : box.height}
                        fill={surface}
                        fillOpacity={0.55}
                        stroke={ink.muted}
                        strokeWidth={1}
                        strokeDasharray="2 2"
                        pointerEvents="none"
                      />
                    )}
                    {extent >= LABEL_MIN && (
                      <text
                        x={
                          direction === 'lr'
                            ? trailing
                              ? box.x + box.width + 5
                              : box.x - 5
                            : box.x + box.width / 2
                        }
                        y={
                          direction === 'lr'
                            ? box.y + box.height / 2 + 3.5
                            : trailing
                              ? box.y + box.height + 12
                              : box.y - 5
                        }
                        textAnchor={
                          direction === 'lr' ? (trailing ? 'start' : 'end') : 'middle'
                        }
                        fontSize={FONT}
                        fill={box.folded.length > 0 ? ink.muted : ink.secondary}
                        stroke={surface}
                        strokeWidth={3}
                        paintOrder="stroke"
                        pointerEvents="none"
                      >
                        {labelValues
                          ? `${label}  ${formatShare(shareOf(box.value, folded.peak))}`
                          : label}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
        )}

        {hover && (
          <ChartTooltip at={hover}>
            {hover.kind === 'box' && (
              <>
                <strong>{hover.box.label}</strong>
                <TooltipRow>
                  {formatNumber(hover.box.value)} ·{' '}
                  {formatShare(shareOf(hover.box.value, folded.peak))} of the widest layer
                </TooltipRow>
                <TooltipRow>layer {hover.box.layer + 1}</TooltipRow>
                {hover.box.folded.length > 0 && (
                  <TooltipRow>{hover.box.folded.length} folded</TooltipRow>
                )}
                {hover.box.stopped > 0.5 && <TooltipRow>some of it stops here</TooltipRow>}
              </>
            )}
            {hover.kind === 'band' && (
              <>
                <strong>
                  {boxLabels.get(hover.band.source) ?? hover.band.source} →{' '}
                  {boxLabels.get(hover.band.target) ?? hover.band.target}
                </strong>
                <TooltipRow>{formatNumber(hover.band.value)}</TooltipRow>
                {hover.band.merged > 1 && (
                  <TooltipRow>{hover.band.merged} rows merged</TooltipRow>
                )}
              </>
            )}
          </ChartTooltip>
        )}
      </div>

      <div className="viewer__caption">
        <span>
          {plural(folded.nodes.length, 'box', 'boxes')} · {folded.layerCount} layers ·{' '}
          {plural(folded.ribbons.length, 'band')}
          {marks.size > 0 ? ` · ${marks.size} selected` : ''}
        </span>
        <ColorKey colors={colors} />
        {/*
         * The claim the mark makes, measured. A Sankey says what arrives at a node leaves it;
         * a flow of synapse counts satisfies that nowhere, and the alternative to saying so is a
         * picture nothing on it lets a reader check.
         */}
        <span
          className="viewer__note"
          title={
            conserves
              ? 'What arrives at each box also leaves it, so the widths can be read as one quantity flowing through.'
              : `Boxes take in ${formatShare(folded.leak)} more than they pass on, measured against the widest layer. On an Influence flow that is drive the walk could not follow — the card above says why. On a flow of synapse counts it means the widths are not one quantity and cannot be traced through.`
          }
        >
          {conserves ? 'conserves' : `${formatShare(folded.leak)} stops`}
        </span>
        {folded.dropped > 0 && (
          <span
            className="viewer__note"
            title="Rows naming no connection, or carrying no positive value — usually a filter upstream that emptied a column."
          >
            {folded.dropped.toLocaleString()} unused
          </span>
        )}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'sankey')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}
