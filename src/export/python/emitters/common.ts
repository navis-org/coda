/**
 * Expressions more than one emitter needs.
 *
 * Small, but each of these was written out three or four times before it lived here — and a
 * second copy of "how do I get the body ids out of a frame" is how two cells end up disagreeing
 * about which column that is.
 */

import type { EmitContext } from '../types'

/**
 * The neuron ids a Neurons input stands for.
 *
 * Coda passes a whole collection between nodes and pulls `bodyId` out at the seam
 * (`idColumn`), so the Python has to do the same — a DataFrame is not a criteria object, and
 * handing one to `NeuronCriteria` fails at a point far from the cause.
 */
export function bodyIds(frame: string): string {
  return `${frame}['bodyId'].tolist()`
}

/**
 * A viewer's `ids` selection param, as numbers.
 *
 * `kind: 'ids'` params are written by widgets and live in the saved file, so the value is
 * whatever was last stored — an array normally, and absent on a graph saved before the param
 * existed.
 */
export function selectionIds(ctx: EmitContext, paramId = 'selection'): number[] {
  const raw = ctx.params[paramId]
  return Array.isArray(raw) ? raw.map(Number) : []
}
