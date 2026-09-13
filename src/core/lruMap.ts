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
 * a map it hands to `memoPromise`, which takes a real `Map`.
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
