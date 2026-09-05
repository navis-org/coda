/**
 * Chart colour system.
 *
 * Values come from a validated palette, not from taste. What was checked, with the
 * validator rather than by eye:
 *
 *  - Categorical 8 (stacked bars, adjacent pairs): PASS in both modes.
 *    Worst adjacent CVD ΔE 8.4 dark / 9.1 light; worst normal-vision 19.3 / 19.6.
 *    Stacked segments also carry the mandated 2px surface gap, which is the secondary
 *    encoding the 6–8 CVD band requires.
 *  - Socket families (any two can appear side by side, so all-pairs applies): only
 *    THREE chromatic slots clear all-pairs on the dark surface. Adding any fourth hue
 *    from these ramps fails the normal-vision floor (best candidate: red, ΔE 7.1 vs
 *    orange). Hence three hues + achromatic gray, with socket *shape* and an
 *    always-visible socket label carrying identity. See theme.css.
 *  - Sequential: blue or red, each a single hue monotonic in lightness. Direction flips by
 *    mode so "near zero" always recedes toward the surface it's drawn on. The two are never
 *    shown at once - a viewer picks one per measure - so this is not an all-pairs case.
 *
 * If you swap these values, re-run the validator — do not reason about ΔE.
 */

import type { PaletteName } from '../nodes/lib/encodingParams'
import type { DivergingPalette, SequentialPalette } from '../nodes/lib/heatmapParams'

export type Mode = 'light' | 'dark'

/**
 * Categorical series, fixed order.
 *
 * A 9th series folds into "Other" wherever the *mark* folds too — a bar, a slice, a histogram
 * segment. Where every row keeps its own mark it cycles instead; see `cycleColor`.
 */
const CATEGORICAL: Record<Mode, string[]> = {
  light: [
    '#2a78d6',
    '#eb6834',
    '#1baf7a',
    '#eda100',
    '#e87ba4',
    '#008300',
    '#4a3aa7',
    '#e34948',
  ],
  dark: [
    '#3987e5',
    '#d95926',
    '#199e70',
    '#c98500',
    '#d55181',
    '#008300',
    '#9085e9',
    '#e66767',
  ],
}

export const MAX_SERIES = 8
export const OTHER_LABEL = 'Other'

/**
 * The categorical palettes an encoding can cycle through.
 *
 * Two rules govern this table, and both are about not doing by eye what somebody else has
 * already done properly.
 *
 * **The values are published sets, transcribed.** `coda` is this app's own, validated with the
 * `dataviz` validator against both surfaces — see the header above, and note it is the only one
 * here that is. The other four are imported whole:
 *
 *  - `okabeIto` — Okabe & Ito's colour-universal-design set, in R's eight-colour spelling
 *    (`palette.colors("Okabe-Ito")`), which substitutes grey `#999999` for the published black.
 *    Black is unusable as a mark on the dark surface, and grey is what the reference
 *    implementation already reaches for. This is the set to pick when the drawing has to survive
 *    all three kinds of colour-blindness.
 *  - `tableau10` — matplotlib's `tab10`, which is Tableau's classic ten.
 *  - `paired` — ColorBrewer's qualitative `Paired`, twelve.
 *  - `tab20` — matplotlib's `tab20`, twenty.
 *
 * **The order is ours, and only the order.** `resolveColor` ranks categories by frequency and
 * hands the leading slots to the commonest values, so slot order carries meaning here in a way
 * it does not in matplotlib. `tab20` and `paired` both ship interleaved dark/light pairs, which
 * would put the two commonest categories in two shades of one hue; both are rotated so the
 * saturated half comes first. Note what falls out of that for `tab20`: its saturated half *is*
 * `tab10`, so the two palettes agree for the first ten categories and the second ten are tints.
 *
 * **Only `coda` is theme-tuned.** The imported four are one set for both surfaces, which is what
 * they are; the pale members of `tab20` and `paired` are correspondingly weak on the light
 * surface. That is the cost of the capacity, and the param's help says so.
 */
