/** Expressions more than one R emitter needs. */

import type { EmitContext } from '../types'

/**
 * The neuron ids a Neurons input stands for.
 *
 * `$neuronId` rather than `[["neuronId"]]`: neuprintr returns data frames with a `bodyid`
 * column, so the *column name Coda uses* is the one to write — and `coda_neurons()` is what
 * guarantees it is there. A partial-match `$` cannot resolve `neuronId` to `bodyid`, unlike the
 * `bodyId`/`bodyid` pair this used to face, but the rule is the same and this is still one
 * expression in one place rather than written out per emitter.
 */
export function neuronIds(frame: string): string {
  return `${frame}$neuronId`
}

/** A viewer's `ids` selection param, as numbers. */
export function selectionIds(ctx: EmitContext, paramId = 'selection'): number[] {
  const raw = ctx.params[paramId]
  return Array.isArray(raw) ? raw.map(Number) : []
}
