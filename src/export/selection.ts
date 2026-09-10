import type { ParamValues } from '../core/node'

/**
 * A viewer's `ids` selection param, as **exact decimal text** — one reading for both exporters.
 *
 * `kind: 'ids'` params are written by widgets and live in the saved file, so the value is whatever
 * was last stored: an array normally, absent on a graph saved before the param existed. Trimmed
 * and blank-free, which the notebook's copy was and the R one was not until they were one function.
 *
 * It used to answer `number[]` in both languages, which is invariant 8 at a seam nobody had looked
 * at: a stored id is a string of digits, and `Number('720575940628857210')` is `…216` — a
 * different neuron, written into a document with nothing to say so. R makes that worse, since
 * `c(7.2e17)` prints back in scientific notation. The id column every one of these is compared
 * against is text on every source, so the emitters quote the digits (`pySelection`, `rVector`) —
 * and use `decodeIndices` (`nodes/lib/chartSelection.ts`) instead where the param holds leaf
 * positions rather than ids.
 */
export function selectionIds(ctx: { params: ParamValues }): string[] {
  const raw = ctx.params.selection
  return Array.isArray(raw) ? raw.map((id) => String(id).trim()).filter(Boolean) : []
}