const PALETTES: Record<PaletteName, string[] | Record<Mode, string[]>> = {
  coda: CATEGORICAL,
  okabeIto: [
    '#e69f00',
    '#56b4e9',
    '#009e73',
    '#f0e442',
    '#0072b2',
    '#d55e00',
    '#cc79a7',
    '#999999',
  ],
  tableau10: [
    '#1f77b4',
    '#ff7f0e',
    '#2ca02c',
    '#d62728',
    '#9467bd',
    '#8c564b',
    '#e377c2',
    '#7f7f7f',
    '#bcbd22',
    '#17becf',
  ],
  paired: [
    // The six saturated members first, then the six pale ones they were published paired with.
    '#1f78b4',
    '#33a02c',
    '#e31a1c',
    '#ff7f00',
    '#6a3d9a',
    '#b15928',
    '#a6cee3',
    '#b2df8a',
    '#fb9a99',
    '#fdbf6f',
    '#cab2d6',
    '#ffff99',
  ],
  tab20: [
    // The ten saturated members — which are exactly `tab10` — then the ten tints.
    '#1f77b4',
    '#ff7f0e',
    '#2ca02c',
    '#d62728',
    '#9467bd',
    '#8c564b',
    '#e377c2',
    '#7f7f7f',
    '#bcbd22',
    '#17becf',
    '#aec7e8',
    '#ffbb78',
    '#98df8a',
    '#ff9896',
    '#c5b0d5',
    '#c49c94',
    '#f7b6d2',
    '#c7c7c7',
    '#dbdb8d',
    '#9edae5',
  ],
}

/** The colours of one palette, in slot order. */
export function paletteColors(name: PaletteName | undefined, mode: Mode): string[] {
  const palette = PALETTES[name ?? 'coda'] ?? CATEGORICAL
  return Array.isArray(palette) ? palette : palette[mode]
}

/**
 * Colour for category `index`, **cycling** when there are more categories than colours.
 *
 * The counterpart to `seriesColor`, and the difference between them is not a preference — it is
 * what the mark does with the tail. A bar, a slice or a histogram segment **folds** everything
 * past the palette into one residual mark, so that mark needs one colour and an achromatic grey
 * is the honest one. A node, a point or a neuron keeps its own mark whatever happens, so folding
 * buys nothing and costs everything: fifty cell types past the eighth became one grey lump that
 * said only "not one of the eight".
 *
 * The cost of cycling is real and is not hidden: two categories forty apart share a hue. The
 * palette dropdown is the answer to that — `tab20` gives twenty before anything repeats — and a
 * viewer whose colours have come round says so in its caption, the way the dendrogram always has.
 */
export function cycleColor(index: number, mode: Mode, palette?: PaletteName): string {
  const colors = paletteColors(palette, mode)
  return colors[((index % colors.length) + colors.length) % colors.length]!
}

/** Reserved for the "Other" bucket — deliberately achromatic so it reads as residual. */
const OTHER_COLOR: Record<Mode, string> = { light: '#898781', dark: '#898781' }

/**
 * Colour for series slot `i`. Anything past slot 8 is the achromatic Other colour —
 * callers are expected to have folded the tail into one bucket before this point.
 */
export function seriesColor(index: number, mode: Mode): string {
  const palette = CATEGORICAL[mode]
  return palette[index] ?? OTHER_COLOR[mode]
}

