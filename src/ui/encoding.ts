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
import type { ColorSpec, ShapeSpec, SizeSpec } from '../nodes/lib/encodingParams'
import type { Mode } from './colors'
import {
  CHART_INK,
  MAX_SERIES,
  OTHER_LABEL,
  cycleColor,
  paletteColors,
  seriesColor,
  sequentialColor,
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
  domain: [number, number]
  /** Sampled stops for a colour bar. */
  stops: string[]
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
