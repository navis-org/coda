/**
 * A heavy-tailed measure drawn as a ranking, with the share of the total beneath it.
 *
 * **SVG rather than canvas**, which is the opposite of `ScatterViewer`'s call and for a reason
 * that is about this chart rather than about SVG. A scatter draws one mark per row over a table
 * that can be the whole of male-CNS; this one draws a *curve* through the ranking and dots only
 * where a reader can tell them apart — `sampleRanks` caps that at a few hundred whatever the
 * table holds, so the DOM cost is bounded by the drawing rather than by the data. What SVG buys
 * back is real text metrics for the point labels, the export path for free (`ViewerActions`
 * clones the live `<svg>`), and hit testing on every dot with no quadtree.
 *
 * **Two panels, never two y-scales.** The obvious Pareto chart puts the cumulative share on a
 * second axis against the same marks. Two measures of different scale sharing one drawing is the
 * one chart construction with no honest reading, so the share gets its own panel below, sharing
 * the rank axis — which is also what gives it room to carry its own annotation.
 *
 * Everything that can be got wrong about the numbers is in `rankSeries.ts`, headless: the
 * ordering, the share, what is dropped and why, and the two cases where a share cannot honestly
 * be drawn at all. What is here is scales, pointer plumbing and the caption.
 *
 * ## The gestures
 *
 * There is no zoom, and that is a decision rather than an omission: a log rank axis already
 * fits an entire table on screen, which is the whole reason it is the default. So the drag is
 * free for what this chart actually wants — **brushing a range of the ranking**, which is how
 * somebody says "the top fifty" without counting. A click selects one point, shift adds, and a
 * click on the background clears.
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { rowKeys } from '../../nodes/lib/rowIds'
import type { TableValue } from '../../core/values'
import { resolveColor } from '../encoding'
import { exportBaseName as makeBaseName } from '../export'
import { formatCompact, formatNumber, formatShare, plural, truncateLabel } from '../format'
import { ChartTooltip, TooltipRow } from './ChartTooltip'
import { GestureMarquee } from './GestureMarquee'
import { ColorKey } from './LegendKeys'
import type { RankPoint, RankSeries } from './rankSeries'
import { rankSeries, sampleRanks, shareAt, shareReaches } from './rankSeries'
import type { ScaleKind } from './scatterPlot'
import {
  axisTicks,
  forward,
  inverse,
  padDomain,
  projectX,
  projectY,
  unprojectX,
} from './scatterPlot'
import { CLICK_SLOP, tooltipPoint } from './tooltipPoint'
import { isAdditive, useMarkSelection } from './useMarkSelection'
import { useChart } from './useChart'
import { useStable } from './useStable'
import { ViewerActions } from './ViewerActions'
import { ViewerEmpty } from './ViewerEmpty'

export interface RankViewerProps {
  table: TableValue
  valueColumn: string | undefined
  labelColumn?: string | undefined
  flagColumn?: string | undefined
  idColumn?: string | undefined
  pointColor: ColorSpec
  descending?: boolean
  valueLog?: boolean
  rankLog?: boolean
  showShare?: boolean
  labelTop?: number
  selection: string[]
  onSelectionChange?: (ids: string[]) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/** Room for the axis labels, and breathing space at the other two edges. */
const PAD = { left: 54, right: 16, top: 20, bottom: 26 }

/** Between the two panels: enough for the share panel's own axis labels. */
const PANEL_GAP = 30

/** How much of the height the value panel takes when the share is drawn beside it. */
const VALUE_SHARE = 0.62

/**
 * How many dots get drawn, and how many of those are the undisturbed head of the ranking.
 *
 * The head is dense because that is the part somebody is reading — the top of a ranking is the
 * answer, and the tail is context. Past `DENSE_HEAD` the sample is logarithmic, which is the
 * shape of the axis; see `sampleRanks`.
 */
const DOT_BUDGET = 420
const DENSE_HEAD = 140

const DOT_R = 3.4
/** A flagged point's ring, outside its dot. */
const FLAG_R = 8

/** Longest point label before it is cut. */
const MAX_LABEL = 20

interface Hover {
  point: RankPoint
  x: number
  y: number
}

