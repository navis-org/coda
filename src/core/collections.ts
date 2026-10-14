/**
 * Small helpers over collections: ones the platform does not have yet at this build's target, and
 * the distinct or counted strings of a column, which several VFB nodes and viewers read.
 */

/**
 * Items grouped by a key, each group in input order and the groups in the order their first item
 * appears. `Map.groupBy` is ES2024 and the app targets ES2022.
 */
export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = groups.get(k)
    if (list) list.push(item)
    else groups.set(k, [item])
  }
  return groups
}

/** A column's distinct non-empty strings, in the order they first appear. */
export function distinctStrings(column: Iterable<unknown>): string[] {
  return [...countStrings(column).keys()]
}

/** How many rows carry each non-empty string, keyed in the order the strings first appear. */
export function countStrings(column: Iterable<unknown>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const cell of column) {
    if (typeof cell === 'string' && cell) counts.set(cell, (counts.get(cell) ?? 0) + 1)
  }
  return counts
}
