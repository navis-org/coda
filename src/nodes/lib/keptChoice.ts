/**
 * A stored choice the options do not list, kept as an option of its own so the select still shows
 * what the graph says — marked once the list is known, plain while it is not.
 *
 * For a dropdown whose options come from data that may not have arrived yet (a datastack's
 * materializations, a BigClust project's embeddings): without it a reload shows the choice as
 * forgotten for a second, and a list that has since lost the choice shows nothing at all, where
 * `validate` is what should say why.
 */
export function keptChoice(
  chosen: string,
  listed: readonly string[] | undefined,
): { value: string; label: string }[] {
  return chosen && !listed?.includes(chosen)
    ? [{ value: chosen, label: listed ? `${chosen} (not listed)` : chosen }]
    : []
}