/**
 * Rank a tally, keep the top `cap`, and put the rest in the residual.
 *
 * The eight-slots-plus-achromatic rule is the load-bearing one in this file's header — a
 * ninth hue would repeat an earlier one and imply two categories are the same thing — and
 * until this existed it was enforced by four separate copies of the same loop rather than by
 * anything. The copies had already drifted: two of them tie-broke equal totals by label and
 * two did not, so two charts assigned colours from `Map` insertion order on a tie and two were
 * stable. Both spellings looked right in isolation.
 *
 * The tie-break is kept, because the alternative is a palette that shuffles when a filter
 * upstream changes nothing but the order rows arrive in.
 *
 * Callers differ in what they do with `tail` and that is fine — a bar and a slice **sum** it
 * into one residual mark, a pie additionally hands its members back when the residual is
 * clicked, and a box plot **drops** it, because pooling fifty distributions describes nothing.
 * What none of them may do is invent a ninth colour.
 */
export interface RankedFold {
  /** Kept names, largest first. */
  kept: string[]
  /** Names past the cap, largest first. Empty when nothing folded. */
  tail: string[]
  /** Legend order: `kept`, plus `Other` when anything folded. */
  legend: string[]
  /** True when `tail` is non-empty. */
  folded: boolean
  /** Palette slot for a name — `MAX_SERIES`, the achromatic residual, for a folded one. */
  slotOf(name: string): number
}

export function foldByRank(totals: Iterable<[string, number]>, cap = MAX_SERIES): RankedFold {
  const ranked = [...totals]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)
  const kept = ranked.slice(0, Math.max(1, cap))
  const tail = ranked.slice(Math.max(1, cap))
  const slots = new Map(kept.map((name, index) => [name, index]))
  return {
    kept,
    tail,
    legend: tail.length > 0 ? [...kept, OTHER_LABEL] : kept,
    folded: tail.length > 0,
    slotOf: (name) => slots.get(name) ?? MAX_SERIES,
  }
}

/**
 * Blue sequential ramp, light→dark as printed in the reference palette. Index 0 is the
 * lightest step.
 */
const BLUE_RAMP = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b',
]

const RED_RAMP = [
  '#fbd5d5',
  '#f5b3b3',
  '#ef9191',
  '#e97070',
  '#e34948',
  '#d03b3b',
  '#b83131',
  '#9c2828',
  '#7d2020',
]

/** Neutral midpoint of the diverging scale — gray, so "nothing" reads as nothing. */
const DIVERGING_MID: Record<Mode, string> = { light: '#f0efec', dark: '#383835' }

function lerpHex(a: string, b: string, t: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t)
  return rgbToHex(mix(pa[0], pb[0]), mix(pa[1], pb[1]), mix(pa[2], pb[2]))
}

/**
 * `#rrggbb` to its three channels.
 *
 * Exported for the heatmap's pixel path, which turns a whole ramp into bytes — a second
 * `parseInt(hex.slice(...), 16)` beside this one is how two readers come to disagree about a
 * malformed colour.
 */
export function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`
}

/** `#rrggbb`, optionally with an `aa` alpha byte — the form sigma's `parseColor` accepts. */
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i

/**
 * Blend two colours, `t` being how far to travel from `a` towards `b`.
 *
 * `lerpHex` is the internal fast path over ramps this module owns, so it can assume
 * well-formed input. This one is exported for callers mixing a colour they were *handed* —
 * the viewers' dimming, where the input is whatever an encoding happened to resolve to — and
 * a bad string there would otherwise parse to NaN and paint nothing at all. Unparseable
 * input returns `a` unchanged, degrading to "no blend" rather than to an invisible mark.
 *
 * An alpha byte on `a` rides through untouched. Blending it away would make a translucent
 * mark opaque the moment it was de-emphasised, which is backwards.
 */
export function mixHex(a: string, b: string, t: number): string {
  if (!HEX.test(a) || !HEX.test(b)) return a
  const alpha = a.length === 9 ? a.slice(7) : ''
  return lerpHex(a.slice(0, 7), b.slice(0, 7), Math.max(0, Math.min(1, t))) + alpha
}

/**
 * Attach an alpha byte to an opaque hex colour.
 *
 * Sigma takes one colour per mark and parses `#rrggbbaa` (see its `parseColor`), so a
 * constant opacity has to be folded into the colour rather than carried beside it. Fully
 * opaque returns the input untouched, which keeps the common case a plain six-digit value
 * that every other consumer — the SVG export included — already understands.
 */
