import { describe, expect, it } from 'vitest'

import { LruMap } from './lruMap'

describe('LruMap', () => {
  it('drops the entry used longest ago once it passes its cap', () => {
    const lru = new LruMap<string, number>(2)
    lru.set('a', 1).set('b', 2).set('c', 3)
    expect(lru.get('a')).toBeUndefined()
    expect(lru.get('b')).toBe(2)
    expect(lru.size).toBe(2)
  })

  it('counts a set as a use and a get as none', () => {
    const read = new LruMap<string, number>(2)
    read.set('a', 1).set('b', 2)
    read.get('a')
    read.set('c', 3)
    expect(read.get('a')).toBeUndefined()

    const written = new LruMap<string, number>(2)
    written.set('a', 1).set('b', 2).set('a', 1).set('c', 3)
    expect(written.get('a')).toBe(1)
    expect(written.get('b')).toBeUndefined()
  })

  it('makes room before a set rather than after, and only when full', () => {
    const lru = new LruMap<string, number>(2)
    lru.set('a', 1)
    lru.makeRoom()
    expect(lru.size).toBe(1)

    lru.set('b', 2)
    lru.makeRoom()
    // The oldest is gone before anything new exists, so the peak never passes the cap.
    expect(lru.get('a')).toBeUndefined()
    expect(lru.size).toBe(1)
    lru.set('c', 3)
    expect(lru.get('b')).toBe(2)
    expect(lru.size).toBe(2)
  })
})
