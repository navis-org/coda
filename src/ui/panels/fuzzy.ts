/**
 * Subsequence fuzzy matching, fzf-style but small.
 *
 * "gb" should find "Group By" and "cr" should find "Clear Results", so scoring rewards
 * matches at word boundaries and runs of adjacent characters. Without those bonuses a
 * plain subsequence test ranks incidental mid-word hits alongside acronym hits, which
 * makes the first result feel arbitrary — and in a palette the first result is the one
 * that gets picked.
 */

export interface FuzzyResult {
  score: number
  /** Indices in the haystack that matched, for highlighting. */
  matches: number[]
}

const BONUS_BOUNDARY = 14
const BONUS_CAMEL = 10
const BONUS_CONSECUTIVE = 8
const PENALTY_GAP = 1
const BONUS_FULL_PREFIX = 12

function isBoundary(previous: string | undefined): boolean {
  if (previous === undefined) return true
  return (
    previous === ' ' ||
    previous === '.' ||
    previous === '-' ||
    previous === '_' ||
    previous === '/'
  )
}

/**
 * Score `query` against `haystack`. Returns undefined when the query is not a
 * subsequence. Case-insensitive; an exact-case hit is not rewarded (users type lowercase).
 *
 * A single greedy left-to-right scan is not enough. For "res" against "Clear Results",
 * greedy takes the `r` in "Clea**r**" and then has to skip forward, scoring worse than an
 * unrelated item whose *description* happens to start with "Rescale". So every occurrence
 * of the first character is tried as a start and the best-scoring alignment wins — which
 * naturally lands on word boundaries, because that is where the bonuses are.
 *
 * This is not a full optimal alignment (real fzf does a backward DP pass), but it fixes
 * the failure mode that actually matters for a palette: the first result feeling arbitrary.
 */
export function fuzzyMatch(query: string, haystack: string): FuzzyResult | undefined {
  if (query.length === 0) return { score: 0, matches: [] }
  if (query.length > haystack.length) return undefined

  const needle = query.toLowerCase()
  const hay = haystack.toLowerCase()
  const first = needle[0]!

  let best: FuzzyResult | undefined
  for (let start = 0; start < hay.length; start++) {
    if (hay[start] !== first) continue
    const candidate = alignFrom(needle, hay, haystack, start)
    if (candidate && (!best || candidate.score > best.score)) best = candidate
  }
  if (!best) return undefined

  let score = best.score
  if (hay.startsWith(needle)) score += BONUS_FULL_PREFIX
  // Shorter haystacks win ties: "Sort" should beat "Select Columns" for "s".
  score -= haystack.length * 0.08
  return { score, matches: best.matches }
}

/** Greedy subsequence scan anchored at `start`. Undefined if it cannot complete. */
function alignFrom(
  needle: string,
  hay: string,
  haystack: string,
  start: number,
): FuzzyResult | undefined {
  const matches: number[] = []
  let score = 0
  let hayIndex = start
  let previousMatch = -2

  for (let n = 0; n < needle.length; n++) {
    const char = needle[n]!
    let found = -1
    for (let h = hayIndex; h < hay.length; h++) {
      if (hay[h] !== char) continue
      found = h
      break
    }
    if (found === -1) return undefined

    if (isBoundary(hay[found - 1])) score += BONUS_BOUNDARY
    // Lowercase followed by uppercase in the original: a camelCase boundary.
    else if (
      haystack[found] === haystack[found]!.toUpperCase() &&
      haystack[found - 1] !== haystack[found - 1]!.toUpperCase()
    ) {
      score += BONUS_CAMEL
    }
    if (found === previousMatch + 1) score += BONUS_CONSECUTIVE
    else if (previousMatch >= 0) score -= (found - previousMatch - 1) * PENALTY_GAP

    matches.push(found)
    previousMatch = found
    hayIndex = found + 1
  }

  return { score, matches }
}

export interface Scored<T> {
  item: T
  score: number
  matches: number[]
}

/**
 * Rank items by the best match across their searchable fields. The primary field (index 0)
 * gets a bonus so a title hit outranks a description hit.
 */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  fields: (item: T) => string[],
): Scored<T>[] {
  const trimmed = query.trim()
  const out: Scored<T>[] = []

  for (const item of items) {
    const candidates = fields(item)
    if (trimmed === '') {
      out.push({ item, score: 0, matches: [] })
      continue
    }
    let best: FuzzyResult | undefined
    let bestIndex = 0
    candidates.forEach((field, index) => {
      const result = fuzzyMatch(trimmed, field)
      if (!result) return
      const adjusted = { ...result, score: result.score + (index === 0 ? 20 : 0) }
      if (!best || adjusted.score > best.score) {
        best = adjusted
        bestIndex = index
      }
    })
    if (best) {
      out.push({ item, score: best.score, matches: bestIndex === 0 ? best.matches : [] })
    }
  }

  // Stable within equal scores: the caller's order is meaningful (categories, frequency).
  return out
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.score - a.entry.score || a.index - b.index)
    .map(({ entry }) => entry)
}