export function RankViewer({
  table,
  valueColumn,
  labelColumn,
  flagColumn,
  idColumn,
  pointColor,
  descending = true,
  valueLog = true,
  rankLog = true,
  showShare = true,
  labelTop = 5,
  selection,
  onSelectionChange,
  compact = false,
  baseName,
  onExpand,
  onError,
}: RankViewerProps) {
  const { ref, size, hover, setHover, svgRef, mode, ink, surface, exportSource } =
    useChart<Hover>(table)
  const [brush, setBrush] = useState<{ from: number; to: number } | null>(null)
  const drag = useRef<{ x: number; moved: boolean } | null>(null)

  const marks = useMarkSelection(selection, onSelectionChange)

  const valueScale: ScaleKind = valueLog ? 'log' : 'linear'
  const rankScale: ScaleKind = rankLog ? 'log' : 'linear'

  const series: RankSeries = useMemo(
    () => rankSeries(table, { valueColumn, flagColumn, valueScale, descending }),
    [table, valueColumn, flagColumn, valueScale, descending],
  )

  // `useStable`, because `readColorSpec` mints a fresh object on every `ValuePreview` render —
  // the hazard `networkRebuild.test.tsx` records, and without it this memo never bites.
  const stableColor = useStable(pointColor)
  const colors = useMemo(
    () => resolveColor(table, stableColor, mode),
    [table, stableColor, mode],
  )

  const names = useMemo(() => rowKeys(table, idColumn), [table, idColumn])
  const labels = useMemo(
    () => (labelColumn ? table.data[labelColumn] : undefined),
    [table, labelColumn],
  )
  const labelOf = useCallback(
    (point: RankPoint): string => {
      const cell = labels?.[point.row]
      if (cell !== null && cell !== undefined && cell !== '') return String(cell)
      return names(point.row)
    },
    [labels, names],
  )

  const count = series.points.length

  /** The ranks that are drawn, as dots and as the line through them. One list, so they agree. */
  const drawn = useMemo(() => sampleRanks(count, DOT_BUDGET, DENSE_HEAD), [count])

  const half = useMemo(() => shareReaches(series, 0.5), [series])

  const shareDrawn = showShare && series.share.length > 0

  // ---- geometry ----------------------------------------------------------
  const width = Math.max(0, size.width)
  const height = Math.max(0, size.height)
  const plotWidth = Math.max(10, width - PAD.left - PAD.right)
  const bodyHeight = Math.max(10, height - PAD.top - PAD.bottom)
  const valueHeight = shareDrawn
    ? Math.max(40, bodyHeight * VALUE_SHARE - PANEL_GAP / 2)
    : bodyHeight
  const shareTop = PAD.top + valueHeight + PANEL_GAP
  const shareHeight = shareDrawn ? Math.max(30, height - PAD.bottom - shareTop) : 0

  const rankDomain = useMemo(() => {
    const min = forward(rankScale, 1)
    const max = forward(rankScale, Math.max(2, count))
    return { min, max: max > min ? max : min + 1 }
  }, [rankScale, count])

  const valueDomain = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const point of series.points) {
      const t = forward(valueScale, point.value)
      if (!Number.isFinite(t)) continue
      if (t < lo) lo = t
      if (t > hi) hi = t
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1 }
    // A little air at each end, so the leading dot is not welded to the top edge and the last one
    // not to the axis. `padDomain` also owns the degenerate case — a single distinct value, which
    // divides by zero on projection — and that rule should not be copied.
    return padDomain({ min: lo, max: hi }, 0.06)
  }, [series.points, valueScale])

  /*
   * The scales, through `scatterPlot.ts`' own projections rather than four copies of them.
   *
   * One memo returning four functions, rather than four memoised boxes feeding four callbacks:
   * the boxes were referenced nowhere else, so naming them cost eight hooks and eight dependency
   * lists to express one thing. Both panels share the rank axis and differ only in the `Rect`,
   * which is what `projectY` takes the plot box for.
   */
  const scales = useMemo(() => {
    const view = { x: rankDomain, y: valueDomain }
    const plot = { x: PAD.left, y: PAD.top, width: plotWidth, height: valueHeight }
    const shareView = { x: rankDomain, y: { min: 0, max: 1 } }
    const sharePlot = { x: PAD.left, y: shareTop, width: plotWidth, height: shareHeight }
    return {
      xOfRank: (rank: number) => projectX(forward(rankScale, rank), view, plot),
      rankOfX: (px: number) => Math.round(inverse(rankScale, unprojectX(px, view, plot))),
      yOfValue: (value: number) => projectY(forward(valueScale, value), view, plot),
      yOfShare: (fraction: number) => projectY(fraction, shareView, sharePlot),
    }
  }, [
    rankScale,
    valueScale,
    rankDomain,
    valueDomain,
    plotWidth,
    valueHeight,
    shareTop,
    shareHeight,
  ])
  const { xOfRank, rankOfX, yOfValue, yOfShare } = scales

  /*
   * Both polylines, memoised — nothing they read moves when the pointer does.
   *
   * Hovering writes state, so in the render body these rebuilt up to `DOT_BUDGET` points' worth
   * of `toFixed` and string append twice over on every pointer move, and React then diffed two
   * multi-kilobyte `d` attributes. Every dependency here is already a `useMemo`/`useCallback`
   * value, which is what makes the memo bite.
   */
  const paths = useMemo(
    () => ({
      linePath: pathThrough(drawn, series, scales.xOfRank, scales.yOfValue),
      sharePath: shareDrawn
        ? pathThrough(drawn, series, scales.xOfRank, (_v, rank) =>
            scales.yOfShare(shareAt(series, rank)),
          )
        : '',
    }),
    [drawn, series, scales, shareDrawn],
  )

  // ---- gestures ----------------------------------------------------------
  const selectRange = useCallback(
    (from: number, to: number, additive: boolean) => {
      const lo = Math.max(1, Math.min(from, to))
      const hi = Math.min(count, Math.max(from, to))
      const picked: string[] = []
      for (const point of series.points) {
        if (point.rank >= lo && point.rank <= hi) picked.push(names(point.row))
      }
      if (picked.length > 0) marks.toggle(picked, additive)
    },
    [count, series.points, names, marks],
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!marks.writable || count === 0) return
      const local = tooltipPoint(event, ref.current)
      drag.current = { x: local.x, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [marks.writable, count, ref],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const held = drag.current
      if (!held) return
      const local = tooltipPoint(event, ref.current)
      if (!held.moved && Math.abs(local.x - held.x) < CLICK_SLOP) return
      held.moved = true
      setHover(null)
      setBrush({ from: held.x, to: local.x })
    },
    [ref, setHover],
  )

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const held = drag.current
      drag.current = null
      setBrush(null)
      if (!held) return
      if (!held.moved) {
        // A press that did not travel is a background click, and a background click clears.
        // A press on a dot never reaches here — the dot stops it.
        marks.clear()
        return
      }
      const local = tooltipPoint(event, ref.current)
      selectRange(rankOfX(held.x), rankOfX(local.x), isAdditive(event))
    },
    [marks, ref, selectRange, rankOfX],
  )

  // ---- content -----------------------------------------------------------
  if (!valueColumn) {
    return <ViewerEmpty>Pick a column to rank</ViewerEmpty>
  }
  if (count === 0) {
    return (
      <ViewerEmpty>
        Nothing to rank in “{valueColumn}”
        {series.missing > 0 || series.nonPositive > 0 ? (
          <>
            <br />
            {series.missing > 0 ? `${series.missing.toLocaleString()} rows have no number` : ''}
            {series.missing > 0 && series.nonPositive > 0 ? ', and ' : ''}
            {series.nonPositive > 0
              ? `${series.nonPositive.toLocaleString()} are at or below zero, which a log axis has no room for`
              : ''}
          </>
        ) : null}
      </ViewerEmpty>
    )
  }

  /*
   * A generous tick budget, because `logTicks` spends it on *decades* and then strides. Asked
   * for three over a four-decade span it strides by two and puts a single label on the axis —
   * measured on the card, where the value panel is about 200px: ticks landed on 0.001/0.1/10
   * and only 0.1 was inside the data. The stride is what keeps the labels apart, so the count
   * is the number of decades worth showing rather than the number of labels wanted.
   */
  const valueTicks = axisTicks(
    valueDomain,
    valueScale,
    Math.max(4, Math.floor(valueHeight / 55)),
  )
  const rankTicks = axisTicks(rankDomain, rankScale, plotWidth > 360 ? 5 : 3)
  const shareTicks = [0, 0.5, 1]

  const { linePath, sharePath } = paths

  const labelled = Math.max(0, Math.min(labelTop, count))

  return (
    <div className="viewer">
      <div
        ref={ref}
        className="viewer__scroll nowheel nodrag"
        style={{ position: 'relative', overflow: 'hidden', touchAction: 'none' }}
      >
        {width > 60 && height > 60 && (
          <svg
            ref={svgRef}
            className="chart rank-chart"
            width={width}
            height={height}
            role="img"
            aria-label={`${valueColumn} against rank for ${count.toLocaleString()} rows${
              shareDrawn ? ', with the cumulative share of the total' : ''
            }`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <rect width={width} height={height} fill={surface} />

            {/* ---- value panel ------------------------------------------ */}
            {valueTicks.map((t) => {
              const y = yOfValue(inverse(valueScale, t))
              return (
                <g key={`v${t}`}>
                  <line
                    x1={PAD.left}
                    y1={y}
                    x2={PAD.left + plotWidth}
                    y2={y}
                    stroke={ink.grid}
                    strokeWidth={1}
                  />
                  <text
                    x={PAD.left - 8}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="central"
                    fontSize={10}
                    fill={ink.muted}
                  >
                    {formatCompact(inverse(valueScale, t))}
                  </text>
                </g>
              )
            })}

            {rankTicks.map((t) => {
              const rank = Math.round(inverse(rankScale, t))
              if (rank < 1 || rank > count) return null
              const x = xOfRank(rank)
              return (
                <line
                  key={`r${t}`}
                  x1={x}
                  y1={PAD.top}
                  x2={x}
                  y2={PAD.top + valueHeight}
                  stroke={ink.grid}
                  strokeWidth={1}
                />
              )
            })}

            <line
              x1={PAD.left}
              y1={PAD.top}
              x2={PAD.left}
              y2={PAD.top + valueHeight}
              stroke={ink.axis}
              strokeWidth={1}
            />
            <line
              x1={PAD.left}
              y1={PAD.top + valueHeight}
              x2={PAD.left + plotWidth}
              y2={PAD.top + valueHeight}
              stroke={ink.axis}
              strokeWidth={1}
            />

            {/* The curve through every drawn rank, under the dots. */}
            <path
              d={linePath}
              fill="none"
              stroke={ink.muted}
              strokeWidth={1.3}
              opacity={0.55}
            />

            {drawn.map((rank) => {
              const point = series.points[rank - 1]
              if (!point) return null
              const x = xOfRank(rank)
              const y = yOfValue(point.value)
              const key = names(point.row)
              // One row, one name — so `has` and `hasAny` are the same question here, and `has`
              // is the one that means "this mark is selected".
              const picked = marks.has([key])
              return (
                <g key={rank}>
                  {point.flagged && (
                    // A ring, not a different colour: the flag says "kept out of the share",
                    // which is a fact about the reading rather than a category in the data —
                    // and colour is already spent on the data.
                    <circle
                      cx={x}
                      cy={y}
                      r={FLAG_R}
                      fill="none"
                      stroke={ink.primary}
                      strokeWidth={1}
                      strokeDasharray="3 2"
                      pointerEvents="none"
                    />
                  )}
                  <circle
                    cx={x}
                    cy={y}
                    r={picked ? DOT_R + 1.6 : DOT_R}
                    fill={colors.at(point.row)}
                    stroke={picked ? ink.primary : surface}
                    strokeWidth={picked ? 2 : 1.5}
                    data-rank={rank}
                    {...(compact
                      ? {}
                      : {
                          style: { cursor: marks.writable ? 'pointer' : 'default' },
                          onPointerDown: (event: React.PointerEvent) => {
                            // Stopped, or the background gesture takes it as the start of a
                            // brush and the click clears the selection it just made.
                            event.stopPropagation()
                          },
                          onClick: (event: React.MouseEvent) => {
                            event.stopPropagation()
                            marks.toggle([key], isAdditive(event))
                          },
                          onMouseMove: (event: React.MouseEvent) =>
                            setHover({ point, ...tooltipPoint(event, ref.current) }),
                          onMouseLeave: () => setHover(null),
                        })}
                  />
                </g>
              )
            })}

            {/* Selective direct labels, never one per point. */}
            {Array.from({ length: labelled }, (_, i) => {
              const point = series.points[i]
              if (!point) return null
              const x = xOfRank(point.rank)
              const y = yOfValue(point.value)
              return (
                <text
                  key={`l${i}`}
                  x={x + (point.flagged ? FLAG_R + 4 : DOT_R + 5)}
                  /*
                   * Staggered over three rows. The leading ranks of a heavy-tailed measure sit
                   * almost on top of each other — on a log rank axis the first five are inside
                   * the first fifth of the width — so labels drawn on one line overlap into an
                   * unreadable band. Seen on the card at five labels, all of them `LC4`.
                   */
                  y={y + 3.5 - (i % 3) * 12}
                  fontSize={10.5}
                  fill={ink.secondary}
                  stroke={surface}
                  strokeWidth={3}
                  paintOrder="stroke"
                  pointerEvents="none"
                >
                  {truncateLabel(labelOf(point), MAX_LABEL, 1)}
                </text>
              )
            })}

            {/* ---- share panel ------------------------------------------ */}
            {shareDrawn && (
              <>
                {shareTicks.map((fraction) => {
                  const y = yOfShare(fraction)
                  return (
                    <g key={`s${fraction}`}>
                      <line
                        x1={PAD.left}
                        y1={y}
                        x2={PAD.left + plotWidth}
                        y2={y}
                        stroke={ink.grid}
                        strokeWidth={1}
                      />
                      <text
                        x={PAD.left - 8}
                        y={y}
                        textAnchor="end"
                        dominantBaseline="central"
                        fontSize={10}
                        fill={ink.muted}
                      >
                        {`${Math.round(fraction * 100)}%`}
                      </text>
                    </g>
                  )
                })}
                <line
                  x1={PAD.left}
                  y1={shareTop}
                  x2={PAD.left}
                  y2={shareTop + shareHeight}
                  stroke={ink.axis}
                  strokeWidth={1}
                />
                <path d={sharePath} fill="none" stroke={ink.primary} strokeWidth={2} />

                {half !== null && (
                  <g pointerEvents="none">
                    <line
                      x1={xOfRank(half)}
                      y1={yOfShare(shareAt(series, half))}
                      x2={xOfRank(half)}
                      y2={shareTop + shareHeight}
                      stroke={ink.primary}
                      strokeWidth={1}
                      strokeDasharray="2 3"
                      opacity={0.6}
                    />
                    <circle
                      cx={xOfRank(half)}
                      cy={yOfShare(shareAt(series, half))}
                      r={3.5}
                      fill={ink.primary}
                      stroke={surface}
                      strokeWidth={2}
                    />
                    <text
                      x={xOfRank(half) + 8}
                      y={yOfShare(shareAt(series, half)) - 7}
                      fontSize={10.5}
                      fill={ink.primary}
                      stroke={surface}
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {`half by rank ${half.toLocaleString()}`}
                    </text>
                  </g>
                )}
              </>
            )}

            {/* Rank axis, drawn under whichever panel is last. */}
            {rankTicks.map((t) => {
              const rank = Math.round(inverse(rankScale, t))
              if (rank < 1 || rank > count) return null
              const x = xOfRank(rank)
              const base = shareDrawn ? shareTop + shareHeight : PAD.top + valueHeight
              return (
                <g key={`rt${t}`}>
                  {shareDrawn && (
                    <line
                      x1={x}
                      y1={shareTop}
                      x2={x}
                      y2={base}
                      stroke={ink.grid}
                      strokeWidth={1}
                    />
                  )}
                  <text x={x} y={base + 14} textAnchor="middle" fontSize={10} fill={ink.muted}>
                    {rank.toLocaleString()}
                  </text>
                </g>
              )
            })}
            {shareDrawn && (
              <line
                x1={PAD.left}
                y1={shareTop + shareHeight}
                x2={PAD.left + plotWidth}
                y2={shareTop + shareHeight}
                stroke={ink.axis}
                strokeWidth={1}
              />
            )}
          </svg>
        )}

        {/*
         * The shared overlay, not a `<rect>` of our own: the corner arithmetic and the dashed
         * styling are `GestureMarquee`'s, so one drag gesture looks the same on this chart as on
         * the scatter and the heatmap. It spans the value panel's height because the brush is a
         * range of the *ranking* — one axis, by construction.
         */}
        {brush && Math.abs(brush.to - brush.from) >= CLICK_SLOP && (
          <GestureMarquee
            x0={brush.from}
            y0={PAD.top}
            x1={brush.to}
            y1={PAD.top + valueHeight}
            width={size.width}
            height={size.height}
          />
        )}

        {hover && !brush && (
          <ChartTooltip at={hover}>
            <strong>{labelOf(hover.point)}</strong>
            <TooltipRow>
              {valueColumn} {formatNumber(hover.point.value)}
            </TooltipRow>
            <TooltipRow>rank {hover.point.rank.toLocaleString()}</TooltipRow>
            {shareDrawn && !hover.point.flagged && (
              <TooltipRow>
                {`${formatShare(shareAt(series, hover.point.rank))} of the total by here`}
              </TooltipRow>
            )}
            {hover.point.flagged && <TooltipRow>not counted in the share</TooltipRow>}
          </ChartTooltip>
        )}
      </div>

      <div className="viewer__caption">
        <span>
          {plural(count, 'row')}
          {series.flagged > 0 ? ` · ${series.flagged.toLocaleString()} flagged` : ''}
          {marks.size > 0 ? ` · ${marks.size} selected` : ''}
          {shareDrawn ? ` · ${shareLine(series, count)}` : ''}
        </span>
        <ColorKey colors={colors} />
        {series.shareRefusal && (
          <span
            className="viewer__note"
            title={`No cumulative share: ${series.shareRefusal}. The ranking above is unaffected.`}
          >
            no share
          </span>
        )}
        {(series.missing > 0 || series.nonPositive > 0) && (
          <span className="viewer__note" title={dropTitle(series)}>
            {(series.missing + series.nonPositive).toLocaleString()} not plotted
          </span>
        )}
        {count > DOT_BUDGET && (
          <span
            className="viewer__note"
            title={`Every row is ranked and the curve runs through all of them, but only ${DOT_BUDGET} points are drawn — the head of the ranking in full, the tail sampled. Hover reads the drawn points.`}
          >
            points sampled
          </span>
        )}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'rank')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}

