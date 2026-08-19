import { describe, expect, it } from 'vitest'

import { fuzzyMatch, fuzzyRank } from './fuzzy'

describe('fuzzyMatch', () => {
  it('matches a subsequence and reports the matched indices', () => {
    const result = fuzzyMatch('gb', 'Group By')
    expect(result).toBeDefined()
    expect(result!.matches).toEqual([0, 6])
  })

  it('rejects a non-subsequence', () => {
    expect(fuzzyMatch('bg', 'Group By')).toBeUndefined()
    expect(fuzzyMatch('xyz', 'Group By')).toBeUndefined()
  })

  it('is case-insensitive', () => {
    expect(fuzzyMatch('GROUP', 'Group By')).toBeDefined()
    expect(fuzzyMatch('group', 'GROUP BY')).toBeDefined()
  })

  it('matches an empty query against anything', () => {
    expect(fuzzyMatch('', 'anything')?.score).toBe(0)
  })

  it('scores word-boundary acronyms above mid-word hits', () => {
    // "cr" as the initials of Clear Results should beat an incidental mid-word match.
    const acronym = fuzzyMatch('cr', 'Clear Results')!
    const midWord = fuzzyMatch('cr', 'Microscopy')!
    expect(acronym.score).toBeGreaterThan(midWord.score)
  })

  it('scores consecutive runs above scattered matches', () => {
    const consecutive = fuzzyMatch('sort', 'Sort')!
    const scattered = fuzzyMatch('sort', 'Select Or Trim')!
    expect(consecutive.score).toBeGreaterThan(scattered.score)
  })

  it('prefers shorter haystacks on otherwise equal matches', () => {
    const short = fuzzyMatch('s', 'Sort')!
    const long = fuzzyMatch('s', 'Select Columns From Somewhere')!
    expect(short.score).toBeGreaterThan(long.score)
  })
})

describe('fuzzyRank', () => {
  interface Item {
    label: string
    hint: string
  }
  const items: Item[] = [
    { label: 'Run All', hint: 'Evaluate stale nodes' },
    { label: 'Clear Results', hint: 'Drop cached results' },
    { label: 'Group By', hint: 'Collapse rows into groups' },
    { label: 'Filter', hint: 'Keep rows matching a condition' },
    { label: 'Normalize', hint: 'Rescale matrix values' },
  ]
  const fields = (item: Item) => [item.label, item.hint]

  it('returns everything in original order for an empty query', () => {
    const ranked = fuzzyRank('', items, fields)
    expect(ranked.map((r) => r.item.label)).toEqual(items.map((i) => i.label))
  })

  it('finds a command by its initials', () => {
    expect(fuzzyRank('cr', items, fields)[0]!.item.label).toBe('Clear Results')
    expect(fuzzyRank('gb', items, fields)[0]!.item.label).toBe('Group By')
    expect(fuzzyRank('ra', items, fields)[0]!.item.label).toBe('Run All')
  })

  it('ranks a label hit above a description hit', () => {
    // "rescale" only appears in Normalize's hint; "results" is in Clear Results' label.
    const ranked = fuzzyRank('res', items, fields)
    expect(ranked[0]!.item.label).toBe('Clear Results')
  })

  it('matches against secondary fields but reports no highlight for them', () => {
    const ranked = fuzzyRank('condition', items, fields)
    expect(ranked[0]!.item.label).toBe('Filter')
    // The match was in the hint, so there is nothing to highlight in the label.
    expect(ranked[0]!.matches).toEqual([])
  })

  it('drops non-matching items entirely', () => {
    expect(fuzzyRank('zzzz', items, fields)).toEqual([])
  })

  it('is stable for equally scored items', () => {
    const duplicates = [
      { label: 'Same', hint: 'a' },
      { label: 'Same', hint: 'b' },
      { label: 'Same', hint: 'c' },
    ]
    const ranked = fuzzyRank('same', duplicates, fields)
    expect(ranked.map((r) => r.item.hint)).toEqual(['a', 'b', 'c'])
  })
})
