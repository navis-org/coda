/**
 * Lists written as a sentence reads them. Headless, since the wizard's graph names, both exporters'
 * messages and the UI's notes all say "a, b and c" — four copies of this had grown before it was
 * one.
 */

/** How many names a note lists before it stops. */
const NAMED_IN_NOTE = 5

/** A few names, then an ellipsis: `a, b, c, d, e, …`. */
export function namedFew(names: readonly string[]): string {
  const named = names.slice(0, NAMED_IN_NOTE).join(', ')
  return names.length > NAMED_IN_NOTE ? `${named}, …` : named
}

/** `a`, `a and b`, `a, b and c`. No Oxford comma, which is what `Intl.ListFormat('en')` adds. */
export function listed(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