/** `top 20 carry 57%` where there is a rank 20 to say it about. */
function shareLine(series: RankSeries, count: number): string {
  const at = count >= 100 ? 100 : count >= 20 ? 20 : count >= 5 ? 5 : count
  return `top ${at.toLocaleString()} carry ${formatShare(shareAt(series, at))}`
}

function dropTitle(series: RankSeries): string {
  const parts: string[] = []
  if (series.missing > 0) {
    parts.push(`${series.missing.toLocaleString()} rows have no number in this column`)
  }
  if (series.nonPositive > 0) {
    parts.push(
      `${series.nonPositive.toLocaleString()} are at or below zero, which has no logarithm — turn Log value off to include them`,
    )
  }
  return parts.join('; ')
}

/**
 * The polyline through a set of ranks.
 *
 * Takes the same rank list the dots do, so the curve cannot pass somewhere the dots say it does
 * not. `y` is a function rather than a value so the share panel reuses it: the two curves differ
 * in what they read off each rank and in nothing else.
 */
function pathThrough(
  ranks: readonly number[],
  series: RankSeries,
  x: (rank: number) => number,
  y: (value: number, rank: number) => number,
): string {
  let d = ''
  for (let i = 0; i < ranks.length; i++) {
    const rank = ranks[i]!
    const point = series.points[rank - 1]
    if (!point) continue
    d += `${d === '' ? 'M' : 'L'}${x(rank).toFixed(2)} ${y(point.value, rank).toFixed(2)}`
  }
  return d
}
