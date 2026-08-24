/**
 * The session geometry cache.
 *
 * What it has to get right is not "does a Map work" but the three things that make it safe to
 * put under every skeleton and mesh fetch in the app: that it asks for **exactly** the ids it is
 * missing, that a hand-back is the *same* array rather than a copy, and that the key is the
 * caller's to compose — a mesh at two levels of detail is two different meshes and must not be
 * one entry.
 *
 * The measurement that motivated it is in the module header. The end-to-end half of this — a
 * real source asking for one body instead of two — is in `catmaid/catmaid.test.ts`, because a
 * cache that works in isolation and is wired in wrongly is exactly as useless as no cache.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { byteLengthOf, cachedGeometry, geometryCacheStats, resetGeometryCache } from './geometryCache'

interface Body {
  positions: Float32Array
}

const body = (n: number): Body => ({ positions: new Float32Array([n, n, n]) })

/** A fetcher that records every id list it was handed. */
function recorder(bytes = 12) {
  const calls: string[][] = []
  const request = async (ids: string[], extra: Record<string, unknown> = {}) => {
    const { ordered, missing } = await cachedGeometry<Body>({
      ids,
      key: (id) => `t:${id}`,
      bytes: () => bytes,
      fetch: (missing) => {
        calls.push([...missing])
        return Promise.resolve(new Map(missing.map((id) => [id, body(Number(id))])))
      },
      ...extra,
    })
    return { map: new Map(ordered), ordered, missing }
  }
  return { calls, request }
}

beforeEach(resetGeometryCache)

describe('what it asks for', () => {
  it('fetches everything the first time', async () => {
    const { calls, request } = recorder()
    const out = await request(['1', '2', '3'])
    expect(calls).toEqual([['1', '2', '3']])
    expect(out.ordered.map(([id]) => id)).toEqual(['1', '2', '3'])
  })

  it('asks only for the ids it does not hold', async () => {
    /*
     * The whole point, and the shape of the reported problem: a morphology node re-runs on any
     * change to its Neurons input and asks for the entire list, so twelve of the twenty-one it
     * wants have just been downloaded.
     */
    const { calls, request } = recorder()
    await request(['1', '2', '3'])
    const out = await request(['1', '2', '3', '4', '5'])
    expect(calls[1]).toEqual(['4', '5'])
    expect(out.ordered).toHaveLength(5)
  })

  it('does not call the fetcher at all when it holds everything', async () => {
    // Not "calls it with an empty list": an empty round trip is still a round trip, and a source
    // handed no ids may still do a batch request for the set.
    const { calls, request } = recorder()
    await request(['1', '2'])
    await request(['2', '1'])
    expect(calls).toHaveLength(1)
  })

  it('collapses a repeated id rather than fetching it twice', async () => {
    const { calls, request } = recorder()
    await request(['1', '1', '2'])
    expect(calls[0]).toEqual(['1', '2'])
  })

  it('leaves an id the source cannot answer for absent, and asks again next time', async () => {
    /*
     * A body the bucket has no mesh for must not be remembered as "fetched and empty", or a
     * transient failure becomes permanent for the session. Absent from the map is what every
     * caller already handles — it is how a missing body has always been reported.
     */
    const calls: string[][] = []
    const ask = (ids: string[]) =>
      cachedGeometry<Body>({
        ids,
        key: (id) => `t:${id}`,
        bytes: () => 12,
        fetch: (missing) => {
          calls.push([...missing])
          return Promise.resolve(new Map(missing.filter((id) => id !== '2').map((id) => [id, body(1)])))
        },
      })
    const first = await ask(['1', '2'])
    expect(first.missing).toEqual(['2'])
    await ask(['1', '2'])
    expect(calls[1]).toEqual(['2'])
  })
})

