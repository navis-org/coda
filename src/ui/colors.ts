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
 *  - Sequential: single blue hue, monotonic in lightness. Direction flips by mode so
 *    "near zero" always recedes toward the surface it's drawn on.
 *
 * If you swap these values, re-run the validator — do not reason about ΔE.
 */

export type Mode = 'light' | 'dark'

/** Categorical series, fixed order, never cycled. A 9th series folds into "Other". */
const CATEGORICAL: Record<Mode, string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
}

export const MAX_SERIES = 8
export const OTHER_LABEL = 'Other'

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

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
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
 * Sequential colour for a normalised magnitude.
 *
 * Direction is mode-dependent on purpose: on a light surface low values take the
 * lightest step and recede into the page; on a dark surface they take the darkest step
 * instead. Flipping this is what stops a dark-mode heatmap from reading as a negative.
 */
export function sequentialColor(t: number, mode: Mode): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0))
  return mode === 'light' ? sampleRamp(BLUE_RAMP, clamped) : sampleRamp(BLUE_RAMP, 1 - clamped)
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
  const pole = clamped > 0 ? sampleRamp(RED_RAMP, 0.45 + magnitude * 0.5) : sampleRamp(BLUE_RAMP, mode === 'light' ? 0.4 + magnitude * 0.55 : 0.6 - magnitude * 0.55)
  return lerpHex(mid, pole, magnitude)
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

export const CHART_INK: Record<Mode, { primary: string; secondary: string; muted: string; grid: string; axis: string }> =
  {
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
