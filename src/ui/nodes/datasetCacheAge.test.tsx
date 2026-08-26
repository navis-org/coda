// @vitest-environment jsdom

/**
 * `cached 3d ago ⟳` on a dataset card — the age of data the card did not fetch.
 *
 * Every other node's badge reports its own last run. A dataset node's `evaluate` resolves
 * metadata and nothing else; what goes stale is the neuron index, downloaded by whichever
 * Explore or Find Neurons card wanted it and kept for a month. So this one *looks*, and looking
 * has failure modes reporting does not:
 *
 *  - **It must not fetch to find out.** Mounting the obvious hook (`useNeuronIndex`) starts a
 *    download, and a canvas holds several dataset cards — dropping one onto it would pull 26 MB
 *    per card for a label nobody asked for.
 *  - **It must notice a download it did not start.** The fetch that fills this cache belongs to
 *    another card entirely. An age that is right on mount and wrong from the first Run is worse
 *    than no age, because it looks maintained.
 *  - **The empty state is not a control.** `no cache` states a fact; a ⟳ next to the pointer is
 *    how somebody starts a 26 MB download by accident.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cacheKeys, cacheSet, resetCache } from '../../data/cache'
import { MockSource } from '../../data/mock/MockSource'
import { mockDatasetIds } from '../../data/mock/generate'
import { registerSource } from '../../data/source'
import { datasetSummaryKey, neuronIndexKey, resetIndexLoads } from '../../data/neuronIndex'
import { resetNeuronIndexState } from '../useNeuronIndex'
import { clearStorage } from '../../test/jsdomStubs'
import { DatasetCacheAge } from './DatasetCacheAge'

const DAY = 86_400_000
const DATASET = mockDatasetIds()[0]!
let source: MockSource

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  vi.restoreAllMocks()
  clearStorage()
  resetCache()
  resetIndexLoads()
  resetNeuronIndexState()
  source = new MockSource({ latencyMs: 0 })
  registerSource(source)
})

afterEach(cleanup)

/** Write a cache entry as though it had been fetched `days` ago. See `datasetCache.test.ts`. */
async function cachedDaysAgo(key: string, days: number): Promise<void> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - days * DAY)
  await cacheSet(key, 'table')
  spy.mockRestore()
}

function draw() {
  return render(<DatasetCacheAge sourceId={source.id} datasetId={DATASET} annotations={undefined} />)
}

describe('what it says', () => {
  it('says "no cache" when nothing has been downloaded', async () => {
    draw()
    expect(await screen.findByText('no cache')).toBeTruthy()
  })

  it('does not offer the empty state as a button', async () => {
    // A dataset card is somewhere people click. Nothing here should start a 26 MB download.
    draw()
    const empty = await screen.findByText('no cache')
    expect(empty.tagName).toBe('SPAN')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reports the age of the index once something has downloaded it', async () => {
    await cachedDaysAgo(neuronIndexKey(source.id, DATASET), 3)
    draw()
    expect(await screen.findByText(/cached 3d ago/)).toBeTruthy()
  })

  it('reports the oldest of everything cached for the dataset', async () => {
    // The index is a week old and the roll-up is an hour old; the card is a week old.
    await cachedDaysAgo(neuronIndexKey(source.id, DATASET), 7)
    await cachedDaysAgo(datasetSummaryKey('roi-completeness', source.id, DATASET), 0)
    draw()
    expect(await screen.findByText(/cached 7d ago/)).toBeTruthy()
  })
})

describe('what it does not do', () => {
  it('starts no download merely by being on screen', async () => {
    // The reason it reads the shared state rather than mounting `useNeuronIndex`.
    const fetching = vi.spyOn(source, 'neuronIndex')
    draw()
    await screen.findByText('no cache')
    expect(fetching).not.toHaveBeenCalled()
  })
})

describe('the ⟳', () => {
  it('drops every entry for the dataset and fetches again', async () => {
    await cachedDaysAgo(neuronIndexKey(source.id, DATASET), 3)
    await cachedDaysAgo(datasetSummaryKey('roi-completeness', source.id, DATASET), 3)
    const fetching = vi.spyOn(source, 'neuronIndex')

    draw()
    fireEvent.click(await screen.findByText(/cached 3d ago/))

    await waitFor(() => expect(fetching).toHaveBeenCalled())
    // Both entries, not just the index: a card that cleared one and kept the other would claim
    // to have refreshed a dataset while a summary counted the old release.
    expect(fetching.mock.calls[0]?.[0]?.refresh).toBe(true)
    await waitFor(async () =>
      expect(await cacheKeys()).not.toContain(datasetSummaryKey('roi-completeness', source.id, DATASET)),
    )
  })

  it('says the download is happening while it runs', async () => {
    await cachedDaysAgo(neuronIndexKey(source.id, DATASET), 3)
    // Held open, so the in-flight state is observable rather than a frame nobody sees.
    let release: () => void = () => {}
    vi.spyOn(source, 'neuronIndex').mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(undefined as never))),
    )

    draw()
    fireEvent.click(await screen.findByText(/cached 3d ago/))
    // A ⟳ that left the card untouched for five seconds reads as a button that does nothing,
    // and the second press is a second download.
    expect(await screen.findByText(/fetching/)).toBeTruthy()
    release()
  })
})

describe('a download somebody else started', () => {
  it('updates the age when another card fills the cache', async () => {
    draw()
    await screen.findByText('no cache')

    // Explore, or a node's `evaluate` — nothing this card can see except through the cache.
    await cacheSet(neuronIndexKey(source.id, DATASET), 'table')

    expect(await screen.findByText(/cached 0s ago/)).toBeTruthy()
  })
})
