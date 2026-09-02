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
  | 'coda'
  | 'viridis'
  | 'magma'
  | 'inferno'
  | 'plasma'
  | 'cividis'
  | 'rocket'
  | 'mako'

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
