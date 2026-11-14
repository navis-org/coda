/**
 * The two bounded-concurrency pools, and the difference between them is the whole point.
 *
 * `mapWithConcurrency` **forgives a failed item**, which is right when the items are separate
 * answers — forty-nine skeletons should survive the fiftieth. `inFlight` **fails the whole read
 * on the first failure**, which is right when the items are pieces of one answer — a chunk of a
 * volume cutout, a byte range of a shard — because forgiving one there means a silently
 * zero-filled hole in something that looks like data.
 *
 * Both live here rather than in a caller because that rule is the load-bearing part, and each
 * was written twice before it moved: `mapWithConcurrency` once for Cypher and once for the
 * object stores, `inFlight` once in `precomputed/volume.ts` before `precomputed/sharded.ts`
 * needed it too.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight, collecting results in order.
 *
 * One body without a skeleton must not lose the other forty-nine, so a failure becomes
 * `undefined` — but if *every* item failed, that is not a patchy dataset, it is a broken
 * request, and the first error is rethrown. Swallowing the lot is how a percent-encoded
 * dataset id once turned into a silent "0 skeletons" instead of a 400.
 *
 * An abort is never a failure to count: it propagates immediately, because the caller asked
 * for the work to stop rather than for it to be attempted and missed.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length)
  let next = 0
  let failures = 0
  let firstError: unknown

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index]!)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        failures++
        firstError ??= error
        results[index] = undefined
      }
    }
  })
  await Promise.all(workers)

  if (items.length > 0 && failures === items.length) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError))
  }
  return results
}

/**
 * Run `work` over `items`, at most `limit` at a time.
 *
 * **The strict sibling of `mapWithConcurrency` above**: the first failure fails the read, though
 * its siblings still run to completion before it surfaces. The module header argues why.
 *
 * A pool rather than `Promise.all` because the limit is politeness at a shared public bucket: a
 * caller reading a hundred boxes would otherwise have every chunk of every one of them in flight
 * at once. The number is the caller's to set and each has measured its own —
 * `precomputed/volume.ts` has the curve behind its.
 */
export async function inFlight<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const at = next
        next += 1
        // `at >= length` rather than `items[at] === undefined`, so an array holding an `undefined`
        // does not end the work early — a trap for the next caller rather than a bug today.
        if (at >= items.length) return
        await work(items[at]!)
      }
    },
  )
  await Promise.all(runners)
}
