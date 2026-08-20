/**
 * The data layer's persistent cache, and the neuron-index loader on top of it.
 *
 * Runs without IndexedDB — vitest's node environment has none — which is itself half of what is
 * being tested: the whole thing has to degrade to an in-memory map rather than throw, because a
 * browser in private mode does exactly the same and a failure to *remember* a value must never
 * look like a failure to compute it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../core/types'
import type { TableValue } from '../core/values'
import { tableFromRows } from '../core/values'
import { cacheDelete, cacheGet, cacheSet, resetCache } from './cache'
import { loadCachedTable, neuronIndexKey, resetIndexLoads } from './neuronIndex'

const SCHEMA = tableSchema(column('bodyId', 'i64'), column('type', 'str'))

function table(rows: number): TableValue {
  return tableFromRows(
    SCHEMA,
    Array.from({ length: rows }, (_, i) => ({ bodyId: i, type: `T${i}` })),
    'neurons',
  )
}

beforeEach(() => {
  resetCache()
  resetIndexLoads()
})

describe('cache', () => {
  it('round-trips a value', async () => {
    await cacheSet('k', { hello: 'world' })
    expect(await cacheGet('k')).toEqual({ hello: 'world' })
  })

  it('reports a miss as undefined rather than throwing', async () => {
    expect(await cacheGet('absent')).toBeUndefined()
  })

  it('misses when the fingerprint differs', async () => {
    // The fingerprint is the column list, so this is what stops a seven-column table cached
    // before schema discovery from being served against a twenty-column schema.
    await cacheSet('k', 1, 'a,b')
    expect(await cacheGet('k', { fingerprint: 'a,b' })).toBe(1)
    expect(await cacheGet('k', { fingerprint: 'a,b,c' })).toBeUndefined()
  })

  it('misses when the entry is older than the caller allows', async () => {
    vi.useFakeTimers()
    try {
      await cacheSet('k', 1)
      vi.advanceTimersByTime(5000)
      expect(await cacheGet('k', { maxAgeMs: 10_000 })).toBe(1)
      expect(await cacheGet('k', { maxAgeMs: 1000 })).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets a deleted key', async () => {
    await cacheSet('k', 1)
    await cacheDelete('k')
    expect(await cacheGet('k')).toBeUndefined()
  })
})

describe('loadCachedTable', () => {
  it('fetches once and serves the same object afterwards', async () => {
    const value = table(3)
    const fetch = vi.fn(async () => value)
    const spec = { key: 'idx', fingerprint: 'bodyId,type', fetch }

    expect(await loadCachedTable(spec)).toBe(value)
    expect(await loadCachedTable(spec)).toBe(value)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent callers into one download', async () => {
    /*
     * The case this exists for: the Explore widget loads the index itself while the node's
     * evaluate asks for the same thing, and a starter graph can hold more than one Explore.
     * Without this, opening one costs several copies of a 7 MB download.
     */
    let release: (value: TableValue) => void = () => {}
    const pending = new Promise<TableValue>((resolve) => {
      release = resolve
    })
    const fetch = vi.fn(() => pending)
    const spec = { key: 'idx', fingerprint: 'f', fetch }

    const first = loadCachedTable(spec)
    const second = loadCachedTable(spec)
    // Promise identity, not a call count: the fetch starts a microtask later, after the cache
    // read, so counting immediately would be testing the scheduler rather than the dedupe.
    expect(second).toBe(first)
    // A full task, not a microtask: the cache read goes through the IndexedDB open promise,
    // which is several links of chain even when it resolves to "no database here".
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetch).toHaveBeenCalledTimes(1)

    const value = table(2)
    release(value)
    expect(await first).toBe(value)
    expect(await second).toBe(value)
  })

  it('re-fetches when asked to refresh', async () => {
    const first = table(1)
    const second = table(2)
    const fetch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    expect(await loadCachedTable({ key: 'idx', fingerprint: 'f', fetch })).toBe(first)
    expect(await loadCachedTable({ key: 'idx', fingerprint: 'f', refresh: true, fetch })).toBe(
      second,
    )
  })

  it('re-fetches when the shape changed', async () => {
    const first = table(1)
    const second = table(2)
    const fetch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    expect(await loadCachedTable({ key: 'idx', fingerprint: 'old', fetch })).toBe(first)
    expect(await loadCachedTable({ key: 'idx', fingerprint: 'new', fetch })).toBe(second)
  })

  it('does not hold a failed load, so a retry can succeed', async () => {
    const value = table(1)
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(value)
    const spec = { key: 'idx', fingerprint: 'f', fetch }

    await expect(loadCachedTable(spec)).rejects.toThrow('network')
    expect(await loadCachedTable(spec)).toBe(value)
  })

  it('keys separately per source and dataset', () => {
    expect(neuronIndexKey('neuprint', 'hemibrain:v1.2.1')).not.toBe(
      neuronIndexKey('neuprint', 'manc:v1.2.3'),
    )
    expect(neuronIndexKey('mock', 'x')).not.toBe(neuronIndexKey('neuprint', 'x'))
    // The colon in a dataset id must survive: it is part of the id everywhere else too.
    expect(neuronIndexKey('neuprint', 'hemibrain:v1.2.1')).toContain('hemibrain:v1.2.1')
  })
})
