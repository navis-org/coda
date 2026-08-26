/**
 * How old this dataset's downloaded data is, on the dataset card.
 *
 * `CacheAge`'s sibling, and the difference is where the age comes from. On a SeaTable or CAVE
 * Table node the answer is a property of the node's own last run — its `evaluate` fetched, said
 * so through `ctx.reportFetched`, and the scheduler kept the time beside the result. A dataset
 * node fetches none of it. Its `evaluate` resolves metadata; the thing with the month-long life
 * is the **neuron index**, downloaded later by whichever Explore or Find Neurons card wanted it
 * and stored under `neuron-index:{source}:{dataset}` in IndexedDB, plus the ROI outlines and the
 * roll-ups beside it. So this card cannot report what it fetched. It has to look.
 *
 * ## Why it is worth looking
 *
 * The index is cached for a month (`NEURON_INDEX_MAX_AGE_MS`), which is right for a released
 * dataset — neuPrint publishes a new *version* rather than editing one in place. It is wrong for
 * the datasets that are still being proofread, where a re-release lands in minutes to days and
 * the only thing that would tell you is a count that changed. A cache hit and a fresh read are
 * indistinguishable from the rows, so nothing on the canvas said which one you were looking at.
 *
 * ## What the ⟳ actually drops
 *
 * Everything keyed to the dataset — see `datasetCacheKey`. Clearing only the index would leave
 * ROI outlines traced from the old release and a summary counting the old neurons, with a card
 * claiming to have cleared the cache: the silent partial refresh is worse than none.
 *
 * Not the geometry cache, and that is not an oversight. It is in memory for the session only and
 * holds skeletons and meshes named by body id, which are immutable by construction — an edit
 * mints a new root id. The morphology nodes carry their own `cached 12m ago ⟳` for the CATMAID
 * case, where tracing is live. See `data/geometryCache.ts`.
 */

import { useCallback, useEffect, useState } from 'react'

import { onCacheChange } from '../../data/cache'
import { dropDatasetCache, peekDatasetCache } from '../../data/neuronIndex'
import type { DatasetAnnotations } from '../../core/values'
import { reloadNeuronIndex, useNeuronIndexState } from '../useNeuronIndex'
import { CacheAge } from './CacheAge'

export interface DatasetCacheAgeProps {
  sourceId: string | undefined
  datasetId: string | undefined
  /**
   * The chain labelling this dataset, off the node's **value** rather than its type.
   *
   * It selects which index variant a ⟳ re-downloads, for `useNeuronIndex`'s reason: two graphs
   * on one datastack with different annotations hold genuinely different tables. Undefined until
   * the node has run, which is the common case and the right one — an unannotated dataset is
   * exactly what an unrun dataset node is asking for.
   *
   * The *age* ignores it and covers every variant, because the ⟳ drops every variant.
   */
  annotations: DatasetAnnotations | undefined
}

export function DatasetCacheAge({ sourceId, datasetId, annotations }: DatasetCacheAgeProps) {
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined)
  const index = useNeuronIndexState(sourceId, datasetId, annotations)

  /*
   * Re-read on every cache write, not only on this card's own ⟳.
   *
   * The download that fills this cache belongs to some other card — Explore's, or a node's
   * `evaluate` — and has no relationship to this one. Without the subscription the age would be
   * right on mount and wrong from the first Run onwards, which is worse than absent: a number
   * that is sometimes maintained is one nobody can use.
   *
   * A peek is a key listing plus a read from the timestamp store; no value is deserialised. See
   * `cachePeek`.
   */
  useEffect(() => {
    if (!sourceId || !datasetId) return setSavedAt(undefined)
    let live = true
    const look = () => {
      void peekDatasetCache(sourceId, datasetId).then((at) => {
        if (live) setSavedAt(at)
      })
    }
    look()
    // `undefined` is a `cacheClear`, which means every key — see `onCacheChange`.
    const stop = onCacheChange((key) => {
      if (key === undefined || key.includes(`:${sourceId}:${datasetId}`)) look()
    })
    return () => {
      live = false
      stop()
    }
  }, [sourceId, datasetId])

  const refresh = useCallback(() => {
    if (!sourceId || !datasetId) return
    /*
     * Dropped first, then re-fetched — in that order and awaited, because `loadCachedTable`
     * reads the store before it fetches. Starting the reload first would have it race the
     * delete and, on the losing branch, hand back the very copy this is replacing.
     */
    void dropDatasetCache(sourceId, datasetId).then(() => {
      reloadNeuronIndex(sourceId, datasetId, annotations)
    })
  }, [sourceId, datasetId, annotations])

  if (!sourceId || !datasetId) return null

  /*
   * The download says so while it runs. A ⟳ on a 7 MB (gzipped) fetch that left the card looking
   * untouched for five seconds reads as a button that does nothing, and the second press is a
   * second download.
   */
  if (index.status === 'loading') {
    return <span className="coda-node__cache coda-node__cache--busy">{index.note ?? 'fetching…'}</span>
  }

  return (
    <CacheAge
      fetchedAt={savedAt}
      onRefresh={refresh}
      empty="no cache"
      title="Neuron index, region outlines and summaries for this dataset"
    />
  )
}
