/**
 * The little LRU-plus-in-flight store the fetching widgets share.
 *
 * Three of these had accumulated — `useNeuronProfile`, `useNeuronTopology` and `useSynapseLinks`
 * — identical down to the eviction loop and the `finally` that clears the in-flight entry only if
 * it is still the current one. None of it is obvious, which is exactly why it should not be
 * retyped: the same call `fetchText.ts` records ("Copied twice already; don't").
 *
 * Two rules are worth stating because both were learned rather than designed:
 *
 * - **A pending promise is shared, not restarted.** Two cards on one neuron cost one request
 *   between them, and an unmount must not cancel a fetch the other is still waiting on.
 * - **A failure is not cached.** The entry is cleared once it settles either way, so the next
 *   look retries instead of being told "no" forever by a request that timed out once.
 *
 * `useNeuronProfile` is deliberately left alone: it is outside this change, and rewiring it is a
 * separate edit with its own tests to re-run.
 */

export interface KeyedCache<T> {
  get(key: string): T | undefined
  /** Run `load` for this key, or join the request already in flight for it. */
  share(key: string, load: () => Promise<T>): Promise<T>
  clear(): void
}

export function keyedCache<T>(maxEntries: number): KeyedCache<T> {
  const memory = new Map<string, T>()
  const pending = new Map<string, Promise<T>>()

  return {
    get: (key) => memory.get(key),

    share(key, load) {
      const shared = pending.get(key) ?? load()
      pending.set(key, shared)
      return shared
        .then((value) => {
          memory.set(key, value)
          /*
           * Map iterates in insertion order, so the first key is the least recently *added*. Good
           * enough here: paging moves forward, and a revisit is served without reordering.
           */
          while (memory.size > maxEntries) {
            const oldest = memory.keys().next().value
            if (oldest === undefined) break
            memory.delete(oldest)
          }
          return value
        })
        .finally(() => {
          // Only if it is still ours: a later call for the same key has already replaced it.
          if (pending.get(key) === shared) pending.delete(key)
        })
    },

    clear() {
      memory.clear()
      pending.clear()
    },
  }
}