export function withAlpha(hex: string, alpha: number): string {
  if (!(alpha < 1)) return hex
  if (!HEX.test(hex)) return hex
  const byte = Math.round(Math.max(0, alpha) * 255)
  return `${hex.slice(0, 7)}${byte.toString(16).padStart(2, '0')}`
}

/** Sample a ramp at t ∈ [0,1] with linear interpolation between steps. */
function sampleRamp(ramp: string[], t: number): string {
  if (ramp.length === 0) return '#000000'
  const clamped = Math.max(0, Math.min(1, t))
  const scaled = clamped * (ramp.length - 1)
  const lo = Math.floor(scaled)
  const hi = Math.min(ramp.length - 1, lo + 1)
  return lerpHex(ramp[lo]!, ramp[hi]!, scaled - lo)
}

/**
 * Which hue a sequential ramp runs through.
 *
 * Two, and never more without re-running the validator. The point of a second one is not decoration:
 * where a viewer switches between two measures of the same kind — presynaptic and postsynaptic
 * completeness, which are otherwise identical pictures over different numbers — the hue is what
 * says *which* is on screen, so a glance is not ambiguous the way two blues would be.
 */
export type SequentialHue = 'blue' | 'red'

/**
 * Sequential colour for a normalised magnitude.
 *
 * Direction is mode-dependent on purpose: on a light surface low values take the
 * lightest step and recede into the page; on a dark surface they take the darkest step
 * instead. Flipping this is what stops a dark-mode heatmap from reading as a negative.
 *
 * The hue argument selects a ramp and changes nothing else — same clamp, same flip. A second
 * function would have been a second copy of that flip, which is exactly the rule that makes a
 * dark-mode ramp read as a negative when it drifts.
 *
 * **Red is a sequential ramp on the same terms as blue**, checked rather than assumed when it
 * gained this second job: monotonic in lightness light-to-dark, luminance spanning 0.729 to 0.055
 * against blue's 0.743 to 0.038, and a minimum step of 0.032 against blue's 0.018 — so its steps
 * are if anything better separated. End contrasts against both surfaces match blue's within a
 * tenth of a stop. It was already in the validated palette as the diverging scale's positive arm;
 * what is new is using the whole of it.
 */
export function sequentialColor(t: number, mode: Mode, hue: SequentialHue = 'blue'): string {
  const ramp = hue === 'red' ? RED_RAMP : BLUE_RAMP
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0))
  return mode === 'light' ? sampleRamp(ramp, clamped) : sampleRamp(ramp, 1 - clamped)
}

/**
 * Diverging colour for t ∈ [-1, 1]: blue for negative, red for positive, neutral gray
 * at zero. Equal step count per arm.
 */
export function divergingColor(t: number, mode: Mode): string {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(t) ? t : 0))
  const mid = DIVERGING_MID[mode]
  if (clamped === 0) return mid
  const magnitude = Math.abs(clamped)
  // Arms run from the neutral midpoint out to a saturated pole.
  const pole =
    clamped > 0
      ? sampleRamp(RED_RAMP, 0.45 + magnitude * 0.5)
      : sampleRamp(
          BLUE_RAMP,
          mode === 'light' ? 0.4 + magnitude * 0.55 : 0.6 - magnitude * 0.55,
        )
  return lerpHex(mid, pole, magnitude)
}

// ---------------------------------------------------------------------------
// Heatmap palettes: published ramps, transcribed
// ---------------------------------------------------------------------------

