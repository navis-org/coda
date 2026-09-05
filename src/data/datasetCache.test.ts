/**
 * "Everything cached for this dataset", which is a question about *keys*.
 *
 * The dataset card reads one number — how old is the copy behind this dataset — and its ⟳ drops
 * what that number describes. Both sides are answered by matching cache keys against a dataset
 * scope, and there are three ways for that to be quietly wrong:
 *
 *  - **Too narrow.** Clearing the neuron index while leaving ROI outlines traced from the old
 *    release, or a summary counting the old neurons, is a card that says it cleared the cache
 *    and did not. That is the failure this whole convention exists to prevent, so every kind of
 *    entry has to be reachable from `datasetCacheKey`'s one rule.
 *  - **Too wide.** A neuPrint dataset id *contains a colon* — `hemibrain:v1.2.1` — so a scope
 *    matched by prefix alone has `hemibrain:v1.2` claiming `v1.2.1`'s cache and dropping a
 *    26 MB download somebody else is using.
 *  - **Too expensive.** The whole point of the timestamp sidecar is that a peek never
 *    deserialises a value. An entry written before that store existed has no record in it, and
 *    the fallback has to find it anyway — otherwise the feature reads "no cache" on a warm cache
 *    until something re-downloads.
 *
 * Run against a real IndexedDB (`fake-indexeddb`) rather than the in-memory fallback, because
 * the two-store transaction and the backfill are precisely what the fallback does not have.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { cacheGet, cacheKeys, cachePeek, cacheSet, onCacheChange, resetCache } from './cache'
import {
  NEURON_INDEX_MAX_AGE_MS,
  datasetCacheKey,
  datasetSummaryKey,
  dropDatasetCache,
  neuronIndexKey,
  peekDatasetCache,
} from './neuronIndex'

const SOURCE = 'neuprint-janelia'
const DATASET = 'hemibrain:v1.2.1'
const DAY = 86_400_000
const START = Date.UTC(2026, 0, 1)

/**
 * Move the clock, by spying on `Date.now` rather than with `vi.useFakeTimers`.
 *
 * Not interchangeable here: vitest's fake timers replace `setImmediate`, which is what
 * `fake-indexeddb` schedules its transactions on — every IndexedDB call then hangs until the
 * case times out, and a `finally` that restores the timers never runs, so the whole rest of the
 * file hangs with it. Only the clock needs faking, so only the clock is faked.
 */
function at(time: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(time)
}

beforeEach(() => {
  // A fresh database per case, the idiom every other IndexedDB test here uses.
  globalThis.indexedDB = new IDBFactory()
  vi.restoreAllMocks()
  resetCache()
})

/** Everything a dataset can have in the store, as the four writers actually key it. */
async function fillDataset(sourceId = SOURCE, datasetId = DATASET): Promise<void> {
  await cacheSet(neuronIndexKey(sourceId, datasetId), 'index')
  await cacheSet(neuronIndexKey(sourceId, datasetId, 'chain-7'), 'annotated index')
  await cacheSet(datasetSummaryKey('roi-completeness', sourceId, datasetId), 'summary')
  await cacheSet(datasetCacheKey('roi-outlines', sourceId, datasetId), 'outlines')
}

