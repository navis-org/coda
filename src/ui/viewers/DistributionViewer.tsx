import { useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import type { TableValue } from '../../core/values'
import { CHART_INK, MAX_BAR_THICKNESS, chartSurface, currentMode, seriesColor } from '../colors'
import { exportBaseName as makeBaseName, tableToCsvParts } from '../export'
import { formatCompact, formatNumber, labelGutter, plural, truncateLabel } from '../format'
import { ClearSelection } from './LegendKeys'
import type { GroupDistribution, WhiskerRule } from './boxStats'
import { MAX_GROUPS_DEFAULT, groupValues, summarise, swarmOffsets } from './boxStats'
import { isAdditive, useMarkSelection } from './useMarkSelection'
import type { ScaleKind } from './scatterPlot'
import { axisTicks, forward, inverse } from './scatterPlot'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { tooltipPoint } from './tooltipPoint'
import { useElementSize } from './useElementSize'

export type DistributionStyle = 'box' | 'violin' | 'both' | 'swarm' | 'swarmBox'
export type DistributionOrientation = 'rows' | 'columns'

export interface DistributionViewerProps {
  table: TableValue
  valueColumn: string
  groupColumn?: string
  style?: DistributionStyle
  /** `rows` puts the groups down the side, `columns` along the bottom. */
  orientation?: DistributionOrientation
  points?: 'outliers' | 'none'
  whiskers?: WhiskerRule
  log?: boolean
  sortByMedian?: boolean
  maxGroups?: number
  /** Group labels — see `chartSelection.ts`. */
  selection?: string[]
  onSelectionChange?: (ids: string[]) => void
  compact?: boolean
  /** Filename stem for CSV/SVG/PNG export. */
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

interface Hover {
  group: number
  x: number
  y: number
}

/** Radius of a swarm mark. Small: a swarm's job is to be countable, not to be seen from afar. */
const SWARM_RADIUS = 2.2
/** Rotation for the group labels when they run along the bottom. */
const COLUMN_LABEL_ANGLE = -45
/** Air above the value axis laid out as columns, so the tallest whisker is not clipped. */
const TOP_PAD = 6

/**
 * Box plots, violins and swarms, either way round and clickable.
 *
 * **The default is groups down the side**, for the reason the Bar Chart is horizontal: these
 * names are ROI and cell types, which read straight along a left-hand gutter and need rotating
 * 45° as columns. `orientation` offers the other one anyway, because a box plot is the panel
 * most likely to have to sit in a figure beside other vertical ones.
 *
 * **Every mark is placed in (value, across) and mapped once.** `frame` below is the only thing
 * in this file that knows which axis is which; a second `if (vertical)` anywhere else is how
 * the two orientations drift into being two charts. It costs one indirection per mark and buys
 * a violin, a swarm, five box parts and the selection outline that cannot disagree.
 *
 * Everything numeric is in `boxStats.ts` — jsdom has no layout, so arithmetic left here is
 * covered by nothing. What is here is marks, the projection, and the tooltip.
 */
export function DistributionViewer({
  table,
  valueColumn,
  groupColumn,
  style = 'box',
  orientation = 'rows',
  points = 'outliers',
  whiskers = 'tukey',
  log = false,
  sortByMedian = true,
  maxGroups = MAX_GROUPS_DEFAULT,
  selection,
  onSelectionChange,
  compact = false,
  baseName,
  onExpand,
  onError,
}: DistributionViewerProps) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<Hover | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const mode = currentMode()
  const ink = CHART_INK[mode]
  const surface = chartSurface(mode)

  const exportSource: ExportSource = useMemo(
    () => ({ csv: () => tableToCsvParts(table), svg: () => svgRef.current }),
    [table],
  )

  const showBox = style === 'box' || style === 'both' || style === 'swarmBox'
  const showViolin = style === 'violin' || style === 'both'
  const showSwarm = style === 'swarm' || style === 'swarmBox'

  // Two memos, not one: the bucketing is the only O(rows) half, and none of the whisker rule,
  // the cap, the sort or the style changes it. See `groupValues`.
  const grouped = useMemo(
    () => groupValues(table, valueColumn, groupColumn, log),
    [table, valueColumn, groupColumn, log],
  )
  const distributions = useMemo(
    () =>
      summarise(grouped, {
        whiskers,
        maxGroups,
        sortByMedian,
        violin: showViolin,
        swarm: showSwarm,
      }),
    [grouped, whiskers, maxGroups, sortByMedian, showViolin, showSwarm],
  )

  const marks = useMarkSelection(selection, onSelectionChange)

  const { groups, dropped, groupCount, lo, hi } = distributions

  if (groups.length === 0) {
    return (
      <div className="viewer">
        <div className="viewer__empty">
          {dropped > 0
            ? `Nothing to plot — no usable ${log ? 'positive ' : ''}numbers in "${valueColumn}"`
            : 'Nothing to plot — no rows'}
        </div>
      </div>
    )
  }

  const vertical = orientation === 'columns'
  const labels = groups.map((g) => g.label)

  /*
   * Two gutters, named by what they hold rather than by which side they are on — because which
   * side they are on is exactly what `orientation` swaps.
   *
   * `groupPad` holds the group names and `tickPad` holds the axis numbers. Laid out as rows the
   * first is the left margin and the second the bottom one; as columns they trade places.
   */
  const groupPad = groupColumn
    ? vertical
      ? // Rotated 45°, so a label's vertical bite is its length times cos(45°). Capped, with
        // `truncateLabel` doing the rest — a 30-character cell type would otherwise take half
        // the card.
        Math.min(compact ? 40 : 84, Math.max(compact ? 16 : 22, longest(labels) * 6 * 0.71 + 8))
      : labelGutter(labels, compact)
    : compact
      ? 8
      : 12
  const tickPad = vertical ? (compact ? 26 : 38) : compact ? 12 : 18
  const farPad = 10
  const leftPad = vertical ? tickPad : groupPad
  const bottomPad = vertical ? groupPad : tickPad

  /*
   * Bands stretch to fill and stop at 72px.
   *
   * A fixed band left ten groups clustered at one end of an expanded viewer with six hundred
   * pixels of gridline beyond them and the tick labels pinned to the far edge — which reads as
   * a chart that failed to draw rather than as one with room to spare. Seen in a browser;
   * jsdom performs no layout, so nothing here could have caught it.
   *
   * The cap is the other half: without one, two groups would each take half the card. Past what
   * the cap can fit the content outgrows the box and the wrapper scrolls, in whichever
   * direction the bands happen to run.
   */
  const bandRoom = vertical
    ? Math.max(40, size.width - leftPad - farPad)
    : Math.max(40, size.height - bottomPad - 6)
  const band = Math.max(16, Math.min(72, bandRoom / groups.length))
  const bandExtent = groups.length * band
  /*
   * Centred in whatever the bands do not fill.
   *
   * The cap means a handful of groups leaves slack — eight columns at 72px use 576px of an
   * expanded viewer's 1,470 — and pinned to one end that reads as a chart that stopped drawing
   * half way. The gridlines and the value-axis labels move with the block rather than with the
   * box, so what floats in the middle is a whole small chart rather than a plot with its axis
   * stranded at the far edge. Both seen in a browser; jsdom performs no layout.
   */
  const bandOffset = Math.max(0, (bandRoom - bandExtent) / 2)
  const valueExtent = Math.max(
    10,
    vertical ? size.height - bottomPad - TOP_PAD : size.width - leftPad - farPad,
  )

  const width = vertical ? Math.max(size.width, leftPad + bandExtent + farPad) : size.width
  const height = vertical
    ? Math.max(60, size.height)
    : Math.max(size.height, bandExtent + bottomPad + 6)

  /*
   * The value axis, in the space the picture is linear in.
   *
   * A log axis maps `log10(value)`, so the domain is transformed and everything drawn against
   * it goes through `forward` — the same two-space discipline `scatterPlot.ts` writes out, and
   * the same rule about never mixing them. The ticks are the exception worth naming: they are
   * chosen in transformed space and labelled through `inverse`, so the labels are round numbers.
   */
  const kind: ScaleKind = log ? 'log' : 'linear'
  const domainLo = log ? forward(kind, lo) : Math.min(0, lo)
  const domainHi = forward(kind, hi)
  const span = domainHi > domainLo ? domainHi - domainLo : 1

  const frame = makeFrame({
    vertical,
    bandOrigin: (vertical ? leftPad : 0) + bandOffset,
    leftPad,
    bottomPad,
    valueExtent,
    band,
    domainLo,
    span,
    kind,
  })

  /*
   * `axisTicks` rather than `niceTicks`, and that is the scatter's rule reused rather than a
   * third one written here. `niceTicks` answers in value space starting from zero — on a log
   * axis it puts every tick inside the last decade, and it rounds its top up *past* the data,
   * so a `600` label landed out in the margin with no gridline under it. `axisTicks` works in
   * transformed space and bounds itself to the domain at both ends.
   */
  const ticks = axisTicks(
    { min: domainLo, max: domainHi },
    kind,
    valueExtent > 240 ? 4 : 2,
  ).map((t) => inverse(kind, t))
  const boxThickness = Math.max(2, Math.min(MAX_BAR_THICKNESS, band - 14))
  const hovered = hover ? groups[hover.group] : undefined

  return (
    <div className="viewer">
      <div ref={ref} className="viewer__scroll nowheel" style={{ position: 'relative' }}>
        {size.width > 60 && (
          <svg ref={svgRef} className="chart" width={width} height={height} role="img">
            <title>{`Distribution of ${valueColumn}${groupColumn ? ` by ${groupColumn}` : ''}`}</title>
            <rect width={width} height={height} fill={surface} />

            {ticks.map((tick) => (
              <line
                key={`grid-${tick}`}
                {...frame.gridLine(tick, bandExtent)}
                stroke={ink.grid}
                strokeWidth={1}
              />
            ))}

            {groups.map((group, index) => {
              const isSelected = marks.has([group.label])
              const dim = marks.size > 0 && !isSelected
              const color = seriesColor(group.colorIndex, mode)
              const stats = group.stats
              const centre = frame.bandCentre(index)
              const half = boxThickness / 2

              return (
                <g
                  key={group.label}
                  {...(marks.writable && groupColumn
                    ? {
                        onClick: (event: ReactMouseEvent) =>
                          marks.toggle([group.label], isAdditive(event)),
                        style: { cursor: 'pointer' },
                      }
                    : {})}
                  onMouseMove={(event) =>
                    setHover({ group: index, ...tooltipPoint(event, ref.current) })
                  }
                  onMouseLeave={() => setHover(null)}
                  opacity={dim ? 0.4 : 1}
                >
                  {/* A full-band hit area: a narrow box is otherwise a few pixels of target. */}
                  <rect {...frame.bandRect(index)} fill="transparent" />

                  {showViolin && group.curve.length > 1 && (
                    <path
                      d={violinPath(group, centre, half + 4, frame)}
                      fill={color}
                      opacity={style === 'both' ? 0.35 : 0.8}
                    />
                  )}

                  {showBox && (
                    <>
                      {/* Whiskers, then the box, then the median: painter's order is what keeps
                          the median line visible over its own box. */}
                      <line
                        {...frame.line(stats.lower, centre, stats.upper, centre)}
                        stroke={ink.muted}
                        strokeWidth={1}
                      />
                      {[stats.lower, stats.upper].map((end, i) => (
                        <line
                          key={`cap-${i}`}
                          {...frame.line(end, centre - half / 2, end, centre + half / 2)}
                          stroke={ink.muted}
                          strokeWidth={1}
                        />
                      ))}
                      {/*
                       * Three fills for three jobs. Alone, the box is the mark and takes the
                       * colour. Over a violin it takes the surface, so it reads as a panel on
                       * top of the shape. Under a swarm it takes **no fill at all** — the
                       * marks inside the IQR are most of them, and a box painted over them is
                       * a swarm you cannot see, which is what this drew first.
                       */}
                      <rect
                        {...frame.rect(stats.q1, stats.q3, centre - half, centre + half)}
                        rx={2}
                        fill={style === 'box' ? color : showSwarm ? 'none' : surface}
                        fillOpacity={style === 'box' ? 1 : 0.9}
                        stroke={style === 'box' ? 'none' : color}
                        strokeWidth={1}
                      />
                      <line
                        {...frame.line(
                          stats.median,
                          centre - half,
                          stats.median,
                          centre + half,
                        )}
                        stroke={style === 'box' ? ink.primary : color}
                        strokeWidth={1.5}
                      />
                    </>
                  )}

                  {/*
                   * Last, so the marks sit on top of the box rather than under it — the same
                   * order `sns.boxplot` then `sns.swarmplot` gives, and the emitters follow.
                   */}
                  {showSwarm &&
                    swarmMarks(group, centre, half + 4, frame).map((mark, i) => (
                      <circle
                        key={`swarm-${i}`}
                        cx={mark.x}
                        cy={mark.y}
                        r={SWARM_RADIUS}
                        fill={color}
                        opacity={0.85}
                      />
                    ))}

                  {/* A swarm already draws every observation, outliers included. */}
                  {points === 'outliers' &&
                    !showSwarm &&
                    stats.outliers.map((value, i) => {
                      const at = frame.point(value, centre)
                      return (
                        <circle
                          key={`out-${i}`}
                          cx={at.x}
                          cy={at.y}
                          r={1.5}
                          fill={ink.muted}
                          opacity={0.7}
                        />
                      )
                    })}

                  {isSelected && (
                    <rect
                      {...frame.bandRect(index, 1)}
                      fill="none"
                      stroke={ink.primary}
                      strokeWidth={1}
                      rx={2}
                    />
                  )}

                  {groupColumn && (
                    <text
                      {...frame.bandLabel(index)}
                      fill={isSelected ? ink.primary : ink.secondary}
                      fontSize={10}
                    >
                      {truncateLabel(group.label, vertical ? groupPad / 0.71 : groupPad - 8)}
                    </text>
                  )}
                </g>
              )
            })}

            {ticks.map((tick) => (
              <text
                key={`tick-${tick}`}
                {...frame.tickLabel(tick, bandExtent)}
                fill={ink.muted}
                fontSize={9.5}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatCompact(tick)}
              </text>
            ))}
          </svg>
        )}

        {hovered && (
          <div
            className="chart-tooltip"
            style={{ left: hover!.x + 12, top: hover!.y + 12 }}
            role="status"
          >
            <strong>{hovered.label}</strong>
            <div className="chart-tooltip__row">
              <span
                className="chart-tooltip__swatch"
                style={{ background: seriesColor(hovered.colorIndex, mode) }}
              />
              median {formatNumber(hovered.stats.median)}
            </div>
            <div className="chart-tooltip__row">
              IQR {formatNumber(hovered.stats.q1)} – {formatNumber(hovered.stats.q3)}
            </div>
            <div className="chart-tooltip__row">
              whiskers {formatNumber(hovered.stats.lower)} – {formatNumber(hovered.stats.upper)}
            </div>
            <div className="chart-tooltip__row">
              {plural(hovered.stats.n, 'row')}
              {showSwarm && hovered.swarm.length < hovered.stats.n
                ? ` · ${formatNumber(hovered.swarm.length)} drawn`
                : ''}
              {!showSwarm && hovered.stats.outlierCount > 0
                ? ` · ${plural(hovered.stats.outlierCount, 'outlier')}`
                : ''}
            </div>
          </div>
        )}
      </div>

      <div className="viewer__caption">
        <span>
          {valueColumn}
          {groupColumn ? ` by ${groupColumn}` : ''}
          {log ? ' · log' : ''}
        </span>
        <span>
          {groupCount > groups.length
            ? `${groups.length} of ${plural(groupCount, 'group')}`
            : plural(groups.length, 'group')}
          {dropped > 0 ? ` · ${dropped} unplottable` : ''}
          {showSwarm && thinnedSwarm(groups) ? ' · swarm thinned' : ''}
        </span>
        {marks.size > 0 && (
          <ClearSelection
            label={`${plural(marks.size, 'group')} selected`}
            onClear={marks.clear}
          />
        )}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'distribution')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The frame: the one place that knows which axis is which
// ---------------------------------------------------------------------------

interface Point {
  x: number
  y: number
}

interface Frame {
  /** Pixel position on the value axis. */
  valuePx(value: number): number
  /**
   * A mark whose value-axis pixel is already known.
   *
   * The swarm's case: it packs in pixels, so it must not round-trip its positions back through
   * the scale — under a log axis that is not the identity.
   */
  alongPoint(alongPx: number, across: number): Point
  /** Pixel position of band `index`'s centre, on the band axis. */
  bandCentre(index: number): number
  /** A (value, band-axis pixel) pair, in screen coordinates. */
  point(value: number, across: number): Point
  line(v0: number, a0: number, v1: number, a1: number): Record<string, number>
  rect(v0: number, v1: number, a0: number, a1: number): Record<string, number>
  /** The whole of band `index`, for a hit area or a selection outline. */
  bandRect(index: number, inset?: number): Record<string, number>
  gridLine(tick: number, bandExtent: number): Record<string, number>
  tickLabel(tick: number, bandExtent: number): Record<string, unknown>
  bandLabel(index: number): Record<string, unknown>
}

function makeFrame(m: {
  vertical: boolean
  /** Where the first band starts on its own axis, centring included. */
  bandOrigin: number
  /** Left margin: the group names laid out as rows, the axis numbers as columns. */
  leftPad: number
  /** Bottom margin: the axis numbers laid out as rows, the group names as columns. */
  bottomPad: number
  valueExtent: number
  band: number
  domainLo: number
  span: number
  kind: ScaleKind
}): Frame {
  const { vertical, bandOrigin, leftPad, bottomPad, valueExtent, band, domainLo, span, kind } =
    m

  /*
   * The value axis runs left-to-right laid out as rows and **bottom-to-top** as columns, which
   * is the one asymmetry here: screen y grows downwards and a value axis does not. Getting it
   * backwards draws the whole chart upside down, which is obvious — and getting it backwards in
   * only the violin, which is what a second copy of the mapping produces, is not.
   */
  const valuePx = (value: number): number => {
    const t = (forward(kind, value) - domainLo) / span
    return vertical ? TOP_PAD + (1 - t) * valueExtent : leftPad + t * valueExtent
  }

  const bandStart = (index: number): number => bandOrigin + index * band
  const bandCentre = (index: number): number => bandStart(index) + band / 2
  const point = (value: number, across: number): Point =>
    vertical ? { x: across, y: valuePx(value) } : { x: valuePx(value), y: across }

  return {
    valuePx,
    bandCentre,
    point,
    alongPoint: (alongPx, across) =>
      vertical ? { x: across, y: alongPx } : { x: alongPx, y: across },
    line: (v0, a0, v1, a1) => {
      const p = point(v0, a0)
      const q = point(v1, a1)
      return { x1: p.x, y1: p.y, x2: q.x, y2: q.y }
    },
    rect: (v0, v1, a0, a1) => {
      const p = point(v0, a0)
      const q = point(v1, a1)
      return {
        x: Math.min(p.x, q.x),
        y: Math.min(p.y, q.y),
        width: Math.max(1, Math.abs(q.x - p.x)),
        height: Math.max(1, Math.abs(q.y - p.y)),
      }
    },
    bandRect: (index, inset = 0) =>
      vertical
        ? {
            x: bandStart(index) + inset,
            y: TOP_PAD,
            width: Math.max(1, band - inset * 2),
            height: valueExtent,
          }
        : {
            x: leftPad,
            y: bandStart(index) + inset,
            width: valueExtent,
            height: Math.max(1, band - inset * 2),
          },
    gridLine: (tick, bandExtent) => {
      const at = valuePx(tick)
      return vertical
        ? { x1: bandOrigin, x2: bandOrigin + bandExtent, y1: at, y2: at }
        : { x1: at, x2: at, y1: bandOrigin, y2: bandOrigin + bandExtent }
    },
    tickLabel: (tick, bandExtent) => {
      const at = valuePx(tick)
      return vertical
        ? {
            // Against the first column rather than the left edge, so the numbers stay with the
            // block they label once it is centred.
            x: bandOrigin - 5,
            y: at,
            textAnchor: 'end' as const,
            dominantBaseline: 'central' as const,
          }
        : { x: at, y: bandOrigin + bandExtent + bottomPad - 5, textAnchor: 'middle' as const }
    },
    bandLabel: (index) => {
      const centre = bandCentre(index)
      if (!vertical) {
        return {
          x: leftPad - 5,
          y: centre,
          textAnchor: 'end' as const,
          dominantBaseline: 'central' as const,
        }
      }
      // Rotated about its own anchor just under the foot of the column, so the label hangs down
      // and to the left of the column it names rather than across its neighbour's.
      const foot = TOP_PAD + valueExtent + 8
      return {
        x: centre,
        y: foot,
        textAnchor: 'end' as const,
        dominantBaseline: 'central' as const,
        transform: `rotate(${COLUMN_LABEL_ANGLE}, ${centre}, ${foot})`,
      }
    },
  }
}

// ---------------------------------------------------------------------------

function longest(labels: string[]): number {
  return labels.reduce((m, label) => Math.max(m, label.length), 0)
}

function thinnedSwarm(groups: GroupDistribution[]): boolean {
  return groups.some((group) => group.swarm.length < group.stats.n)
}

/**
 * The violin outline: the curve up one side and back down the other.
 *
 * Symmetric, which is the convention and is what makes the width readable — a half violin
 * doubles as a density plot and reads as one, i.e. as a different chart.
 */
function violinPath(
  group: GroupDistribution,
  centre: number,
  halfWidth: number,
  frame: Frame,
): string {
  // `curve.t` is already in the axis's own space, so `frame.point` takes it as a value and
  // re-projects — the one crossing between the two spaces in this file.
  const at = (p: { t: number; w: number }, sign: number) => {
    const q = frame.point(p.t, centre + sign * p.w * halfWidth)
    return `${q.x},${q.y}`
  }
  const near = group.curve.map((p) => at(p, -1))
  const far = [...group.curve].reverse().map((p) => at(p, 1))
  return `M${near.join('L')}L${far.join('L')}Z`
}

/**
 * A group's swarm, packed so no two marks overlap.
 *
 * Projected first and packed second, because the packing is a question about circles on screen:
 * the same values at two zoom levels want different offsets. `swarmOffsets` does the packing
 * and is tested; what is here is the projection and the clamp.
 *
 * The clamp is the part that would otherwise bite: a dense group packs wider than its band and
 * would spill into its neighbours, so the whole swarm is scaled to fit. Scaling rather than
 * truncating keeps it symmetric, which is what stops a squeezed swarm reading as a skewed one.
 */
function swarmMarks(
  group: GroupDistribution,
  centre: number,
  halfWidth: number,
  frame: Frame,
): Point[] {
  if (group.swarm.length === 0) return []
  const along = group.swarm.map((value) => frame.valuePx(value))
  // `valuePx` is descending under a vertical layout, and `swarmOffsets` needs its window sorted.
  const ascending = along.length > 1 && along[0]! > along[along.length - 1]!
  const ordered = ascending ? [...along].reverse() : along
  const packed = swarmOffsets(ordered, SWARM_RADIUS)
  const offsets = ascending ? [...packed].reverse() : packed

  const widest = offsets.reduce((m, offset) => Math.max(m, Math.abs(offset)), 0)
  const scale = widest > halfWidth ? halfWidth / widest : 1
  return along.map((at, i) => frame.alongPoint(at, centre + offsets[i]! * scale))
}
