/**
 * Loading a dataset's neuron index, once, however many widgets want it.
 *
 * The index is what makes Explore searchable and what the Dataset Summary counts, and the two
 * are the kind of pair somebody puts on one canvas. `data/neuronIndex.ts` already deduplicates
 * the *download* — `loadCachedTable` keys on (source, dataset), shares an in-flight promise and
 * persists to IndexedDB — so what was left to share is everything above it: the React state
 * machine, the progress note, and the reload.
 *
 * That sounds cosmetic and is not, once more than one widget exists. Each mount used to run its
 * own effect and set `status: 'loading'` before awaiting a call that resolves from memory, so a
 * second card flashed a spinner over data it already had; each printed its own "downloading
 * index" note for one download; and a reload pressed on one left the other showing the table it
 * had just replaced. Hoisting the state out of the component fixes all three by construction.
 *
 * Lives in `src/ui` rather than `src/ui/explore` because it is no longer Explore's. The data
 * half stays in `src/data`, which is headless and knows nothing about any of this.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import type { DatasetAnnotations, TableValue } from '../core/values'
import { errorMessage } from '../core/errors'
import { getSource } from '../data/source'
import { neuronIndexKey } from '../data/neuronIndex'

export type NeuronIndexState =
  /** No dataset resolved yet — usually an unconnected Dataset input. */
  | { status: 'none' }
  | { status: 'loading'; note: string | undefined }
  | { status: 'ready'; table: TableValue }
  | { status: 'error'; message: string }

export interface NeuronIndexHandle {
  state: NeuronIndexState
  /**
   * Re-download, ignoring every cached copy.
   *
   * Shared, like the state: pressing it on one widget reloads for all of them. A reload that
   * refreshed only the card it was pressed on would leave two widgets on one dataset showing
   * different data, which is worse than not offering it.
   */
  reload: () => void
}

/**
 * Returned whenever there is no dataset to load.
 *
 * One frozen object rather than a fresh `{ status: 'none' }` per call — this is read through
 * `useSyncExternalStore`, which compares snapshots by identity, so a new object every time is
 * an infinite render loop. Same reason `Scheduler.info()` shares a frozen `IDLE`; see
 * invariant 7.
 */
const NONE: NeuronIndexState = Object.freeze({ status: 'none' })

interface Entry {
  state: NeuronIndexState
  listeners: Set<() => void>
  /** Bumped by `reload`, and what carries the "ignore the cache" intent into the next load. */
  reloads: number
  /** True while a load is in flight, so a remount does not start a second one. */
  loading: boolean
}

const entries = new Map<string, Entry>()

/**
 * What a shared entry is a fact about: the dataset, and the chain labelling it.
 *
 * Through `neuronIndexKey`, which `data/neuronIndex.ts` documents as "one place, so a reader and
 * a writer agree" and which already takes exactly this variant. Derived here instead, this map
 * and the persistent cache could disagree about what makes two indexes different — the memo
 * handing the first table looked at to the second widget while IndexedDB kept them apart.
 */
function entryKey(
  sourceId: string,
  datasetId: string,
  annotations: DatasetAnnotations | undefined,
): string {
  return neuronIndexKey(sourceId, datasetId, annotations?.key ?? '')
}

function entryFor(key: string): Entry {
  let entry = entries.get(key)
  if (!entry) {
    entry = { state: NONE, listeners: new Set(), reloads: 0, loading: false }
    entries.set(key, entry)
  }
  return entry
}

function publish(entry: Entry, state: NeuronIndexState): void {
  entry.state = state
  for (const listener of entry.listeners) listener()
}

/**
 * Start a load for one dataset, unless one is already running or has already finished.
 *
 * **Nothing is aborted, and that is deliberate.** The obvious shape — an `AbortController` torn
 * down on unmount — is actively wrong once the state is shared: two Explore cards on one
 * dataset would have the first one's unmount cancel the fetch the second is still waiting for.
 * That is the same trap the Profile widget's paging documents, one level up. Nor is there
 * anything to save by cancelling: the result is cached, so a download that completes after the
 * last widget has gone is paid for and kept rather than wasted, and one that is abandoned
 * half-way has to start from zero next time.
 */
function ensureLoaded(
  key: string,
  sourceId: string,
  datasetId: string,
  annotations: DatasetAnnotations | undefined,
): void {
  const entry = entryFor(key)
  if (entry.loading) return
  if (entry.state.status === 'ready' || entry.state.status === 'error') return

  const source = getSource(sourceId)
  if (!source) {
    publish(entry, { status: 'error', message: `Data source "${sourceId}" is not registered` })
    return
  }
  if (!source.neuronIndex) {
    publish(entry, {
      status: 'error',
      message: `${source.label} cannot list a whole dataset — use Find Neurons instead`,
    })
    return
  }

  const reloads = entry.reloads
  entry.loading = true
  publish(entry, { status: 'loading', note: undefined })

  source
    .neuronIndex({
      datasetId,
      ...(annotations ? { annotations } : {}),
      refresh: reloads > 0,
      onProgress: (_fraction, note) => {
        // Notes only, no percentage: the response is gzipped, so `Content-Length` describes the
        // compressed stream while the body yields decompressed bytes, and a fraction built from
        // the two is simply wrong.
        if (entry.reloads === reloads) publish(entry, { status: 'loading', note })
      },
    })
    .then((table) => {
      if (entry.reloads === reloads) publish(entry, { status: 'ready', table })
    })
    .catch((error: unknown) => {
      if (entry.reloads === reloads) {
        publish(entry, { status: 'error', message: errorMessage(error) })
      }
    })
    .finally(() => {
      if (entry.reloads === reloads) entry.loading = false
    })
}

