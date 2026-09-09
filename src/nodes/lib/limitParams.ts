/**
 * The `Warn above` control, in one place.
 *
 * Six nodes carry it — three morphology fetches, both NBLASTs and Neuroglancer — and until the
 * guard rails became warnings they at least differed in their defaults (500, 25, 100, 100, 100,
 * 500), each picked at a different time for a different reason. Converging them on one
 * threshold converged everything else too, leaving six copies of a block whose only real
 * variation is a floor and a sentence. That is the moment to factor: the alternative is that
 * the next edit to "Nothing is capped" is six edits, and a seventh node copies whichever
 * of the six it happens to land beside.
 *
 * The shared half is the part that carries the policy — `Warn above` as the label, the
 * threshold as its own maximum, `advanced` because nobody sets it on the way past — and the
 * per-node half is `counting`, which names what the threshold is over and cannot be shared.
 *
 * Follows `encodingParams.ts`'s `colorParams`, which is the same shape of thing for the same
 * reason.
 */

import type { ParamDef } from '../../core/node'

export interface WarnAboveOptions {
  /** The threshold, which is also the control's maximum: `MAX_NEURONS`, `SEGMENTS_WARN`. */
  threshold: number
  /** Smallest sensible value. 1 for a fetch; 2 for a comparison, which needs two sides. */
  min: number
  /**
   * What is being counted, as a clause completing "Show a warning before …".
   *
   * The per-node half of one sentence: the shared half says a warning is all that happens, and
   * `core/limits.ts` records why that has to survive being copied. Kept a clause rather than a
   * sentence so every one of the six reads the same way.
   */
  counting: string
}

export function warnAboveParam(options: WarnAboveOptions): ParamDef {
  return {
    id: 'limit',
    kind: 'int',
    label: 'Warn above',
    help: `Show a warning before ${options.counting}. Nothing is capped.`,
    default: options.threshold,
    min: options.min,
    max: options.threshold,
    step: 10,
    advanced: true,
  }
}
