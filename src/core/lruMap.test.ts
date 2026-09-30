import { describe, expect, it } from 'vitest'

import { LruMap, PinnedLru } from './lruMap'

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

describe('PinnedLru', () => {
  // Release on collection is `FinalizationRegistry`'s, which no test can make run on demand.
  it('keeps what a live owner pins past the recency bound, and sweeps what nothing holds', () => {
    const lru = new PinnedLru<number>(2)
    const owner = {}
    lru.set('held', 1)
    lru.pin(owner, 'held')
    lru.set('b', 2)
    lru.set('c', 3)
    lru.set('d', 4)
    expect(lru.get('held')).toBe(1)
    expect(lru.get('b')).toBeUndefined()
  })

  it('takes no recency slot for what it pins, and forgets pins on clear', () => {
    const lru = new PinnedLru<number>(2)
    lru.set('held', 1)
    lru.pin({}, 'held')
    lru.set('b', 2)
    lru.set('c', 3)
    lru.get('held')
    // Two unpinned entries fit beside the pinned one, however often it is read.
    expect([lru.get('b'), lru.get('c')]).toEqual([2, 3])
    lru.clear()
    expect(lru.get('held')).toBeUndefined()
  })

  it('counts a read as a use', () => {
    const lru = new PinnedLru<number>(2)
    lru.set('a', 1)
    lru.set('b', 2)
    lru.get('a')
    lru.set('c', 3)
    expect(lru.get('a')).toBe(1)
    expect(lru.get('b')).toBeUndefined()
  })
})
