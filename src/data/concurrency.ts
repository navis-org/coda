/**
 * Bounded-concurrency map, shared by every source that fans out over body ids.
 *
 * Lives here rather than in either caller because the failure rule below is the load-bearing
 * part, and it was written twice — once for Cypher, once for the object stores — which meant
 * remembering it twice.
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
