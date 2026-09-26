import { useMemo } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'

import type { TableValue } from '../../core/values'
import type { ValueRange } from '../../nodes/lib/chartSelection'
import { MISSING_LABEL } from '../../nodes/lib/chartSelection'
import type { CorticalFrame } from '../../packs/cortex/frames'
import type { FacetRef } from '../../packs/cortex/profileSelection'
import { encodeProfileMark } from '../../packs/cortex/profileSelection'
import type { Mode } from '../colors'
import { CHART_INK, SURFACE_GAP, seriesColor } from '../colors'
import { exportBaseName as makeBaseName } from '../export'
import { formatCompact, formatNumber, formatShare, niceTicks, plural } from '../format'
import { ChartTooltip, TooltipRow } from '../viewers/ChartTooltip'
import { ClearSelection } from '../viewers/LegendKeys'
import type { Histogram, ValueScan } from '../viewers/histogramBins'
import {
  MISSING_SLOT,
  alignedWidth,
  binScan,
  normalizeLabel,
  scanValues,
  seriesFold,
} from '../viewers/histogramBins'
import { tooltipPoint } from '../viewers/tooltipPoint'
import { isAdditive, useMarkSelection } from '../viewers/useMarkSelection'
import { useChart } from '../viewers/useChart'
import { ViewerActions } from '../viewers/ViewerActions'
import { ViewerEmpty } from '../viewers/ViewerEmpty'
import type { LayerCount } from './laminarProfile'
import { facetGrid, facetGroups, layerCounts, profileScale } from './laminarProfile'
import type { LayerBand, RowScale } from './wall'
import { depthY, layerBands, piaY } from './wall'

