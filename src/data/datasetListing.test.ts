/**
 * `DatasetListing`: the three rules neuPrint, CAVE and CATMAID each used to keep by hand.
 *
 * A peek starts one fetch; further peeks start none, even after a failure (inference runs on every
 * graph mutation, so a peek that retried would be a request per keystroke); an awaited caller does
 * retry a failure. Plus the one that was quietly different per source: what a success is kept for.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DatasetListing } from './datasetListing'
import type { DatasetInfo } from './source'
import { subscribeSourceLearned } from './source'

const info = (id: string): DatasetInfo => ({ id, label: id, rois: [], statuses: [] })

let unsubscribe: (() => void) | undefined
afterEach(() => unsubscribe?.())

describe('DatasetListing', () => {
  it('a peek starts one fetch, and a second peek does not start another', async () => {
    const load = vi.fn(() => Promise.resolve([info('a')]))
    const listing = new DatasetListing('src', load, { keep: 'inflight' })
    expect(listing.peek()).toBeUndefined()
    expect(listing.peek()).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(listing.peek()).toEqual([info('a')]))
    expect(listing.find('a')).toEqual(info('a'))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a failed listing is not retried from a peek, and is retried by the next awaited call', async () => {
    const load = vi
      .fn<() => Promise<DatasetInfo[]>>()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue([info('a')])
    const listing = new DatasetListing('src', load, { keep: 'resolved' })
    listing.peek()
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    for (let i = 0; i < 10; i++) listing.peek()
    expect(load).toHaveBeenCalledTimes(1)
    expect(await listing.get()).toEqual([info('a')])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shares one request between concurrent callers', async () => {
    const load = vi.fn(() => Promise.resolve([info('a')]))
    const listing = new DatasetListing('src', load, { keep: 'inflight' })
    await Promise.all([listing.get(), listing.get(), listing.get()])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("keep: 'inflight' re-fetches on every awaited call; keep: 'resolved' does not", async () => {
    const refetching = vi.fn(() => Promise.resolve([info('a')]))
    const inflight = new DatasetListing('src', refetching, { keep: 'inflight' })
    await inflight.get()
    await inflight.get()
    expect(refetching).toHaveBeenCalledTimes(2)

    const kept = vi.fn(() => Promise.resolve([info('a')]))
    const resolved = new DatasetListing('src', kept, { keep: 'resolved' })
    await resolved.get()
    await resolved.get()
    expect(kept).toHaveBeenCalledTimes(1)
  })

  it('publishes the list before announcing it, so the re-inference finds it', async () => {
    const listing = new DatasetListing('src', () => Promise.resolve([info('a')]), {
      keep: 'inflight',
    })
    let seen: DatasetInfo[] | undefined
    unsubscribe = subscribeSourceLearned((id) => {
      if (id === 'src') seen = listing.peek()
    })
    await listing.get()
    expect(seen).toEqual([info('a')])
  })

  it('revise swaps one entry as a new list, and only for a listed dataset', async () => {
    const listing = new DatasetListing('src', () => Promise.resolve([info('a'), info('b')]), {
      keep: 'resolved',
    })
    const before = await listing.get()
    expect(listing.revise('b', (d) => ({ ...d, rois: ['R'] }))).toBe(true)
    expect(listing.revise('zzz', (d) => d)).toBe(false)
    expect(listing.find('b')?.rois).toEqual(['R'])
    expect(before[1]!.rois).toEqual([])
    // A kept listing hands out the revised list, not the one the request resolved to.
    expect((await listing.get())[1]!.rois).toEqual(['R'])
  })
})
