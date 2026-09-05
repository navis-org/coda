/**
 * The Heatmap node's colour vocabulary — palette names the node offers and the viewer resolves.
 *
 * Names here, hex in `ui/colors.ts`, which is `encodingParams.ts`'s arrangement for the
 * categorical palettes and for the same reason: a node definition is headless and cannot import
 * the colour module, while the colour module may import a list of names.
 *
 * **Every palette but `coda` is a published set, transcribed.** Coda's own sequential and
 * diverging ramps are the validated ones (see the header of `ui/colors.ts`), and they are the
 * default. The rest are matplotlib's and seaborn's, sampled mechanically from the installed
 * packages rather than typed in — see `HEATMAP_SEQUENTIAL` in `ui/colors.ts` — and chosen for
 * being spelled the same way in Python and in R's viridisLite / ColorBrewer, so the exporters
 * can name the palette somebody picked rather than substituting one.
 *
 * Sequential and diverging are two lists because they are two kinds of thing: a diverging ramp
 * has a middle, and `Colour scale` decides whether zero is one. Each is its own param so a
 * choice survives toggling the scale and back.
 */

import type { ParamValues } from '../../core/node'

export type SequentialPalette =
  'coda' | 'viridis' | 'magma' | 'inferno' | 'plasma' | 'cividis' | 'rocket' | 'mako'

export type DivergingPalette = 'coda' | 'RdBu' | 'PuOr' | 'BrBG'

export type HeatmapPalette = SequentialPalette | DivergingPalette

export const SEQUENTIAL_PALETTE_OPTIONS: Array<{ value: SequentialPalette; label: string }> = [
  { value: 'coda', label: 'Coda blue' },
  { value: 'viridis', label: 'viridis' },
  { value: 'magma', label: 'magma' },
  { value: 'inferno', label: 'inferno' },
  { value: 'plasma', label: 'plasma' },
  { value: 'cividis', label: 'cividis (CVD-safe)' },
  { value: 'rocket', label: 'rocket' },
  { value: 'mako', label: 'mako' },
]

export const DIVERGING_PALETTE_OPTIONS: Array<{ value: DivergingPalette; label: string }> = [
  { value: 'coda', label: 'Coda blue–red' },
  { value: 'RdBu', label: 'red–blue (RdBu)' },
  { value: 'PuOr', label: 'purple–orange (PuOr)' },
  { value: 'BrBG', label: 'brown–teal (BrBG)' },
]

const SEQUENTIAL = new Set<string>(SEQUENTIAL_PALETTE_OPTIONS.map((o) => o.value))
const DIVERGING = new Set<string>(DIVERGING_PALETTE_OPTIONS.map((o) => o.value))

export function isSequentialPalette(name: unknown): name is SequentialPalette {
  return typeof name === 'string' && SEQUENTIAL.has(name)
}

export function isDivergingPalette(name: unknown): name is DivergingPalette {
  return typeof name === 'string' && DIVERGING.has(name)
}

/**
 * The palette a heatmap's params name, for the scale they name.
 *
 * One reader for the viewer, the exporters and the tests, so a stored name that is not on the
 * list for its scale — a hand-edited file, a palette retired later — degrades to Coda's own
 * everywhere at once rather than to whatever each caller's fallback happened to be.
 */
export function heatmapPaletteOf(params: ParamValues): HeatmapPalette {
  if (params.scale === 'diverging') {
    return isDivergingPalette(params.divergingPalette) ? params.divergingPalette : 'coda'
  }
  return isSequentialPalette(params.palette) ? params.palette : 'coda'
}

// ---------------------------------------------------------------------------
// The colour domain: manual ends, and a log mapping
// ---------------------------------------------------------------------------

/**
 * Where the ramp starts and stops, when somebody has said rather than let the data say.
 *
 * **A limit is a `string` param, and empty means automatic.** A `number` param cannot express
 * "unset": `ParamField` coerces anything unparseable back to the declared default, so a numeric
 * field would have to invent a sentinel — and `0` is a perfectly ordinary limit. Empty-means-
 * something is the idiom a dataset's `Version` already uses, and the cost is the scrub gesture,
 * which nobody misses on a value they type once.
 */
export interface ColorLimits {
  /** The value at the bottom of the ramp. Absent means the data decides. */
  min?: number
  /** The value at the top. On a diverging scale this is the magnitude of *both* arms. */
  max?: number
  /** Why what was typed is being ignored, for the caption to admit. */
  problem?: string
}

function readLimit(value: unknown): { value?: number; problem?: string } {
  if (typeof value === 'number' && Number.isFinite(value)) return { value }
  if (typeof value !== 'string') return {}
  const text = value.trim()
  if (!text) return {}
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return { problem: `"${text}" is not a number` }
  return { value: parsed }
}

/**
 * The two limit params, parsed.
 *
 * One reader for the viewer, both exporters and the tests, so a limit that is being ignored is
 * ignored everywhere rather than in whichever of the three remembered to check.
 *
 * **An inverted pair drops both.** A ramp running from 10 down to 1 has no meaning the rest of
 * this module could honour — `normalize` would clamp every cell to one end — so the honest
 * answer is the automatic domain plus a note saying why, rather than a picture of one colour.
 */
export function readColorLimits(params: ParamValues): ColorLimits {
  const min = readLimit(params.colorMin)
  const max = readLimit(params.colorMax)
  const problem = min.problem ?? max.problem
  if (problem) return { problem }
  if (min.value !== undefined && max.value !== undefined && min.value >= max.value) {
    return { problem: `the minimum (${min.value}) is not below the maximum (${max.value})` }
  }
  return {
    ...(min.value !== undefined ? { min: min.value } : {}),
    ...(max.value !== undefined ? { max: max.value } : {}),
  }
}

/**
 * Whether the colour runs on a log scale — the mapping only, never the numbers.
 *
 * Offered on a sequential scale alone. A diverging ramp is centred on zero and its two arms are
 * a *signed* magnitude, which is already the shape a log is reached for; taking a log across it
 * would compress the two arms differently on either side of the middle, which is a picture of
 * nothing. `visibleIf` on the node keeps it off screen there, and this keeps it off in the
 * exporters and on a hand-edited file.
 */
export function heatmapLogColor(params: ParamValues): boolean {
  return params.logColor === true && params.scale !== 'diverging'
}