export interface LaminarProfileViewerProps {
  table: TableValue
  depthColumn: string
  seriesColumn?: string
  /** A column giving each of its values a panel of its own. */
  facetColumn?: string
  /** The most panels drawn, largest first. */
  facetMax?: number
  /** The dataset's frame, for the layers; absent draws the bars alone. */
  frame?: CorticalFrame
  binUm: number
  normalize: 'count' | 'percent'
  /** Encoded depth ranges, each within a facet where faceted — see `profileSelection.ts`. */
  selection?: string[]
  onSelectionChange?: (ids: string[]) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

interface Hover {
  panel: number
  bar: number
  x: number
  y: number
}

/** One panel: its facet (none unfaceted), its values, bars and layer counts. */
interface Panel {
  facet?: FacetRef
  scan: ValueScan
  profile: Histogram
  layers: LayerCount[]
}

/** Where everything sits, px — worked out once per size and data, never per pointer move. */
interface Layout {
  grid: { columns: number; rows: number; panelWidth: number }
  rowHeight: number
  plotHeight: number
  axisHeight: number
  titleHeight: number
  tickWidth: number
  panelGap: number
  /** The unfaceted gutter holding each layer's count and share; 0 when faceted or compact. */
  countWidth: number
  /** Faceted: each layer's name and share inside its panel's right edge. */
  inlineShares: boolean
  y: (depth: number) => number
  scale: RowScale
  scaleMax: number
  ticks: number[]
  depthTicks: number[]
  bands: LayerBand[]
}

/** Where panel `index` sits: its grid cell, left edge and plot top, px. The marks and the hover. */
function panelOrigin(layout: Layout, index: number) {
  const { grid, rowHeight, titleHeight, axisHeight, tickWidth, panelGap } = layout
  const column = index % grid.columns
  const row = Math.floor(index / grid.columns)
  return {
    column,
    row,
    left: tickWidth + column * (grid.panelWidth + panelGap),
    plotTop: row * rowHeight + titleHeight + axisHeight,
  }
}

/** A series' or facet's colour: the muted ink for the absence set apart, the palette otherwise. */
function slotColor(slot: number, mode: Mode): string {
  return slot === MISSING_SLOT ? CHART_INK[mode].muted : seriesColor(slot, mode)
}

/** A label as the chart says it: an absence named for its column, never as a value called `—`. */
function nameOf(label: string, column: string | undefined): string {
  return label === MISSING_LABEL && column ? `no ${column}` : label
}

/**
 * A depth column as horizontal bars running down the cortex, the layers behind them — one panel,
 * or one per value of a facet column.
 *
 * **Every panel is one picture read the same way**: one depth axis, one bin grid (the width is
 * decided once, over the whole table — `alignedWidth`), one count scale, and one colour per
 * series, the ranking taken over the whole table (`seriesFold`) rather than per panel — per
 * panel, a partner type would change colour from one neuron to the next. Under `percent` each
 * panel is a share of its *own* rows, which is what makes two neurons of very different sizes
 * comparable by shape.
 *
 * **A pointer move redraws the tooltip and one outline, never the panels**: the panels are
 * memoised apart from the hover, which at 48 panels of 200 bars was a reconciliation of some
 * hundred thousand rects per move.
 *
 * The arithmetic is `histogramBins.ts`' and `laminarProfile.ts`'; what is here is marks, hit areas
 * and the tooltip. The layer bands are the gallery's (`layerBands`), in the grid ink — chrome, so
 * they read as ground under the data rather than as data.
 */
export function LaminarProfileViewer({
  table,
  depthColumn,
  seriesColumn,
  facetColumn,
  facetMax = 12,
  frame,
  binUm,
  normalize,
  selection,
  onSelectionChange,
  compact = false,
  baseName,
  onExpand,
  onError,
}: LaminarProfileViewerProps) {
  const { ref, size, hover, setHover, svgRef, mode, ink, surface, exportSource } =
    useChart<Hover>(table)
  const marks = useMarkSelection(selection, onSelectionChange)

  // The row walks keyed on the table and columns alone; `Panels`, bin width and scale only
  // reshape what they found.
  const whole = useMemo(
    () => scanValues(table, depthColumn, seriesColumn),
    [table, depthColumn, seriesColumn],
  )
  // Untyped partners out of the ranking, stacked last and muted, so typed ones take the palette.
  const fold = useMemo(() => seriesFold(whole, true), [whole])
  const groups = useMemo(
    () => (facetColumn ? facetGroups(table, facetColumn) : undefined),
    [table, facetColumn],
  )
  const scans = useMemo((): { facet?: FacetRef; scan: ValueScan }[] => {
    if (!groups || !facetColumn) return [{ scan: whole }]
    return groups.slice(0, Math.max(1, facetMax)).map(({ label, rows }) => ({
      facet: { column: facetColumn, label },
      scan: scanValues(table, depthColumn, seriesColumn, false, rows),
    }))
  }, [groups, facetColumn, facetMax, whole, table, depthColumn, seriesColumn])
  const layers = useMemo(
    () => scans.map(({ scan }) => (frame ? layerCounts(frame, scan.kept) : [])),
    [scans, frame],
  )
  // An empty scan spans nothing, so this is `binUm` itself there.
  const width = alignedWidth(binUm, whole.loT, whole.hiT)
  const panels: Panel[] = useMemo(
    () =>
      scans.map(({ facet, scan }, i) => ({
        ...(facet ? { facet } : {}),
        scan,
        profile: binScan(scan, { width, normalize, missingLast: true, fold }),
        layers: layers[i]!,
      })),
    [scans, width, normalize, fold, layers],
  )

  const faceted = groups !== undefined
  const drawn = useMemo(() => panels.filter((panel) => panel.profile.bars.length > 0), [panels])
  // Undefined until the container is measured — which needs the container drawn, so an unmeasured
  // chart is an empty box, never the "nothing to plot" state, or it would stay unmeasured.
  const layout = useMemo((): Layout | undefined => {
    if (drawn.length === 0 || size.width <= 60) return undefined
    const axisHeight = compact ? 14 : 18
    const titleHeight = faceted ? 16 : 0
    const tickWidth = compact ? 28 : 36
    const panelGap = faceted ? 12 : 0
    const countWidth = frame && !compact && !faceted ? 78 : 0
    const height = Math.max(120, size.height)
    const grid = facetGrid(
      panels.length,
      Math.max(1, size.width - tickWidth - countWidth - 6),
      panelGap,
    )
    // One row fills the card; more scroll, each tall enough to read the layers in.
    const rowHeight =
      grid.rows === 1 ? height : Math.max(compact ? 160 : 260, Math.floor(height / 2))
    const plotHeight = Math.max(40, rowHeight - axisHeight - titleHeight - 6)
    const lo = Math.min(...drawn.map((p) => p.profile.bars[0]!.lo))
    const hi = Math.max(...drawn.map((p) => p.profile.bars[p.profile.bars.length - 1]!.hi))
    const scale = profileScale(frame, lo, hi, plotHeight)
    const max = Math.max(...drawn.map((p) => p.profile.max))
    const ticks = niceTicks(max, grid.panelWidth > 240 ? 4 : 2)
    const bottom = scale.top + plotHeight / scale.pxPerUm
    return {
      grid,
      rowHeight,
      plotHeight,
      axisHeight,
      titleHeight,
      tickWidth,
      panelGap,
      countWidth,
      inlineShares: faceted && !!frame,
      y: depthY(scale),
      scale,
      scaleMax: ticks.length > 1 ? ticks[ticks.length - 1]! : max || 1,
      ticks,
      depthTicks: niceTicks(bottom, compact ? 4 : 8).filter(
        (tick) => tick >= scale.top && tick <= bottom,
      ),
      bands: frame ? layerBands(frame, scale, plotHeight) : [],
    }
  }, [drawn, panels, size.width, size.height, compact, faceted, frame])

  /*
   * Every mark the current grouping draws, so a selection made under another — `Facet by` changed
   * since, or the unfaceted chart — is counted rather than silently dimming every bar with nothing
   * highlighted. Those entries still select their rows (`profileSelection.ts`).
   */
  const drawnKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const panel of panels) {
      for (const bar of panel.profile.bars) keys.add(encodeProfileMark(bar, panel.facet))
      for (const layer of panel.layers) keys.add(encodeProfileMark(layer.range, panel.facet))
    }
    return keys
  }, [panels])
  const shown = (selection ?? []).filter((key) => drawnKeys.has(key)).length
  const elsewhere = (selection?.length ?? 0) - shown

  const body = useMemo((): ReactNode => {
    if (!layout) return null
    const { grid, plotHeight, countWidth, inlineShares, y, scale } = layout
    const { scaleMax, ticks, depthTicks, bands } = layout
    const { panelWidth } = grid
    const clickable = (key: string) =>
      marks.writable
        ? { onClick: (event: ReactMouseEvent) => marks.toggle([key], isAdditive(event)) }
        : {}
    const pointer = marks.writable ? { cursor: 'pointer' } : {}
    const unit = normalize === 'percent' ? '%' : ''

    return panels.map((panel, index) => {
      const { column, row, left, plotTop } = panelOrigin(layout, index)
      const yOf = (depth: number) => plotTop + y(depth)
      const xOf = (value: number) => left + (value / scaleMax) * panelWidth
      const markOf = (range: ValueRange) => encodeProfileMark(range, panel.facet)
      const panelUsed = panel.scan.kept.length
      return (
        <g key={panel.facet?.label ?? 'whole'}>
          {panel.facet && (
            <text
              x={left}
              y={row * layout.rowHeight + 12}
              fill={ink.secondary}
              fontSize={11}
              fontWeight={600}
            >
              {nameOf(panel.facet.label, facetColumn)}
              <tspan fill={ink.muted} fontWeight={400}>
                {` · ${formatNumber(panelUsed)}`}
              </tspan>
            </text>
          )}

          {/* The layers, as ground: every other band filled. */}
          <g transform={`translate(${left} ${plotTop})`}>
            {bands.map((band) =>
              band.filled ? (
                <rect
                  key={band.name}
                  x={0}
                  y={band.from}
                  width={panelWidth}
                  height={Math.max(0, band.to - band.from)}
                  fill={ink.grid}
                />
              ) : null,
            )}
          </g>

          {/* Count gridlines, hairline, behind the bars. */}
          {ticks.map((tick) => (
            <line
              key={`grid-${tick}`}
              x1={xOf(tick)}
              x2={xOf(tick)}
              y1={plotTop}
              y2={plotTop + plotHeight}
              stroke={ink.grid}
              strokeWidth={1}
            />
          ))}

          {panel.profile.bars.map((bar, b) => {
            const top = yOf(bar.lo)
            const pitch = yOf(bar.hi) - top
            const gap = pitch > 6 ? 1 : 0
            const key = markOf(bar)
            const isSelected = marks.has([key])
            const dim = shown > 0 && !isSelected
            let cursor = 0
            return (
              <g
                key={key}
                {...clickable(key)}
                style={pointer}
                onMouseMove={(event) =>
                  setHover({ panel: index, bar: b, ...tooltipPoint(event, ref.current) })
                }
                onMouseLeave={() => setHover(null)}
              >
                {/* A full-width hit area, so a short bar deep in the tail is still a target. */}
                <rect
                  x={left}
                  y={top}
                  width={panelWidth}
                  height={Math.max(1, pitch)}
                  fill="transparent"
                />
                {bar.segments.map((segment, s) => {
                  const from = cursor
                  cursor += segment.value
                  // Surface showing between stacked segments, never a stroke.
                  const inset = s === bar.segments.length - 1 ? 0 : SURFACE_GAP
                  const w = Math.max(0, xOf(cursor) - xOf(from) - inset)
                  if (w <= 0) return null
                  return (
                    <rect
                      key={segment.series}
                      x={xOf(from)}
                      y={top}
                      width={w}
                      height={Math.max(0.5, pitch - gap)}
                      fill={slotColor(segment.colorIndex, mode)}
                      opacity={dim ? 0.35 : 1}
                    />
                  )
                })}
                {isSelected && (
                  <rect
                    x={left}
                    y={top}
                    width={Math.max(0, xOf(bar.total) - left)}
                    height={Math.max(0.5, pitch - gap)}
                    fill="none"
                    stroke={ink.primary}
                    strokeWidth={1}
                  />
                )}
              </g>
            )
          })}

          {/* Layer names at the plot's right edge, the counts in the gutter beside them. */}
          {!inlineShares &&
            bands.map((band) => (
              <text
                key={`name-${band.name}`}
                x={left + panelWidth - 4}
                y={plotTop + band.labelY}
                fill={ink.muted}
                fontSize={10}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {band.name}
              </text>
            ))}
          {frame && (
            <line
              x1={left}
              x2={left + panelWidth}
              y1={plotTop + piaY(scale) + 0.5}
              y2={plotTop + piaY(scale) + 0.5}
              stroke={ink.axis}
              strokeWidth={1}
            />
          )}

          {/* The baseline the bars grow from. */}
          <line
            x1={left + 0.5}
            x2={left + 0.5}
            y1={plotTop}
            y2={plotTop + plotHeight}
            stroke={ink.axis}
            strokeWidth={1}
          />

          {ticks.map((tick, t) => (
            <text
              key={`tick-${tick}`}
              x={xOf(tick)}
              y={plotTop - 5}
              fill={ink.muted}
              fontSize={9.5}
              // The ends anchored inward, or the last label runs past the panel into the next.
              textAnchor={t === 0 ? 'start' : t === ticks.length - 1 ? 'end' : 'middle'}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatCompact(tick)}
              {unit}
            </text>
          ))}
          {column === 0 &&
            depthTicks.map((tick) => (
              <text
                key={`depth-${tick}`}
                x={left - 4}
                y={yOf(tick)}
                fill={ink.muted}
                fontSize={9.5}
                textAnchor="end"
                dominantBaseline="central"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatCompact(tick)}
              </text>
            ))}

          {/* Each layer's count and share, clickable: a layer is a selection too. */}
          {(countWidth > 0 || inlineShares) &&
            panel.layers.map((layer) => {
              const band = bands.find((b) => b.name === layer.name)
              if (!band) return null
              const key = markOf(layer.range)
              const isSelected = marks.has([key])
              const share = panelUsed > 0 ? formatShare(layer.count / panelUsed) : ''
              return (
                <text
                  key={`count-${layer.name}`}
                  x={inlineShares ? left + panelWidth - 4 : left + panelWidth + 8}
                  y={plotTop + band.labelY}
                  fill={isSelected ? ink.primary : ink.secondary}
                  fontSize={10}
                  fontWeight={isSelected ? 600 : undefined}
                  textAnchor={inlineShares ? 'end' : 'start'}
                  dominantBaseline="middle"
                  style={{ fontVariantNumeric: 'tabular-nums', ...pointer }}
                  {...clickable(key)}
                >
                  <title>{`${layer.name}: ${plural(layer.count, 'row')}`}</title>
                  {inlineShares ? (
                    <>
                      <tspan fill={ink.muted}>{layer.name} </tspan>
                      {share}
                    </>
                  ) : (
                    `${formatCompact(layer.count)} · ${share}`
                  )}
                </text>
              )
            })}
        </g>
      )
    })
  }, [layout, panels, marks, shown, normalize, frame, facetColumn, ink, mode, ref, setHover])

  if (drawn.length === 0) {
    return (
      <ViewerEmpty>
        {whole.dropped > 0
          ? `Nothing to plot — no depths in "${depthColumn}"`
          : 'Nothing to plot — no rows'}
      </ViewerEmpty>
    )
  }

  const hoveredPanel = hover ? panels[hover.panel] : undefined
  const hovered = hover ? hoveredPanel?.profile.bars[hover.bar] : undefined
  const hoveredUsed = hoveredPanel?.scan.kept.length ?? 0
  const used = whole.kept.length
  const plotted = panels.reduce((sum, panel) => sum + panel.scan.kept.length, 0)
  const layered = panels.reduce(
    (sum, panel) => sum + panel.layers.reduce((s, layer) => s + layer.count, 0),
    0,
  )
  const more = groups ? groups.length - panels.length : 0
  const svgHeight = layout ? layout.rowHeight * layout.grid.rows : 0

  // The hovered bar, lit by one rect over the memoised panels, so a move redraws only this.
  const hoverOutline = (() => {
    if (!layout || !hover || !hovered) return null
    const { left, plotTop } = panelOrigin(layout, hover.panel)
    const top = plotTop + layout.y(hovered.lo)
    return (
      <rect
        x={left}
        y={top}
        width={layout.grid.panelWidth}
        height={Math.max(1, plotTop + layout.y(hovered.hi) - top)}
        fill={ink.primary}
        opacity={0.08}
        pointerEvents="none"
      />
    )
  })()

  return (
    <div className="viewer">
      <div ref={ref} className="viewer__scroll nowheel" style={{ position: 'relative' }}>
        {layout && (
          <svg
            ref={svgRef}
            className="chart"
            width={size.width}
            height={svgHeight}
            role="img"
            aria-label={
              `Laminar profile of ${depthColumn}` +
              (seriesColumn ? `, split by ${seriesColumn}` : '') +
              (faceted ? `, one panel per ${facetColumn}` : '')
            }
          >
            <rect width={size.width} height={svgHeight} fill={surface} />
            {body}
            {hoverOutline}
          </svg>
        )}

        {hovered && hoveredPanel && (
          <ChartTooltip at={hover!}>
            <strong>
              {formatNumber(hovered.lo)} – {formatNumber(hovered.hi)} µm
            </strong>
            {hoveredPanel.facet && (
              <TooltipRow>{nameOf(hoveredPanel.facet.label, facetColumn)}</TooltipRow>
            )}
            {seriesColumn &&
              hovered.segments.map((segment) => (
                <TooltipRow key={segment.series} swatch={slotColor(segment.colorIndex, mode)}>
                  {nameOf(segment.series, seriesColumn)}: {plural(segment.count, 'row')}
                </TooltipRow>
              ))}
            <TooltipRow>
              {plural(hovered.count, 'row')}
              {hoveredUsed > 0 ? ` · ${formatShare(hovered.count / hoveredUsed)}` : ''}
            </TooltipRow>
          </ChartTooltip>
        )}
      </div>

      {seriesColumn && fold.legend.length >= 2 && (
        <div className="legend">
          {fold.legend.map((name) => {
            // `Other` takes its own slot from `slotOf`; the missing series sits outside the fold.
            const slot = name === MISSING_LABEL ? MISSING_SLOT : fold.slotOf(name)
            return (
              <span key={name} className="legend__item">
                <span
                  className="legend__swatch"
                  style={{ background: slotColor(slot, mode) }}
                />
                {nameOf(name, seriesColumn)}
              </span>
            )
          })}
        </div>
      )}

      <div className="viewer__caption">
        <span>
          {depthColumn} · {normalizeLabel(normalize, false)} · {formatNumber(width)} µm bins
        </span>
        <span>
          {plural(used, 'row')}
          {faceted ? ` · ${plural(panels.length, 'panel')}` : ''}
          {more > 0
            ? ` · ${formatNumber(more)} more not drawn (${formatNumber(used - plotted)} rows)`
            : ''}
          {whole.dropped > 0 ? ` · ${formatNumber(whole.dropped)} without a depth` : ''}
          {frame && plotted > layered
            ? ` · ${formatNumber(plotted - layered)} above the layers`
            : ''}
          {frame ? '' : ' · wire the Dataset to draw the layers'}
        </span>
        {marks.size > 0 && (
          <ClearSelection
            label={
              `${plural(marks.size, 'range')} selected` +
              (elsewhere > 0 ? ` (${formatNumber(elsewhere)} not in these panels)` : '')
            }
            onClear={marks.clear}
          />
        )}
        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'laminar-profile')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}
