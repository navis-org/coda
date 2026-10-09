/**
 * Finding points on a scatter by name — BigClust's search, in the Scatter Plot's strip.
 *
 * One term, four choices: which text is searched (the point's label and id, or one picked
 * column), and whether the term is matched exactly, with case, or as a regular expression. The
 * grammar is Coda's, not a third one: a **leading `/` opts into a pattern** as in the Heatmap's
 * filters and Explore's box (`bareRegex`), and the regex switch makes the whole term one without
 * the slashes; a pattern that will not compile is said, never thrown (`regexError`). Exact anchors
 * a pattern (`anchoredPattern`) and means equality for plain text.
 *
 * Pure over strings handed in, so jsdom tests it.
 */

import { anchoredPattern } from '../../data/terms'
import { bareRegex, regexError } from '../../nodes/lib/neuronSearch'

export interface SearchOptions {
  exact: boolean
  caseSensitive: boolean
  regex: boolean
}

export const DEFAULT_SEARCH: SearchOptions = {
  exact: false,
  caseSensitive: false,
  regex: false,
}

export type SearchMatcher = { test: (text: string) => boolean } | { error: string }

/** The term as a test, an error to show, or undefined while the box is empty. */
export function searchMatcher(term: string, options: SearchOptions): SearchMatcher | undefined {
  const source = term.trim()
  if (!source) return undefined
  const pattern = options.regex ? source : bareRegex(source)
  if (pattern !== undefined) {
    const anchored = options.exact ? anchoredPattern(pattern) : pattern
    const error = regexError(anchored)
    if (error) return { error }
    const expression = new RegExp(anchored, options.caseSensitive ? '' : 'i')
    return { test: (text) => expression.test(text) }
  }
  // `/` alone is what the box holds while a pattern is being typed: it matches nothing yet.
  if (source === '/') return { test: () => false }
  const needle = options.caseSensitive ? source : source.toLowerCase()
  const fold = (text: string) => (options.caseSensitive ? text : text.toLowerCase())
  return options.exact
    ? { test: (text) => fold(text) === needle }
    : { test: (text) => fold(text).includes(needle) }
}

/**
 * The positions whose text matches, in order. `textsOf` gives the strings a position is known by —
 * a label and an id, say — and one matching is enough.
 */
export function searchHits(
  count: number,
  textsOf: (position: number) => readonly string[],
  matcher: SearchMatcher | undefined,
): number[] {
  if (!matcher || 'error' in matcher) return []
  const hits: number[] = []
  for (let i = 0; i < count; i++) if (textsOf(i).some(matcher.test)) hits.push(i)
  return hits
}
