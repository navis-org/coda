/**
 * A column header's sort, and what a click on it does next: ascending → descending → unsorted, so
 * there is always a way back to the order the data actually arrived in. The table viewer's rule,
 * shared with any table that sorts by its headers.
 */

export interface ColumnSort<K extends string = string> {
  readonly column: K
  readonly descending: boolean
}

export function nextSort<K extends string>(
  current: ColumnSort<K> | undefined,
  column: K,
): ColumnSort<K> | undefined {
  if (!current || current.column !== column) return { column, descending: false }
  if (!current.descending) return { column, descending: true }
  return undefined
}

/** A header's `aria-sort` under `sort`. */
export function sortAria(
  sort: ColumnSort | undefined,
  column: string,
): 'ascending' | 'descending' | 'none' {
  if (sort?.column !== column) return 'none'
  return sort.descending ? 'descending' : 'ascending'
}

/** The arrow a sorted header draws, empty on every other. */
export function sortGlyph(sort: ColumnSort | undefined, column: string): string {
  if (sort?.column !== column) return ''
  return sort.descending ? '▾' : '▴'
}