/**
 * The continuous colormaps the Heatmap node offers beside Coda's own, as 64 stops each.
 *
 * **Sampled from the installed matplotlib 3.11 / seaborn 0.13 by a script, not typed** — the
 * same rule the categorical `PALETTES` follow, for the same reason: a published set is somebody
 * else's validated work, and the one thing a transcription can add is an error. 64 stops
 * rather than the 256 the packages hold, and the number was measured rather than chosen: the
 * ramps are smooth, so linear interpolation between 64 of their entries reproduces all 256 to
 * **within two channel values** (viridis, magma, inferno, plasma, rocket, mako at one or two,
 * cividis at two) — the same tolerance `RAMP_STEPS` is held to in `heatmapPlot.ts`, and a
 * quarter of the bytes. 32 stops measured three to six, which is where banding starts.
 *
 * **Not theme-tuned, and not flipped.** Coda's own ramp reverses with the theme so "nothing
 * here" always recedes into the surface; these run as published — dark end low — on both
 * surfaces, which is how every reader has seen them in a paper and is what makes the exported
 * `cmap='viridis'` the picture on the card. On the light surface a low cell is therefore
 * *dark*, exactly as in matplotlib on white.
 */
const HEATMAP_SEQUENTIAL: Record<Exclude<SequentialPalette, 'coda'>, string[]> = {
  viridis: [
    '#440154',
    '#46075a',
    '#470d60',
    '#471365',
    '#48186a',
    '#481d6f',
    '#482374',
    '#482878',
    '#472d7b',
    '#46327e',
    '#453781',
    '#443b84',
    '#424086',
    '#404588',
    '#3e4989',
    '#3d4e8a',
    '#3a538b',
    '#38588c',
    '#365c8d',
    '#34608d',
    '#32648e',
    '#31688e',
    '#2f6c8e',
    '#2d708e',
    '#2c738e',
    '#2a778e',
    '#297b8e',
    '#277f8e',
    '#26828e',
    '#24868e',
    '#238a8d',
    '#218e8d',
    '#20928c',
    '#1f968b',
    '#1f9a8a',
    '#1f9e89',
    '#1fa187',
    '#21a585',
    '#23a983',
    '#26ad81',
    '#2ab07f',
    '#2fb47c',
    '#35b779',
    '#3bbb75',
    '#42be71',
    '#4ac16d',
    '#52c569',
    '#5ac864',
    '#65cb5e',
    '#6ece58',
    '#77d153',
    '#81d34d',
    '#8bd646',
    '#95d840',
    '#a0da39',
    '#aadc32',
    '#b5de2b',
    '#c0df25',
    '#cae11f',
    '#d5e21a',
    '#dfe318',
    '#eae51a',
    '#f4e61e',
    '#fde725',
  ],
  magma: [
    '#000004',
    '#020109',
    '#030312',
    '#06051a',
    '#0a0822',
    '#0e0b2b',
    '#130d34',
    '#180f3d',
    '#1d1147',
    '#221150',
    '#29115a',
    '#2f1163',
    '#36106b',
    '#3d0f71',
    '#440f76',
    '#4a1079',
    '#52137c',
    '#59157e',
    '#5f187f',
    '#651a80',
    '#6b1d81',
    '#721f81',
    '#782281',
    '#7e2482',
    '#842681',
    '#8b2981',
    '#912b81',
    '#982d80',
    '#9e2f7f',
    '#a5317e',
    '#ab337c',
    '#b2357b',
    '#ba3878',
    '#c03a76',
    '#c73d73',
    '#cd4071',
    '#d3436e',
    '#d9466b',
    '#df4a68',
    '#e44f64',
    '#e95462',
    '#ed5a5f',
    '#f1605d',
    '#f4675c',
    '#f66e5c',
    '#f8765c',
    '#fa7d5e',
    '#fb8560',
    '#fc8e64',
    '#fd9668',
    '#fe9d6c',
    '#fea571',
    '#feac76',
    '#feb47b',
    '#febb81',
    '#fec287',
    '#feca8d',
    '#fed194',
    '#fed89a',
    '#fde0a1',
    '#fde7a9',
    '#fceeb0',
    '#fcf6b8',
    '#fcfdbf',
  ],
  inferno: [
    '#000004',
    '#02010a',
    '#040312',
    '#07051b',
    '#0b0724',
    '#10092d',
    '#150b37',
    '#1b0c41',
    '#210c4a',
    '#280b53',
    '#2f0a5b',
    '#360961',
    '#3d0965',
    '#440a68',
    '#4a0c6b',
    '#510e6c',
    '#59106e',
    '#5f136e',
    '#65156e',
    '#6c186e',
    '#721a6e',
    '#781c6d',
    '#7f1e6c',
    '#85216b',
    '#8c2369',
    '#922568',
    '#982766',
    '#9f2a63',
    '#a52c60',
    '#ab2f5e',
    '#b1325a',
    '#b73557',
    '#bf3952',
    '#c43c4e',
    '#ca404a',
    '#cf4446',
    '#d44842',
    '#d94d3d',
    '#de5238',
    '#e25734',
    '#e65d2f',
    '#ea632a',
    '#ed6925',
    '#f06f20',
    '#f3761b',
    '#f57d15',
    '#f78410',
    '#f98b0b',
    '#fa9407',
    '#fb9b06',
    '#fca309',
    '#fcaa0f',
    '#fcb216',
    '#fbba1f',
    '#fac228',
    '#f9c932',
    '#f7d13d',
    '#f5d949',
    '#f4e156',
    '#f2e865',
    '#f1ef75',
    '#f3f586',
    '#f6fa96',
    '#fcffa4',
  ],
  plasma: [
    '#0d0887',
    '#19068c',
    '#220690',
    '#2a0593',
    '#310597',
    '#38049a',
    '#3f049c',
    '#46039f',
    '#4c02a1',
    '#5302a3',
    '#5901a5',
    '#6001a6',
    '#6600a7',
    '#6c00a8',
    '#7201a8',
    '#7801a8',
    '#8004a8',
    '#8606a6',
    '#8b0aa5',
    '#910ea3',
    '#9613a1',
    '#9c179e',
    '#a11b9b',
    '#a62098',
    '#ab2494',
    '#b02991',
    '#b42e8d',
    '#b83289',
    '#bd3786',
    '#c13b82',
    '#c5407e',
    '#c9447a',
    '#cd4a76',
    '#d14e72',
    '#d5536f',
    '#d8576b',
    '#db5c68',
    '#de6164',
    '#e26561',
    '#e56a5d',
    '#e76f5a',
    '#ea7457',
    '#ed7953',
    '#ef7e50',
    '#f1834c',
    '#f48849',
    '#f68d45',
    '#f79342',
    '#f99a3e',
    '#fb9f3a',
    '#fca537',
    '#fdab33',
    '#fdb130',
    '#feb72d',
    '#febd2a',
    '#fdc328',
    '#fdca26',
    '#fcd025',
    '#fbd724',
    '#f9dd25',
    '#f7e425',
    '#f5eb27',
    '#f2f227',
    '#f0f921',
  ],
  cividis: [
    '#00224e',
    '#002554',
    '#00285b',
    '#002b62',
    '#002e6a',
    '#003070',
    '#053371',
    '#123570',
    '#1a386f',
    '#213b6e',
    '#273e6e',
    '#2d416d',
    '#32436d',
    '#36466c',
    '#3b496c',
    '#3f4c6c',
    '#444f6c',
    '#48526c',
    '#4c556c',
    '#50576c',
    '#545a6d',
    '#575d6d',
    '#5b606e',
    '#5e636f',
    '#62656f',
    '#656870',
    '#696b71',
    '#6c6e72',
    '#707173',
    '#737475',
    '#777776',
    '#7a7a78',
    '#7e7d78',
    '#828079',
    '#868379',
    '#8a8678',
    '#8e8978',
    '#928c78',
    '#958f77',
    '#999277',
    '#9d9576',
    '#a19975',
    '#a59c74',
    '#a99f73',
    '#ada272',
    '#b1a570',
    '#b6a96f',
    '#baac6d',
    '#bfb06b',
    '#c3b369',
    '#c7b767',
    '#ccba64',
    '#d0be62',
    '#d4c15f',
    '#d9c55c',
    '#ddc858',
    '#e1cc55',
    '#e6d051',
    '#ead34c',
    '#efd748',
    '#f3db42',
    '#f8df3c',
    '#fde334',
    '#fee838',
  ],
  rocket: [
    '#03051a',
    '#07071d',
    '#0d0a21',
    '#130d25',
    '#180f29',
    '#1e122d',
    '#241432',
    '#2a1636',
    '#30173a',
    '#35193e',
    '#3c1a42',
    '#421b45',
    '#481c48',
    '#4e1d4b',
    '#541e4e',
    '#5b1e51',
    '#631f53',
    '#691f55',
    '#701f57',
    '#761f58',
    '#7d1f5a',
    '#841e5a',
    '#8b1d5b',
    '#921c5b',
    '#981b5b',
    '#9f1a5b',
    '#a6195a',
    '#ad1759',
    '#b41658',
    '#ba1656',
    '#c11754',
    '#c71951',
    '#ce1d4e',
    '#d3214b',
    '#d82748',
    '#dd2c45',
    '#e13342',
    '#e53940',
    '#e8403e',
    '#eb483e',
    '#ed503e',
    '#ef5840',
    '#f06043',
    '#f26747',
    '#f26f4c',
    '#f37651',
    '#f47d57',
    '#f4845d',
    '#f58d64',
    '#f5946b',
    '#f69b71',
    '#f6a178',
    '#f6a880',
    '#f6ae87',
    '#f6b48f',
    '#f6bb97',
    '#f6c19f',
    '#f7c7a8',
    '#f7cdb1',
    '#f8d3ba',
    '#f8d9c3',
    '#f9dfcb',
    '#f9e5d4',
    '#faebdd',
  ],
  mako: [
    '#0b0405',
    '#10060a',
    '#140910',
    '#180d16',
    '#1c101c',
    '#201322',
    '#241628',
    '#28192e',
    '#2b1c35',
    '#2e1e3b',
    '#312142',
    '#342548',
    '#37284f',
    '#392b56',
    '#3b2e5d',
    '#3d3164',
    '#3f366d',
    '#403974',
    '#413d7b',
    '#414082',
    '#414488',
    '#40498e',
    '#3e4d93',
    '#3d5296',
    '#3b5799',
    '#3a5c9b',
    '#38619d',
    '#37659e',
    '#366a9f',
    '#366fa0',
    '#3573a1',
    '#3578a2',
    '#357da3',
    '#3482a4',
    '#3486a5',
    '#348ba6',
    '#348fa7',
    '#3493a8',
    '#3498a9',
    '#359caa',
    '#35a1ab',
    '#37a5ac',
    '#38aaac',
    '#3aaead',
    '#3db3ad',
    '#40b7ad',
    '#44bcad',
    '#48c0ad',
    '#4fc5ad',
    '#55caad',
    '#5ecdad',
    '#68d1ad',
    '#73d4ad',
    '#7fd7af',
    '#8bdab2',
    '#96ddb5',
    '#a1dfb9',
    '#abe2be',
    '#b5e5c4',
    '#bee8ca',
    '#c6ebd1',
    '#ceeed7',
    '#d6f1de',
    '#def5e5',
  ],
}

