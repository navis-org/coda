/**
 * Expressions more than one emitter needs.
 *
 * Small, but each of these was written out three or four times before it lived here — and a
 * second copy of "how do I get the neuron ids out of a frame" is how two cells end up disagreeing
 * about which column that is.
 */

import type { EmitContext } from '../types'

/**
 * The neuron ids a Neurons input stands for.
 *
 * Coda passes a whole collection between nodes and pulls `neuronId` out at the seam
 * (`idColumn`), so the Python has to do the same — a DataFrame is not a criteria object, and
 * handing one to `NeuronCriteria` fails at a point far from the cause.
 */
export function neuronIds(frame: string): string {
  return `${frame}['neuronId'].tolist()`
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

/**
 * Normalise a frame that has just come back from neuprint-python.
 *
 * The library publishes `bodyId`; every Coda table calls the id column `neuronId`, so an
 * unrenamed frame meets the next generated cell — a Filter, a Group By, anything carrying a
 * column param — addressing a column it does not have.
 *
 * **It declares the helper and emits the call together**, which is the whole point of it being
 * a function. Those are two separate acts at a call site — `ctx.helper('coda_neurons')` in one
 * place and the assignment line in another — and `resolveHelpers` only writes out helpers that
 * were asked for, so a site that emits the call and forgets the declaration produces a notebook
 * referring to a function nothing defines. That is invisible to the golden file, which only
 * looks right because *some other* node in the fixture happened to request it; `neuron.roiCounts`
 * had already lost the pairing that way.
 */
export function codaNeurons(ctx: EmitContext, frame: string): string {
  ctx.helper('coda_neurons')
  return `${frame} = coda_neurons(${frame})`
}
