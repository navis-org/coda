/**
 * Saying which half a region is in, and colouring by a fraction.
 *
 * The side *rule* itself moved to `roiProjection.ts` when the explode began pairing homologous
 * regions with it — what is left here is the two things that are purely presentational, kept out
 * of the component because jsdom has no layout and anything inside one is covered by nothing.
 */

import { sequentialColor } from '../colors'
import type { Mode, SequentialHue } from '../colors'
// `regionSide` lives with the explode: it stopped being a presentation detail the moment the
// relaxation started pairing homologous regions with it.
import { homologyKey, regionSide } from './roiProjection'

export { regionSide } from './roiProjection'
export type { RoiSide } from './roiProjection'

/** For a facts row: the side spelled out, or the honest word for having none. */
export function sideLabel(roi: string): string {
  const side = regionSide(roi)
  if (side === 'left') return 'left'
  if (side === 'right') return 'right'
  return 'midline'
}

/**
 * A traced fraction as a colour on the sequential ramp.
 *
 * Clamped rather than trusted: `preCompleteness` is a ratio the server computed, and a region
 * with more traced synapses than total ones — which happens where the two are counted slightly
 * differently — would otherwise index past the end of the ramp and come back undefined.
 *
 * The hue is the caller's, because presynaptic and postsynaptic completeness are otherwise
 * identical pictures over different numbers: two blues would leave a glance unable to say which
 * one is on screen.
 */
export function rampColor(fraction: number, mode: Mode, hue: SequentialHue = 'blue'): string {
  const clamped = Math.max(0, Math.min(1, fraction))
  return sequentialColor(clamped, mode, hue)
}

/**
 * A colour per neuropil, keyed to the name.
 *
 * **Not a categorical encoding, and the difference is why the palette rule does not apply here.**
 * `colors.ts` never cycles a ninth hue, because in a chart a repeated colour claims two series
 * are the same thing. Nothing is being encoded here: there are 63 to 152 regions, no legend
 * could list them, and the hue means only "this shape is not that shape". It is the same job
 * neuroglancer's segment colours do, and the same reason it hashes rather than assigning.
 *
 * **Keyed on the homology key, so `ME(L)` and `ME(R)` come out the same colour.** They are one
 * structure seen twice, and giving them different hues would say the opposite — which is also
 * what makes this readable at a glance on a whole brain: the picture goes symmetric.
 *
 * Hue comes from the hash times the golden angle, which spreads consecutive hashes across the
 * wheel instead of clustering them — a plain `hash % 360` leaves neighbouring names looking
 * alike often enough to notice. Saturation and lightness are fixed per mode so every region
 * clears its surface; only the hue varies, which is the one channel there is room to vary.
 */
export function regionColor(roi: string, mode: Mode): string {
  const hue = (hashName(homologyKey(roi)) * 137.508) % 360
  return mode === 'dark' ? hslToHex(hue, 0.58, 0.62) : hslToHex(hue, 0.62, 0.42)
}

/** FNV-1a, so a region keeps its colour across reloads, datasets and filters. */
function hashName(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * HSL to `#rrggbb`.
 *
 * Hex rather than an `hsl()` string because every colour in this app's drawings is a literal the
 * SVG export can carry off unchanged — that is the whole reason vector export is nearly free
 * here, and a colour arriving in a different notation is the sort of thing that works until
 * somebody opens the file somewhere else.
 */
function hslToHex(hue: number, saturation: number, lightness: number): string {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation
  const h = ((hue % 360) + 360) % 360
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = lightness - c / 2
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  const byte = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v + m) * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}