/**
 * The diverging ones are ColorBrewer's eleven-class sets, and here the eleven **are** the
 * definition: matplotlib holds exactly these anchors at 0, 0.1 … 1 and interpolates linearly
 * between them, which `sampleRamp` does too, so this is the colormap rather than a sampling of
 * it. Stored low-to-high as published — `RdBu` runs red at the negative end — so the name means
 * what it means in every other tool; somebody who wants blue for negative has Coda's own.
 */
const HEATMAP_DIVERGING: Record<Exclude<DivergingPalette, 'coda'>, string[]> = {
  RdBu: [
    '#67001f',
    '#b2182b',
    '#d6604d',
    '#f4a582',
    '#fddbc7',
    '#f7f7f7',
    '#d1e5f0',
    '#92c5de',
    '#4393c3',
    '#2166ac',
    '#053061',
  ],
  PuOr: [
    '#7f3b08',
    '#b35806',
    '#e08214',
    '#fdb863',
    '#fee0b6',
    '#f7f7f7',
    '#d8daeb',
    '#b2abd2',
    '#8073ac',
    '#542788',
    '#2d004b',
  ],
  BrBG: [
    '#543005',
    '#8c510a',
    '#bf812d',
    '#dfc27d',
    '#f6e8c3',
    '#f5f5f5',
    '#c7eae5',
    '#80cdc1',
    '#35978f',
    '#01665e',
    '#003c30',
  ],
}

