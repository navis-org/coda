/**
 * The `Warn above` control, in one place.
 *
 * Six nodes carry it — three morphology fetches, both NBLASTs and Neuroglancer — and until the
 * guard rails became warnings they at least differed in their defaults (500, 25, 100, 100, 100,
 * 500), each picked at a different time for a different reason. Converging them on one
 * threshold converged everything else too, leaving six copies of a block whose only real
 * variation is a floor and a sentence. That is the moment to factor: the alternative is that
 * the next edit to "A threshold, not a cap" is six edits, and a seventh node copies whichever
 * of the six it happens to land beside.
 *
 * The shared half is the part that carries the policy — `Warn above` as the label, the
 * threshold as its own maximum, `advanced` because nobody sets it on the way past — and the
 * per-node half is `cost`, which is the whole point of a warning and cannot be shared.
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
   * What is being counted and what it costs past the threshold, as one sentence.
   *
   * Appended to the shared "a threshold, not a cap" clause rather than replacing it, so every
   * one of the six says the load-bearing half in the same words — `core/limits.ts` records why
   * that clause has to survive being copied.
   */
  cost: string
}

export function warnAboveParam(options: WarnAboveOptions): ParamDef {
  return {
    id: 'limit',
    kind: 'int',
    label: 'Warn above',
    help: `Say so before going past this many. A threshold, not a cap: ${options.cost}`,
    default: options.threshold,
    min: options.min,
    max: options.threshold,
    step: 10,
    advanced: true,
  }
}
