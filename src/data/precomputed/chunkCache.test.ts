/**
 * The chunk cache: what it keeps, what it drops, and the two cases that would make it a leak.
 *
 * Everything here is about the bound. A cache that holds the right bytes and never lets go is
 * the failure mode that matters — it is sized in hundreds of megabytes, held outside the
 * JavaScript heap where nothing refuses it, and the symptom is a tab that dies rather than one
 * that answers wrongly.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_CHUNK_BUDGET, chunkCache } from './chunkCache'

const MB = 1024 * 1024
const bytes = (mb: number) => new ArrayBuffer(mb * MB)

describe('the chunk cache', () => {
  it('hands back what it was given, by key', () => {
    const cache = chunkCache(10 * MB)
    const buffer = bytes(1)
    cache.set('a', buffer)
    expect(cache.get('a')).toBe(buffer)
    expect(cache.get('b')).toBeUndefined()
  })

  it('counts what it was asked for and what it had', () => {
    const cache = chunkCache(10 * MB)
    cache.set('a', bytes(1))
    cache.get('a')
    cache.get('b')
    expect([cache.asked, cache.hits]).toEqual([2, 1])
  })

  /** The whole point of a budget: a run that walks a volume must not grow without end. */
  it('drops the oldest once the budget is full', () => {
    const cache = chunkCache(3 * MB)
    for (const name of ['a', 'b', 'c', 'd']) cache.set(name, bytes(1))
    expect(cache.bytes).toBe(3 * MB)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('d')).toBeDefined()
  })

  /**
   * **Least recently used, not first in.** A run reads one end's search box, then its patch box
   * over the same chunks, then moves a micrometre and reads them again — so the chunk that has
   * been in longest is usually the one most worth keeping. Insertion order alone would evict
   * exactly the working set.
   */
  it('keeps what was read most recently, not what arrived most recently', () => {
    const cache = chunkCache(3 * MB)
    for (const name of ['a', 'b', 'c']) cache.set(name, bytes(1))
    // `a` is the oldest by arrival; reading it makes it the newest by use.
    expect(cache.get('a')).toBeDefined()
    cache.set('d', bytes(1))
    expect(cache.get('a')).toBeDefined()
    expect(cache.get('b')).toBeUndefined()
  })

  /**
   * A chunk larger than the whole budget would evict everything to store something the next
   * `set` evicts again — a cache that holds nothing and costs a copy of every chunk that passes
   * through it.
   */
  it('refuses a chunk bigger than the budget rather than emptying itself for it', () => {
    const cache = chunkCache(2 * MB)
    cache.set('small', bytes(1))
    cache.set('huge', bytes(5))
    expect(cache.get('huge')).toBeUndefined()
    expect(cache.get('small')).toBeDefined()
  })

  /** Zero is a real setting — `Chunk cache` offers it — and it must hold nothing, not crash. */
  it('holds nothing at a budget of zero', () => {
    const cache = chunkCache(0)
    cache.set('a', bytes(1))
    expect(cache.get('a')).toBeUndefined()
    expect(cache.bytes).toBe(0)
  })

  /** Re-setting a url it already holds must not count its bytes twice. */
  it('does not double-count a key it already has', () => {
    const cache = chunkCache(10 * MB)
    cache.set('a', bytes(1))
    cache.set('a', bytes(1))
    expect(cache.bytes).toBe(1 * MB)
  })

  /**
   * The policy a reader that can see ahead should use. LRU is a guess about the future; this
   * caller knows it, so the right victim is whatever is wanted furthest away — which also makes
   * "nothing will ask for this again" the first thing dropped, with no second mechanism.
   */
  describe('told when each chunk is next wanted', () => {
    /** `d` is the chunk being read now; `a` soon, `b` later, `c` never again. */
    const when: Record<string, number> = { d: 0, a: 1, b: 9, c: Infinity }
    const planned = (mb: number) => chunkCache(mb * MB, (key) => when[key] ?? Infinity)

    it('drops what is wanted furthest away, not what was read longest ago', () => {
      const cache = planned(3)
      for (const name of ['a', 'b', 'c']) cache.set(name, bytes(1))
      cache.set('d', bytes(1))
      // `c` goes though it arrived first of the three; `a` stays though it did too.
      expect(cache.get('c')).toBeUndefined()
      expect(cache.get('a')).toBeDefined()
      expect(cache.get('b')).toBeDefined()
    })

    it('drops the furthest of two that are both still wanted', () => {
      const cache = planned(2)
      cache.set('a', bytes(1))
      cache.set('b', bytes(1))
      cache.set('d', bytes(1))
      expect(cache.get('b')).toBeUndefined()
      expect(cache.get('a')).toBeDefined()
    })

    /**
     * **The chunk just stored is a candidate like any other.** One the plan says nothing will
     * want again is the one that goes, immediately — which is right rather than wasteful: the
     * read that fetched it has already pasted it, and keeping it would cost a chunk that has a
     * next use.
     */
    it('does not keep a chunk it was just given if nothing will want it again', () => {
      const cache = planned(2)
      cache.set('a', bytes(1))
      cache.set('b', bytes(1))
      cache.set('c', bytes(1))
      expect(cache.get('c')).toBeUndefined()
      expect(cache.bytes).toBe(2 * MB)
    })

    /**
     * **Where the plan knows nothing, this line *is* the policy.** A plan not yet armed answers
     * `Infinity` for every key — which is what `openSearchVolume` hands over before the first
     * `planEnds` — so every held chunk ties and the tie-break alone decides what goes. Picking
     * the newest there is MRU: on a walk along a neuron it drops exactly the chunk the next box
     * is about to want.
     *
     * The test below it uses a single unknown key and so cannot see this; it takes two.
     */
    it('drops the one read longest ago when the plan knows none of them', () => {
      const cache = planned(2)
      cache.set('unknown-first', bytes(1))
      cache.set('unknown-second', bytes(1))
      cache.set('unknown-third', bytes(1))
      expect(cache.get('unknown-first')).toBeUndefined()
      expect(cache.get('unknown-second')).toBeDefined()
      expect(cache.get('unknown-third')).toBeDefined()
    })

    /**
     * A plan that has drifted from the reader — a key it has never heard of — must degrade to
     * evicting arbitrarily rather than to keeping the wrong thing for ever. `Infinity` is the
     * honest answer for "I do not know", and it sorts first out.
     */
    it('treats a chunk it was told nothing about as never wanted again', () => {
      const cache = planned(3)
      cache.set('a', bytes(1))
      cache.set('unknown', bytes(1))
      cache.set('b', bytes(1))
      cache.set('d', bytes(1))
      expect(cache.get('unknown')).toBeUndefined()
      expect(cache.get('a')).toBeDefined()
      expect(cache.get('d')).toBeDefined()
    })
  })

  it('defaults to a budget stated in bytes, not chunks', () => {
    // 512 MB. Pinned because the help text on `Chunk cache` quotes the figure it implies.
    expect(DEFAULT_CHUNK_BUDGET).toBe(512 * MB)
  })
})