describe('the dataset scope', () => {
  it('covers every kind of entry keyed to the dataset', async () => {
    await fillDataset()
    expect(await peekDatasetCache(SOURCE, DATASET)).toBeDefined()

    await dropDatasetCache(SOURCE, DATASET)
    expect(await peekDatasetCache(SOURCE, DATASET)).toBeUndefined()
    expect(await cacheKeys()).toEqual([])
  })

  it('does not let one version claim another’s cache', async () => {
    /*
     * The reason the scope is matched as a whole segment rather than as a prefix: a neuPrint
     * dataset id carries its version behind a colon, so `hemibrain:v1.2` is a prefix of
     * `hemibrain:v1.2.1` and a prefix match would drop a release nobody asked about.
     */
    await cacheSet(neuronIndexKey(SOURCE, 'hemibrain:v1.2'), 'older')
    await cacheSet(neuronIndexKey(SOURCE, 'hemibrain:v1.2.1'), 'newer')

    await dropDatasetCache(SOURCE, 'hemibrain:v1.2')
    expect(await cacheGet(neuronIndexKey(SOURCE, 'hemibrain:v1.2.1'))).toBe('newer')
    expect(await cacheGet(neuronIndexKey(SOURCE, 'hemibrain:v1.2'))).toBeUndefined()
  })

  it('does not reach another source publishing the same dataset', async () => {
    // The same connectome is on more than one deployment, and they are not the same fetch.
    await cacheSet(neuronIndexKey('neuprint-mock', DATASET), 'elsewhere')
    await fillDataset()

    await dropDatasetCache(SOURCE, DATASET)
    expect(await cacheGet(neuronIndexKey('neuprint-mock', DATASET))).toBe('elsewhere')
  })

  it('reports the oldest entry, not the newest', async () => {
    // The number is read as "how old is what I am looking at", and that is the stalest part of
    // it: a summary re-fetched this morning does not make a month-old index fresh.
    at(START)
    await cacheSet(neuronIndexKey(SOURCE, DATASET), 'index')
    at(START + 4 * DAY)
    await cacheSet(datasetSummaryKey('roi-completeness', SOURCE, DATASET), 'summary')

    expect(await peekDatasetCache(SOURCE, DATASET)).toBe(START)
  })

  it('reads an expired entry as no cache, the way the loader would', async () => {
    // Otherwise the card offers an age for a copy `loadCachedTable` has already decided to
    // re-fetch, and the two disagree about what is there.
    at(START)
    await cacheSet(neuronIndexKey(SOURCE, DATASET), 'index')
    at(START + NEURON_INDEX_MAX_AGE_MS + 1000)
    expect(await peekDatasetCache(SOURCE, DATASET)).toBeUndefined()
  })

  it('drops an expired entry all the same', async () => {
    // Invisible to the peek, so nothing else would ever delete it.
    at(START)
    await cacheSet(neuronIndexKey(SOURCE, DATASET), 'index')
    at(START + NEURON_INDEX_MAX_AGE_MS + 1000)
    await dropDatasetCache(SOURCE, DATASET)
    expect(await cacheKeys()).toEqual([])
  })
})

describe('peeking', () => {
  it('answers from the sidecar, leaving the value alone', async () => {
    await cacheSet('k', { big: 'value' }, 'fp')
    resetCache() // forget the in-memory copy, so this has to come off the store
    expect(await cachePeek('k')).toEqual({ savedAt: expect.any(Number), fingerprint: 'fp' })
  })

  it('finds an entry written before the sidecar store existed, and leaves one behind', async () => {
    /*
     * Simulated by deleting the meta record a `cacheSet` just wrote, which is exactly the state
     * a database upgraded from version 1 is in. Without the fallback every warm cache would read
     * `no cache` until something re-downloaded it — the feature saying the opposite of the truth
     * on precisely the machines it was built for.
     */
    await cacheSet('legacy', { big: 'value' }, 'fp')
    await new Promise<void>((resolve) => {
      const open = indexedDB.open('coda')
      open.onsuccess = () => {
        const tx = open.result.transaction('meta', 'readwrite')
        tx.objectStore('meta').delete('legacy')
        tx.oncomplete = () => resolve()
      }
    })
    resetCache()

    expect(await cachePeek('legacy')).toMatchObject({ fingerprint: 'fp' })

    // ...and the sidecar is now there, so the full read is paid once rather than every session.
    const backfilled = await new Promise((resolve) => {
      const open = indexedDB.open('coda')
      open.onsuccess = () => {
        const req = open.result
          .transaction('meta', 'readonly')
          .objectStore('meta')
          .get('legacy')
        req.onsuccess = () => resolve(req.result)
      }
    })
    expect(backfilled).toMatchObject({ fingerprint: 'fp' })
  })

  it('reports a key that was never written as absent', async () => {
    expect(await cachePeek('nothing')).toBeUndefined()
  })

  it('lists keys held only in memory, for the browser that has no IndexedDB at all', async () => {
    // Private-mode Firefox and vitest's node environment both land here, and a listing off the
    // sidecar store alone would report an empty cache while `cacheGet` answered from memory.
    await cacheSet('in-memory', 1)
    expect(await cacheKeys()).toContain('in-memory')
  })
})

describe('announcements', () => {
  it('names the key a write or a delete touched', async () => {
    const seen: Array<string | undefined> = []
    const stop = onCacheChange((key) => seen.push(key))
    await cacheSet(neuronIndexKey(SOURCE, DATASET), 'index')
    await dropDatasetCache(SOURCE, DATASET)
    stop()
    expect(seen).toEqual([neuronIndexKey(SOURCE, DATASET), neuronIndexKey(SOURCE, DATASET)])
  })

  it('stops when unsubscribed', async () => {
    const listener = vi.fn()
    onCacheChange(listener)()
    await cacheSet('k', 1)
    expect(listener).not.toHaveBeenCalled()
  })
})
