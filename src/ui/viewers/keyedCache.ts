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
 * - **A `clear()` outlives the requests already in flight.** Without the generation guard below,
 *   a request issued before the reload button was pressed writes its result into the store just
 *   after — so "forget everything and ask again" quietly returns the answer it was told to
 *   discard. It presents as a reload that did nothing, and it is also how one test's cached
 *   value reaches the next through a `clear()` in `beforeEach`.
 *
 * `useNeuronProfile` joined them when Neuron Profile learned to profile a whole cell type, and it
 * brought the third rule with it:
 *
 * - **An entry count is not always a budget.** One profile used to weigh one neuron's partners;
 *   grouped, it weighs a whole type's, and twenty-four of those is a dataset's connectivity held
 *   in memory. `weigh` is how a caller says what an entry costs, and it is measured in whatever
 *   unit that caller finds honest — rows, here. A cache without it behaves exactly as before.
 */

export interface KeyedCache<T> {
  get(key: string): T | undefined
  /** Run `load` for this key, or join the request already in flight for it. */
  share(key: string, load: () => Promise<T>): Promise<T>
  clear(): void
}

export interface KeyedCacheOptions<T> {
  /**
   * What one entry costs, and the ceiling on the total.
   *
   * One optional object rather than two optional fields, so "both or neither" is something the
   * type says rather than something a comment asks for and the eviction check re-tests at
   * runtime. Eviction runs until *both* bounds hold: `maxEntries` stays the cap on how many
   * things are remembered and `max` the cap on how much they weigh — an entry heavier than the
   * whole budget is still kept, because evicting the value just stored would make the cache a
   * slow way of not caching.
   */
  budget?: { weigh: (value: T) => number; max: number }
}

export function keyedCache<T>(
  maxEntries: number,
  options: KeyedCacheOptions<T> = {},
): KeyedCache<T> {
  const memory = new Map<string, T>()
  const pending = new Map<string, Promise<T>>()
  const { budget } = options
  let generation = 0
  // Kept as entries go in and out rather than re-summed per eviction: the loop below calls
  // `overBudget` after every delete, so a re-sum makes one insert O(evicted × entries) and calls
  // `weigh` — which walks three table lengths here — that many times over.
  let weight = 0

  function overBudget(): boolean {
    if (memory.size > maxEntries) return true
    // An entry heavier than the whole budget is still kept: evicting the value just stored would
    // make the cache a slow way of not caching. Hence `size > 1` rather than a bare comparison.
    return budget !== undefined && memory.size > 1 && weight > budget.max
  }

  function remember(key: string, value: T): void {
    forget(key)
    memory.set(key, value)
    if (budget) weight += budget.weigh(value)
  }

  function forget(key: string): void {
    const held = memory.get(key)
    if (held === undefined) return
    if (budget) weight -= budget.weigh(held)
    memory.delete(key)
  }

  return {
    get: (key) => memory.get(key),

    share(key, load) {
      const shared = pending.get(key) ?? load()
      pending.set(key, shared)
      const issued = generation
      return shared
        .then((value) => {
          // Still handed to the caller — it asked for this and the answer is good. What a
          // `clear()` in between forbids is *remembering* it.
          if (issued !== generation) return value
          remember(key, value)
          /*
           * Map iterates in insertion order, so the first key is the least recently *added*. Good
           * enough here: paging moves forward, and a revisit is served without reordering.
           */
          while (overBudget()) {
            const oldest = memory.keys().next().value
            if (oldest === undefined) break
            forget(oldest)
          }
          return value
        })
        .finally(() => {
          // Only if it is still ours: a later call for the same key has already replaced it.
          if (pending.get(key) === shared) pending.delete(key)
        })
    },

    clear() {
      generation += 1
      memory.clear()
      pending.clear()
      weight = 0
    },
  }
}