/**
 * Sequential colour for a normalised magnitude under a named palette.
 *
 * `coda` is `sequentialColor` and keeps its theme flip; every other name is a published ramp
 * read as published. One function rather than a branch at each caller, so the cells, the
 * colour bar and the printed values' ink cannot resolve a name three ways.
 */
export function heatmapSequentialColor(
  t: number,
  mode: Mode,
  palette: SequentialPalette = 'coda',
): string {
  if (palette === 'coda') return sequentialColor(t, mode)
  return sampleRamp(HEATMAP_SEQUENTIAL[palette], Number.isFinite(t) ? t : 0)
}

/** Diverging colour for t ∈ [-1, 1] under a named palette; `coda` is `divergingColor`. */
export function heatmapDivergingColor(
  t: number,
  mode: Mode,
  palette: DivergingPalette = 'coda',
): string {
  if (palette === 'coda') return divergingColor(t, mode)
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(t) ? t : 0))
  return sampleRamp(HEATMAP_DIVERGING[palette], (clamped + 1) / 2)
}

/** The transcribed stops of a published palette, for the test that pins the transcription. */
export function heatmapPaletteStops(palette: SequentialPalette | DivergingPalette): string[] {
  if (palette === 'coda') return []
  return palette in HEATMAP_SEQUENTIAL
    ? HEATMAP_SEQUENTIAL[palette as Exclude<SequentialPalette, 'coda'>]
    : HEATMAP_DIVERGING[palette as Exclude<DivergingPalette, 'coda'>]
}

