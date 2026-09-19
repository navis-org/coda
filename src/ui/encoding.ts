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
import type { ColorSpec, ShapeSpec, SizeSpec, ValueScale } from '../nodes/lib/encodingParams'
import type { ColorLimits, HeatmapPalette } from '../nodes/lib/heatmapParams'
import { isDivergingPalette, isSequentialPalette } from '../nodes/lib/heatmapParams'
import type { Mode } from './colors'
import {
  CHART_INK,
  MAX_SERIES,
  OTHER_LABEL,
  cycleColor,
  heatmapDivergingColor,
  heatmapSequentialColor,
  paletteColors,
  seriesColor,
} from './colors'
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
  /**
   * True when there are more categories than the palette has colours, so at least two of them
   * share a hue.
   *
   * A legend cannot show this — two identical swatches look like a mistake, not like a
   * statement — so it is carried for the caption to admit, the way `out.dendrogram` has always
   * said `colours repeat`. Same doctrine as `labels thinned`: nothing quietly stops being
   * distinguishable without saying it did.
   */
  cycled?: boolean
}

export interface SequentialLegend {
  kind: 'sequential'
  column: string
  /** The values at the two ends of the ramp — typed limits where there are some, else the data's. */
  domain: [number, number]
  /** Sampled stops for a colour bar. */
  stops: string[]
  /** The value a centred ramp's middle colour stands for. Absent on a one-way ramp. */
  center?: number
  /** The colour runs on a log scale. `domain` is still the values. */
  log?: true
  /** Some values fall outside `domain` and take the end colour they passed. */
  clipped?: true
  /** Why typed limits are being ignored; `domain` is then the data's. */
  problem?: string
}

export type Legend = CategoricalLegend | SequentialLegend | undefined

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * Every mark that can be drawn, in the order the renderers number them.
 *
 * One list, and everything else here is derived from it: the union type, the six assignable
 * marks, and the index the node program sends into a vertex buffer. A second spelling of the
 * vocabulary is a second thing to keep in step, and the one that reaches a shader is the one
 * that fails silently.
 *
 * **Append only** — the index is in a vertex buffer, and `SHAPE_OPTIONS` in
 * `src/nodes/lib/encodingParams.ts` is built from this array.
 */
export const ALL_SHAPES = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'cross',
  'plus',
  'dash',
] as const

export type MarkerShape = (typeof ALL_SHAPES)[number]

/**
 * The shape everything past the cap takes.
 *
 * A dash, chosen because it shares no silhouette with any of the six — folding into `circle`
 * would make the residual bucket indistinguishable from the most common category, which is the
 * same mistake as reusing a categorical hue.
 */
export const OTHER_SHAPE: MarkerShape = 'dash'

/**
 * Shapes in assignment order, most distinguishable first.
 *
 * Six rather than the palette's eight-and-cycling, and that asymmetry is the point: shape is a
 * coarser channel than hue at the size a node is drawn, and a seventh mark that reads as "a
 * slightly different blob" is worse than an honest fold. `OTHER_SHAPE` is the one left out.
 */
export const MARKER_SHAPES: readonly MarkerShape[] = ALL_SHAPES.filter(
  (shape) => shape !== OTHER_SHAPE,
)

export const MAX_SHAPES = MARKER_SHAPES.length

/** Is this a shape we can draw? The guard on a hand-edited or stale override. */
export function isMarkerShape(value: unknown): value is MarkerShape {
  return ALL_SHAPES.includes(value as MarkerShape)
}

export interface ShapeLegend {
  kind: 'shape'
  column: string
  /**
   * In assignment order, with the fold last when there was one.
   *
   * No `truncated` flag beside it, unlike `CategoricalLegend`: the fold *is* an entry here, so
   * the strip already admits to it and a boolean saying the same thing was written by this
   * module and read by nobody.
   */
  entries: Array<{ label: string; shape: MarkerShape }>
}

export interface ResolvedShape {
  at(rowIndex: number): MarkerShape
  legend: ShapeLegend | undefined
  /** Which legend key a row belongs to. Undefined where the encoding has no keys. */
  labelAt?(rowIndex: number): string | undefined
}

