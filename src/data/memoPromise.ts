/**
 * One promise per key, shared between everybody who asks while it is wanted.
 *
 * Sixteen sites in the data layer had written this by hand as `get / if (!p) { p = run().catch(
 * …delete…) ; set }`, and they had diverged on the half that matters. The obvious spelling —
 * `slot ??= run()` — caches a **rejection** and replays it for the life of the tab, so one failed
 * listing on a flaky connection kept CATMAID's dataset picker empty until a reload. That is the
 * incident this helper exists to make unrepeatable: keeping the resolved value is the whole point
 * of a memo, and keeping the failure is never what anybody wanted. **A rejection is never kept,
 * under either variant.** The next caller runs again.
 *
 * What does vary, legitimately, is what happens after a *success*:
 *
 *  - `keep: 'resolved'` holds the promise for the session. Right for a fact that cannot change
 *    under a key — a frozen materialization's table list, a datastack record, a landmark file,
 *    a minishard index — where a second request is pure cost.
 *  - `keep: 'inflight'` holds it only while it is pending, so concurrent callers share one
 *    request and the next caller after it settles asks afresh. Right where the settled answer is
 *    kept somewhere else (a value map a peek reads synchronously), or where asking again is the
 *    point — `loadCachedTable` behind a `refresh`, a listing the Connections panel re-requests.
 *
 * The eviction is **identity-guarded**: a settled promise removes its entry only while that entry
 * is still itself. A caller that cleared the map — a changed CAVE server, a test seam, an eviction
 * in `sharded.ts` — and started again must not have the new request dropped by the old one
 * settling late. Several hand-written copies deleted unconditionally, so a stale rejection could
 * evict a live request and cost a duplicate fetch.
 *
 * Deliberately **not** a peek. The sites that answer synchronously (`peekMaterializations`,
 * `DatasetListing.peek`) keep their own value map and their own "asked already" flag, because a
 * peek must not retry — inference runs on every graph mutation — where an awaited caller must.
 * Folding that rule in here would make it one boolean away from being wrong at every site.
 */

/** What a memo holds on to once its promise has settled successfully. See the module header. */
export type Keep = 'resolved' | 'inflight'

export function memoPromise<K, V>(
  held: Map<K, Promise<V>>,
  key: K,
  run: () => Promise<V>,
  options: { keep: Keep },
): Promise<V> {
  const existing = held.get(key)
  if (existing) return existing
  const forget = () => {
    if (held.get(key) === pending) held.delete(key)
  }
  const started = run()
  const pending: Promise<V> =
    options.keep === 'inflight'
      ? started.finally(forget)
      : started.catch((error: unknown) => {
          forget()
          throw error
        })
  held.set(key, pending)
  return pending
}
