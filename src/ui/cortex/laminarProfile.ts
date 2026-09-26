/**
 * Laminar Profile, headless: the depth axis, and what each layer holds.
 *
 * The bars are the histogram's (`histogramBins.ts`, with `width` for edges at round depths), so a
 * stacked series, its fold into `Other` and a stored selection mean what they mean on a Histogram.
 * What is the profile's own is here, where jsdom's missing layout cannot hide it: the axis runs
 * down the cortex through the gallery's own `RowScale`, and a layer is counted by the frame's
 * `layerRanges` — never by a `layer` column, which the frame wrote once and a Join may since have
 * replaced.
 */

import type { TableValue } from '../../core/values'
import type { ValueRange } from '../../nodes/lib/chartSelection'
import { MISSING_LABEL, inRange, markLabel } from '../../nodes/lib/chartSelection'
import { foldByRank } from '../colors'
import type { CorticalFrame } from '../../packs/cortex/frames'
import { layerRanges } from '../../packs/cortex/frames'
import type { RowScale } from './wall'
import { rowScale } from './wall'

/**
 * The depth axis for a plot `height` tall: the gallery's row — a little above the pia to past the
 * white matter — widened to take any value beyond it, so no bar is drawn off the plot. Without a
 * frame, the data's own extent.
 */
export function profileScale(
  frame: CorticalFrame | undefined,
  lo: number,
  hi: number,
  height: number,
): RowScale {
  const frameRow = frame ? rowScale(frame, 1) : undefined
  const frameTop = frameRow?.top ?? lo
  const frameBottom = frameRow ? frameRow.top + 1 / frameRow.pxPerUm : hi
  const top = Math.min(frameTop, lo)
  const bottom = Math.max(frameBottom, hi, top + 1)
  return { top, pxPerUm: height / (bottom - top) }
}

/** One layer's share of the values: how many fell in it, and the depth range that selects it. */
export interface LayerCount {
  name: string
  count: number
  range: ValueRange
}

/**
 * Per layer, in the frame's order, how many values fall in its `layerRanges` range — the range a
 * click on its count then stores, so the two cannot disagree. Values in no layer (far above the
 * pia) are counted by the caller as the difference, not here.
 */
export function layerCounts(frame: CorticalFrame, depths: readonly number[]): LayerCount[] {
  const ranges = layerRanges(frame)
  const counts = ranges.map(() => 0)
  for (const depth of depths) {
    const i = ranges.findIndex((range) => inRange(range, depth))
    if (i !== -1) counts[i]!++
  }
  return ranges.map(({ name, lo, hi }, i) => ({ name, count: counts[i]!, range: { lo, hi } }))
}

/** One panel of a faceted profile: the facet's label as a cell prints, and its rows. */
export interface Facet {
  label: string
  rows: number[]
}

/**
 * A column's values as panels, in the order they are drawn: ranked as a series is — `foldByRank`,
 * largest first and a tie by label, so panels and colours cannot come to disagree about order —
 * with rows holding no value as a panel of their own, `—`, **always last**: the missing series'
 * rule, since faceted by `partnerType` the untyped panel would otherwise open the chart. The whole
 * ranking, so a chart capping how many it draws slices it without walking the table again.
 */
export function facetGroups(table: TableValue, column: string): Facet[] {
  const cells = table.data[column] ?? []
  const byLabel = new Map<string, number[]>()
  for (let row = 0; row < table.length; row++) {
    const label = markLabel(cells[row])
    const rows = byLabel.get(label)
    if (rows) rows.push(row)
    else byLabel.set(label, [row])
  }
  const missing = byLabel.get(MISSING_LABEL)
  byLabel.delete(MISSING_LABEL)
  const { kept } = foldByRank(
    [...byLabel].map(([label, rows]) => [label, rows.length]),
    Number.POSITIVE_INFINITY,
  )
  return [
    ...kept.map((label) => ({ label, rows: byLabel.get(label)! })),
    ...(missing ? [{ label: MISSING_LABEL, rows: missing }] : []),
  ]
}

/** The narrowest a panel is drawn, px: a depth profile still reads at this width, if barely. */
export const MIN_PANEL_WIDTH = 150

/**
 * How `count` panels tile a width with `gap` between them: as many side by side as fit at
 * `MIN_PANEL_WIDTH` — gaps included, or the panels come out narrower than it — never more than
 * there are, then as many rows as that takes, and the width each panel gets.
 */
export function facetGrid(
  count: number,
  width: number,
  gap: number,
): { columns: number; rows: number; panelWidth: number } {
  const fit = Math.floor((width + gap) / (MIN_PANEL_WIDTH + gap))
  const columns = Math.max(1, Math.min(count, fit))
  return {
    columns,
    rows: Math.ceil(count / columns),
    panelWidth: Math.max(20, (width - gap * (columns - 1)) / columns),
  }
}