/**
 * Shape by category, ranked by frequency exactly as `resolveColor` ranks hue.
 *
 * The sibling of `resolveColor`, and beside it for the reason that module opens with: the
 * legend and the thing it keys have to agree, and two places deciding what a row's mark is is
 * how they stop agreeing. Same ranking, same `—` null key, same `Other` label, same
 * override-wins rule — so hiding a key, soloing it or reading the caption means the same thing
 * whichever channel it came from.
 *
 * **It folds where colour cycles**, and that is deliberate rather than an oversight. Cycling a
 * hue is survivable — two categories a palette apart share a colour and the caption says so —
 * because there are twenty of them and the eye reads position too. There are six shapes, and a
 * seventh category drawn as a second circle would be a lie the caption could not undo. See
 * `MARKER_SHAPES`.
 */
export function resolveShape(
  attributes: TableValue | undefined,
  spec: ShapeSpec,
): ResolvedShape {
  const flat = isMarkerShape(spec.constant) ? spec.constant : 'circle'
  const fallback: ResolvedShape = { at: () => flat, legend: undefined }
  if (spec.mode !== 'categorical' || !spec.column || !attributes) return fallback

  let data
  try {
    data = getColumn(attributes, spec.column)
  } catch {
    return fallback
  }

  const cellKey = (rowIndex: number): string => {
    const cell = data[rowIndex]
    return cell === null || cell === undefined ? NULL_KEY : String(cell)
  }

  const counts = new Map<string, number>()
  for (let row = 0; row < data.length; row++) {
    const key = cellKey(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  /*
   * One category is not an encoding. Every node the same shape carries no information, and a
   * one-entry legend claiming otherwise is worse than no legend — so this degrades to the
   * constant, exactly as the scatter's shape channel always has.
   */
  if (counts.size <= 1) return fallback

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  /*
   * The legend *is* the lookup table, which is what keeps a pinned mark honest.
   *
   * An earlier version built a separate map over every distinct value and let the legend apply
   * overrides on its own. The two then disagreed about the fold: choosing a mark for the
   * `Other` key changed the key and not one node, because a folded row looked itself up rather
   * than looking up the key it is drawn under. Resolving each key once — including `Other` —
   * and having `at` read the same table removes the second answer rather than syncing it.
   *
   * Bounded at seven entries however many distinct values there are, where the old map held
   * one entry per value: a network shaped by a high-cardinality column kept a 36,000-entry map
   * of the word "dash".
   */
  const listed = new Set(ranked.slice(0, MAX_SHAPES).map(([label]) => label))
  const pick = (label: string, fallbackShape: MarkerShape): MarkerShape => {
    const override = spec.overrides?.[label]
    return isMarkerShape(override) ? override : fallbackShape
  }

  const entries = ranked
    .slice(0, MAX_SHAPES)
    .map(([label], index) => ({ label, shape: pick(label, MARKER_SHAPES[index]!) }))
  if (ranked.length > MAX_SHAPES) {
    entries.push({ label: OTHER_LABEL, shape: pick(OTHER_LABEL, OTHER_SHAPE) })
  }
  const byKey = new Map(entries.map((entry) => [entry.label, entry.shape]))

  /** The key a row is drawn under: its own past nothing, `Other` once it has been folded. */
  const keyOf = (rowIndex: number): string => {
    const key = cellKey(rowIndex)
    return listed.has(key) ? key : OTHER_LABEL
  }

  return {
    at: (rowIndex) => byKey.get(keyOf(rowIndex)) ?? OTHER_SHAPE,
    labelAt: keyOf,
    legend: { kind: 'shape', column: spec.column, entries },
  }
}

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
 * How many keys a legend lists before it gives up and says "+N more".
 *
 * Not a palette size: that is how many *hues* there are, and this is how much strip a reader
 * will tolerate. The two used to be the same number by accident, because a categorical
 * encoding could not produce more keys than it had slots; now that it cycles, they are
 * independent and a twenty-colour palette can still list twelve.
 *
 * The values are often 18-digit root ids, so twelve is already a wide row. Everything past it
 * is still *drawn* in its own colour — the cap is on the key, never on the picture — and the
 * count is what says so.
 */
export const LEGEND_KEYS = 12

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
 * The value range a ramp is resolved against.
 *
 * `neutral` is the end of the scale that means "nothing here" — the low end for a sequential
 * ramp, the centre for a diverging one — and is what makes "the strongest cell in this block" a
 * well-defined thing for the Heatmap to keep when folding.
 */
export interface ColorDomain {
  lo: number
  hi: number
  neutral: number
  /**
   * Map a value to the ramp through `log(1 + v - lo)` rather than linearly.
   *
   * On the **colour only**: printed values, tooltips and a colour bar's two ends are the numbers
   * themselves, because a log axis is a way of *looking* at a distribution and a relabelled value
   * is a way of misreading one. Connectivity is the case it exists for — a handful of strong
   * pairs and a long tail of ones, where a linear ramp paints the tail as empty.
   *
   * Offered on a sequential ramp alone, which is what makes the shift by `lo` safe: `lo` is the
   * bottom of the ramp, so `v - lo` is never negative and the logarithm always exists. With `lo`
   * of 0 this is exactly `log10(1 + v)`, which is the expression the Heatmap's exporters emit.
   */
  log?: boolean
}

/**
 * Ramp position of a value in [0, 1], clamped — the one place the linear and log mappings live.
 *
 * Here rather than in `heatmapPlot.ts`, where it was written, because `by value` in the Scatter,
 * Network and 3D viewers now reads it too: two copies of a log mapping are two pictures of one
 * number. The log arm is `log1p` of the distance from the bottom over `log1p` of the span —
 * natural logs, because a ratio of two logs is the same in any base, so this and an exporter's
 * `log10` draw the same picture.
 */
export function normalize(value: number, domain: ColorDomain): number {
  const span = domain.hi - domain.lo
  if (!(span > 0)) return 0
  const above = value - domain.lo
  if (above <= 0) return 0
  if (above >= span) return 1
  return domain.log ? Math.log1p(above) / Math.log1p(span) : above / span
}

/**
 * Where a ramp starts and stops — the Heatmap's colour domain and `by value`'s, as one rule.
 *
 *  - **A typed end replaces one end**, and an out-of-range value clamps to the end it passed, as
 *    in matplotlib; each caller's legend or caption admits it rather than letting it vanish.
 *  - **A diverging ramp is symmetric about its centre**: `max` is the distance from the centre to
 *    either end, and absent it is the furthest the data reaches from the centre on either side —
 *    so the middle colour means the centre and equal steps of colour are equal amounts. `min` and
 *    `log` do not apply there.
 *  - **An automatic bottom is the one place the callers differ.** `floor: 'zero'` is the
 *    Heatmap's, so an all-positive matrix reads against a baseline of nothing; the default is
 *    `by value`'s, the data's own minimum, which is what it always drew.
 */
export function rampDomain(
  extent: { min: number; max: number },
  options: {
    diverging?: boolean
    center?: number
    limits?: ColorLimits
    log?: boolean
    floor?: 'data' | 'zero'
  } = {},
): ColorDomain {
  const { limits = {}, center = 0 } = options
  if (options.diverging) {
    const magnitude =
      limits.max ??
      (Math.max(Math.abs(extent.min - center), Math.abs(extent.max - center)) || 1)
    return { lo: center - magnitude, hi: center + magnitude, neutral: center }
  }
  const lo = limits.min ?? (options.floor === 'zero' ? Math.min(0, extent.min) : extent.min)
  const hi = limits.max ?? extent.max
  return { lo, hi, neutral: lo, ...(options.log ? { log: true } : {}) }
}

/**
 * `by value`'s domain: `rampDomain` over the node's controls, plus the one refusal a typed end
 * needs there. `parseColorLimits` already refuses an inverted typed pair; the case left is one
 * typed end on the wrong side of the data's other end, which would draw every value in one colour.
 */
export function valueDomain(
  extent: { min: number; max: number },
  scale: ValueScale | undefined,
): { domain: ColorDomain; problem?: string } {
  if (!scale) return { domain: rampDomain(extent) }
  const { problem } = scale.limits
  const limits = problem ? {} : scale.limits
  const admitted = problem ? { problem } : {}

  if (scale.diverging) {
    return {
      domain: rampDomain(extent, { diverging: true, center: scale.center, limits }),
      ...admitted,
    }
  }

  const domain = rampDomain(extent, { limits, log: scale.log })
  if (domain.lo >= domain.hi && (limits.min !== undefined || limits.max !== undefined)) {
    return {
      domain: rampDomain(extent, { log: scale.log }),
      problem:
        limits.min !== undefined
          ? `the minimum (${limits.min}) is not below the largest value (${extent.max})`
          : `the maximum (${limits.max}) is not above the smallest value (${extent.min})`,
    }
  }
  return { domain, ...admitted }
}

/**
 * Steps a colour ramp is sampled into, shared by every surface that maps a number to a colour:
 * the Heatmap's fills and colour bar, and `by value` in `resolveColor`.
 *
 * A lookup table rather than a ramp call per value, and that is not a micro-optimisation: each of
 * those calls parses two hex strings and formats a third. Measured in a browser, 285,000 of them —
 * one grid cell per pixel of a full-width plot — cost **65 ms** against **2 ms** through the table.
 * `by value` pays the same per synapse point, 10^5 at a time, and a table also turns the 3D
 * viewer's per-colour parse cache from a miss per point into a hit.
 *
 * It does not put a colour on screen the ramp would not have drawn, in any visible sense — checked
 * rather than assumed, over 200,000 samples of both scales in both modes: the ramps are
 * piecewise-linear in RGB and the output is 8 bits a channel, so the whole of the blue ramp is 453
 * distinct colours and the diverging scale 621–1,006. Against those, **512 steps is within one
 * channel value of exact for sequential and two for diverging** — 256 measures the same, so this is
 * headroom rather than the edge of it. The objection to quantising is real for a *categorical*
 * palette, where a substituted slot means a different category; here a colour is a magnitude and
 * the substitute is the same magnitude to within a rounding step.
 */
export const RAMP_STEPS = 512

/** Ramp bucket of a value — its index into a `rampColors` table of `RAMP_STEPS`. */
export function bucketOf(value: number, domain: ColorDomain): number {
  return Math.round(normalize(value, domain) * (RAMP_STEPS - 1))
}

/**
 * A ramp, resolved to hex.
 *
 * One function for every lookup table and every colour bar, so a bar cannot come to describe a
 * scale the marks are not drawn in — the two were separate samplings of the same ramp before,
 * which is exactly how that drifts.
 */
export function rampColors(
  scale: 'sequential' | 'diverging',
  mode: Mode,
  steps = RAMP_STEPS,
  palette: HeatmapPalette = 'coda',
): string[] {
  // A name from the other scale's list is not an error, just not an answer: Coda's own ramp
  // stands in, which is also what `heatmapPaletteOf` hands a caller reading the params.
  const sequential = isSequentialPalette(palette) ? palette : 'coda'
  const diverging = isDivergingPalette(palette) ? palette : 'coda'
  return Array.from({ length: steps }, (_, i) => {
    const t = steps === 1 ? 0 : i / (steps - 1)
    return scale === 'diverging'
      ? heatmapDivergingColor(t * 2 - 1, mode, diverging)
      : heatmapSequentialColor(t, mode, sequential)
  })
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
  /*
   * A literal hex is itself.
   *
   * The palette slots above are the vocabulary a *param* offers, and they stay the default answer
   * — `colorParams`' enum is nine validated choices and picking a tenth by eye is what
   * `colors.ts` refuses. But a colour the user typed into an `<input type="color">` is not a
   * palette choice, it is their lab's convention or an existing figure's key, which is exactly
   * the case `LegendKeys`' own override already serves. Without this a stored `#3b7a2f` parsed as
   * `NaN` and came back as slot 0 — a plausible blue, and no way to tell it from a colour that
   * had been chosen.
   */
  const literal = literalColor(spec.constant)
  if (literal) return literal
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
  const overrideOf = (label: string): string | undefined =>
    literalColor(spec.overrides?.[label])

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
    const listed = [...unique].slice(0, LEGEND_KEYS)

    return {
      at: (rowIndex) => colors.get(cellKey(rowIndex)) ?? MUTED,
      labelAt: cellKey,
      legend: {
        kind: 'categorical',
        column: spec.column,
        entries: listed.map((label) => ({ label, color: colors.get(label)! })),
        truncated: unique.size > LEGEND_KEYS,
        unlisted: Math.max(0, unique.size - LEGEND_KEYS),
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
    const { scale } = spec
    const { domain, problem } = valueDomain({ min, max }, scale)
    /*
     * The Heatmap's lookup table, so a palette name means one set of colours app-wide and a row
     * costs arithmetic rather than a ramp sample — see `RAMP_STEPS`. `coda` sequential is
     * `sequentialColor` itself, which keeps a node that never opted in on the ramp it drew.
     */
    const kind = scale?.diverging ? 'diverging' : 'sequential'
    const ramp = rampColors(kind, mode, RAMP_STEPS, scale?.palette)
    const clipped = min < domain.lo || max > domain.hi
    return {
      at: (rowIndex) => {
        const v = numeric(data[rowIndex])
        return v === undefined ? MUTED : ramp[bucketOf(v, domain)]!
      },
      legend: {
        kind: 'sequential',
        column: spec.column,
        domain: [domain.lo, domain.hi],
        // Nine stops, an odd count, so a centred ramp's bar has its middle colour on a stop.
        stops: rampColors(kind, mode, 9, scale?.palette),
        ...(scale?.diverging ? { center: domain.neutral } : {}),
        ...(domain.log ? { log: true } : {}),
        ...(clipped ? { clipped: true } : {}),
        ...(problem ? { problem } : {}),
      },
    }
  }

  /*
   * Categorical: rank by frequency, then **cycle** the palette.
   *
   * Ranking is what it always was — the commonest values get the leading, most distinguishable
   * slots, ties broken on the label so a filter that changes nothing but row order cannot
   * reshuffle the picture.
   *
   * What changed is the tail. This used to fold everything past the eighth slot into one
   * achromatic `Other`, on the grounds that a repeated hue implies two categories are the same
   * thing. That reasoning holds where the *mark* folds too — a bar, a slice, a histogram
   * segment, all of which sum the tail into one shape that needs one colour, and `foldByRank`
   * still governs those. It does not hold here: a node, a point or a neuron keeps its own mark
   * whatever colour it is given, so folding bought nothing and cost everything — fifty cell
   * types past the eighth became one grey lump that said only "not one of the eight".
   *
   * Cycling has a real cost and it is not hidden. Two categories a palette-length apart share a
   * hue, and `cycled` is how a caption gets to say so. The palette dropdown is the other half of
   * the answer: `tab20` gives twenty before anything comes round.
   *
   * `—` keeps its own key like any other value; a null is a category here, not an absence to be
   * greyed. That is unchanged.
   */
  const counts = new Map<string, number>()
  for (let row = 0; row < data.length; row++) {
    const key = cellKey(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  /*
   * One colour per distinct value, resolved once rather than per row.
   *
   * `overrideOf` runs `literalColor` — a `trim` and a regex — and the palette lookup is a table
   * read; both were happening per row, on a path shared by the scatter, network and 3D viewers
   * and driven per *point* by `buildPoints`. Unbounded now that nothing folds, so it is a Map
   * over the distinct values rather than an array of nine, the same shape `hash` uses and for
   * the same reason.
   */
  const colors = new Map<string, string>()
  ranked.forEach(([label], index) => {
    colors.set(label, overrideOf(label) ?? cycleColor(index, mode, spec.palette))
  })

  const listed = ranked.slice(0, LEGEND_KEYS).map(([label]) => label)

  return {
    at: (rowIndex) => colors.get(cellKey(rowIndex)) ?? MUTED,
    labelAt: cellKey,
    legend: {
      kind: 'categorical',
      column: spec.column,
      entries: listed.map((label) => ({ label, color: colors.get(label)! })),
      truncated: ranked.length > LEGEND_KEYS,
      unlisted: Math.max(0, ranked.length - LEGEND_KEYS),
      cycled: ranked.length > paletteColors(spec.palette, mode).length,
    },
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

/** One thing a colour bar alone would misstate. `kind` is for a caller that says fewer of them. */
export interface RampNote {
  kind: 'centre' | 'clipped' | 'log' | 'ignored'
  text: string
  title: string
}

/**
 * What a colour bar alone would misstate, in words — for every surface that draws one.
 *
 * The Heatmap caption, the shared `ColorKey` and an exported bar's title all read this, so a
 * reworded note reaches every one of them. `extent` is the data's range where the caller has it,
 * which lets `values clipped` say how far past the ends the values run.
 */
export function rampNotes(ramp: {
  domain: [number, number]
  center?: number | undefined
  log?: boolean | undefined
  clipped?: boolean | undefined
  problem?: string | undefined
  extent?: { min: number; max: number }
}): RampNote[] {
  const [lo, hi] = ramp.domain
  const notes: RampNote[] = []
  // A centre of zero is a diverging ramp's ordinary meaning, and says nothing.
  if (ramp.center !== undefined && ramp.center !== 0) {
    const center = formatCompact(ramp.center)
    notes.push({
      kind: 'centre',
      text: `centred on ${center}`,
      title: `The middle colour stands for ${center}, and both arms are the same length.`,
    })
  }
  if (ramp.clipped) {
    const runs = ramp.extent
      ? `, and the values run ${formatCompact(ramp.extent.min)} to ${formatCompact(ramp.extent.max)}`
      : ''
    notes.push({
      kind: 'clipped',
      text: 'values clipped',
      title:
        `The colour scale stops at ${formatCompact(lo)} and ${formatCompact(hi)}${runs}. ` +
        `Values outside are drawn in the end colour, not dropped.`,
    })
  }
  if (ramp.log) {
    notes.push({
      kind: 'log',
      text: 'log colour',
      title:
        'The colour runs on a log scale, so equal steps of colour are not equal steps of ' +
        'value. The numbers printed are the values themselves.',
    })
  }
  if (ramp.problem) {
    notes.push({
      kind: 'ignored',
      text: 'limits ignored',
      title:
        `The colour limits are ignored because ${ramp.problem}. The scale is the one the ` +
        `data gives.`,
    })
  }
  return notes
}

/**
 * A colour bar's title in an exported file, carrying what the screen says in notes beside it.
 *
 * A figure outlives the card, and a log ramp or a clamp that the file does not mention is a
 * picture read as linear and complete. `limits ignored` is left out on purpose: the file's two
 * ends are then the data's, which is already true of the picture it labels.
 */
export function rampLabel(legend: SequentialLegend): string {
  const notes = rampNotes(legend).filter((note) => note.kind !== 'ignored')
  return [legend.column, ...notes.map((note) => note.text)].join(' · ')
}

/** The sRGB transfer function, one channel in 0..1, encoded → linear light. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * Convert a CSS hex colour to its 0..1 RGB triplet in **linear light** — what a three.js vertex
 * colour buffer holds, and what luminance is defined over.
 *
 * It returned the *encoded* triplet until every caller turned out to want the other thing. three
 * reads a `color` attribute as already linear and encodes to sRGB on the way out, so an encoded
 * triplet written straight in was encoded twice: every skeleton and synapse point drew lighter and
 * greyer than its legend swatch — a grey asked for as `#8f`–`#97` rendered at `#c8`. A material's
 * `color` never had the problem (`THREE.Color` converts a hex on the way in), which is why meshes
 * were right all along. Linearising here rather than at each buffer builder is what stops the next
 * vertex-colour writer making the same mistake: there is no encoded triplet left to write.
 */
export function hexToLinearRgb(hex: string): [number, number, number] {
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
  return [
    srgbToLinear(((value >> 16) & 255) / 255),
    srgbToLinear(((value >> 8) & 255) / 255),
    srgbToLinear((value & 255) / 255),
  ]
}
