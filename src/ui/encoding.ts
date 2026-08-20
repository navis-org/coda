/**
 * Resolves a visual encoding spec into per-row colours and sizes.
 *
 * One implementation for every viewer, which is the point: the palette rules from the
 * dataviz work — eight categorical slots in fixed order, a ninth folding into an
 * achromatic "Other", single-hue sequential ramps that flip direction by theme — are
 * enforced here rather than re-litigated per widget.
 *
 * Returns both an accessor and a legend descriptor, because a categorical encoding without
 * a legend is colour-as-sole-channel, which the accessibility pass rules out.
 */

import type { CellValue, TableValue } from '../core/values'
import { getColumn } from '../core/values'
import type { ColorSpec, SizeSpec } from '../nodes/lib/encodingParams'
import type { Mode } from './colors'
import { CHART_INK, MAX_SERIES, OTHER_LABEL, seriesColor, sequentialColor } from './colors'
import { formatCompact } from './format'

export interface CategoricalLegend {
  kind: 'categorical'
  column: string
  entries: Array<{ label: string; color: string }>
  /** True when values past the eighth were folded into "Other". */
  truncated: boolean
}

export interface SequentialLegend {
  kind: 'sequential'
  column: string
  domain: [number, number]
  /** Sampled stops for a colour bar. */
  stops: string[]
}

export type Legend = CategoricalLegend | SequentialLegend | undefined

export interface ResolvedColor {
  /** Colour for a row of the attribute table. */
  at(rowIndex: number): string
  legend: Legend
}

/**
 * The grey a null, an out-of-palette value and the folded `Other` slot all take.
 *
 * Read off the palette rather than written out, so a palette change reaches it — the header
 * comment in `colors.ts` records what was validated, and a literal here is invisible to that.
 * Achromatic and identical in both modes, which is why it needs no `mode` argument: it must
 * never compete with a categorical encoding.
 */
const MUTED = CHART_INK.dark.muted

/**
 * Read a cell as a number, or undefined when it is absent.
 *
 * `Number(null)` is 0, so a plain conversion silently encodes missing data as zero — which
 * on a sequential ramp paints "no value" the same as "the minimum". Absence has to be
 * distinguishable from a real reading.
 */
function numeric(cell: unknown): number | undefined {
  if (cell === null || cell === undefined || cell === '') return undefined
  const value = Number(cell)
  return Number.isFinite(value) ? value : undefined
}

function constantColor(spec: ColorSpec, mode: Mode): string {
  if (spec.constant === 'muted') return MUTED
  const slot = Number(spec.constant)
  return seriesColor(Number.isFinite(slot) ? slot : 0, mode)
}

/**
 * A cell read as a colour, or undefined where it is not one.
 *
 * `#rgb`, `#rrggbb` and `#rrggbbaa` — the three forms the rest of this module already emits and
 * `withAlpha` already produces. Anything else is **not** coerced: a column of cell types under
 * this mode is a mistake, and painting it grey says so where guessing a hue from the text would
 * produce a picture that looks deliberate. Same null-as-grey rule the other modes follow.
 */
export function literalColor(cell: CellValue | undefined): string | undefined {
  if (typeof cell !== 'string') return undefined
  const text = cell.trim()
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ? text : undefined
}

/**
 * The colour a cluster is drawn in, wherever it is drawn.
 *
 * One rule, because two would be a dendrogram whose branches disagree with the neurons it sent
 * to a 3D view. Cluster numbers are 1-based and 0 means *not cut*, which takes the achromatic
 * ink rather than a palette slot — a leaf belonging to no group is not a ninth category.
 *
 * **Hues cycle past the eighth**, which is the one place this departs from `resolveColor`'s
 * categorical rule, and deliberately: there a repeated hue claims two series are the same
 * thing, where clusters sit in leaf order along one axis so two sharing a hue are visibly far
 * apart. `DendrogramViewer` says so in its caption when it happens.
 */
export function clusterColor(cluster: number, mode: Mode): string {
  return cluster <= 0 ? CHART_INK[mode].muted : seriesColor((cluster - 1) % MAX_SERIES, mode)
}

/**
 * Build a colour accessor over an attribute table.
 *
 * Falls back to the constant colour whenever the chosen column is missing or unusable, so
 * an upstream schema change degrades to a flat colour rather than throwing inside a render.
 */
