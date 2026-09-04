/**
 * The fetch-state machine the widget hooks share, next to the cache they already share.
 *
 * `keyedCache.ts` extracted the LRU and the in-flight sharing; this is the other half, and the
 * half that had been retyped three times — `useNeuronTopology`, `useSynapseLinks` and
 * `useNeuronMesh` each spelled out: guard the key → `setState('loading')` → a `live` flag → an
 * optional settle timer → fetch → `.then`/`.catch` guarded on `live` → a cleanup clearing both.
 * None of that is difficult and all of it is easy to get subtly different, which is the same call
 * `keyedCache`'s own header makes about the eviction loop.
 *
 * Two rules are worth stating because both were learned in the copies:
 *
 * - **The loader is held in a ref, and the effect keys on `key` alone.** Every caller builds its
 *   loader as an inline closure over props, so a fresh identity every render — as a dependency it
 *   would re-fetch on any parent re-render. The key is what says *what is being fetched*, which
 *   is why the callers compose one out of the source, the dataset, the id and the annotation
 *   chain rather than passing those separately.
 * - **The first render is seeded from the cache**, so paging back to a neuron paints immediately
 *   rather than flashing `loading` for a value already in hand. That was `useNeuronTopology`'s
 *   `initial()`, and the other two did not have it.
 *
 * The settle delay is the one genuine difference between the callers and stays a parameter: it
 * exists so a held-down arrow key does not put twenty fetches in flight, and it is 0 where the
 * fetch is behind a deliberate click, because a delay before a two-second query only makes the
 * click feel dead.
 */

import { useEffect, useRef, useState } from 'react'

import { errorMessage } from '../../core/errors'
import type { KeyedCache } from './keyedCache'

export type SettledFetch<T> =
  /** No key: nothing has been asked for. Callers rename this — `none`, `unavailable`. */
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string }

export interface SettledFetchOptions<T> {
  /** How long the key must hold still before anything is fetched. 0 fetches immediately. */
  settleMs?: number
  /**
   * Where a result is kept, if anywhere.
   *
   * Optional because it is a real decision rather than an omission: `useNeuronMesh` passes none,
   * since a mesh is the largest thing these hooks fetch and `data/geometryCache.ts` already holds
   * the same typed arrays under a byte budget — a second strong reference there would keep
   * megabytes alive outside the budget that exists to bound exactly that.
   */
  cache?: KeyedCache<T>
}

export function useSettledFetch<T>(
  key: string | undefined,
  load: () => Promise<T>,
  options: SettledFetchOptions<T> = {},
): SettledFetch<T> {
  const { settleMs = 0, cache } = options

  // Held rather than depended on — see the header. Assigned during render so the effect below
  // always calls the current one, which matters because it closes over this render's props.
  const loader = useRef(load)
  loader.current = load

  const [state, setState] = useState<SettledFetch<T>>(() => seed(key, cache))

  useEffect(() => {
    if (!key) {
      setState({ status: 'idle' })
      return
    }

    const cached = cache?.get(key)
    if (cached) {
      setState({ status: 'ready', data: cached })
      return
    }

    let live = true
    setState({ status: 'loading' })

    const start = () => {
      const pending = cache ? cache.share(key, () => loader.current()) : loader.current()
      pending
        .then((data) => {
          if (live) setState({ status: 'ready', data })
        })
        .catch((error: unknown) => {
          if (live) setState({ status: 'error', message: errorMessage(error) })
        })
    }

    // No timer at all when there is nothing to wait for, rather than a `setTimeout(…, 0)`: that
    // would defer the start of a deliberate click's fetch by a task for no reason.
    if (settleMs <= 0) {
      start()
      return () => {
        live = false
      }
    }
    const timer = setTimeout(start, settleMs)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key, settleMs, cache])

  return state
}

function seed<T>(key: string | undefined, cache: KeyedCache<T> | undefined): SettledFetch<T> {
  if (!key) return { status: 'idle' }
  const cached = cache?.get(key)
  return cached ? { status: 'ready', data: cached } : { status: 'loading' }
}