/** Ink that stays legible on top of a filled cell — the one place text takes the fill. */
export function inkOn(background: string): string {
  const [r, g, b] = parseHex(background)
  // Rec. 709 relative luminance, good enough for a light/dark decision.
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return luminance > 0.55 ? '#0b0b0b' : '#ffffff'
}

/** Read the mode the document is actually rendering in. */
export function currentMode(): Mode {
  if (typeof document === 'undefined') return 'dark'
  const stamped = document.documentElement.dataset.theme
  if (stamped === 'light' || stamped === 'dark') return stamped
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Surface the charts are drawn on — the colour the 2px spacers are painted in. */
export function chartSurface(mode: Mode): string {
  return mode === 'light' ? '#fcfcfb' : '#1a1a19'
}

export const CHART_INK: Record<
  Mode,
  { primary: string; secondary: string; muted: string; grid: string; axis: string }
> = {
  light: {
    primary: '#0b0b0b',
    secondary: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
  },
  dark: {
    primary: '#ffffff',
    secondary: '#c3c2b7',
    muted: '#898781',
    grid: '#2c2c2a',
    axis: '#383835',
  },
}

/** The 2px spacer that separates touching marks. Never a stroke. */
export const SURFACE_GAP = 2
/** Bars are capped rather than filling their band — the leftover is air. */
export const MAX_BAR_THICKNESS = 24