export function resolveColor(
  attributes: TableValue | undefined,
  spec: ColorSpec,
  mode: Mode,
): ResolvedColor {
  const flat = constantColor(spec, mode)
  const fallback: ResolvedColor = { at: () => flat, legend: undefined }

  // `default` means "let the renderer choose", which no in-app viewer can do — they need a
  // colour per row. Falling back to the flat one keeps the mode harmless if it ever reaches
  // a viewer that did not opt into offering it.
  if (spec.mode === 'constant' || spec.mode === 'default' || !spec.column || !attributes) {
    return fallback
  }
  let data
  try {
    data = getColumn(attributes, spec.column)
  } catch {
    return fallback
  }

  /*
   * Literal: the cells *are* the colours, so nothing is derived and nothing is ranked.
   *
   * The point of the mode is that a producer has already decided, and the usual categorical
   * pass would quietly overrule it — `resolveColor` ranks by frequency where a dendrogram
   * numbers its clusters left to right, so "colour by cluster" gives the biggest group the
   * leading slot rather than the one it was drawn in.
   *
   * **No legend.** A hex is not a name, so there is nothing to key: the swatches would be
   * correct and every label beside them would be `#3987e5`. Silence beats a legend that only
   * repeats the colour it is next to.
   */
  if (spec.mode === 'literal') {
    return {
      at: (rowIndex) => literalColor(data[rowIndex]) ?? MUTED,
      legend: undefined,
    }
  }

  if (spec.mode === 'sequential') {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const cell of data) {
      const v = numeric(cell)
      if (v === undefined) continue
      if (v < min) min = v
      if (v > max) max = v
    }
    if (!Number.isFinite(min)) return fallback
    const span = max - min || 1
    const stops = Array.from({ length: 9 }, (_, i) => sequentialColor(i / 8, mode))
    return {
      at: (rowIndex) => {
        const v = numeric(data[rowIndex])
        if (v === undefined) return MUTED
        return sequentialColor((v - min) / span, mode)
      },
      legend: { kind: 'sequential', column: spec.column, domain: [min, max], stops },
    }
  }

  // Categorical. Rank by frequency so the most common values get the leading (most
  // distinguishable) slots, and everything past the cap folds into one achromatic bucket
  // rather than cycling hues — a repeated hue would imply two categories are the same.
  const counts = new Map<string, number>()
  for (const cell of data) {
    const key = cell === null || cell === undefined ? '—' : String(cell)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const kept = ranked.slice(0, MAX_SERIES).map(([key]) => key)
  const slotOf = new Map(kept.map((key, index) => [key, index]))
  const truncated = ranked.length > MAX_SERIES

  const entries = kept.map((label, index) => ({ label, color: seriesColor(index, mode) }))
  if (truncated) entries.push({ label: OTHER_LABEL, color: MUTED })

  return {
    at: (rowIndex) => {
      const cell = data[rowIndex]
      const key = cell === null || cell === undefined ? '—' : String(cell)
      const slot = slotOf.get(key)
      return slot === undefined ? MUTED : seriesColor(slot, mode)
    },
    legend: { kind: 'categorical', column: spec.column, entries, truncated },
  }
}

export interface ResolvedSize {
  at(rowIndex: number): number
  /** Undefined when the size is constant. */
  domain: [number, number] | undefined
}

/**
 * Map a numeric column onto a size range. Areas would be more perceptually honest than
 * radii for circles, but sigma and three both take a radius, so the sqrt is applied here:
 * value scales with *area*, which is what readers actually compare.
 */
export function resolveSize(
  attributes: TableValue | undefined,
  spec: SizeSpec,
  options: { areaScaled?: boolean } = {},
): ResolvedSize {
  const constant = { at: () => spec.min, domain: undefined }
  if (!spec.column || !attributes) return constant

  let data
  try {
    data = getColumn(attributes, spec.column)
  } catch {
    return constant
  }

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const cell of data) {
    const v = numeric(cell)
    if (v === undefined) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min)) return constant

  const span = max - min || 1
  const areaScaled = options.areaScaled !== false
  return {
    at: (rowIndex) => {
      const v = numeric(data[rowIndex])
      if (v === undefined) return spec.min
      const t = (v - min) / span
      const scaled = areaScaled ? Math.sqrt(t) : t
      return spec.min + scaled * (spec.max - spec.min)
    },
    domain: [min, max],
  }
}

/** One-line legend caption, e.g. "colour: type (6 values)". */
export function describeLegend(legend: Legend): string {
  if (!legend) return ''
  if (legend.kind === 'categorical') {
    return `${legend.column} · ${legend.entries.length}${legend.truncated ? '+' : ''} values`
  }
  return `${legend.column} · ${formatCompact(legend.domain[0])}–${formatCompact(legend.domain[1])}`
}

/** Convert a CSS hex colour to the 0..1 RGB triplet three.js buffers want. */
export function hexToRgbFloat(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const value = Number.parseInt(
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean,
    16,
  )
  if (!Number.isFinite(value)) return [1, 1, 1]
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}
