/**
 * Slices and the arcs that draw them, headless.
 *
 * Same standing as `histogramBins.ts`: the geometry is testable, the component is not.
 *
 * **A pie refuses negatives rather than drawing them.** An angle is a share of a whole, and a
 * share cannot be less than nothing — a `-40` next to a `100` would either draw backwards over
 * its neighbour or quietly make the total 60, and both are a picture that lies. They are
 * dropped and counted, and the caption says so. This is the one chart here with that property:
 * a bar of −40 is perfectly readable.
 *
 * **The residual slice remembers what went into it.** Folding the tail into `Other` is the
 * palette rule every chart here follows, but a pie is clickable, and a click on `Other` has to
 * mean "these nineteen categories" to the node resolving it — the fold depends on `maxSlices`,
 * which is `presentational` and therefore absent from the cache key, so a stored `"Other"`
 * would name a different set of rows after somebody widened the chart with nothing to re-run.
 * The labels travel with the slice and the viewer writes them out.
 */

import type { TableValue } from '../../core/values'
import { markLabel, numericCell } from '../../nodes/lib/chartSelection'
import { MAX_SERIES, OTHER_LABEL, foldByRank } from '../colors'

export interface PieSlice {
  label: string
  value: number
  /** Share of the total, 0…1. */
  fraction: number
  /** Radians from twelve o'clock, clockwise. */
  start: number
  end: number
  colorIndex: number
  /** Present on the residual slice only: the categories folded into it. */
  folded?: string[]
}

export interface PieLayout {
  slices: PieSlice[]
  total: number
  /** Distinct categories in the data, whether or not each got its own slice. */
  categoryCount: number
  /** Rows the tally could not use: an unreadable number, or a negative one. */
  dropped: number
}

/** Slices drawn before the tail folds into one residual. Matches the node param's default. */
const MAX_SLICES_DEFAULT = MAX_SERIES

const EMPTY: PieLayout = { slices: [], total: 0, categoryCount: 0, dropped: 0 }

/**
 * Total a value column per category — or count rows, when no value column is given.
 *
 * Counting is the default a pie is usually reached for ("how many of each type"), and making
 * the value column `optional` is what lets the node answer it without a Group By in front.
 */
export function tallyCategories(
  table: TableValue,
  categoryColumn: string,
  valueColumn: string | undefined,
): { totals: Map<string, number>; dropped: number } {
  const categories = table.data[categoryColumn]
  const totals = new Map<string, number>()
  let dropped = 0
  if (!categories) return { totals, dropped }
  const values = valueColumn ? table.data[valueColumn] : undefined

  for (let row = 0; row < table.length; row++) {
    let amount = 1
    if (values) {
      const value = numericCell(values[row])
      if (value === undefined || value < 0) {
        dropped++
        continue
      }
      amount = value
    }
    const label = markLabel(categories[row])
    totals.set(label, (totals.get(label) ?? 0) + amount)
  }
  return { totals, dropped }
}

/** Lay a tally out as arcs. */
export function pieSlices(
  totals: Map<string, number>,
  options: { maxSlices?: number; sort?: boolean; dropped?: number } = {},
): PieLayout {
  const { maxSlices = MAX_SLICES_DEFAULT, sort = true, dropped = 0 } = options

  // A zero-valued category has no arc to draw. It is not dropped in the sense the caption
  // reports — nothing was unreadable — it simply has no width.
  const entries = [...totals.entries()].filter(([, value]) => value > 0)
  if (entries.length === 0) return { ...EMPTY, categoryCount: totals.size, dropped }

  /*
   * Which categories get their own slice is decided by **size**, whatever the display order is —
   * that is `foldByRank`'s contract, shared with every other chart here. Folding the
   * alphabetical tail instead would put `Other` in front of a category larger than every slice
   * beside it, and would make `Sort by size` quietly change which rows a click on the residual
   * selects, which is not what a sort control is.
   */
  const fold = foldByRank(entries, maxSlices)
  const value = new Map(entries)
  const total = entries.reduce((sum, [, amount]) => sum + amount, 0)
  const order = sort
    ? fold.kept
    : [...fold.kept].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const laid: PieSlice[] = []
  let cursor = 0
  const push = (label: string, amount: number, colorIndex: number, folded?: string[]) => {
    const fraction = total > 0 ? amount / total : 0
    const start = cursor
    cursor += fraction * Math.PI * 2
    laid.push({
      label,
      value: amount,
      fraction,
      start,
      end: cursor,
      colorIndex,
      ...(folded ? { folded } : {}),
    })
  }

  for (const label of order) push(label, value.get(label)!, fold.slotOf(label))
  if (fold.folded) {
    push(
      OTHER_LABEL,
      fold.tail.reduce((sum, label) => sum + (value.get(label) ?? 0), 0),
      MAX_SERIES,
      fold.tail,
    )
  }

  return { slices: laid, total, categoryCount: entries.length, dropped }
}

/**
 * A ring segment. `inner` of 0 gives a wedge, i.e. a pie rather than a donut.
 *
 * A slice covering the whole circle is drawn as two half arcs, because SVG's elliptical arc is
 * defined by its endpoints — a 360° sweep starts and ends at the same point and renders as
 * nothing at all. A single-category pie is exactly that case and is not rare.
 */
export function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  start: number,
  end: number,
): string {
  const sweep = end - start
  if (!(sweep > 0)) return ''
  if (sweep >= Math.PI * 2 - 1e-9) {
    const ring = (radius: number, direction: 0 | 1): string =>
      [
        `M${fmt(cx)},${fmt(cy - radius)}`,
        `A${fmt(radius)},${fmt(radius)} 0 0 ${direction} ${fmt(cx)},${fmt(cy + radius)}`,
        `A${fmt(radius)},${fmt(radius)} 0 0 ${direction} ${fmt(cx)},${fmt(cy - radius)}`,
        'Z',
      ].join(' ')
    // The hole is wound the other way, so the even-odd-free default fill rule cuts it out.
    return inner > 0 ? `${ring(outer, 1)} ${ring(inner, 0)}` : ring(outer, 1)
  }

  const large = sweep > Math.PI ? 1 : 0
  const o1 = polar(cx, cy, outer, start)
  const o2 = polar(cx, cy, outer, end)
  if (inner <= 0) {
    return [
      `M${fmt(cx)},${fmt(cy)}`,
      `L${fmt(o1.x)},${fmt(o1.y)}`,
      `A${fmt(outer)},${fmt(outer)} 0 ${large} 1 ${fmt(o2.x)},${fmt(o2.y)}`,
      'Z',
    ].join(' ')
  }
  const i1 = polar(cx, cy, inner, end)
  const i2 = polar(cx, cy, inner, start)
  return [
    `M${fmt(o1.x)},${fmt(o1.y)}`,
    `A${fmt(outer)},${fmt(outer)} 0 ${large} 1 ${fmt(o2.x)},${fmt(o2.y)}`,
    `L${fmt(i1.x)},${fmt(i1.y)}`,
    `A${fmt(inner)},${fmt(inner)} 0 ${large} 0 ${fmt(i2.x)},${fmt(i2.y)}`,
    'Z',
  ].join(' ')
}

/** Twelve o'clock is zero and angles run clockwise, which is how a pie is read. */
export function polar(
  cx: number,
  cy: number,
  radius: number,
  angle: number,
): { x: number; y: number } {
  return { x: cx + radius * Math.sin(angle), y: cy - radius * Math.cos(angle) }
}

/** Three decimals is under a thousandth of a pixel at these radii, and keeps the path short. */
function fmt(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '0'
}
