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
import { segmentColor } from './segmentColor'

export interface CategoricalLegend {
  kind: 'categorical'
  column: string
  entries: Array<{ label: string; color: string }>
  /**
   * True when not every value in the column has a key here.
   *
   * Two different things end up under one flag, deliberately, because what a *reader* needs to
   * know is the same in both: the strip is not the whole story. Under `categorical` the
   * remainder was folded into the achromatic "Other", which is an entry in `entries`; under
   * `hash` the remainder is simply unlisted and still drawn in a colour of its own, because
   * there is no folding to do. `describeLegend` renders both as `12+ values`.
   */
  truncated: boolean
  /**
   * How many distinct values have no key in `entries` at all.
   *
   * Zero — and omitted — under `categorical`, where the remainder is folded into `Other` and
   * `Other` *is* an entry, so nothing is unaccounted for. Under `hash` it is the count the
   * strip has to admit to: twelve keys over twenty-one neurons, every one of them drawn in a
   * colour of its own, and only a number can say so. Same rule as `labels thinned` and `meshes
   * simplified` — nothing quietly leaves a picture, or its key, without saying it did.
   */
  unlisted?: number
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
  /**
   * Which legend key a row belongs to, or undefined when this encoding has no keys.
   *
   * The inverse of `legend`, and the half an *interactive* legend needs: a key that can be
   * clicked has to be able to say which rows it stands for. Rows past the eighth slot answer
   * with `OTHER_LABEL`, because that is the key they are drawn under and hiding `Other` has to
   * hide all of them.
   *
   * Undefined for constant, sequential and literal encodings — none of them has a key, so
   * there is nothing a caller could do with a label. Callers should treat that as "this
   * encoding is not addressable by key" rather than as an error.
   */
  labelAt?(rowIndex: number): string | undefined
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

/** What a null cell is keyed under, in every mode that has keys. */
const NULL_KEY = '—'

/**
 * How many keys a `hash` legend lists before it gives up and says "+ more".
 *
 * Not `MAX_SERIES`: that eight is a *palette* limit — the number of hues that survived the
 * colourblind-safety gate — and this is a limit on how much strip a reader will tolerate. The
 * values here are often 18-digit root ids, so twelve is already a wide row; the rest are drawn
 * in their own colour regardless, and hiding one of them is what the eye toggles on the listed
 * keys cannot reach.
 */
export const HASH_LEGEND_KEYS = 12

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

/**
 * The two achromatic extremes are **not** theme-flipped, unlike everything else here.
 *
 * Every other colour in this module answers to the mode, because a chart's ink has to stay
 * legible when the surface under it changes. These two are the case where that rule is wrong:
 * somebody choosing black for a figure means black, and a black that turns white when the
 * editor's theme changes is a different colour, not a preserved one. They are reachable only
 * by choosing them — no categorical or sequential encoding ever lands here.
 */
const FIXED_CONSTANTS: Record<string, string> = { black: '#000000', white: '#ffffff' }

function constantColor(spec: ColorSpec, mode: Mode): string {
  if (spec.constant === 'muted') return MUTED
  const fixed = FIXED_CONSTANTS[spec.constant]
  if (fixed) return fixed
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
   * A hand-picked colour wins over whatever the mode would have derived, for the mark *and*
   * for its key.
   *
   * Applied here rather than in a viewer for the reason the module opens with: the legend and
   * the thing it keys have to agree, and two places applying an override is how they stop
   * agreeing. An override that is not a colour is ignored — `literalColor` already owns what
   * counts as one, and a second spelling of that rule is a second answer to it.
   */
  const overrideOf = (label: string): string | undefined => literalColor(spec.overrides?.[label])

  /** The key a row belongs to before any folding: the cell as text, or the null marker. */
  const cellKey = (rowIndex: number): string => {
    const cell = data[rowIndex]
    return cell === null || cell === undefined ? NULL_KEY : String(cell)
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

  /*
   * Hash: the id decides its own colour, and no two ids share one by design.
   *
   * The one mode with no cap on how many colours it hands out, which is what makes it right
   * for identity and wrong for a series — see `segmentColor.ts` for the trade. Two consequences
   * follow from there being no folding:
   *
   *  - **Every distinct value is its own legend key**, so hide, solo, select and recolour work
   *    per neuron rather than per bucket. That is the whole reason this mode carries a
   *    categorical-shaped legend at all instead of `literal`'s silence.
   *  - **The strip lists only the first few.** A hundred 18-digit root ids is not a legend, and
   *    the ones past the cap are still drawn in their own colour rather than folded into grey —
   *    hence `truncated` without an `Other` entry.
   *
   * Listed in **first-appearance order**, unlike `categorical`, which ranks by frequency to put
   * the commonest values in the most distinguishable slots. There are no slots here, so the only
   * ordering that means anything is the one the table already has.
   */
  if (spec.mode === 'hash') {
    // `Set` iterates in insertion order, which *is* the first-appearance order the legend wants —
    // so it is both the dedup and the ordering, rather than a set and a parallel array to keep in
    // step with it.
    const unique = new Set<string>()
    for (let row = 0; row < data.length; row++) unique.add(cellKey(row))

    /*
     * Resolved once per distinct value, not once per row.
     *
     * `segmentColor` is a regex, a `BigInt` parse, two murmur rounds, an HSV conversion and three
     * `padStart` allocations. `at` is called per row when a colour buffer is built — 40k skeleton
     * segments, 10^5 synapses — and this is now the *default* mode for two channels, so doing it
     * per row was the whole hash pipeline run tens of thousands of times to produce a few dozen
     * distinct answers.
     */
    const colors = new Map<string, string>()
    for (const key of unique) {
      colors.set(key, overrideOf(key) ?? (key === NULL_KEY ? MUTED : segmentColor(key)))
    }
    const listed = [...unique].slice(0, HASH_LEGEND_KEYS)

    return {
      at: (rowIndex) => colors.get(cellKey(rowIndex)) ?? MUTED,
      labelAt: cellKey,
      legend: {
        kind: 'categorical',
        column: spec.column,
        entries: listed.map((label) => ({ label, color: colors.get(label)! })),
        truncated: unique.size > HASH_LEGEND_KEYS,
        unlisted: Math.max(0, unique.size - HASH_LEGEND_KEYS),
      },
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
  for (let row = 0; row < data.length; row++) {
    const key = cellKey(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const kept = ranked.slice(0, MAX_SERIES).map(([key]) => key)
  const slotOf = new Map(kept.map((key, index) => [key, index]))
  const truncated = ranked.length > MAX_SERIES

  const labelFor = (rowIndex: number): string => {
    const key = cellKey(rowIndex)
    return slotOf.has(key) ? key : OTHER_LABEL
  }

  /*
   * The nine possible answers, resolved once.
   *
   * `overrideOf` runs `literalColor` — a `trim` and a regex — and the palette lookup is a table
   * read; both were happening per row, on a path shared by the scatter, network and 3D viewers
   * and driven per *point* by `buildPoints`. The set is bounded by `MAX_SERIES` plus `Other`, so
   * there is nothing to gain by deferring any of it.
   */
  const slotColors = kept.map((label, index) => overrideOf(label) ?? seriesColor(index, mode))
  const otherColor = overrideOf(OTHER_LABEL) ?? MUTED

  const entries = kept.map((label, index) => ({ label, color: slotColors[index]! }))
  if (truncated) entries.push({ label: OTHER_LABEL, color: otherColor })

  return {
    at: (rowIndex) => {
      const slot = slotOf.get(cellKey(rowIndex))
      return slot === undefined ? otherColor : slotColors[slot]!
    },
    labelAt: labelFor,
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
