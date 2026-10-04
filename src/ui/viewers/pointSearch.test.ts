import { describe, expect, it } from 'vitest'

import type { SearchOptions } from './pointSearch'
import { DEFAULT_SEARCH, searchHits, searchMatcher } from './pointSearch'

const NAMES = ['LC4', 'LC40', 'lc6', 'T4a', 'MBON01']

function find(term: string, options: Partial<SearchOptions> = {}) {
  const matcher = searchMatcher(term, { ...DEFAULT_SEARCH, ...options })
  return searchHits(NAMES.length, (i) => [NAMES[i]!], matcher).map((i) => NAMES[i])
}

describe('finding points by name', () => {
  it('matches a substring, ignoring case, by default', () => {
    expect(find('lc4')).toEqual(['LC4', 'LC40'])
  })

  it('matches the whole value under Exact', () => {
    expect(find('lc4', { exact: true })).toEqual(['LC4'])
  })

  it('keeps case under Case sensitive', () => {
    expect(find('lc', { caseSensitive: true })).toEqual(['lc6'])
  })

  it('reads a leading / as a pattern, as the Heatmap filter and Explore do', () => {
    expect(find('/^LC\\d$/')).toEqual(['LC4', 'lc6'])
  })

  it('reads the whole term as a pattern with the regex switch on, anchored under Exact', () => {
    expect(find('LC\\d+', { regex: true })).toEqual(['LC4', 'LC40', 'lc6'])
    expect(find('LC\\d', { regex: true, exact: true })).toEqual(['LC4', 'lc6'])
  })

  it('says a pattern will not compile rather than throwing, and finds nothing', () => {
    const matcher = searchMatcher('/[', DEFAULT_SEARCH)
    expect(matcher && 'error' in matcher).toBe(true)
    expect(find('/[')).toEqual([])
  })

  it('finds nothing for an empty box or a lone slash', () => {
    expect(searchMatcher('  ', DEFAULT_SEARCH)).toBeUndefined()
    expect(find('/')).toEqual([])
  })

  it('counts a position once when any of its texts matches', () => {
    const texts = [
      ['LC4', '101'],
      ['T4a', '102'],
    ]
    const matcher = searchMatcher('10', DEFAULT_SEARCH)
    expect(searchHits(2, (i) => texts[i]!, matcher)).toEqual([0, 1])
  })
})