/**
 * The index for a dataset, optionally as an annotation chain labels it.
 *
 * `annotations` comes off the **value** on the widget's Dataset input, not off the type: a type
 * carries the chain's schema and only a `DatasetValue` carries its table, because that table is
 * a fetch somebody's Run paid for. So a chain reaches this widget one run later than it reaches
 * the node's ports, and with nothing wired the widget behaves exactly as it always did.
 *
 * That is a bounded departure from "loads independently of any run", and it was forced rather
 * than chosen. It began as a labelling gap — an annotated CAVE dataset listed the backend's
 * `type` while the wire carried the chain's columns — and became a hard failure the moment
 * `DatastackSpec.neurons` was allowed to be absent: on a datastack that publishes no neuron
 * table the chain *is* the neuron list, so without it there is nothing to list at all and the
 * source refuses. `wclee_aedes_brain` is exactly that datastack.
 *
 * The entry is keyed by the chain, for `neuronIndexKey`'s reason: two graphs on one datastack
 * with different annotations hold genuinely different tables, and sharing one entry would serve
 * the first one looked at to the other for the session.
 */
/**
 * Re-download this dataset's index, discarding every cached copy.
 *
 * Module-level rather than a method on the handle, because the two things that ask for it are
 * not the same shape. A widget *displaying* the index presses reload and watches its own state;
 * the dataset card presses it having just dropped the persistent entries, and must be able to
 * start a download for a dataset **no widget is currently showing** — which is most of them.
 * A hook cannot serve the second case without mounting, and mounting `useNeuronIndex` is itself
 * a download.
 */
export function reloadNeuronIndex(
  sourceId: string,
  datasetId: string,
  annotations?: DatasetAnnotations,
): void {
  const key = entryKey(sourceId, datasetId, annotations)
  const entry = entryFor(key)
  entry.reloads++
  entry.loading = false
  entry.state = NONE
  ensureLoaded(key, sourceId, datasetId, annotations)
}

/** The shared entry's state, subscribed to but never started. See `useNeuronIndexState`. */
function useEntryState(key: string | undefined): NeuronIndexState {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!key) return () => {}
      const entry = entryFor(key)
      entry.listeners.add(onChange)
      return () => {
        entry.listeners.delete(onChange)
      }
    },
    [key],
  )

  const getSnapshot = useCallback(() => (key ? entryFor(key).state : NONE), [key])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * What the shared load is doing, **without asking for one**.
 *
 * The half of `useNeuronIndex` that a card which does not want the table can afford. Mounting
 * the full hook starts a download, so a dataset node — of which a canvas holds several, none of
 * them displaying neurons — cannot use it merely to say `downloading…` under its own ⟳.
 *
 * Reads `none` when nobody has asked, which is the honest answer rather than a missing one.
 */
export function useNeuronIndexState(
  sourceId: string | undefined,
  datasetId: string | undefined,
  annotations?: DatasetAnnotations,
): NeuronIndexState {
  return useEntryState(sourceId && datasetId ? entryKey(sourceId, datasetId, annotations) : undefined)
}

export function useNeuronIndex(
  sourceId: string | undefined,
  datasetId: string | undefined,
  annotations?: DatasetAnnotations,
): NeuronIndexHandle {
  const key = sourceId && datasetId ? entryKey(sourceId, datasetId, annotations) : undefined

  /*
   * Held in a ref rather than a dependency: the value comes off a `DatasetValue` the store mints
   * afresh on every tick, so the object identity churns while the *chain* does not — and `key`
   * above already says which chain it is. Watching the object would reload the index on every
   * unrelated edit; watching the key reloads exactly when the answer would differ.
   */
  const chain = useRef(annotations)
  chain.current = annotations

  const state = useEntryState(key)

  /*
   * From an effect, never from render. `ensureLoaded` publishes synchronously on several paths,
   * and publishing is other components' `setState` — during render that is the "cannot update a
   * component while rendering a different component" warning, and the components in question
   * are sibling node cards with no relationship to each other.
   *
   * Nothing is lost by waiting a tick. The reason a second widget feels instant is the shared
   * entry, not the timing: it mounts, `getSnapshot` finds the entry already `ready`, and it
   * paints the table on its first frame without this effect having run.
   */
  useEffect(() => {
    if (key && sourceId && datasetId) ensureLoaded(key, sourceId, datasetId, chain.current)
  }, [key, sourceId, datasetId])

  const reload = useCallback(() => {
    if (!sourceId || !datasetId) return
    reloadNeuronIndex(sourceId, datasetId, chain.current)
  }, [sourceId, datasetId])

  return { state, reload }
}

/** Test seam: drop every shared load between cases. */
export function resetNeuronIndexState(): void {
  entries.clear()
}