describe('what it hands back', () => {
  it('returns the same array, not a copy', async () => {
    /*
     * Load-bearing, in both directions. It is what makes holding the geometry nearly free — the
     * scheduler's result cache already references these arrays — and it is what would corrupt
     * every later reader if a consumer wrote through one. The transform nodes copy
     * (`transformOps.ts` builds a `new Float32Array`), and that is a property this depends on.
     */
    const { request } = recorder()
    const first = await request(['1'])
    const second = await request(['1'])
    expect(second.map.get('1')!.positions).toBe(first.map.get('1')!.positions)
  })

  it('keeps two levels of detail apart, because the key is the caller’s', async () => {
    // `chooseLod` weighs the whole batch, so the same body is legitimately two different meshes.
    // A key of the bare id would serve the coarse one to a caller that asked for the fine one.
    const calls: string[][] = []
    const ask = async (ids: string[], lod: number) => {
      const { ordered } = await cachedGeometry<Body>({
        ids,
        key: (id) => `m:lod${lod}:${id}`,
        bytes: () => 12,
        fetch: (missing) => {
          calls.push([...missing])
          return Promise.resolve(new Map(missing.map((id) => [id, body(lod)])))
        },
      })
      return new Map(ordered)
    }
    await ask(['1'], 2)
    const fine = await ask(['1'], 0)
    expect(calls).toEqual([['1'], ['1']])
    expect(fine.get('1')!.positions[0]).toBe(0)
  })
})

describe('Clear Cache', () => {
  it('re-reads the ids it was asked about, and only those', async () => {
    const { calls, request } = recorder()
    await request(['1', '2', '3'])
    await request(['2'], { refresh: true })
    expect(calls[1]).toEqual(['2'])
    // 1 and 3 are untouched: Clear Cache on a node means *this* node's data, not everything the
    // session has ever downloaded.
    await request(['1', '3'])
    expect(calls).toHaveLength(2)
  })

  it('does not leave the old bytes counted against the budget', async () => {
    const { request } = recorder(1000)
    await request(['1'])
    await request(['1'], { refresh: true })
    expect(geometryCacheStats()).toEqual({ entries: 1, bytes: 1000 })
  })
})

describe('the age it reports', () => {
  it('says now for a fresh read', async () => {
    const before = Date.now()
    const onFetched = vi.fn()
    const { request } = recorder()
    await request(['1'], { onFetched })
    expect(onFetched).toHaveBeenCalledTimes(1)
    expect(onFetched.mock.calls[0]![0]).toBeGreaterThanOrEqual(before)
  })

  it('says when a hit was stored, not when it was read', async () => {
    // The distinction the card's `cached 12m ago ⟳` badge is made of. Reporting the read time
    // would make every held copy look freshly downloaded, which is the failure `dataCache`'s
    // note calls "a control that looks like it worked".
    vi.useFakeTimers()
    try {
      const { request } = recorder()
      await request(['1'])
      const stored = Date.now()
      vi.advanceTimersByTime(60_000)
      const onFetched = vi.fn()
      await request(['1'], { onFetched })
      expect(onFetched).toHaveBeenCalledWith(stored)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the oldest of a mixed batch', async () => {
    vi.useFakeTimers()
    try {
      const { request } = recorder()
      await request(['1'])
      const stored = Date.now()
      vi.advanceTimersByTime(60_000)
      const onFetched = vi.fn()
      await request(['1', '2'], { onFetched })
      // The stalest thing behind the answer, which is what a reader deciding whether to re-read
      // needs — and what the scheduler keeps anyway.
      expect(onFetched).toHaveBeenCalledWith(stored)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the budget', () => {
  it('counts real bytes rather than entries', async () => {
    const { request } = recorder(4096)
    await request(['1', '2'])
    expect(geometryCacheStats()).toEqual({ entries: 2, bytes: 8192 })
  })

  it('evicts the least recently used once it is over', async () => {
    /*
     * Entries here differ in size by four orders of magnitude — a 264-byte coarse mesh against a
     * megabyte of densely traced CATMAID skeleton — which is why the budget is bytes and not a
     * count. Three 100 MB bodies do not fit in 256 MB, so the oldest goes.
     */
    const huge = 100 * 1024 * 1024
    const { calls, request } = recorder(huge)
    await request(['1'])
    await request(['2'])
    await request(['1']) // a read, which makes 1 the *young* one
    await request(['3'])
    expect(geometryCacheStats().entries).toBe(2)

    await request(['2'])
    // 2 was evicted and had to be fetched again; 1 and 3 survived.
    expect(calls.map((c) => c.join())).toEqual(['1', '2', '3', '2'])
  })
})

describe('byteLengthOf', () => {
  it('adds up the arrays a geometry actually holds, skipping the absent ones', () => {
    expect(byteLengthOf(new Float32Array(3), new Uint32Array(2), undefined)).toBe(12 + 8)
  })
})
