/** Expressions more than one R emitter needs. */

import type { EmitContext } from '../types'

/**
 * The neuron ids a Neurons input stands for.
 *
 * `$bodyId` rather than `[["bodyId"]]`: neuprintr returns data frames with a `bodyid` column
 * in some places and `bodyId` in others, so the *column name Coda uses* is the one to write,
 * and a partial-match `$` would quietly resolve `bodyId` to `bodyid` — which is why this is one
 * expression in one place rather than written out per emitter.
 */
export function bodyIds(frame: string): string {
  return `${frame}$bodyId`
}

/** A viewer's `ids` selection param, as numbers. */
export function selectionIds(ctx: EmitContext, paramId = 'selection'): number[] {
  const raw = ctx.params[paramId]
  return Array.isArray(raw) ? raw.map(Number) : []
}
