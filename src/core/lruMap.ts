/**
 * A `Map` capped at `max` entries, dropping the one written longest ago.
 *
 * Session caches kept writing this out by hand — the network layout, 3D camera and neuroglancer
 * scene memos, the heatmap's shaped matrices, Explore's search haystacks — as a `delete`, `set`,
 * `keys().next()` dance around a plain `Map`, and the copies differed on the one thing that
 * matters: what counts as a use.
 *
 * **A use is a write.** `set` counts; `get` does not. Re-setting a key moves it to the back, so
 * the entry somebody keeps writing is the one that survives. A read never reorders, so a lookup
 * cannot quietly promote something a caller has decided is stale; a caller that wants a hit to
 * count sets what it read back — `layoutMemo` does, once it has checked the entry still fits.
 *
 * `set` evicts *after* adding, so for a moment the map holds `max + 1`. A caller whose values
 * are costly to hold calls `makeRoom` before building the next one, so the new value and the one
 * it displaces never coexist — `neuronSearch.ts`, whose haystacks are 24 MB apiece.
 *
 * Hand-written loops remain, deliberately, and they divide into two kinds. `ui/viewers/keyedCache.ts`
 * and `data/precomputed/sharded.ts` are the odd ones out on *mechanism*: the first evicts against a
 * **weight** budget rather than a count, so one insert may drop several entries, and the second caps
 * a map it hands to `memoPromise`, which takes a real `Map` — as does Split Axon/Dendrite's
 * automatic-split cache (`nodes/transform/splitCompartments.ts`), for the same reason.
 *
 * The other kind is a **byte-budgeted, read-promoting** cache — `data/geometryCache.ts` and
 * `data/zapbench/traces.ts` — and both differ from this class on the rule above rather than on the
 * budget: there, *a read counts as a use*, because the thing being held is a download somebody
 * keeps asking for rather than a value somebody keeps rewriting. Sharing this class would mean
 * every hit calling `set` to promote, which is the escape hatch `layoutMemo` uses and a poor
 * default. They are two implementations of one shape and could be one helper in `src/data`; that
 * is worth doing when a third appears, not before.
 */
export class LruMap<K, V> {
  private readonly entries = new Map<K, V>()
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  get size(): number {
    return this.entries.size
  }

  get(key: K): V | undefined {
    return this.entries.get(key)
  }

  set(key: K, value: V): this {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.max) this.dropOldest()
    return this
  }

  /** Drop the oldest entry if the map is full, so the next `set` of a new key evicts nothing. */
  makeRoom(): void {
    if (this.entries.size >= this.max) this.dropOldest()
  }

  delete(key: K): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  private dropOldest(): void {
    const oldest = this.entries.keys().next()
    if (!oldest.done) this.entries.delete(oldest.value)
  }
}

/**
 * An `LruMap` keyed by string whose entries also stay for as long as an **owner** holds them.
 *
 * For a handle a value carries by id — a Custom Dataset's wired edge list, synapse table and build
 * — whose registry entry the value cannot answer without. Bounded by recency alone, a sixteenth
 * edit elsewhere evicted the entry behind a dataset value still in the scheduler's cache, and a
 * question on it failed with advice (run the node again) that could not work: the cached result
 * was fresh, so Run skipped it. `pin` ties an entry's life to the value itself — a
 * `FinalizationRegistry` lets go once the owner is collected — and the recency bound goes on
 * sweeping everything nothing has pinned yet. A `get` is a use, so it refreshes recency.
 */
export class PinnedLru<V> {
  private readonly recent: LruMap<string, V>
  /** Pinned entries, out of `recent` so they take no slot there, with how many owners hold each. */
  private readonly pinned = new Map<string, { value: V; owners: number }>()
  /**
   * Bumped by `clear`, which forgets every pin: an owner collected afterwards must not release a
   * pin made since under the same key.
   */
  private generation = 0
  private readonly registry = new FinalizationRegistry<{ key: string; generation: number }>(
    ({ key, generation }) => {
      if (generation === this.generation) this.release(key)
    },
  )

  constructor(max: number) {
    this.recent = new LruMap(max)
  }

  get(key: string): V | undefined {
    const held = this.pinned.get(key)
    if (held) return held.value
    const value = this.recent.get(key)
    if (value !== undefined) this.recent.set(key, value)
    return value
  }

  set(key: string, value: V): void {
    const held = this.pinned.get(key)
    if (held) held.value = value
    else this.recent.set(key, value)
  }

  /** Keep `key`'s entry for as long as `owner` is reachable. Nothing where there is no entry. */
  pin(owner: object, key: string): void {
    const held = this.pinned.get(key)
    if (held) held.owners++
    else {
      const value = this.recent.get(key)
      if (value === undefined) return
      this.recent.delete(key)
      this.pinned.set(key, { value, owners: 1 })
    }
    this.registry.register(owner, { key, generation: this.generation })
  }

  clear(): void {
    this.recent.clear()
    this.pinned.clear()
    this.generation++
  }

  /**
   * The last owner gone: forgotten at once. Nothing can ask for it again — a key is a value's
   * provenance, and the value is what has gone — while an entry may hold a whole in-memory table,
   * which sent back to recency stayed alive through the next sixteen edits.
   */
  private release(key: string): void {
    const held = this.pinned.get(key)
    if (!held || --held.owners > 0) return
    this.pinned.delete(key)
  }
}
