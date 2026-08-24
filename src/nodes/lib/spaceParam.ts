/**
 * The `Space` override, shared by the two nodes that transform geometry.
 *
 * Both `Mirror Neurons` and `Transform Neurons` face the same question — *which template space
 * are these coordinates in?* — and both answer it the same way: read it off the value, and let
 * a param fill in where the value says nothing. Extracted here when the second one arrived,
 * because the rule below is subtle enough that two copies would eventually be two rules.
 */

/** Empty means "read it off the geometry", which is the normal case. */
export const FROM_DATA = { value: '', label: 'From the data' }

/**
 * Which space to work in: whatever the value carries, or the override where it carries none.
 *
 * **That order is the point, and the obvious alternative is a trap.** If the override won, a
 * param set once and forgotten would silently relocate a later graph's neurons: rewire the
 * input to a different dataset and the node keeps transforming as though nothing changed, with
 * a green card and a plausible result several hundred micrometres from the truth. So an
 * override can only ever *fill a gap*, never contradict — the two agree, one fills for the
 * other, or it is a conflict and the caller refuses.
 *
 * The gap it fills is real rather than hypothetical: a Custom dataset node points at a
 * deployment Coda ships no binding for, so its geometry arrives with no space at all, and
 * naming one here is the only way through. That is a claim the user is making, which is why
 * it is a visible setting rather than a guess.
 */
export function resolveSpace(
  override: string,
  carried: string | undefined,
): { space?: string; conflict?: [carried: string, override: string] } {
  if (carried && override && carried !== override) return { conflict: [carried, override] }
  return { space: carried || override || undefined }
}
