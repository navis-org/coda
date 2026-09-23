/**
 * The rules both browser shelves share. `normalizeName` and `findByName` are pinned in
 * `library.test.ts`, where they were first written; what is here is what arrived with recipes.
 */

import { describe, expect, it } from 'vitest'

import { freeName, newestFirst } from './shelf'

describe('freeName', () => {
  it('keeps a name nothing has, and numbers one that is taken', () => {
    expect(freeName([], 'Search')).toBe('Search')
    expect(freeName([{ name: 'search' }], 'Search')).toBe('Search (2)')
    expect(freeName([{ name: 'Search' }, { name: 'Search (2)' }], 'Search')).toBe('Search (3)')
  })
})

describe('newestFirst', () => {
  it('orders by save time, then by name so equal times stay put', () => {
    const rows = [
      { name: 'b', savedAt: 1 },
      { name: 'a', savedAt: 1 },
      { name: 'c', savedAt: 2 },
    ]
    expect(newestFirst(rows).map((r) => r.name)).toEqual(['c', 'a', 'b'])
  })
})
