import { describe, expect, it } from 'vitest'

import { ByteLru, LruMap, PinnedLru } from './lruMap'

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

describe('a cache held to a byte budget', () => {
  it('drops what was used longest ago, and a read is a use', () => {
    const cache = new ByteLru<string, number>(200)
    cache.set('a', 1, 100)
    cache.set('b', 2, 100)
    // Read, so `a` is now the newer of the two — the opposite of `LruMap`, where only a write is.
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3, 100)
    expect([cache.has('a'), cache.has('b'), cache.has('c')]).toEqual([true, false, true])
    expect(cache.bytes).toBe(200)
    expect(cache.size).toBe(2)
  })

  it('does not count `has` or `peek` as a use', () => {
    // A caller pricing work it may be about to do must not, by asking, change what is dropped.
    const cache = new ByteLru<string, number>(200)
    cache.set('a', 1, 100)
    cache.set('b', 2, 100)
    cache.has('a')
    expect(cache.peek('a')).toBe(1)
    cache.set('c', 3, 100)
    expect(cache.has('a')).toBe(false)
    expect(cache.peek('a')).toBeUndefined()
  })

  it('drops as many as one write needs room for', () => {
    const cache = new ByteLru<string, number>(300)
    cache.set('a', 1, 100)
    cache.set('b', 2, 100)
    cache.set('c', 3, 100)
    cache.set('big', 4, 250)
    expect([cache.has('a'), cache.has('b'), cache.has('c'), cache.has('big')]).toEqual([
      false,
      false,
      false,
      true,
    ])
    expect(cache.bytes).toBe(250)
  })

  it('does not keep a value larger than the whole budget, nor empty itself for it', () => {
    const cache = new ByteLru<string, number>(200)
    cache.set('a', 1, 100)
    expect(cache.set('huge', 2, 201)).toBe(false)
    expect([cache.has('a'), cache.has('huge')]).toEqual([true, false])
    // And a key that held something no longer holds the old value once a write to it was refused.
    expect(cache.set('a', 9, 201)).toBe(false)
    expect(cache.has('a')).toBe(false)
    expect(cache.bytes).toBe(0)
  })

  it('refuses a weight that is not a size, rather than losing count for good', () => {
    const cache = new ByteLru<string, number>(200)
    cache.set('a', 1, 100)
    expect(cache.set('nan', 2, Number.NaN)).toBe(false)
    expect(cache.set('negative', 3, -50)).toBe(false)
    expect(cache.bytes).toBe(100)
    // Still a working cache: the next write evicts by the budget, not everything.
    cache.set('b', 4, 100)
    expect([cache.has('a'), cache.has('b')]).toEqual([true, true])
  })

  it('keeps its count of bytes through a replace and a delete', () => {
    const cache = new ByteLru<string, number>(1000)
    cache.set('a', 1, 100)
    cache.set('a', 2, 300)
    expect(cache.bytes).toBe(300)
    expect(cache.get('a')).toBe(2)
    expect(cache.delete('a')).toBe(true)
    expect(cache.delete('a')).toBe(false)
    expect(cache.bytes).toBe(0)
  })
})
