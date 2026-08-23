/**
 * How a set of column renames is written down.
 *
 * Split from `tableOps.ts`, which holds what a rename *does*: `renamePlan` and its
 * schema/value pair work on an already-decoded list, and this is the storage the node and its
 * card share. The same split, and the same reason, as `tableFilter.ts` beside `out.table` — the
 * widget writing the param and the `evaluate` reading it have to agree on the encoding exactly,
 * and a second decoder in the UI is how a row somebody typed stops surviving a reload.
 *
 * The encoding itself is `paramPairs.ts`, shared with those filter clauses. What is here is the
 * named struct and the one rule that genuinely differs: which rows are worth storing.
 */

import { decodePairs, encodePair } from './paramPairs'

/** One remapping: the column as it arrives, and what it should be called. */
export interface Rename {
  from: string
  to: string
}

/**
 * Read a stored `renames` param. Anything unreadable is dropped rather than throwing.
 *
 * A **half-filled row is kept**, unlike a cleared filter cell, and that is the difference
 * between a control a viewer writes and one somebody types into. A row with a column picked and
 * no new name yet is a row mid-edit: dropping it here would delete it from under the cursor the
 * moment the param round-trips. `resolveRenames` ignores an empty target, so an unfinished row
 * renames nothing meanwhile, and `validate` is what says so out loud.
 *
 * Both halves empty is an abandoned row rather than an unfinished one — nothing can act on it
 * and nothing is lost by letting it go, which is also what lets `+ Add` draw a row the store
 * never sees.
 */
export function decodeRenames(raw: unknown): Rename[] {
  return decodePairs(raw)
    .filter(([from, to]) => from || to)
    .map(([from, to]) => ({ from, to }))
}

export function encodeRenames(renames: readonly Rename[]): string[] {
  return renames.filter((r) => r.from || r.to).map((r) => encodePair(r.from, r.to))
}
