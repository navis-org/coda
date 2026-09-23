/**
 * The rules the two browser shelves share — the workflow library (`library.ts`) and the recipe
 * shelf (`recipes.ts`) — so neither reaches into the other for them.
 *
 * Identity and order only. The storage policy (writes reject, reads resolve) is stated in
 * `library.ts`' header and followed by both; the plumbing is `data/idb.ts`'.
 */

/**
 * Normalised form of a name, for deciding whether two saves mean the same document.
 *
 * Case- and whitespace-insensitive: "LC4 sweep" and "lc4  sweep" as two separate entries is a
 * shelf nobody can keep tidy, and the typed form is kept for display either way.
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The entry a save under this name would overwrite, if any. */
export function findByName<T extends { name: string }>(
  list: readonly T[],
  name: string,
): T | undefined {
  const key = normalizeName(name)
  return list.find((entry) => normalizeName(entry.name) === key)
}

/**
 * Newest first, ties broken on name so the order is stable — two entries saved in the same
 * millisecond is a test, not a user, but a list that reshuffles between renders is a bug either way.
 */
export function newestFirst<T extends { savedAt: number; name: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.savedAt - a.savedAt || a.name.localeCompare(b.name))
}

/**
 * `name`, or the first of `name (2)`, `name (3)`… that no entry already has — for an arrival that
 * is not a save somebody confirmed (an imported file), where taking a name on the shelf would
 * replace an entry nobody asked to lose.
 */
export function freeName(list: readonly { name: string }[], name: string): string {
  if (!findByName(list, name)) return name
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`
    if (!findByName(list, candidate)) return candidate
  }
}
