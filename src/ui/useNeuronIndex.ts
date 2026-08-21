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

import { useCallback, useEffect, useSyncExternalStore } from 'react'

import type { TableValue } from '../core/values'
import { errorMessage } from '../core/errors'
import { getSource } from '../data/source'

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
function ensureLoaded(key: string, sourceId: string, datasetId: string): void {
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
 * **Known gap: this shows the dataset's *own* labels, even when an annotation chain is wired.**
 *
 * The node's ports are annotated — `explore.ts`'s `evaluate` threads the chain into
 * `neuronIndex` — but this widget loads independently of any run, by design, so all it has is
 * the dataset *type*. That carries the chain's schema, not its table, and a table is what an
 * index needs. Closing it means the widget reading a run's value, which is the thing its
 * independence was built to avoid.
 *
 * So an annotated CAVE dataset shows `type`/`status` in the list and the chain's columns on the
 * wire. Visible rather than silent, and stated here because the alternative — a parameter
 * nothing can supply — would read as though it were handled.
 */
export function useNeuronIndex(
  sourceId: string | undefined,
  datasetId: string | undefined,
): NeuronIndexHandle {
  const key = sourceId && datasetId ? `${sourceId}:${datasetId}` : undefined

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
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

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
    if (key && sourceId && datasetId) ensureLoaded(key, sourceId, datasetId)
  }, [key, sourceId, datasetId])

  const reload = useCallback(() => {
    if (!key || !sourceId || !datasetId) return
    const entry = entryFor(key)
    entry.reloads++
    entry.loading = false
    entry.state = NONE
    ensureLoaded(key, sourceId, datasetId)
  }, [key, sourceId, datasetId])

  return { state, reload }
}

/** Test seam: drop every shared load between cases. */
export function resetNeuronIndexState(): void {
  entries.clear()
}
